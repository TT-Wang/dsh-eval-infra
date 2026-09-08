import { type DockerOptions } from './docker.js';
import type { DriverFactory, DriverInput } from './runner.js';
/** The Node build mounted into task images. Official Linux builds need glibc; every Terminal-Bench 2.0 image has it. */
export declare const NODE_VERSION = "v22.23.2";
export declare const NODE_MOUNT = "/opt/dsh-node";
export type ImagePlatform = 'amd64' | 'arm64';
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}
export interface TaskEnvironment {
    /** Container id, image and platform: what a host-side verifier needs to reach the environment or start a sibling from the same image. */
    id?: string;
    image?: string;
    platform?: ImagePlatform;
    /** Working directory inside the environment (the image's WORKDIR, /app by convention). */
    workdir: string;
    exec(command: string, options?: {
        cwd?: string;
        timeoutMs?: number;
        env?: Record<string, string>;
    }): Promise<ExecResult>;
    /** Copy a host directory's contents to a directory inside the environment (created if missing). */
    upload(localDir: string, target: string): Promise<void>;
    readFile(path: string): Promise<string | null>;
    stop(): Promise<void>;
    /** Raw `docker diff` lines: what the trial wrote inside the container. */
    diffWrites?(): Promise<string[]>;
}
export interface TaskRuntime {
    environment: TaskEnvironment;
    /** Drivers whose runtime process runs inside this environment. */
    driverFactory: DriverFactory;
}
export interface ContainerTaskOptions {
    image: string;
    /** Platform of the image; amd64 for every published Terminal-Bench image. Emulated when it is not the host's. */
    platform: ImagePlatform;
    /** Directory holding the Linux Node build for `platform` (see ensureNodeRuntime). */
    nodeDir: string;
    dsh: Pick<DockerOptions, 'dshSource' | 'nativeShims' | 'mounts' | 'onStderr'>;
    cpus?: number;
    memoryMb?: number;
    workdir?: string;
    log?: (line: string) => void;
}
/**
 * Download the pinned Node build for a container platform once per eval home.
 * Nothing is fetched until a container scenario actually runs.
 */
export declare function ensureNodeRuntime(evalHome: string, platform: ImagePlatform, log?: (line: string) => void): Promise<string>;
/** Is the image's platform the host's? When not, Docker emulates it and every trial is slower. */
export declare function platformIsEmulated(platform: ImagePlatform): boolean;
/** The `docker run -d` arguments for a task container: image, resources, the runtime mounts, kept alive until removed. */
export declare function taskContainerArgs(input: DriverInput, options: ContainerTaskOptions): string[];
/** The host's proxy settings as a container sees them: loopback rewritten to the host gateway, both spellings kept. */
export declare function proxyEnvForContainer(env: Record<string, string | undefined>): Array<[string, string]>;
/** The runtime command inside a running task container: the mounted Node, dsh's CLI with the arm's overlays. */
export declare function taskRuntimeExecArgs(containerId: string, input: DriverInput, options: ContainerTaskOptions): string[];
/**
 * Start the task container for one trial and hand back the environment plus a
 * driver factory whose dsh runtime runs inside it. The caller stops the
 * environment after verification.
 */
/** The image's own working directory — where the task's files are and where its tests expect to run. */
export declare function imageWorkdir(image: string): Promise<string | null>;
export declare function openContainerTask(input: DriverInput, options: ContainerTaskOptions): Promise<TaskRuntime>;
/** Where the benchmark's own verifier writes; the same paths Harbor uses, so a task's test.sh works unchanged. */
export declare const TESTS_DIR = "/tests";
export declare const VERIFIER_DIR = "/logs/verifier";
export declare const SOLUTION_DIR = "/solution";
/**
 * Run a Harbor-style verifier in the environment: upload `tests/`, run
 * test.sh, read the reward. Reward 1 is a pass; anything else, or no reward
 * file at all, is a fail with the test output as the reason.
 */
export interface EnvironmentVerdict {
    ok: boolean;
    detail: string;
    reward: number | null;
    /** False when the verifier never reached its tests (its own bootstrap — apt, uv, pip — failed): an infrastructure failure, not the agent's. */
    testsRan: boolean;
}
export declare function verifyInEnvironment(environment: TaskEnvironment, testsDir: string, timeoutMs: number): Promise<EnvironmentVerdict>;
/** Environment variables a host-side verifier of a container scenario receives. */
export declare function hostVerifierEnv(environment: TaskEnvironment): Record<string, string>;
/** The same, plus the verifier's own time budget. */
export declare function hostVerifierEnvWithTimeout(environment: TaskEnvironment, timeoutS: number): Record<string, string>;
/** A host-side verifier says a grade could not be made (its own container or tooling failed) by starting its reason with this. */
export declare const INFRA_PREFIX = "INFRA:";
/** Apply the benchmark's reference solution inside the environment (the oracle). */
export declare function solveInEnvironment(environment: TaskEnvironment, solutionDir: string, timeoutMs: number): Promise<ExecResult>;
