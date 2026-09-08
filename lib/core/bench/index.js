import { terminalBench } from './terminal-bench.js';
import { swebenchVerified } from './swebench.js';
export { defaultFetch } from './types.js';
export const ADAPTERS = { [terminalBench.id]: terminalBench, [swebenchVerified.id]: swebenchVerified };
export function adapterFor(id) {
    const a = ADAPTERS[id];
    if (a === undefined)
        throw new Error(`unknown benchmark "${id}"; available: ${Object.keys(ADAPTERS).join(', ')}`);
    return a;
}
