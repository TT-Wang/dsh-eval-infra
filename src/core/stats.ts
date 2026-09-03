/**
 * Paired statistics for A/B runs. Small-sample honest: repeats pair by index
 * (baseline rep i ↔ candidate rep i, launched back to back), scenarios are the
 * resampling unit of the bootstrap, and "no difference" is the default verdict
 * whenever the interval covers zero.
 */

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

/** Deterministic PRNG (mulberry32) so reports are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface BootstrapCI {
  mean: number
  lo: number
  hi: number
  n: number
  /** True when the interval excludes zero. */
  significant: boolean
}

/**
 * Percentile bootstrap of the mean of `values` (one value per scenario, e.g. the
 * per-scenario paired cost difference). B resamples with replacement.
 */
export function bootstrapMean(values: number[], b = 2000, seed = 42, alpha = 0.05): BootstrapCI {
  const n = values.length
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n: 0, significant: false }
  if (n === 1) return { mean: values[0]!, lo: values[0]!, hi: values[0]!, n, significant: false }
  const r = rng(seed)
  const means: number[] = new Array(b)
  for (let i = 0; i < b; i += 1) {
    let s = 0
    for (let j = 0; j < n; j += 1) s += values[Math.floor(r() * n)]!
    means[i] = s / n
  }
  const lo = quantile(means, alpha / 2)
  const hi = quantile(means, 1 - alpha / 2)
  return { mean: mean(values), lo, hi, n, significant: lo > 0 || hi < 0 }
}

/**
 * Hierarchical percentile bootstrap: resample scenarios with replacement, then
 * within each chosen scenario resample its repeat-pair values with replacement,
 * and take the mean of per-scenario means. Captures both between-scenario and
 * within-scenario (repeat) variability; with one value per scenario it reduces
 * to the scenario bootstrap.
 */
export function bootstrapHierarchical(groups: number[][], b = 2000, seed = 42, alpha = 0.05): BootstrapCI {
  const valid = groups.filter(g => g.length > 0)
  const n = valid.length
  const point = mean(valid.map(g => mean(g)))
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n: 0, significant: false }
  if (n === 1 && valid[0]!.length === 1) return { mean: point, lo: point, hi: point, n, significant: false }
  const r = rng(seed)
  const means: number[] = new Array(b)
  for (let i = 0; i < b; i += 1) {
    let s = 0
    for (let j = 0; j < n; j += 1) {
      const g = valid[Math.floor(r() * n)]!
      let inner = 0
      for (let k = 0; k < g.length; k += 1) inner += g[Math.floor(r() * g.length)]!
      s += inner / g.length
    }
    means[i] = s / n
  }
  const lo = quantile(means, alpha / 2)
  const hi = quantile(means, 1 - alpha / 2)
  return { mean: point, lo, hi, n, significant: lo > 0 || hi < 0 }
}

/** Exact two-sided sign test p-value over discordant pairs (wins vs losses). */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  const k = Math.min(wins, losses)
  let p = 0
  for (let i = 0; i <= k; i += 1) p += binom(n, i)
  p = Math.min(1, 2 * p / 2 ** n)
  return p
}

function binom(n: number, k: number): number {
  let r = 1
  for (let i = 1; i <= k; i += 1) r = r * (n - k + i) / i
  return r
}

/** Wilson score interval for a pass rate. */
export function wilson(passes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 }
  const p = passes / n
  const denom = 1 + z * z / n
  const centre = (p + z * z / (2 * n)) / denom
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) }
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/** Two-sided 97.5% Student t quantile for small degrees of freedom (table up to 30, then normal). */
export function tCritical(df: number): number {
  const table: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 25: 2.060, 30: 2.042 }
  if (df <= 0) return 12.706
  if (table[df] !== undefined) return table[df]!
  if (df < 25) return table[20]!
  if (df < 30) return table[25]!
  return 1.96
}

/**
 * Intraclass correlation of repeat values within scenarios (one-way ANOVA
 * estimator) and the design effect 1 + (k − 1)ρ that inflates the variance of
 * a mean over n·k correlated trials relative to n·k independent ones.
 */
export function icc(groups: number[][]): { rho: number; designEffect: number; k: number } {
  const valid = groups.filter(g => g.length > 0)
  const n = valid.length
  const k = n ? valid.reduce((a, g) => a + g.length, 0) / n : 0
  if (n < 2 || k <= 1) return { rho: 0, designEffect: 1, k }
  const grand = mean(valid.flat())
  const msb = valid.reduce((a, g) => a + g.length * (mean(g) - grand) ** 2, 0) / (n - 1)
  const dfw = valid.reduce((a, g) => a + g.length, 0) - n
  const msw = dfw > 0 ? valid.reduce((a, g) => a + g.reduce((x, v) => x + (v - mean(g)) ** 2, 0), 0) / dfw : 0
  const rho = msb + (k - 1) * msw > 0 ? Math.max(0, Math.min(1, (msb - msw) / (msb + (k - 1) * msw))) : 0
  return { rho, designEffect: 1 + (k - 1) * rho, k }
}

/**
 * McNemar on discordant pairs: b = candidate passed where baseline failed,
 * c = baseline passed where candidate failed. Returns the exact two-sided p,
 * the mid-p (recommended by Fagerland et al. 2013), the posterior probability
 * that the candidate wins a discordant pair (Beta(b+1, c+1)), and the share of
 * that posterior inside a region of practical equivalence around 1/2.
 */
export function mcnemar(b: number, c: number, ropeHalfWidth = 0.1): { b: number; c: number; exactP: number; midP: number; pWin: number; inRope: number } {
  const n = b + c
  if (n === 0) return { b, c, exactP: 1, midP: 1, pWin: 0.5, inRope: 1 }
  const pmf = (i: number): number => binom(n, i) / 2 ** n
  const kmin = Math.min(b, c)
  let tail = 0
  for (let i = 0; i <= kmin; i += 1) tail += pmf(i)
  const exactP = Math.min(1, 2 * tail)
  const midP = Math.max(0, Math.min(1, exactP - pmf(kmin)))
  // Beta(b+1, c+1) posterior of π = P(candidate wins a discordant pair); numeric integration on a fine grid.
  const a = b + 1
  const bb = c + 1
  const steps = 2000
  let mass = 0
  let above = 0
  let rope = 0
  for (let i = 0; i < steps; i += 1) {
    const x = (i + 0.5) / steps
    const w = Math.exp((a - 1) * Math.log(x) + (bb - 1) * Math.log(1 - x))
    mass += w
    if (x > 0.5) above += w
    if (Math.abs(x - 0.5) < ropeHalfWidth) rope += w
  }
  return { b, c, exactP, midP, pWin: above / mass, inRope: rope / mass }
}

/**
 * Resolution of a paired comparison: N* is the number of scenarios at which a
 * paired t-test would reach 80% power at α = 0.05 for the observed mean
 * difference and spread; q = n / N*. q ≥ 1 means the design could resolve
 * an effect of the observed size; q ≪ 1 means "inconclusive" is about the
 * design, not the effect.
 */
export function resolution(values: number[]): { nStar: number | null; q: number | null } {
  const n = values.length
  if (n < 2) return { nStar: null, q: null }
  const d = Math.abs(mean(values))
  const s = stddev(values)
  if (d === 0 || s === 0) return { nStar: null, q: null }
  const nStar = Math.ceil(((1.96 + 0.84) * s / d) ** 2)
  return { nStar, q: n / nStar }
}

/** Normalized Levenshtein similarity of two sequences (1 = identical). */
export function sequenceSimilarity(a: string[], b: string[]): number {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return 1
  const prev = new Array<number>(m + 1)
  const cur = new Array<number>(m + 1)
  for (let j = 0; j <= m; j += 1) prev[j] = j
  for (let i = 1; i <= n; i += 1) {
    cur[0] = i
    for (let j = 1; j <= m; j += 1) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    for (let j = 0; j <= m; j += 1) prev[j] = cur[j]!
  }
  return 1 - prev[m]! / Math.max(n, m)
}
