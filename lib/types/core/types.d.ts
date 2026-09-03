/**
 * Shared types for dsh-eval-infra: scenarios, arms, ledgers, plans, and reports.
 * Everything a run produces is derived from these records; the report never
 * carries a number that is not recomputable from the ledgers on disk.
 */
/** meta.json of a scenario directory. */
export interface ScenarioMeta {
    name: string;
    /** Number of user turns (must equal prompts.json length). */
    turns: number;
    /** Free-text description of what the scenario stresses. */
    stressor?: string;
    /** Category tag used by pools and the UI (e.g. context, tools, memory, safety, prompt, cost). */
    category?: string;
    tags?: string[];
    /** Advisory per-turn step budget for loops that support one; the stock loop has none. */
    max_steps_per_turn?: number;
    /** Wall-clock budget per turn in seconds (default 1800). */
    turn_timeout_s?: number;
    /** Whether the scenario needs network tools (web_fetch/web_search); default false → they are disabled. */
    network?: boolean;
    /** `required` (default): oracle.py must exist and pass selfcheck; `none`: scenario has no oracle (only the null check runs). */
    oracle?: 'required' | 'none';
    /** Who wrote it — surfaced in reports so author-provided scenarios are visible. */
    author?: string;
    /**
     * Sealed holdout: excluded from runs unless `--include-holdout` is given, and
     * reported separately so tuning a change against the dev pool shows up as a
     * dev–holdout gap. Authors should not run these while iterating.
     */
    holdout?: boolean;
    /**
     * 1-based turn numbers before which the runner ends the session and starts a
     * fresh runtime process on the same workspace and eval home. This is how a
     * memory plugin is tested: what survives a restart is what it stored.
     */
    new_session_before_turns?: number[];
    /** Files the strict self-check must not mutate: side products of the scenario's own scripts that no prompt asks for. */
    strict_ignore?: string[];
}
/** A loaded scenario. */
export interface Scenario {
    name: string;
    dir: string;
    meta: ScenarioMeta;
    prompts: string[];
    hasOracle: boolean;
    hasSetup: boolean;
}
/** One patch row as dsh's loader accepts it (id-targeted override or insert list). */
export type PatchRow = Record<string, unknown>;
/** An arm: one complete configuration of the agent under test. */
export interface ArmSpec {
    /** Short identifier used in file names and tables. */
    name: string;
    description?: string;
    /** dsh profile name inside the eval home (default `eval`). */
    profile?: string;
    /** Provider route (default deepseek-official). */
    provider?: string;
    /** Model id (default deepseek-v4-flash). */
    model?: string;
    /** Reasoning effort id passed at SDK initialize; omitted keeps the adapter default. */
    effort?: string;
    /** Output-token cap per request. */
    maxTokens?: number;
    /** Inline patch rows applied after the profile's own layer (the arm's whole difference lives here). */
    patches?: PatchRow[];
    /** Extra patch files (paths relative to the arm file) applied before `patches`. */
    patchFiles?: string[];
    /** Extra environment variables for the runtime subprocess. */
    env?: Record<string, string>;
}
/** Resolved arm with absolute paths and defaults filled in. */
export interface ResolvedArm extends ArmSpec {
    profile: string;
    provider: string;
    model: string;
    /** Absolute path of the overlay file the runner passes as `--patch`. */
    overlayPath: string;
    /** Absolute paths of patchFiles. */
    patchFilePaths: string[];
    /** Path of the arm definition file, when loaded from disk. */
    sourcePath?: string;
}
export type TimeBand = 'peak' | 'offpeak';
/** Token usage of one model call, normalized: `miss` is billed input, `hit` is cache-read input. */
export interface Usage {
    hit: number;
    miss: number;
    output: number;
    reasoning: number;
}
/** One model call (step) as recorded in the ledger. */
export interface StepRow extends Usage {
    turn: number;
    step: number;
    /** Unix ms of the assistant/message event. */
    time: number;
    band: TimeBand;
    usd: number;
    /** Tool calls the model issued in this step. */
    calls: Array<{
        name: string;
        args: string;
    }>;
    /** Characters of visible assistant text. */
    textChars: number;
    /** Characters of reasoning text. */
    reasoningChars: number;
}
/** Per-turn aggregate. */
export interface TurnRow extends Usage {
    turn: number;
    steps: number;
    usd: number;
    wallMs: number;
    /** How the turn ended (`completed`, `error`, `aborted`, `max-tokens`, ...). */
    end: string;
    /** Error message when the turn ended in error. */
    error?: string;
}
/** Totals across the run. */
export interface Totals extends Usage {
    steps: number;
    turns: number;
    usd: number;
    /** Cost re-priced entirely at peak and entirely at off-peak rates, so runs at different hours stay comparable. */
    usdPeak: number;
    usdOffpeak: number;
    /** Largest single-request prompt (hit + miss) in tokens. */
    peakPrompt: number;
}
export interface Verdict {
    ok: boolean;
    detail: string;
}
/** The ledger of one run: one scenario × one arm × one repeat. */
export interface RunLedger {
    schema: 'dsh-eval-ledger/1';
    runId: string;
    scenario: string;
    arm: string;
    rep: number;
    /** Position in the interleaved launch order of the whole run. */
    order: number;
    startedAt: string;
    endedAt: string;
    wallMs: number;
    /** Route as the SDK initialized it. */
    provider: string;
    model: string;
    /** Effort as resolved from the first request header (not the requested value). */
    resolvedEffort: string | null;
    /** Model as resolved from the first request header. */
    headerModel: string | null;
    /** Tool names in the first request header. */
    tools: string[];
    /** SHA-256 of the system prompt text of the first request header. */
    systemPromptSha: string | null;
    systemPromptChars: number;
    turns: TurnRow[];
    steps: StepRow[];
    totals: Totals;
    toolHistogram: Record<string, number>;
    /** Counts of session event types worth watching (compaction/start, ...). */
    eventCounts: Record<string, number>;
    verdict: Verdict | null;
    /** Behaviour signature: tool errors, repeated calls, no-action steps, observation volume, compactions. */
    behaviour: {
        toolErrors: number;
        repeatedCalls: number;
        noActionSteps: number;
        observationChars: number;
        compactions: number;
    };
    /** Set when the run itself failed (runtime crash, timeout) — the verdict is then null. */
    error?: string;
    /** Present when a human override replaced the machine verdict (the original is kept here). */
    machineVerdict?: Verdict | null;
    overridden?: boolean;
    sessionId: string | null;
    /** Runtime sessions used (1 unless the scenario declares new_session_before_turns). */
    sessions: number;
    workdir: string;
    /** Path of the events dump (JSONL) relative to the run directory. */
    eventsFile: string;
    /** Path of the per-step trace dump relative to the run directory. */
    traceFile: string;
}
/** What `dsh-eval run` was asked to do. */
export interface RunPlan {
    id: string;
    createdAt: string;
    baseline: ArmSpec;
    candidates: ArmSpec[];
    scenarios: string[];
    repeats: number;
    concurrency: number;
    /** Directory of the scenario library used. */
    scenarioRoot: string;
    /** Free-text label. */
    label?: string;
}
/** Environment facts recorded once per run for reproducibility. */
export interface RunEnvironment {
    dshVersion: string | null;
    dshSource: string | null;
    /** Git revision of the dsh source checkout, when available. */
    dshRevision: string | null;
    evalInfraVersion: string;
    node: string;
    platform: string;
    /** Composed profile tree per arm (dump-config output), keyed by arm name. */
    composedTreeSha: Record<string, string>;
    priceTableAsOf: string;
}
export interface RunIndexEntry {
    id: string;
    createdAt: string;
    label?: string;
    status: 'running' | 'done' | 'failed' | 'cancelled';
    arms: string[];
    scenarios: number;
    repeats: number;
    completed: number;
    total: number;
    usd: number;
}
