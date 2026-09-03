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
  /** Preference after both orders: 'candidate', 'baseline', or 'tie' (including inconsistent answers). */
  preference: 'candidate' | 'baseline' | 'tie'
  /** The two raw answers as seen by the judge ('first' | 'second' | 'tie'), for the two presentation orders. */
  answers: [string, string]
  /** Which artifact was shown first in the first call ('baseline' | 'candidate'). */
  firstShown: 'baseline' | 'candidate'
  reasons: [string, string]
  usd: number
  model: string
  artifactSha: { baseline: string; candidate: string }
}

export interface JudgeReport {
  schema: 'dsh-eval-judge/1'
  runId: string
  candidate: string
  baseline: string
  model: string
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

export interface JudgeInput {
  plan: RunPlan
  candidate: string
  ledgers: RunLedger[]
  /** Scenario name → judge spec. */
  specs: Record<string, JudgeSpec>
  /** Artifact directory for a trial. */
  artifactDir: (scenario: string, arm: string, rep: number) => string
  chat: ChatCall
  model: string
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
      const r1 = await input.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(spec.rubric, x, y) }])
      const r2 = await input.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(spec.rubric, y, x) }])
      const p1 = parseWinner(r1.text)
      const p2 = parseWinner(r2.text)
      for (const r of [r1, r2]) usd += priceUsage(input.model, bandAt(Date.now()), { hit: r.usage.hit, miss: r.usage.miss, output: r.usage.output, reasoning: 0 })
      // Map answers back to arms: in call 1 "1" = firstShown; in call 2 "1" = the other arm.
      const other: 'baseline' | 'candidate' = firstShown === 'baseline' ? 'candidate' : 'baseline'
      const pick1 = p1.winner === '1' ? firstShown : p1.winner === '2' ? other : 'tie'
      const pick2 = p2.winner === '1' ? other : p2.winner === '2' ? firstShown : 'tie'
      const preference: Judgment['preference'] = pick1 === pick2 ? pick1 : 'tie'
      judgments.push({ scenario, rep, preference, answers: [p1.winner, p2.winner], firstShown, reasons: [p1.reason, p2.reason], usd: 0, model: input.model, artifactSha: { baseline: artB.sha, candidate: artC.sha } })
      input.log?.(`judge ${scenario}#${rep}: ${preference}${pick1 !== pick2 ? ' (orders disagreed → tie)' : ''}`)
    }
  }
  const wins = judgments.filter(j => j.preference === 'candidate').length
  const losses = judgments.filter(j => j.preference === 'baseline').length
  const ties = judgments.length - wins - losses
  const inconsistent = judgments.filter(j => { const a = j.answers[0]; const b = j.answers[1]; return !(a === 'tie' && b === 'tie') && !((a === '1' && b === '2') || (a === '2' && b === '1')) }).length
  const m = mcnemar(wins, losses)
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
    model: input.model,
    generatedAt: new Date().toISOString(),
    judgments,
    wins,
    losses,
    ties,
    inconsistentShare: judgments.length ? inconsistent / judgments.length : 0,
    midP: m.midP,
    pWin: m.pWin,
    usd,
    humanAgreement,
  }
}

export { mean as _mean }
