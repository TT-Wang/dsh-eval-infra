/** Public benchmarks as pools: the adapters this build knows, by dataset id. */
import type { BenchAdapter } from './types.js';
export type { BenchAdapter, BenchIndex, BenchTask, Fetcher, MaterializeOptions } from './types.js';
export { defaultFetch } from './types.js';
export declare const ADAPTERS: Record<string, BenchAdapter>;
export declare function adapterFor(id: string): BenchAdapter;
