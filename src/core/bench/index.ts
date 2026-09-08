/** Public benchmarks as pools: the adapters this build knows, by dataset id. */
import type { BenchAdapter } from './types.js'
import { terminalBench } from './terminal-bench.js'
import { swebenchVerified } from './swebench.js'

export type { BenchAdapter, BenchIndex, BenchTask, Fetcher, MaterializeOptions } from './types.js'
export { defaultFetch } from './types.js'

export const ADAPTERS: Record<string, BenchAdapter> = { [terminalBench.id]: terminalBench, [swebenchVerified.id]: swebenchVerified }

export function adapterFor(id: string): BenchAdapter {
  const a = ADAPTERS[id]
  if (a === undefined) throw new Error(`unknown benchmark "${id}"; available: ${Object.keys(ADAPTERS).join(', ')}`)
  return a
}
