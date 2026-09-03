import { type RunPaths } from './store.js';
export interface RunManifest {
    schema: 'dsh-eval-manifest/1';
    runId: string;
    sealedAt: string;
    /** Relative path → sha256 of every evidence file. */
    files: Record<string, string>;
    count: number;
    bytes: number;
    /** sha256 over the sorted (path, sha) list: one id for the whole evidence set. */
    evidenceSha: string;
    regrades: Array<{
        at: string;
        changed: number;
        regradable: number;
        verifiers: Record<string, string>;
    }>;
}
export interface VerifyResult {
    ok: boolean;
    sealedAt: string | null;
    evidenceSha: string | null;
    missing: string[];
    changed: string[];
    /** Evidence files present now that were not sealed (added after the seal). */
    added: string[];
    /** Whether report.json's readings equal a fresh derivation from the sealed ledgers (null when no report). */
    reportReproduces: boolean | null;
    reportDiff: string[];
}
export declare function evidenceFiles(runDir: string): string[];
export declare function fileSha(path: string): string;
export declare function evidenceShaOf(files: Record<string, string>): string;
export declare function sealRun(paths: RunPaths, runId: string, regrade?: RunManifest['regrades'][number]): RunManifest;
export declare function readManifest(paths: RunPaths): RunManifest | null;
/** Compare sealed hashes with the files on disk; `derive` re-derives the report and returns its readings for comparison. */
export declare function verifyRun(paths: RunPaths, derive?: () => {
    fresh: Record<string, unknown>;
    stored: Record<string, unknown> | null;
}): VerifyResult;
