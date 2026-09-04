/**
 * Plan preparation: resolve arms into overlays, compose each arm's tree
 * through dsh itself, count the variables that differ between baseline and
 * candidate, and record the environment facts a reader needs to trust the run.
 */
import yaml from 'js-yaml';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armOverlays, diffComposedRows, diffRoute, dumpComposedTree, parseComposedRows, resolveArm, sha256 } from './arms.js';
import { dshSourceRevision, dshSourceRoot, dshVersion, evalInfraVersion } from './env.js';
import { DEEPSEEK_PRICES } from './pricing.js';
import { writeBaseOverlays } from './runner.js';
export async function prepareArms(baseline, candidates, options) {
    const names = new Set();
    for (const a of [baseline, ...candidates]) {
        if (names.has(a.name))
            throw new Error(`duplicate arm name: ${a.name}`);
        names.add(a.name);
    }
    const base = writeBaseOverlays(options.armsDir);
    const resolvedBaseline = resolveArm(baseline, options.armsDir, options.sources?.[baseline.name]);
    const resolvedCandidates = candidates.map(c => resolveArm(c, options.armsDir, options.sources?.[c.name]));
    const composed = {};
    const trees = new Map();
    for (const arm of [resolvedBaseline, ...resolvedCandidates]) {
        const text = await dumpComposedTree(options.evalHome, arm.profile, [base.noNetwork, ...armOverlays(arm)], options.invoke);
        composed[arm.name] = text;
        trees.set(arm.name, parseComposedRows(text));
    }
    const diffs = resolvedCandidates.map((cand) => {
        const rows = diffComposedRows(trees.get(resolvedBaseline.name), trees.get(cand.name));
        const route = diffRoute(resolvedBaseline, cand);
        const patchSources = [];
        const claimed = new Set();
        // Files applied by either arm: removing a plugin on the baseline side is one
        // decision that moves several rows, exactly like adding it on the other side.
        for (const file of [...resolvedBaseline.patchFilePaths, ...cand.patchFilePaths]) {
            const touched = rowsTouchedBy(file).filter(id => rows.some(r => r.id === id) && !claimed.has(id));
            for (const id of touched)
                claimed.add(id);
            if (touched.length > 0)
                patchSources.push({ file, rows: touched });
        }
        const loose = rows.filter(r => !claimed.has(r.id)).length;
        return { candidate: cand.name, rows, route, variables: loose + patchSources.length + route.length, ...(patchSources.length > 0 ? { patchSources } : {}) };
    });
    return { baseline: resolvedBaseline, candidates: resolvedCandidates, diffs, composed, trees };
}
export async function recordEnvironment(composed) {
    const composedTreeSha = {};
    for (const [arm, text] of Object.entries(composed))
        composedTreeSha[arm] = sha256(text.split('\n').filter(l => !l.startsWith('#')).join('\n'));
    const source = dshSourceRoot();
    return {
        dshVersion: await dshVersion(),
        dshSource: source,
        dshRevision: await dshSourceRevision(source),
        evalInfraVersion: evalInfraVersion(),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        composedTreeSha,
        priceTableAsOf: DEEPSEEK_PRICES.asOf,
    };
}
/** Human-readable one-line-per-difference summary of an arm diff. */
/** Row ids a patch file affects: what one applied file accounts for in the diff. */
export function rowsTouchedBy(file) {
    if (!existsSync(file))
        return [];
    let parsed;
    try {
        parsed = yaml.load(readFileSync(file, 'utf8'));
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
    const ids = [];
    for (const row of parsed) {
        if (row === null || typeof row !== 'object')
            continue;
        const r = row;
        if (typeof r['id'] === 'string')
            ids.push(r['id']);
        if (Array.isArray(r['insert'])) {
            for (const entry of r['insert']) {
                if (entry !== null && typeof entry === 'object' && typeof entry['id'] === 'string')
                    ids.push(entry['id']);
            }
        }
    }
    return ids;
}
export function describeDiff(diff) {
    const out = [];
    const bySource = new Map();
    for (const source of diff.patchSources ?? [])
        for (const id of source.rows)
            bySource.set(id, source.file.split('/').slice(-2).join('/'));
    for (const r of diff.rows) {
        const via = bySource.has(r.id) ? ` · via ${bySource.get(r.id)}` : '';
        if (r.kind === 'added')
            out.push(`+ row ${r.id} (${String(r.after?.['name'] ?? '')})${via}`);
        else if (r.kind === 'removed')
            out.push(`− row ${r.id}${via}`);
        else
            out.push(`~ row ${r.id}: ${r.fields.join(', ')}${via}`);
    }
    for (const f of diff.route)
        out.push(`~ route ${f}`);
    if (out.length === 0)
        out.push('(identical composition — the arms do not differ)');
    return out;
}
/** Read the profile manifest of the eval home, if the profile exists. */
export function evalProfileManifest(evalHome, profile) {
    const manifest = join(evalHome, 'profiles', profile, 'package.json');
    if (!existsSync(manifest))
        return { exists: false, dependencies: {}, bundles: [] };
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    return { exists: true, dependencies: parsed.dependencies ?? {}, bundles: parsed.dsh?.profile?.bundles ?? [] };
}
