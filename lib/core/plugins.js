/**
 * Discover dsh plugins on this machine so an arm can be designed by picking
 * from what is actually installable, instead of by typing a package name.
 *
 * Three sources, in the order a user thinks about them: what the eval profile
 * already has, what sits in the local development roots, and what is installed
 * globally. A package qualifies when its manifest looks like a dsh plugin: a
 * `dsh` section, or a dsh-shaped name with a module entry. Bundles are marked,
 * because a bundle is a whole profile layer rather than one row.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { evalProfileManifest } from './plan.js';
/** Rows a bundle patch turns off and rows it inserts, read from the plugin's own patch file. */
export function summarisePatch(text) {
    const replaces = [];
    const inserts = [];
    let parsed;
    try {
        parsed = yaml.load(text);
    }
    catch {
        return { replaces, inserts };
    }
    if (!Array.isArray(parsed))
        return { replaces, inserts };
    for (const row of parsed) {
        if (row === null || typeof row !== 'object')
            continue;
        const r = row;
        if (typeof r['id'] === 'string' && r['disabled'] === true)
            replaces.push(r['id']);
        if (Array.isArray(r['insert'])) {
            for (const entry of r['insert']) {
                if (entry !== null && typeof entry === 'object' && typeof entry['id'] === 'string')
                    inserts.push(entry['id']);
            }
        }
    }
    return { replaces, inserts };
}
/** Row id conventionally derived from a package name: the last segment without the dsh- prefix. */
export function rowIdFor(name) {
    const last = name.split('/').pop() ?? name;
    return last.replace(/^dsh-/, '') || last;
}
function readManifest(dir) {
    const file = join(dir, 'package.json');
    if (!existsSync(file))
        return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
function looksLikePlugin(m) {
    const name = typeof m['name'] === 'string' ? m['name'] : '';
    if (name === '')
        return false;
    if (m['dsh'] !== null && typeof m['dsh'] === 'object')
        return true;
    // A dsh-shaped name with a module entry: the loader can import it.
    return /(^|\/)dsh-/.test(name) && (typeof m['main'] === 'string' || typeof m['exports'] === 'object');
}
function describe(dir, source, installedNames) {
    const m = readManifest(dir);
    if (m === null || !looksLikePlugin(m))
        return null;
    const name = m['name'];
    const dsh = (m['dsh'] ?? {});
    const bundleDecl = (dsh['bundle'] ?? {});
    let bundlePatch;
    let summary;
    if (typeof bundleDecl['patch'] === 'string') {
        const patchPath = isAbsolute(bundleDecl['patch']) ? bundleDecl['patch'] : resolve(dir, bundleDecl['patch']);
        if (existsSync(patchPath)) {
            bundlePatch = patchPath;
            try {
                summary = summarisePatch(readFileSync(patchPath, 'utf8'));
            }
            catch {
                summary = undefined;
            }
        }
    }
    return {
        name,
        ...(bundlePatch !== undefined ? { bundlePatch } : {}),
        ...(summary !== undefined ? { replaces: summary.replaces, inserts: summary.inserts } : {}),
        ...(typeof m['version'] === 'string' ? { version: m['version'] } : {}),
        ...(typeof m['description'] === 'string' ? { description: m['description'] } : {}),
        path: dir,
        source,
        installed: installedNames.has(name),
        bundle: dsh['bundle'] !== undefined,
        client: dsh['client'] !== undefined,
        rowId: rowIdFor(name),
    };
}
/** Package directories one level under a root, including one level of scope directories. */
function packageDirs(root, limit = 400) {
    if (!existsSync(root))
        return [];
    const out = [];
    let entries;
    try {
        entries = readdirSync(root);
    }
    catch {
        return [];
    }
    for (const entry of entries) {
        if (entry.startsWith('.') || out.length >= limit)
            continue;
        const dir = join(root, entry);
        try {
            if (!statSync(dir).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        if (entry.startsWith('@')) {
            try {
                for (const scoped of readdirSync(dir))
                    out.push(join(dir, scoped));
            }
            catch { /* unreadable scope */ }
        }
        else
            out.push(dir);
    }
    return out;
}
export function discoverPlugins(options = {}) {
    const home = homedir();
    const installedNames = new Set();
    if (options.evalHome !== undefined && options.profile !== undefined) {
        try {
            for (const dep of Object.keys(evalProfileManifest(options.evalHome, options.profile).dependencies))
                installedNames.add(dep);
        }
        catch { /* no profile yet */ }
    }
    const found = new Map();
    const consider = (dir, source) => {
        const p = describe(dir, source, installedNames);
        if (p === null)
            return;
        const existing = found.get(p.name);
        // Prefer an installed copy, then a local checkout: audit worktrees of the same package must not multiply.
        if (existing === undefined || (!existing.installed && p.installed) || (existing.source === 'global' && p.source !== 'global'))
            found.set(p.name, p);
    };
    if (options.evalHome !== undefined && options.profile !== undefined) {
        const modules = join(options.evalHome, 'profiles', options.profile, 'node_modules');
        for (const dir of packageDirs(modules)) {
            try {
                consider(realpathSync(dir), 'profile');
            }
            catch {
                consider(dir, 'profile');
            }
        }
    }
    for (const root of options.roots ?? [join(home, 'code'), join(home, 'src')]) {
        for (const dir of packageDirs(resolve(root)))
            consider(dir, 'local');
    }
    const globalRoot = options.globalRoot ?? [join(home, '.local', 'lib', 'node_modules'), '/usr/local/lib/node_modules'].find(existsSync);
    if (globalRoot !== undefined)
        for (const dir of packageDirs(globalRoot))
            consider(dir, 'global');
    return [...found.values()].sort((a, b) => (Number(b.installed) - Number(a.installed)) || a.name.localeCompare(b.name));
}
