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
/**
 * Interval for a mean over few units: Student-t for n < 10 (a percentile
 * bootstrap of three or four values has almost no distinct resamples and
 * understates the width), percentile bootstrap otherwise. Both are read at the
 * same alpha so multiplicity adjustment applies uniformly.
 */
export function smallSampleCI(values, b = 2000, seed = 42, alpha = 0.05) {
    const n = values.length;
    if (n === 0)
        return { mean: 0, lo: 0, hi: 0, n: 0, significant: false };
    if (n === 1)
        return { mean: values[0], lo: values[0], hi: values[0], n, significant: false };
    if (n >= 10)
        return bootstrapMean(values, b, seed, alpha);
    const m = mean(values);
    const s = stddev(values);
    // t quantile for the requested alpha: table for 0.05; Bonferroni-adjusted alphas use a normal-ratio scaling of the 0.05 quantile.
    const t05 = tCritical(n - 1);
    const z05 = 1.96;
    const zAlpha = alpha >= 0.05 ? z05 : normalQuantile(1 - alpha / 2);
    const t = t05 * (zAlpha / z05);
    const half = t * s / Math.sqrt(n);
    return { mean: m, lo: m - half, hi: m + half, n, significant: m - half > 0 || m + half < 0 };
}
/** Inverse normal CDF (Acklam's rational approximation), good to ~1e-9. */
export function normalQuantile(p) {
    if (p <= 0)
        return -Infinity;
    if (p >= 1)
        return Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const plow = 0.02425;
    if (p < plow) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - plow) {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
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
/**
 * Intraclass correlation of repeat values within scenarios (one-way ANOVA
 * estimator) and the design effect 1 + (k − 1)ρ that inflates the variance of
 * a mean over n·k correlated trials relative to n·k independent ones.
 */
export function icc(groups) {
    const valid = groups.filter(g => g.length > 0);
    const n = valid.length;
    const k = n ? valid.reduce((a, g) => a + g.length, 0) / n : 0;
    if (n < 2 || k <= 1)
        return { rho: 0, designEffect: 1, k };
    const grand = mean(valid.flat());
    const msb = valid.reduce((a, g) => a + g.length * (mean(g) - grand) ** 2, 0) / (n - 1);
    const dfw = valid.reduce((a, g) => a + g.length, 0) - n;
    const msw = dfw > 0 ? valid.reduce((a, g) => a + g.reduce((x, v) => x + (v - mean(g)) ** 2, 0), 0) / dfw : 0;
    const rho = msb + (k - 1) * msw > 0 ? Math.max(0, Math.min(1, (msb - msw) / (msb + (k - 1) * msw))) : 0;
    return { rho, designEffect: 1 + (k - 1) * rho, k };
}
/**
 * McNemar on discordant pairs: b = candidate passed where baseline failed,
 * c = baseline passed where candidate failed. Returns the exact two-sided p,
 * the mid-p (recommended by Fagerland et al. 2013), the posterior probability
 * that the candidate wins a discordant pair (Beta(b+1, c+1)), and the share of
 * that posterior inside a region of practical equivalence around 1/2.
 */
export function mcnemar(b, c, ropeHalfWidth = 0.1) {
    const n = b + c;
    if (n === 0)
        return { b, c, exactP: 1, midP: 1, pWin: 0.5, inRope: 1 };
    const pmf = (i) => binom(n, i) / 2 ** n;
    const kmin = Math.min(b, c);
    let tail = 0;
    for (let i = 0; i <= kmin; i += 1)
        tail += pmf(i);
    const exactP = Math.min(1, 2 * tail);
    const midP = Math.max(0, Math.min(1, exactP - pmf(kmin)));
    // Beta(b+1, c+1) posterior of π = P(candidate wins a discordant pair); numeric integration on a fine grid.
    const a = b + 1;
    const bb = c + 1;
    const steps = 2000;
    let mass = 0;
    let above = 0;
    let rope = 0;
    for (let i = 0; i < steps; i += 1) {
        const x = (i + 0.5) / steps;
        const w = Math.exp((a - 1) * Math.log(x) + (bb - 1) * Math.log(1 - x));
        mass += w;
        if (x > 0.5)
            above += w;
        if (Math.abs(x - 0.5) < ropeHalfWidth)
            rope += w;
    }
    return { b, c, exactP, midP, pWin: above / mass, inRope: rope / mass };
}
/**
 * Resolution of a paired comparison: N* is the number of scenarios at which a
 * paired t-test would reach 80% power at α = 0.05 for the observed mean
 * difference and spread; q = n / N*. q ≥ 1 means the design could resolve
 * an effect of the observed size; q ≪ 1 means "inconclusive" is about the
 * design, not the effect.
 */
export function resolution(values) {
    const n = values.length;
    if (n < 2)
        return { nStar: null, q: null };
    const d = Math.abs(mean(values));
    const s = stddev(values);
    if (d === 0 || s === 0)
        return { nStar: null, q: null };
    const nStar = Math.ceil(((1.96 + 0.84) * s / d) ** 2);
    return { nStar, q: n / nStar };
}
/** Normalized Levenshtein similarity of two sequences (1 = identical). */
export function sequenceSimilarity(a, b) {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0)
        return 1;
    const prev = new Array(m + 1);
    const cur = new Array(m + 1);
    for (let j = 0; j <= m; j += 1)
        prev[j] = j;
    for (let i = 1; i <= n; i += 1) {
        cur[0] = i;
        for (let j = 1; j <= m; j += 1)
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        for (let j = 0; j <= m; j += 1)
            prev[j] = cur[j];
    }
    return 1 - prev[m] / Math.max(n, m);
}
/**
 * Asymptotic confidence sequence (Waudby-Smith, Arbour, Sinha, Kennedy, Ramdas
 * 2021, Theorem 2.2) for the running mean of a sequence: valid uniformly over
 * time, so a run may be stopped the moment 0 leaves the interval without
 * inflating the error rate. ρ tunes where the sequence is tightest; the
 * paper's choice for a planned first look at m units is used.
 */
export function asympCS(values, alpha = 0.05, plannedN = 10) {
    const t = values.length;
    const mu = mean(values);
    if (t < 2)
        return { mean: mu, lo: -Infinity, hi: Infinity, t };
    const sd = Math.max(stddev(values), 1e-9);
    const m = Math.max(2, plannedN);
    const rho = Math.sqrt((-2 * Math.log(alpha) + Math.log(-2 * Math.log(alpha)) + 1) / (m * Math.log(Math.max(m, Math.E))));
    const width = sd * Math.sqrt((2 * (t * rho * rho + 1) / (t * t * rho * rho)) * Math.log(Math.sqrt(t * rho * rho + 1) / alpha));
    return { mean: mu, lo: mu - width, hi: mu + width, t };
}
/**
 * Betting confidence sequence for the mean of [0, 1] outcomes (Waudby-Smith &
 * Ramdas 2020, predictable-plug-in bets). Used on x = (d + 1) / 2 where d is
 * the per-scenario pass-rate difference in [−1, 1]; the null "no difference"
 * is the point 1/2. Returns the set of means not rejected, on a grid.
 */
export function bettingCS(xs, alpha = 0.05) {
    // Hedged capital process (Waudby-Smith & Ramdas 2020, "betting" CS): for each
    // candidate mean m, two capital processes bet that the truth is above (K+) and
    // below (K−) m with a predictable plug-in bet from the running variance,
    // truncated at c/m and c/(1−m) so wealth stays positive; m is rejected once
    // max(K+, K−) ≥ 1/α. Non-asymptotic: valid at every t and under early stopping.
    const t = xs.length;
    if (t === 0)
        return { lo: 0, hi: 1, t };
    const grid = 400;
    const c = 0.9;
    let lo = 1;
    let hi = 0;
    for (let g = 0; g <= grid; g += 1) {
        const m = g / grid;
        let plus = 1;
        let minus = 1;
        let sumX = 0;
        let sumSq = 0;
        let rejected = false;
        for (let i = 0; i < t; i += 1) {
            const n = i;
            const mu = n ? (0.5 + sumX) / (n + 1) : 0.5;
            const varHat = n ? Math.max((0.25 + sumSq) / (n + 1) - mu * mu, 1e-4) : 0.25;
            const lam = Math.sqrt(2 * Math.log(2 / alpha) / (varHat * (n + 1) * Math.log(n + 2)));
            const lamPlus = Math.min(lam, c / Math.max(m, 1e-9));
            const lamMinus = Math.min(lam, c / Math.max(1 - m, 1e-9));
            const x = xs[i];
            plus *= 1 + lamPlus * (x - m);
            minus *= 1 - lamMinus * (x - m);
            sumX += x;
            sumSq += x * x;
            if (Math.max(plus, minus) >= 1 / alpha) {
                rejected = true;
                break;
            }
        }
        if (!rejected) {
            lo = Math.min(lo, m);
            hi = Math.max(hi, m);
        }
    }
    if (lo > hi)
        return { lo: 0.5, hi: 0.5, t };
    return { lo, hi, t };
}
