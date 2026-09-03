/**
 * Paired statistics for A/B runs. Small-sample honest: repeats pair by index
 * (baseline rep i ↔ candidate rep i, launched back to back), scenarios are the
 * resampling unit of the bootstrap, and "no difference" is the default verdict
 * whenever the interval covers zero.
 */
export function mean(xs) {
    return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
export function median(xs) {
    if (xs.length === 0)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(xs, q) {
    if (xs.length === 0)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
/** Deterministic PRNG (mulberry32) so reports are reproducible. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * Percentile bootstrap of the mean of `values` (one value per scenario, e.g. the
 * per-scenario paired cost difference). B resamples with replacement.
 */
export function bootstrapMean(values, b = 2000, seed = 42, alpha = 0.05) {
    const n = values.length;
    if (n === 0)
        return { mean: 0, lo: 0, hi: 0, n: 0, significant: false };
    if (n === 1)
        return { mean: values[0], lo: values[0], hi: values[0], n, significant: false };
    const r = rng(seed);
    const means = new Array(b);
    for (let i = 0; i < b; i += 1) {
        let s = 0;
        for (let j = 0; j < n; j += 1)
            s += values[Math.floor(r() * n)];
        means[i] = s / n;
    }
    const lo = quantile(means, alpha / 2);
    const hi = quantile(means, 1 - alpha / 2);
    return { mean: mean(values), lo, hi, n, significant: lo > 0 || hi < 0 };
}
/**
 * Hierarchical percentile bootstrap: resample scenarios with replacement, then
 * within each chosen scenario resample its repeat-pair values with replacement,
 * and take the mean of per-scenario means. Captures both between-scenario and
 * within-scenario (repeat) variability; with one value per scenario it reduces
 * to the scenario bootstrap.
 */
export function bootstrapHierarchical(groups, b = 2000, seed = 42, alpha = 0.05) {
    const valid = groups.filter(g => g.length > 0);
    const n = valid.length;
    const point = mean(valid.map(g => mean(g)));
    if (n === 0)
        return { mean: 0, lo: 0, hi: 0, n: 0, significant: false };
    if (n === 1 && valid[0].length === 1)
        return { mean: point, lo: point, hi: point, n, significant: false };
    const r = rng(seed);
    const means = new Array(b);
    for (let i = 0; i < b; i += 1) {
        let s = 0;
        for (let j = 0; j < n; j += 1) {
            const g = valid[Math.floor(r() * n)];
            let inner = 0;
            for (let k = 0; k < g.length; k += 1)
                inner += g[Math.floor(r() * g.length)];
            s += inner / g.length;
        }
        means[i] = s / n;
    }
    const lo = quantile(means, alpha / 2);
    const hi = quantile(means, 1 - alpha / 2);
    return { mean: point, lo, hi, n, significant: lo > 0 || hi < 0 };
}
/** Exact two-sided sign test p-value over discordant pairs (wins vs losses). */
export function signTest(wins, losses) {
    const n = wins + losses;
    if (n === 0)
        return 1;
    const k = Math.min(wins, losses);
    let p = 0;
    for (let i = 0; i <= k; i += 1)
        p += binom(n, i);
    p = Math.min(1, 2 * p / 2 ** n);
    return p;
}
function binom(n, k) {
    let r = 1;
    for (let i = 1; i <= k; i += 1)
        r = r * (n - k + i) / i;
    return r;
}
/** Wilson score interval for a pass rate. */
export function wilson(passes, n, z = 1.96) {
    if (n === 0)
        return { lo: 0, hi: 0 };
    const p = passes / n;
    const denom = 1 + z * z / n;
    const centre = (p + z * z / (2 * n)) / denom;
    const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
    return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
export function stddev(xs) {
    if (xs.length < 2)
        return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
/** Two-sided 97.5% Student t quantile for small degrees of freedom (table up to 30, then normal). */
export function tCritical(df) {
    const table = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 25: 2.060, 30: 2.042 };
    if (df <= 0)
        return 12.706;
    if (table[df] !== undefined)
        return table[df];
    if (df < 25)
        return table[20];
    if (df < 30)
        return table[25];
    return 1.96;
}
