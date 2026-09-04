import { type RunPaths } from './store.js';
/** The analysis contract, fixed before the readings are made and signed with the receipt. */
export interface AnalysisContract {
    estimand: string;
    pairing: string;
    estimator: string;
    alpha: number;
    sesoiPct: number;
    minScenarios: number;
    bootstrapDraws: number;
    seed: number;
    gateOrder: string;
    costRule: string;
}
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
    contract?: AnalysisContract;
}
/** A signed, self-contained statement of what this run claims and what evidence backs it. */
export interface RunReceipt {
    schema: 'dsh-eval-receipt/1';
    runId: string;
    issuedAt: string;
    evidenceSha: string;
    contract: AnalysisContract;
    claims: Array<{
        arm: string;
        gate: string;
        costReading: string;
        grade: string;
        verdict: string;
    }>;
    coverage: {
        trials: number;
        scenarios: number;
        repeats: number;
        arms: number;
        reconciled: number;
        metered: number;
        unrun: number;
        errors: number;
    };
    environment: {
        dshVersion?: string;
        dshRevision?: string;
        evalInfraVersion?: string;
        sandbox?: string;
        composedTreeSha?: Record<string, string>;
    };
    publicKey: string;
    /** Ed25519 signature over the canonical JSON of everything above except this field. */
    signature: string;
}
export type ReceiptStatus = 'PASS' | 'INVALID' | 'INCONCLUSIVE';
export interface VerifyResult {
    ok: boolean;
    /** PASS: signed claims recomputed from intact evidence. INVALID: evidence or signature broken. INCONCLUSIVE: nothing was falsified but the run carries no receipt, or its evidence is incomplete. */
    status?: ReceiptStatus;
    statusReason?: string;
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
export declare function sealRun(paths: RunPaths, runId: string, regrade?: RunManifest['regrades'][number], contract?: AnalysisContract): RunManifest;
export declare function readManifest(paths: RunPaths): RunManifest | null;
/** Compare sealed hashes with the files on disk; `derive` re-derives the report and returns its readings for comparison. */
export declare function verifyRun(paths: RunPaths, derive?: () => {
    fresh: Record<string, unknown>;
    stored: Record<string, unknown> | null;
}): VerifyResult;
/** The project's signing key, generated once and kept private; the public half travels in every receipt. */
export declare function signingKey(evalDir: string): {
    privateKey: string;
    publicKey: string;
};
export declare function signReceipt(receipt: Omit<RunReceipt, 'signature'>, privateKeyPem: string): RunReceipt;
export declare function receiptSignatureValid(receipt: RunReceipt): boolean;
export declare function readReceipt(paths: RunPaths): RunReceipt | null;
export declare function writeReceipt(paths: RunPaths, receipt: RunReceipt): void;
