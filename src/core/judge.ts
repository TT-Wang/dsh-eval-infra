/**
 * Blinded pairwise judge for scenarios whose quality cannot be fully verified
 * by code. The judge never sees arm names, model names or scenario metadata;
 * it sees the rubric and the two artifacts in a random order, is asked twice
 * (A/B then B/A), and an inconsistent pair of answers counts as a tie
 * (Zheng et al. 2023; Shi et al. 2024). Judgments are stored with the run and
 * compared with human annotations when those exist.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunLedger, RunPlan } from './types.js'
import { priceUsage, bandAt } from './pricing.js'
import { mean, mcnemar } from './stats.js'

export interface JudgeSpec {
  /** What "better" means for this scenario, in plain language. */
  rubric: string
  /** Workspace files captured at the end of each trial and shown to the judge. */
  artifacts: string[]
  /** Optional cap per artifact in characters (default 12000). */
  maxChars?: number
}

export interface JudgeConfig {
  model: string
  baseUrl?: string
  apiKey: string
  /** Random seed for the presentation order. */
  seed?: number
  temperature?: number
}

export interface Judgment {
  scenario: string
  rep: number
  /** Panel preference: majority of decided votes when it is a strict majority of the panel; otherwise 'tie'. */
  preference: 'candidate' | 'baseline' | 'tie'
  /** One vote per judge model, each already order-swapped (inconsistent orders → tie). */
  votes: Array<{ model: string; preference: 'candidate' | 'baseline' | 'tie'; answers: [string, string]; reasons: [string, string]; usd: number }>
  /** The two raw answers as seen by the judge ('first' | 'second' | 'tie'), for the two presentation orders. */
  answers: [string, string]
  /** Which artifact was shown first in the first call ('baseline' | 'candidate'). */
  firstShown: 'baseline' | 'candidate'
  reasons: [string, string]
  usd: number
  model: string
  artifactSha: { baseline: string; candidate: string }
  lengths?: { baseline: number; candidate: number }
}

export interface JudgeReport {
  schema: 'dsh-eval-judge/1'
  runId: string
  candidate: string
  baseline: string
  /** Panel models (one entry = single judge). */
  models: string[]
  /** Kept for readers of older reports; the first panel model. */
  model: string
  /** Share of pairs on which every judge agreed (1 for a single judge). */
  panelAgreement: number
  generatedAt: string
  judgments: Judgment[]
  wins: number
  losses: number
  ties: number
  /** Share of pairs where the two presentation orders disagreed (position sensitivity of the judge on this data). */
  inconsistentShare: number
  midP: number
  pWin: number
  usd: number
  /** Agreement with human annotations on the same trials, when any exist. */
  humanAgreement: { n: number; agree: number; kappa: number | null } | null
  /** Share of decided pairs in which the preferred artifact set was the longer one (verbosity bias check; 0.5 ≈ none). */
  longerWinsShare: number | null
  /** Cohen's κ between the first two panel members' votes (error correlation of the panel), when a panel was used. */
  interJudgeKappa: number | null
}

/** Read the captured artifacts of one trial into a single text block (deterministic order). */
export function readArtifacts(dir: string, maxChars: number): { text: string; sha: string } {
  if (!existsSync(dir)) return { text: '(no artifacts captured)', sha: 'none' }
  const parts: string[] = []
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`)
      else if (e.isFile()) {
        const raw = readFileSync(p, 'utf8')
        const body = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…[${raw.length - maxChars} more chars truncated]` : raw
        parts.push(`=== ${prefix}${e.name} (${statSync(p).size} bytes) ===\n${body}`)
      }
    }
  }
  walk(dir, '')
  const text = parts.length ? parts.join('\n\n') : '(no artifacts captured)'
  return { text, sha: createHash('sha256').update(text).digest('hex') }
}

const SYSTEM = 'You are a strict, impartial grader comparing two anonymous submissions to the same task. You see only the rubric and the submissions; you know nothing about who or what produced them. Judge only what is on the page. Reply with a single JSON object.'

function prompt(rubric: string, first: string, second: string): string {
  return `Rubric (what a better submission does):\n${rubric}\n\n### Submission 1\n${first}\n\n### Submission 2\n${second}\n\nWhich submission better satisfies the rubric? Answer with JSON: {"winner": "1" | "2" | "tie", "reason": "<one or two sentences citing concrete evidence>"}. Use "tie" when they are equally good or the difference is not material to the rubric.`
}

export interface ChatCall {
  (messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<{ text: string; usage: { hit: number; miss: number; output: number } }>
}

/** DeepSeek chat completions over HTTPS (OpenAI-compatible); no dsh runtime needed. */
export function deepseekChat(config: JudgeConfig): ChatCall {
  return async (messages) => {
    const res = await fetch(`${(config.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      // Reasoning models spend completion tokens on thinking before the JSON answer; the cap must leave room for both.
      body: JSON.stringify({ model: config.model, messages, temperature: config.temperature ?? 0, max_tokens: 12000, response_format: { type: 'json_object' } }),
    })
    if (!res.ok) throw new Error(`judge request failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    const body = await res.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number } }
    const u = body.usage ?? {}
    const hit = u.prompt_cache_hit_tokens ?? 0
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit)
    const choice = body.choices?.[0]
    const text = choice?.message?.content ?? ''
    if (text.trim() === '') return { text: JSON.stringify({ winner: 'tie', reason: `judge returned no answer (finish_reason ${choice?.finish_reason ?? 'unknown'})` }), usage: { hit, miss, output: u.completion_tokens ?? 0 } }
    return { text, usage: { hit, miss, output: u.completion_tokens ?? 0 } }
  }
}

function parseWinner(text: string): { winner: '1' | '2' | 'tie'; reason: string } {
  try {
    const j = JSON.parse(text) as { winner?: unknown; reason?: unknown }
    const w = String(j.winner ?? 'tie').trim()
    return { winner: w === '1' || w === '2' ? w : 'tie', reason: String(j.reason ?? '').slice(0, 500) }
  } catch {
    const m = /"winner"\s*:\s*"?(1|2|tie)"?/.exec(text)
    return { winner: (m?.[1] as '1' | '2' | 'tie' | undefined) ?? 'tie', reason: text.slice(0, 300) }
  }
}

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function kappa(pairs: Array<[string, string]>): number | null {
  const n = pairs.length
  if (n < 2) return null
  const cats = [...new Set(pairs.flat())]
  const po = pairs.filter(([a, b]) => a === b).length / n
  let pe = 0
  for (const c of cats) pe += (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}

export interface JudgeModel { model: string; chat: ChatCall }

export interface JudgeInput {
  plan: RunPlan
  candidate: string
  ledgers: RunLedger[]
  /** Scenario name → judge spec. */
  specs: Record<string, JudgeSpec>
  /** Artifact directory for a trial. */
  artifactDir: (scenario: string, arm: string, rep: number) => string
  /** The judge panel: one or more models; each is asked in both orders. */
  judges: JudgeModel[]
  seed?: number
  /** Human annotations keyed "scenario|arm|rep" → verdict boolean, for agreement. */
  annotations?: Record<string, { verdict: boolean | null }>
  log?: (line: string) => void
}

export async function judgeRun(input: JudgeInput): Promise<JudgeReport> {
  const rnd = seeded(input.seed ?? 42)
  const judgments: Judgment[] = []
  let usd = 0
  for (const [scenario, spec] of Object.entries(input.specs)) {
    const reps = [...new Set(input.ledgers.filter(l => l.scenario === scenario).map(l => l.rep))].sort((a, b) => a - b)
    for (const rep of reps) {
      const b = input.ledgers.find(l => l.scenario === scenario && l.arm === input.plan.baseline.name && l.rep === rep)
      const c = input.ledgers.find(l => l.scenario === scenario && l.arm === input.candidate && l.rep === rep)
      if (!b || !c) continue
      const maxChars = spec.maxChars ?? 12_000
      const artB = readArtifacts(input.artifactDir(scenario, input.plan.baseline.name, rep), maxChars)
      const artC = readArtifacts(input.artifactDir(scenario, input.candidate, rep), maxChars)
      const firstShown: 'baseline' | 'candidate' = rnd() < 0.5 ? 'baseline' : 'candidate'
      const [x, y] = firstShown === 'baseline' ? [artB.text, artC.text] : [artC.text, artB.text]
      const other: 'baseline' | 'candidate' = firstShown === 'baseline' ? 'candidate' : 'baseline'
      const votes: Judgment['votes'] = []
      for (const judge of input.judges) {
        const r1 = await judge.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(spec.rubric, x, y) }])
        const r2 = await judge.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(spec.rubric, y, x) }])
        const p1 = parseWinner(r1.text)
        const p2 = parseWinner(r2.text)
        let cost = 0
        for (const r of [r1, r2]) cost += priceUsage(judge.model, bandAt(Date.now()), { hit: r.usage.hit, miss: r.usage.miss, output: r.usage.output, reasoning: 0 })
        usd += cost
        // Map answers back to arms: in call 1 "1" = firstShown; in call 2 "1" = the other arm.
        const pick1 = p1.winner === '1' ? firstShown : p1.winner === '2' ? other : 'tie'
        const pick2 = p2.winner === '1' ? other : p2.winner === '2' ? firstShown : 'tie'
        votes.push({ model: judge.model, preference: pick1 === pick2 ? pick1 : 'tie', answers: [p1.winner, p2.winner], reasons: [p1.reason, p2.reason], usd: cost })
      }
      const forC = votes.filter(v => v.preference === 'candidate').length
      const forB = votes.filter(v => v.preference === 'baseline').length
      const half = votes.length / 2
      const preference: Judgment['preference'] = forC > forB && forC > half ? 'candidate' : forB > forC && forB > half ? 'baseline' : 'tie'
      const first = votes[0]!
      judgments.push({ scenario, rep, preference, votes, answers: first.answers, firstShown, reasons: first.reasons, usd: votes.reduce((a, v) => a + v.usd, 0), model: first.model, artifactSha: { baseline: artB.sha, candidate: artC.sha }, lengths: { baseline: artB.text.length, candidate: artC.text.length } })
      input.log?.(`judge ${scenario}#${rep}: ${preference} (${votes.map(v => `${v.model}: ${v.preference}`).join(', ')})`)
    }
  }
  const wins = judgments.filter(j => j.preference === 'candidate').length
  const losses = judgments.filter(j => j.preference === 'baseline').length
  const ties = judgments.length - wins - losses
  const inconsistentVotes = judgments.flatMap(j => j.votes).filter(v => { const a = v.answers[0]; const b = v.answers[1]; return !(a === 'tie' && b === 'tie') && !((a === '1' && b === '2') || (a === '2' && b === '1')) }).length
  const totalVotes = judgments.reduce((a, j) => a + j.votes.length, 0)
  const unanimous = judgments.filter(j => new Set(j.votes.map(v => v.preference)).size <= 1).length
  const m = mcnemar(wins, losses)
  const decided = judgments.filter(j => j.preference !== 'tie' && j.lengths && j.lengths.baseline !== j.lengths.candidate)
  const longerWins = decided.filter(j => (j.preference === 'candidate') === (j.lengths!.candidate > j.lengths!.baseline)).length
  const longerWinsShare = decided.length ? longerWins / decided.length : null
  const interJudgeKappa = input.judges.length >= 2 ? kappa(judgments.map(j => [j.votes[0]!.preference, j.votes[1]!.preference] as [string, string])) : null
  let humanAgreement: JudgeReport['humanAgreement'] = null
  if (input.annotations) {
    const pairs: Array<[string, string]> = []
    for (const j of judgments) {
      const hb = input.annotations[`${j.scenario}|${input.plan.baseline.name}|${j.rep}`]?.verdict
      const hc = input.annotations[`${j.scenario}|${input.candidate}|${j.rep}`]?.verdict
      if (hb === undefined || hc === undefined || hb === null || hc === null) continue
      const human = hc && !hb ? 'candidate' : hb && !hc ? 'baseline' : 'tie'
      pairs.push([j.preference, human])
    }
    if (pairs.length) humanAgreement = { n: pairs.length, agree: pairs.filter(([a, b]) => a === b).length / pairs.length, kappa: kappa(pairs) }
  }
  return {
    schema: 'dsh-eval-judge/1',
    runId: input.plan.id,
    candidate: input.candidate,
    baseline: input.plan.baseline.name,
    models: input.judges.map(j => j.model),
    model: input.judges[0]?.model ?? 'none',
    panelAgreement: judgments.length ? unanimous / judgments.length : 1,
    generatedAt: new Date().toISOString(),
    judgments,
    wins,
    losses,
    ties,
    inconsistentShare: totalVotes ? inconsistentVotes / totalVotes : 0,
    midP: m.midP,
    pWin: m.pWin,
    usd,
    humanAgreement,
    longerWinsShare,
    interJudgeKappa,
  }
}

const ABS_SYSTEM = 'You are a strict, impartial grader. You see a rubric and one anonymous submission; you know nothing about who produced it. Decide whether the submission satisfies the rubric. Reply with a single JSON object.'

function absPrompt(rubric: string, submission: string): string {
  return `Rubric:\n${rubric}\n\n### Submission\n${submission}\n\nDoes the submission satisfy the rubric? Answer with JSON: {"pass": true | false, "score": <0 to 1>, "reason": "<one or two sentences citing concrete evidence>"}.`
}

export interface AbsoluteGrade { scenario: string; arm: string; rep: number; pass: boolean; score: number; reason: string; model: string; usd: number }

/** PPI++ (Angelopoulos, Duchi, Zrnic 2023) estimate of a pass rate from judge grades f on all trials and human labels Y on a labelled subset. */
export function ppiRate(all: number[], labelled: Array<{ f: number; y: number }>): { estimate: number; se: number; lambda: number; n: number; N: number; judgeOnly: number } {
  const N = all.length
  const n = labelled.length
  const judgeOnly = N ? mean(all) : 0
  if (n === 0) return { estimate: judgeOnly, se: N ? Math.sqrt(judgeOnly * (1 - judgeOnly) / Math.max(1, N)) : 0, lambda: 1, n, N, judgeOnly }
  const y = labelled.map(l => l.y)
  const fl = labelled.map(l => l.f)
  const my = mean(y)
  const mf = mean(fl)
  const cov = n > 1 ? labelled.reduce((a, l) => a + (l.y - my) * (l.f - mf), 0) / (n - 1) : 0
  const varF = N > 1 ? all.reduce((a, v) => a + (v - judgeOnly) ** 2, 0) / (N - 1) : 0
  const lambdaRaw = varF > 0 ? cov / ((1 + n / N) * varF) : 0
  const lambda = Math.max(0, Math.min(1, lambdaRaw))
  const estimate = my + lambda * (judgeOnly - mf)
  const resid = labelled.map(l => l.y - lambda * l.f)
  const mr = mean(resid)
  const varResid = n > 1 ? resid.reduce((a, r) => a + (r - mr) ** 2, 0) / (n - 1) : 0
  const se = Math.sqrt(varResid / n + (lambda * lambda * varF) / Math.max(1, N))
  return { estimate: Math.max(0, Math.min(1, estimate)), se, lambda, n, N, judgeOnly }
}

export interface AbsoluteReport {
  schema: 'dsh-eval-judge-absolute/1'
  runId: string
  models: string[]
  generatedAt: string
  grades: AbsoluteGrade[]
  /** Per arm: judge-only pass rate, PPI++ estimate with SE using human annotations as labels, and how many labels were used. */
  arms: Record<string, { estimate: number; se: number; lambda: number; n: number; N: number; judgeOnly: number }>
  /** Judge vs human labels over all labelled trials: true-positive and true-negative rates, reported separately because agreement alone misleads. */
  calibration: { labelled: number; tpr: number | null; tnr: number | null } 
  usd: number
}

export interface AbsoluteInput {
  plan: RunPlan
  ledgers: RunLedger[]
  specs: Record<string, JudgeSpec>
  artifactDir: (scenario: string, arm: string, rep: number) => string
  judges: JudgeModel[]
  annotations?: Record<string, { verdict: boolean | null }>
  log?: (line: string) => void
}

/** Grade every trial of every judged scenario on its own (no pairing), then rectify per-arm pass rates with human labels via PPI++. */
export async function absoluteJudge(input: AbsoluteInput): Promise<AbsoluteReport> {
  const grades: AbsoluteGrade[] = []
  let usd = 0
  const arms = [input.plan.baseline.name, ...input.plan.candidates.map(c => c.name)]
  for (const [scenario, spec] of Object.entries(input.specs)) {
    for (const l of input.ledgers.filter(x => x.scenario === scenario)) {
      const art = readArtifacts(input.artifactDir(scenario, l.arm, l.rep), spec.maxChars ?? 12_000)
      const votes: Array<{ pass: boolean; score: number; reason: string }> = []
      for (const judge of input.judges) {
        const r = await judge.chat([{ role: 'system', content: ABS_SYSTEM }, { role: 'user', content: absPrompt(spec.rubric, art.text) }])
        usd += priceUsage(judge.model, bandAt(Date.now()), { hit: r.usage.hit, miss: r.usage.miss, output: r.usage.output, reasoning: 0 })
        let parsed: { pass?: unknown; score?: unknown; reason?: unknown } = {}
        try { parsed = JSON.parse(r.text) as typeof parsed } catch { /* keep defaults */ }
        votes.push({ pass: parsed.pass === true, score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : parsed.pass === true ? 1 : 0, reason: String(parsed.reason ?? '').slice(0, 400) })
      }
      const passVotes = votes.filter(v => v.pass).length
      grades.push({ scenario, arm: l.arm, rep: l.rep, pass: passVotes > votes.length / 2, score: mean(votes.map(v => v.score)), reason: votes[0]?.reason ?? '', model: input.judges.map(j => j.model).join('+'), usd: 0 })
      input.log?.(`grade ${scenario}/${l.arm}#${l.rep}: ${passVotes > votes.length / 2 ? 'pass' : 'fail'} (${passVotes}/${votes.length} judges)`)
    }
  }
  const perArm: AbsoluteReport['arms'] = {}
  let tp = 0, fn = 0, tn = 0, fp = 0
  for (const arm of arms) {
    const rows = grades.filter(g => g.arm === arm)
    const all = rows.map(g => (g.pass ? 1 : 0))
    const labelled = rows.flatMap((g) => { const v = input.annotations?.[`${g.scenario}|${arm}|${g.rep}`]?.verdict; return v === true || v === false ? [{ f: g.pass ? 1 : 0, y: v ? 1 : 0 }] : [] })
    for (const l of labelled) { if (l.y === 1) { if (l.f === 1) tp += 1; else fn += 1 } else if (l.f === 0) tn += 1; else fp += 1 }
    perArm[arm] = ppiRate(all, labelled)
  }
  const calibration = { labelled: tp + fn + tn + fp, tpr: tp + fn > 0 ? tp / (tp + fn) : null, tnr: tn + fp > 0 ? tn / (tn + fp) : null }
  return { schema: 'dsh-eval-judge-absolute/1', runId: input.plan.id, models: input.judges.map(j => j.model), generatedAt: new Date().toISOString(), grades, arms: perArm, calibration, usd }
}

export { mean as _mean }
