import { prepareArms, type ArmDiff } from './plan.js';
import { type Project } from './project.js';
import { type NoiseFloor, type Report } from './report.js';
import { type AnalysisContract, type ReceiptStatus, type RunReceipt, type VerifyResult } from './manifest.js';
import { type ProbeVerdict } from './probe.js';
import { type RunDeps } from './runner.js';
import { type SelfcheckResult } from './selfcheck.js';
import { runPaths, type Progress } from './store.js';
import type { RunLedger, RunPlan, Scenario } from './types.js';
export interface RunRequest {
    /** Arm file path, or a name resolved against the project's arms dir. */
    baseline: string;
    candidates: string[];
    scenarios?: string[];
    categories?: string[];
    tags?: string[];
    repeats?: number;
    concurrency?: number;
    label?: string;
    allowMulti?: boolean;
    skipSelfcheck?: boolean;
    keepWorkdirs?: boolean;
    turnTimeoutS?: number;
    /** Resume an existing run id (skips finished jobs). */
    resume?: string;
    /** A/A: run the baseline against an identical copy of itself to measure the noise floor. */
    aa?: boolean;
    /** Budget cap in USD; the run stops scheduling trials once exceeded. */
    maxUsd?: number;
    /** Include sealed holdout scenarios (meta.holdout) in the run. */
    includeHoldout?: boolean;
    /** Anytime-valid sequential mode: shuffled scenario order, early stop once the paired comparison is decided. */
    sequential?: boolean;
    /** Where each trial's dsh runtime runs: on the host under dsh's own sandbox (default) or inside a Docker container. */
    sandbox?: 'host' | 'docker';
    /** Container runtime for docker mode (`runsc`, `kata`, …), recorded in env.json. */
    dockerRuntime?: string;
    /** Keep dsh's in-process sandbox on inside the container (defence in depth) instead of the plain bash executor. */
    dockerKeepSandbox?: boolean;
    /** Route the runtime's provider calls through the independent usage meter (default on for real runs). */
    meter?: boolean;
    /** Prompt perturbation: repeats above 1 use a seeded paraphrase variant (prompts.variants.json), identical across arms. */
    perturb?: boolean;
    /** Probe the route's served model before the trials and refuse readings when it differs from the enrolled reference. */
    probe?: boolean;
    /** Replay another run's recorded provider responses (keyless); forkAt serves that many recorded responses per trial, then goes live. */
    replay?: {
        runId: string;
        forkAt?: number;
    };
    /** Per-trial spend cap in USD (observed usage after each turn). */
    maxUsdPerTrial?: number;
    /** Sequential scenario order: seeded shuffle (default) or archive signal-to-noise, strongest first. */
    order?: 'seed' | 'signal';
    /** Fault injection through the meter: share of provider requests answered with 429 or a stall. */
    faultRate?: number;
    faultSeed?: number;
    /** Container image for docker mode (default node:22-bookworm-slim). */
    dockerImage?: string;
    /** Seed for the sequential shuffle (default 42). */
    seed?: number;
}
export interface LaunchHooks {
    log?: (line: string) => void;
    onProgress?: (p: Progress) => void;
    onLedger?: (l: RunLedger) => void;
    signal?: AbortSignal;
    /** Test seam: replace the SDK driver. */
    driverFactory?: RunDeps['driverFactory'];
    /** Test seam: replace the dsh CLI used to compose trees. */
    invoke?: Parameters<typeof prepareArms>[2]['invoke'];
}
export declare class LaunchError extends Error {
    readonly code: 'usage' | 'selfcheck' | 'arms' | 'env';
    constructor(message: string, code?: 'usage' | 'selfcheck' | 'arms' | 'env');
}
export interface Launched {
    id: string;
    plan: RunPlan;
    diffs: ArmDiff[];
    scenarios: Scenario[];
    selfcheck: SelfcheckResult[];
    /** Resolves with the final report when the run ends (or is cancelled). */
    done: Promise<{
        progress: Progress;
        report: Report;
    }>;
}
export declare function resolveArmPath(project: Project, ref: string): string;
export declare function collectScenarios(project: Project, request: Pick<RunRequest, 'scenarios' | 'categories' | 'tags' | 'includeHoldout'>): {
    scenarios: Scenario[];
    invalid: Array<{
        dir: string;
        error: string;
    }>;
};
/** Prepare everything, then start the run in the background; `done` resolves with the report. */
export declare function launchRun(project: Project, request: RunRequest, hooks?: LaunchHooks): Promise<Launched>;
/** Per-scenario mean cost of an arm across earlier runs (excluding `exceptRunId`) — the CUPED covariate. */
export declare function archiveBaselineCosts(project: Project, arm: string, exceptRunId?: string): Record<string, number>;
/** The most recent A/A noise floor per baseline arm found in the archive (excluding `exceptRunId`). */
/** Behavioural drift of this run's baseline arm against archived trials of the same arm name and model. */
export declare function baselineDrift(project: Project, plan: RunPlan, ledgers: RunLedger[]): import('./drift.js').DriftResult | null;
/**
 * Probe the route the arms will use and compare with the enrolled reference for
 * that (model, endpoint). The first call enrols; later calls test. The result is
 * archived under the project and, for a run, written into the run directory.
 */
export declare function probeRoute(project: Project, options?: {
    model?: string;
    samples?: number;
    enroll?: boolean;
    chat?: import('./judge.js').ChatCall;
    log?: (line: string) => void;
}): Promise<ProbeVerdict>;
export declare function archiveNoiseFloors(project: Project, exceptRunId?: string): Record<string, NoiseFloor>;
export interface JudgeOptions {
    /** Judge models; several form a panel. Each may be `model` or `model@baseUrl` with the key from `<NAME>_API_KEY` env, or a name from project config `judges`. */
    models?: string[];
    candidate?: string;
    seed?: number;
    /** pairwise (default), absolute (per-trial grades + PPI++), or both. */
    mode?: 'pairwise' | 'absolute' | 'both';
    log?: (line: string) => void;
    /** Test seam: replace the chat calls (one per model). */
    chats?: Record<string, import('./judge.js').ChatCall>;
    /** Allow judges from the same model family as the arms (refused by default: self-preference and preference leakage). */
    allowSameFamily?: boolean;
}
/** Model family from a model id or a configured `family` (deepseek-* → deepseek, gpt-* → openai, claude-* → anthropic, gemini-* → google). */
export declare function modelFamily(model: string, configured?: string): string;
/**
 * Run the blinded pairwise judge over every scenario of a finished run that
 * declares `meta.judge`. Writes `judge-<candidate>.json` next to the report and
 * returns it. The judge model defaults to deepseek-v4-pro so it differs from
 * the usual v4-flash arms (same family: a stated limitation).
 */
export declare function runJudge(project: Project, id: string, options?: JudgeOptions): Promise<import('./judge.js').JudgeReport[]>;
/** Absolute judge report stored with a run, if any. */
export declare function readAbsoluteJudge(paths: ReturnType<typeof runPaths>): import('./judge.js').AbsoluteReport | null;
/** Final confidence sequences of a sequential run, as report options (empty when the run was not sequential). */
/** The analysis contract this tool applies; fixed by the code and the plan, not chosen after seeing the data. */
export declare function analysisContract(plan: RunPlan): AnalysisContract;
/** Seal the evidence and issue a signed receipt carrying the contract, the claims and the coverage counts. */
export declare function sealAndIssue(project: Project, paths: ReturnType<typeof runPaths>, plan: RunPlan, report: Report): RunReceipt;
/**
 * Status of a run's claims (ClaimReceipt semantics): INVALID when the evidence
 * or the signature is broken or the report no longer follows from the ledgers;
 * INCONCLUSIVE when nothing is falsified but there is no receipt, or the run's
 * own evidence is incomplete (unrun trials, errors, or usage that never
 * reconciled); PASS when the signed claims recompute from intact evidence.
 */
export declare function receiptStatus(paths: ReturnType<typeof runPaths>, base: VerifyResult, report: Report | null): {
    status: ReceiptStatus;
    reason: string;
};
export declare function probeOf(paths: ReturnType<typeof runPaths>): {
    probe?: ProbeVerdict;
};
export declare function sequencesOf(paths: ReturnType<typeof runPaths>): {
    sequences?: Record<string, {
        cost: {
            mean: number;
            lo: number;
            hi: number;
        } | null;
        pass: {
            lo: number;
            hi: number;
        } | null;
        scenarios: number;
    }>;
};
/** Judge reports stored with a run, keyed by candidate. */
export declare function readJudgeReports(paths: ReturnType<typeof runPaths>): Record<string, import('./judge.js').JudgeReport>;
/**
 * Re-derive every ledger of a run from its stored events (the ledger schema
 * evolves; the events are the durable record). Keeps verdict, timing, route
 * and error facts from the existing ledger; recomputes usage, prices, steps,
 * behaviour, observations and invariants. Then rebuilds the report.
 */
export declare function rebuildLedgers(project: Project, id: string): Promise<number>;
/** Rebuild the report of a finished (or partial) run from its ledgers. */
/** Re-derive the report from the ledgers, annotations and judge files without writing anything. */
export declare function deriveReport(project: Project, id: string, at?: ReturnType<typeof runPaths>): Report;
export interface RerunResult {
    scenario: string;
    candidate: string;
    newRunId: string;
    /** Fork mode: the trials replayed the original run's responses up to the divergence and went live from there. */
    fork?: {
        sourceRunId: string;
        forkAt: number;
        step: number;
    };
    reps: number;
    original: {
        rep: number;
        call: number;
        baseline: string;
        candidate: string;
        failing: string;
    } | null;
    /** Reruns in which the originally failing arm failed again (or, without an original, exactly one arm failed). */
    failedAgain: number;
    /** Reruns whose first divergence happened at the same call index as the original. */
    sameCall: number;
    verdict: 'reproduced' | 'partly reproduced' | 'not reproduced' | 'no original failure';
}
/**
 * How many provider responses precede the step that holds the given tool call.
 * One assistant message is one provider response, so this is the fork point:
 * replaying that many responses reproduces the trial's prefix exactly, and the
 * next call is made live (Repair or Resample, 2608.25920: a cause only counts
 * when the failure recurs from an identical prefix more often than resampling
 * alone reproduces it).
 */
export declare function forkPointForCall(ledger: RunLedger, call: number): {
    forkAt: number;
    step: number;
};
/** First tool call at which two trials' tool sequences part, and which arm failed (null when both passed or both failed). */
export declare function pairDivergence(rb: RunLedger, rc: RunLedger, candidateName: string, baselineName: string): {
    call: number;
    baseline: string;
    candidate: string;
    failing: string;
} | null;
/**
 * Rerun validation of a failure: run one scenario again with the same arms a few
 * times and check whether the originally failing arm fails again and whether the
 * first divergence recurs at the same call. The result is stored beside the
 * original run (a derived file, so its seal stays valid) and shown in its report.
 */
export declare function rerunScenario(project: Project, runId: string, scenario: string, options?: {
    repeats?: number;
    candidate?: string;
    fork?: boolean;
    log?: (line: string) => void;
    hooks?: LaunchHooks;
}): Promise<RerunResult>;
/** Verify a run directory that lives anywhere (a published bundle): hashes plus report re-derivation. */
export declare function verifyRunDir(project: Project, dir: string): VerifyResult;
export declare function rebuildReport(project: Project, id: string): Report;
/** Check the sealed evidence against the files on disk and the stored report against a fresh derivation. */
export declare function verifyRunIntegrity(project: Project, id: string): VerifyResult;
/** Archived human-labelled trials with judge artifacts, newest first, for the judge drift check. */
export declare function collectAnchors(project: Project, exceptRunId: string, limit?: number): Array<{
    key: string;
    rubric: string;
    artifactDir: string;
    humanPass: boolean;
    previousJudgePass?: boolean;
}>;
export declare function rememberAnchorAnswers(project: Project, answers: Record<string, boolean>): void;
export interface RegradeResult {
    at: string;
    regradable: number;
    skipped: number;
    changed: Array<{
        scenario: string;
        arm: string;
        rep: number;
        before: boolean | null;
        after: boolean;
        detail: string;
    }>;
    verifiers: Record<string, string>;
}
/**
 * Re-run each scenario's verifier on the kept workspace of every trial (runs
 * made with --keep-workdirs), without re-running any agent, then rebuild the
 * report and re-seal the evidence with the regrade recorded in the manifest.
 */
export declare function regradeRun(project: Project, id: string, options?: {
    log?: (line: string) => void;
}): Promise<RegradeResult>;
