/** Parse a dotenv-style file into a map (quotes stripped, `export` allowed). */
export declare function parseDotenv(text: string): Record<string, string>;
/** The user's real dsh home (credentials live there); eval runs use a separate home. */
export declare function userDshHome(): string;
/**
 * Resolve the DeepSeek API key: process env first, then `$DSH_HOME/.env`, then `~/.dsh/.env`.
 * Returns undefined when none is found; callers decide whether that is fatal.
 */
export declare function resolveApiKey(env?: NodeJS.ProcessEnv): string | undefined;
/** `dsh --version` output, or null when the CLI is unavailable. */
export declare function dshVersion(bin?: string): Promise<string | null>;
/**
 * The dsh source checkout the local install points at, when discoverable.
 * By default the real path; `{ realpath: false }` returns the path as configured
 * (usually the `~/.dsh/source/current` link), which plugins' dependency links go
 * through and which container mounts therefore need.
 */
export declare function dshSourceRoot(options?: {
    realpath?: boolean;
}): string | null;
/** Git revision of the dsh source checkout, when it is a git worktree. */
export declare function dshSourceRevision(root: string | null): Promise<string | null>;
export declare function evalInfraVersion(): string;
