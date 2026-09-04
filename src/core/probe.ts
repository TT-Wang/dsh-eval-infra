/**
 * Served-model verification by behaviour, not by declaration.
 *
 * The wire meter records the model id and fingerprint the provider *declares*.
 * A substituted or silently updated model can keep both. This module probes the
 * route the arms actually use: a fixed battery of prompts, each sampled N times
 * at temperature 1, gives a distribution over short answers per probe. An
 * enrolled reference is stored per (model, baseURL); later probes are compared
 * with a permutation test on the mean total-variation distance between the two
 * answer distributions, the cheap variant of AgentProv's MMD permutation test
 * (2609.00052) and of one-token fingerprinting (2607.10252).
 */
import { createHash } from 'node:crypto'
import { rng } from './stats.js'
import type { ChatCall } from './judge.js'

/** Short, low-token prompts whose answer distribution is characteristic of a model build. */
export const PROBES: string[] = [
  'Reply with exactly one word: a colour.',
  'Reply with exactly one word: an animal.',
  'Answer with a single integer between 1 and 100. Digits only.',
  'Name one programming language. One word only.',
  'Reply with exactly one word: a city.',
  'Answer with one word: the opposite of "up".',
  'Pick one: alpha, beta, gamma, delta. One word only.',
  'Answer with a single letter from A to Z.',
]

export interface ProbeSample { probe: number; answer: string }

export interface ProbeReference {
  schema: 'dsh-eval-probe/1'
  model: string
  baseUrl: string
  enrolledAt: string
  samples: ProbeSample[]
  usd: number
}

export interface ProbeVerdict {
  model: string
  distance: number
  p: number
  probes: number
  samplesPerSide: number
  verdict: 'matches' | 'differs' | 'no-reference'
  enrolledAt?: string
  comparedAt: string
  usd: number
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').slice(0, 24)
}

/** Mean over probes of the total-variation distance between the two answer distributions. */
export function probeDistance(a: ProbeSample[], b: ProbeSample[]): number {
  const probes = [...new Set([...a, ...b].map(s => s.probe))].sort((x, y) => x - y)
  let total = 0
  let counted = 0
  for (const p of probes) {
    const xs = a.filter(s => s.probe === p).map(s => s.answer)
    const ys = b.filter(s => s.probe === p).map(s => s.answer)
    if (xs.length === 0 || ys.length === 0) continue
    const keys = new Set([...xs, ...ys])
    let tv = 0
    for (const k of keys) tv += Math.abs(xs.filter(v => v === k).length / xs.length - ys.filter(v => v === k).length / ys.length)
    total += tv / 2
    counted += 1
  }
  return counted ? total / counted : 0
}

/** Permutation test of the probe distance under exchangeability of the two sides within each probe. */
export function probePermutationTest(a: ProbeSample[], b: ProbeSample[], B = 1000, seed = 11): { distance: number; p: number } {
  const observed = probeDistance(a, b)
  const random = rng(seed)
  let atLeast = 0
  const probes = [...new Set([...a, ...b].map(s => s.probe))]
  for (let i = 0; i < B; i += 1) {
    const pa: ProbeSample[] = []
    const pb: ProbeSample[] = []
    for (const p of probes) {
      const pool = [...a.filter(s => s.probe === p), ...b.filter(s => s.probe === p)]
      const nA = a.filter(s => s.probe === p).length
      for (let k = pool.length - 1; k > 0; k -= 1) { const j = Math.floor(random() * (k + 1)); [pool[k], pool[j]] = [pool[j]!, pool[k]!] }
      pa.push(...pool.slice(0, nA))
      pb.push(...pool.slice(nA))
    }
    if (probeDistance(pa, pb) >= observed - 1e-12) atLeast += 1
  }
  return { distance: observed, p: (atLeast + 1) / (B + 1) }
}

/** Send the battery: `samples` answers per probe, at temperature 1 so the distribution is informative. */
export async function collectProbes(chat: ChatCall, samples = 8, log?: (line: string) => void): Promise<{ samples: ProbeSample[]; usd: number }> {
  const out: ProbeSample[] = []
  let usd = 0
  for (let p = 0; p < PROBES.length; p += 1) {
    for (let i = 0; i < samples; i += 1) {
      const r = await chat([{ role: 'user', content: `${PROBES[p]!} Answer with JSON: {"answer": "<your answer>"}` }])
      usd += (r.usage.miss * 0.44 + r.usage.hit * 0.014 + r.usage.output * 1.32) / 1e6
      let answer = ''
      try { answer = String((JSON.parse(r.text) as { answer?: unknown }).answer ?? '') } catch { answer = r.text }
      out.push({ probe: p, answer: normalize(answer) })
    }
    log?.(`probe ${p + 1}/${PROBES.length}: ${out.filter(s => s.probe === p).map(s => s.answer).join(', ')}`)
  }
  return { samples: out, usd }
}

export function referenceKey(model: string, baseUrl: string): string {
  return createHash('sha256').update(`${model}|${baseUrl}`).digest('hex').slice(0, 16)
}

/** Compare fresh probes with an enrolled reference; alpha 0.01 keeps false alarms rare on a check that blocks verdicts. */
export function compareWithReference(fresh: ProbeSample[], reference: ProbeReference | null, model: string, usd: number, alpha = 0.01): ProbeVerdict {
  const comparedAt = new Date().toISOString()
  if (reference === null) return { model, distance: 0, p: 1, probes: PROBES.length, samplesPerSide: 0, verdict: 'no-reference', comparedAt, usd }
  const { distance, p } = probePermutationTest(reference.samples, fresh)
  return { model, distance, p, probes: PROBES.length, samplesPerSide: Math.round(fresh.length / PROBES.length), verdict: p < alpha ? 'differs' : 'matches', enrolledAt: reference.enrolledAt, comparedAt, usd }
}
