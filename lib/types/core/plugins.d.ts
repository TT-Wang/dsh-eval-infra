export interface DiscoveredPlugin {
    /** Package name, the value an arm row's `name` takes. */
    name: string;
    version?: string;
    description?: string;
    /** Absolute path of the package directory. */
    path: string;
    /** Where it was found. */
    source: 'profile' | 'local' | 'global';
    /** Already a dependency of the eval profile, so it can be inserted without installing. */
    installed: boolean;
    /** Declares `dsh.bundle`: a profile layer, not a single row. */
    bundle: boolean;
    /** Declares `dsh.client`: ships a browser half too. */
    client: boolean;
    /** Suggested row id for an insert patch. */
    rowId: string;
}
/** Row id conventionally derived from a package name: the last segment without the dsh- prefix. */
export declare function rowIdFor(name: string): string;
export interface DiscoverOptions {
    /** Extra roots to scan for local checkouts (defaults to ~/code and ~/src). */
    roots?: string[];
    /** The eval home whose profile dependencies count as installed. */
    evalHome?: string;
    profile?: string;
    /** Global npm root; defaults to the usual prefix locations. */
    globalRoot?: string;
}
export declare function discoverPlugins(options?: DiscoverOptions): DiscoveredPlugin[];
