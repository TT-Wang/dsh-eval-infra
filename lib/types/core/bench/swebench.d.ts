import type { Project } from '../project.js';
import { type BenchAdapter } from './types.js';
/** The grading package, pinned: it is the benchmark's own harness, so a version is a protocol. */
export declare const SWEBENCH_PACKAGE = "swebench==5.0.2";
interface Row {
    instance_id: string;
    repo: string;
    base_commit: string;
    patch: string;
    test_patch: string;
    problem_statement: string;
    hints_text: string;
    created_at: string;
    version: string;
    FAIL_TO_PASS: string;
    PASS_TO_PASS: string;
    environment_setup_commit: string;
    difficulty?: string;
    image: string;
    eval_script: string;
    log_parser: string;
    eval_type: string;
}
/**
 * The grading package in a venv of its own under the eval dir, built once:
 * `uv` when the machine has it (seconds), else python3 -m venv and pip.
 * Returns the interpreter path.
 */
export declare function ensureSwebenchVenv(project: Project, log?: (line: string) => void): Promise<string>;
/** What the agent is told: the issue, where the checkout is, and that the maintainers' tests decide. Hints are not given. */
export declare function instructionFor(row: Row): string;
/**
 * The host-side grader, written into each task directory. It runs in the
 * managed venv and is handed the agent's container through the environment.
 */
export declare const VERIFY_PY: string;
export declare const swebenchVerified: BenchAdapter;
export {};
