/**
 * Tamper-evident run seal. After a run (and after every regrade) the evidence
 * files under the run directory are hashed into `manifest.json`; `verifyRun`
 * recomputes the hashes and re-derives the report from the sealed ledgers so
 * a reader can check that the report they were given follows from the
 * evidence they were given. Report, annotations and judge files are derived
 * or added later and are checked separately.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { writeJsonAtomic } from './store.js';
const DERIVED = new Set(['manifest.json', 'report.json', 'report.md', 'annotations.json']);
function isDerived(rel) {
    if (DERIVED.has(rel))
        return true;
    if (rel.startsWith('judge-') && rel.endsWith('.json'))
        return true;
    if (rel.startsWith('regrade-') && rel.endsWith('.json'))
        return true;
    if (rel.startsWith('rerun-') && rel.endsWith('.json'))
        return true;
    if (rel === 'report.html' || rel === 'VERIFY.md')
        return true;
    return false;
}
function walk(dir, root, out) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory())
            walk(p, root, out);
        else
            out.push(relative(root, p));
    }
}
export function evidenceFiles(runDir) {
    const out = [];
    walk(runDir, runDir, out);
    return out.filter(rel => !isDerived(rel) && !rel.startsWith('arms/_meter-')).sort();
}
export function fileSha(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function evidenceShaOf(files) {
    const h = createHash('sha256');
    for (const rel of Object.keys(files).sort())
        h.update(rel + '\0' + files[rel] + '\n');
    return h.digest('hex');
}
export function sealRun(paths, runId, regrade) {
    const previous = readManifest(paths);
    const files = {};
    let bytes = 0;
    for (const rel of evidenceFiles(paths.dir)) {
        files[rel] = fileSha(join(paths.dir, rel));
        bytes += statSync(join(paths.dir, rel)).size;
    }
    const manifest = {
        schema: 'dsh-eval-manifest/1',
        runId,
        sealedAt: new Date().toISOString(),
        files,
        count: Object.keys(files).length,
        bytes,
        evidenceSha: evidenceShaOf(files),
        regrades: [...(previous?.regrades ?? []), ...(regrade ? [regrade] : [])],
    };
    writeJsonAtomic(join(paths.dir, 'manifest.json'), manifest);
    return manifest;
}
export function readManifest(paths) {
    const file = join(paths.dir, 'manifest.json');
    if (!existsSync(file))
        return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
/** Compare sealed hashes with the files on disk; `derive` re-derives the report and returns its readings for comparison. */
export function verifyRun(paths, derive) {
    const manifest = readManifest(paths);
    if (!manifest)
        return { ok: false, sealedAt: null, evidenceSha: null, missing: [], changed: [], added: [], reportReproduces: null, reportDiff: ['no manifest: this run was never sealed'] };
    const missing = [];
    const changed = [];
    for (const [rel, sha] of Object.entries(manifest.files)) {
        const p = join(paths.dir, rel);
        if (!existsSync(p)) {
            missing.push(rel);
            continue;
        }
        if (fileSha(p) !== sha)
            changed.push(rel);
    }
    const now = new Set(evidenceFiles(paths.dir));
    const added = [...now].filter(rel => !(rel in manifest.files)).sort();
    let reportReproduces = null;
    const reportDiff = [];
    if (derive) {
        const { fresh, stored } = derive();
        if (stored === null)
            reportReproduces = null;
        else {
            for (const key of Object.keys(fresh)) {
                const a = JSON.stringify(fresh[key]);
                const b = JSON.stringify(stored[key]);
                if (a !== b)
                    reportDiff.push(`${key}: stored ${b} vs derived ${a}`);
            }
            reportReproduces = reportDiff.length === 0;
        }
    }
    return { ok: missing.length === 0 && changed.length === 0 && reportReproduces !== false, sealedAt: manifest.sealedAt, evidenceSha: manifest.evidenceSha, missing, changed, added, reportReproduces, reportDiff };
}
