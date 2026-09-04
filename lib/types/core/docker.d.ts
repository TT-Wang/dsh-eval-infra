import type { DriverFactory, DriverInput } from './runner.js';
export interface DockerOptions {
    image?: string;
    /** dsh source checkout on the host (resolved like the CLI does). */
    dshSource: string;
    /** Extra `docker run` arguments (e.g. `--memory 2g`). */
    extraArgs?: string[];
    /** Container runtime (`--runtime`): e.g. `runsc` (gVisor) or `kata` for microVM isolation when the host provides it. */
    runtime?: string;
    /** Image platform, defaulting to this machine's architecture (`arm64` or `amd64`). */
    platform?: string;
    /** Keep dsh's in-process sandbox rows on inside the container (needs a kernel with Landlock or user namespaces + bubblewrap). */
    keepDshSandbox?: boolean;
    /** Extra host paths to mount read-only at the same path (plugins linked into the profile are discovered automatically). */
    mounts?: string[];
    /** Linux native-module shims from `prepareNativeShims`: [hostDir, containerTarget] pairs mounted over the checkout. */
    nativeShims?: Array<[string, string]>;
    onStderr?: (line: string) => void;
}
export declare const DEFAULT_IMAGE = "node:22-bookworm-slim";
/** Host directories the eval profile links (pnpm `link:` symlinks) — they must exist inside the container at the same path. */
export declare function linkedPluginPaths(evalHome: string, profile: string): string[];
/**
 * dsh depends on Koffi (FFI) whose native binary comes from a per-platform
 * package; the host checkout only carries the host's. For the container we
 * fetch the Linux package of the same version once per eval home (npm pack)
 * and bind-mount it over the checkout's `@koromix` directory, shadowing the
 * macOS build. Returns the mount pairs, or [] when the checkout has no Koffi.
 */
export declare function prepareNativeShims(evalHome: string, dshSource: string, arch?: 'arm64' | 'x64', log?: (line: string) => void): Array<[string, string]>;
export declare function dockerArgs(input: DriverInput, options: DockerOptions, runDir: string): string[];
/** Docker-backed driver: one container per trial. */
export declare function dockerDriverFactory(options: DockerOptions, runDir: string): DriverFactory;
/** Overlay rows that make a profile run inside a container: the in-process sandbox off, the plain bash executor on. */
/**
 * Image for `keepDshSandbox`: the base image plus bubblewrap, which dsh's in-process
 * sandbox needs inside a container (Landlock is unavailable on stock Docker kernels).
 * Built once per base image and cached by tag.
 */
export declare function prepareSandboxImage(baseImage: string, log?: (line: string) => void): Promise<string>;
/** Container rows when dsh's own sandbox is kept on inside the container (defence in depth): only the native image module is off. */
export declare const CONTAINER_OVERLAY_ROWS_KEEP_SANDBOX: {
    id: string;
    disabled: boolean;
}[];
export declare const CONTAINER_OVERLAY_ROWS: ({
    id: string;
    disabled: boolean;
    insert?: never;
} | {
    insert: {
        id: string;
        name: string;
        config: {
            timeoutMs: number;
        };
    }[];
    id?: never;
    disabled?: never;
})[];
/** Whether the docker CLI and daemon are reachable. */
export declare function dockerAvailable(): Promise<{
    ok: boolean;
    detail: string;
}>;
