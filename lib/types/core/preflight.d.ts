import { prepareArms } from './plan.js';
import { type DriverFactory } from './runner.js';
import type { Project } from './project.js';
export interface PreflightStage {
    name: 'compose' | 'mounted' | 'runs';
    ok: boolean;
    detail: string;
}
export interface PreflightResult {
    arm: string;
    baseline: string;
    ok: boolean;
    stages: PreflightStage[];
    /**
     * Rows the arm adds, with whether each is present and enabled — and whether the
     * baseline already has it. A plugin installed into the profile itself lands in
     * both arms, so a card sitting in arm B can look right and change nothing.
     */
    rows: Array<{
        id: string;
        name?: string;
        present: boolean;
        enabled: boolean;
        inBaseline: boolean;
    }>;
    /** What the composed-tree diff says, in the same words the run report uses. */
    diff: string[];
    variables: number;
    /** Set when stage 3 ran: the smoke scenario, its outcome and what it cost. */
    smoke?: {
        scenario: string;
        ok: boolean;
        usd: number;
        steps: number;
        tools: string[];
        error?: string;
        wallMs: number;
    };
}
/**
 * The line of a runtime failure worth showing. dsh reports the symptom first
 * ("JSON-RPC input closed") and the cause deep in a stack trace, so the specific
 * loader complaints are preferred, then any Error line, then the first line.
 */
export declare function explainRuntimeFailure(error: string): string;
export interface PreflightOptions {
    /** Scenario used for the live turn; defaults to the environment smoke scenario. */
    scenario?: string;
    /** Skip the live turn: compose and mount checks only, no spend. */
    dry?: boolean;
    driverFactory?: DriverFactory;
    invoke?: Parameters<typeof prepareArms>[2]['invoke'];
    log?: (line: string) => void;
}
export declare function preflightArm(project: Project, armName: string, options?: PreflightOptions): Promise<PreflightResult>;
