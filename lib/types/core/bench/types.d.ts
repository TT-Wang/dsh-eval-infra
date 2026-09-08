/**
 * The contract a public-benchmark adapter fulfils: a dataset's task index,
 * what each task needs (image, size, platform), and how one task becomes a
 * scenario directory — nothing is downloaded until a task is picked.
 */
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
    /** Docker command runner, replaceable in tests. */
    docker?: (args: string[]) => Promise<{
        code: number;
        stderr: string;
    }>;
}
export interface BenchAdapter {
    /** Dataset id used on the command line and as the pool directory name. */
    id: string;
    title: string;
    version: string;
    license: string;
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
/** Plain GET with three attempts: an index is dozens of small files, and one dropped connection must not fail it. */
export declare function defaultFetch(url: string): Promise<string>;
