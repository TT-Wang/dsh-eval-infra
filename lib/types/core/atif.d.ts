/**
 * Export one run ledger + trace as an ATIF v1.8 trajectory (Harbor's Agent
 * Trajectory Interchange Format), so Harbor's viewer and the ATIF trajectory
 * viewer can open dsh-eval trials. https://www.harborframework.com/docs/agents/trajectory-format
 */
import type { RunLedger } from './types.js';
import type { TraceRow } from './ledger.js';
export interface AtifStep {
    step_id: number;
    timestamp: string;
    source: 'user' | 'agent' | 'system';
    message: string;
    model_name?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
        tool_call_id: string;
        function_name: string;
        arguments: Record<string, unknown> | {
            raw: string;
        };
    }>;
    metrics?: {
        prompt_tokens: number;
        completion_tokens: number;
        cached_tokens?: number;
        cost_usd?: number;
    };
    extra?: Record<string, unknown>;
}
export interface AtifTrajectory {
    schema_version: 'ATIF-v1.8';
    session_id: string;
    agent: {
        name: string;
        version: string;
        model_name: string;
        extra?: Record<string, unknown>;
    };
    steps: AtifStep[];
    final_metrics: {
        total_prompt_tokens: number;
        total_completion_tokens: number;
        total_cached_tokens: number;
        total_cost_usd: number;
        total_steps: number;
    };
    extra: Record<string, unknown>;
}
export declare function toAtif(ledger: RunLedger, trace: TraceRow[], prompts: string[], version: string): AtifTrajectory;
