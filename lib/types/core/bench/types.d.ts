import type { Project } from '../project.js';
export interface BenchTask {
    id: string;
    title: string;
    category?: string;
    difficulty?: string;
    tags: string[];
    /** Prebuilt image the task runs in, and what is known about it. */
    image: string;
    platforms?: Array<'amd64' | 'arm64'>;
    imageMb?: number;
    cpus?: number;
    memoryMb?: number;
    agentTimeoutS?: number;
    verifierTimeoutS?: number;
    /** The dataset's own estimate of an expert's time, in minutes. */
    expertMinutes?: number;
    /** Provenance for the receipt. */
    source: {
        gitUrl: string;
        commit: string;
        path: string;
    };
}
export interface BenchIndex {
    dataset: string;
    version: string;
    license: string;
    fetchedAt: string;
    tasks: BenchTask[];
}
export interface Fetcher {
    (url: string): Promise<string>;
}
export interface MaterializeOptions {
    fetcher?: Fetcher;
    log?: (line: string) => void;
    /** Pull the task image (default true); false writes the scenario only. */
    pull?: boolean;
    /** Docker command runner, replaceable in tests; `stdout` carries `docker inspect` answers. */
    docker?: (args: string[]) => Promise<{
        code: number;
        stderr: string;
        stdout?: string;
    }>;
    /** Interpreter for a host-side verifier that needs its own environment (tests pass one so no venv is built). */
    verifierPython?: string;
}
/**
 * The directory of one task inside a pool. A task id is one path segment; anything else (a path, `..`, an
 * absolute name) is refused here so no adapter can be talked into removing or writing outside its pool.
 */
export declare function taskDir(pool: string, id: string): string;
export interface BenchAdapter {
    /** Dataset id used on the command line and as the pool directory name. */
    id: string;
    title: string;
    version: string;
    license: string;
    /** One line the shelf shows under the title: what a task costs to get, what it needs. */
    note: string;
    /** The task index: fetched once and cached in the project; `refresh` refetches. */
    index(project: Project, options?: {
        fetcher?: Fetcher;
        refresh?: boolean;
        log?: (line: string) => void;
    }): Promise<BenchIndex>;
    /** Facts about the task's image from its registry (size, platforms); null when the registry does not answer. */
    describeImage(image: string, fetcher?: Fetcher): Promise<{
        platforms: Array<'amd64' | 'arm64'>;
        sizeMb: number;
    } | null>;
    /** Download the task's files and image and write the scenario directory; returns its path. */
    materialize(project: Project, id: string, options?: MaterializeOptions): Promise<{
        dir: string;
        task: BenchTask;
        taskHash: string;
    }>;
    remove(project: Project, id: string): boolean;
    /** Directory of this dataset's pool inside the project. */
    poolDir(project: Project): string;
}
/** What Docker Hub knows about an image tag: the platforms it is built for and its compressed size. Null when it does not answer. */
export declare function dockerHubImage(image: string, fetcher?: Fetcher): Promise<{
    platforms: Array<'amd64' | 'arm64'>;
    sizeMb: number;
} | null>;
/** Pull an image unless it is already present: a registry that will not answer must not block a task whose image is on the machine. */
export declare function ensureImage(image: string, docker: (args: string[]) => Promise<{
    code: number;
    stderr: string;
    stdout?: string;
}>, log: (line: string) => void, sizeNote?: string): Promise<void>;
/** Plain GET with three attempts: an index is dozens of small files, and one dropped connection must not fail it. */
export declare function defaultFetch(url: string): Promise<string>;
