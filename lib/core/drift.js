import { rng } from './stats.js';
export function toolFrequency(l) {
    const counts = new Map();
    let n = 0;
    for (const st of l.steps)
        for (const c of st.calls) {
            counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
            n += 1;
        }
    if (n === 0)
        return counts;
    for (const [k, v] of counts)
        counts.set(k, v / n);
    return counts;
}
function meanVector(vs) {
    const out = new Map();
    for (const v of vs)
        for (const [k, x] of v)
            out.set(k, (out.get(k) ?? 0) + x / vs.length);
    return out;
}
function l1(a, b) {
    let d = 0;
    for (const k of new Set([...a.keys(), ...b.keys()]))
        d += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
    return d;
}
/**
 * Current vs archived ledgers of the same arm; both sides need at least two
 * trials on at least one common scenario. Alpha 0.05, B permutations.
 */
export function driftTest(current, archive, seed = 7, B = 500, alpha = 0.05) {
    const byScenario = new Map();
    for (const l of current) {
        const e = byScenario.get(l.scenario) ?? { cur: [], arc: [] };
        e.cur.push(toolFrequency(l));
        byScenario.set(l.scenario, e);
    }
    for (const l of archive) {
        const e = byScenario.get(l.scenario) ?? { cur: [], arc: [] };
        e.arc.push(toolFrequency(l));
        byScenario.set(l.scenario, e);
    }
    const usable = [...byScenario.values()].filter(e => e.cur.length >= 1 && e.arc.length >= 2);
    const curN = usable.reduce((a, e) => a + e.cur.length, 0);
    const arcN = usable.reduce((a, e) => a + e.arc.length, 0);
    if (usable.length === 0 || curN < 2)
        return { scenarios: usable.length, current: curN, archive: arcN, distance: 0, p: 1, verdict: 'insufficient' };
    const stat = (groups) => groups.reduce((a, e) => a + l1(meanVector(e.cur), meanVector(e.arc)), 0) / groups.length;
    const observed = stat(usable);
    const random = rng(seed);
    let atLeast = 0;
    for (let b = 0; b < B; b += 1) {
        const permuted = usable.map((e) => {
            const pool = [...e.cur, ...e.arc];
            for (let i = pool.length - 1; i > 0; i -= 1) {
                const j = Math.floor(random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            return { cur: pool.slice(0, e.cur.length), arc: pool.slice(e.cur.length) };
        });
        if (stat(permuted) >= observed - 1e-12)
            atLeast += 1;
    }
    const p = (atLeast + 1) / (B + 1);
    return { scenarios: usable.length, current: curN, archive: arcN, distance: observed, p, verdict: p < alpha ? 'drift' : 'no-drift' };
}
