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

/**
 * Short prompts whose *answer distribution* is characteristic of a model build.
 * Deterministic questions carry no signal, so every probe here is one where a
 * model has to choose among many equally valid answers; that free choice is
 * what differs between builds.
 */
export const PROBES: string[] = [
  'Reply with exactly one word: a colour.',
  'Reply with exactly one word: an animal.',
  'Answer with a single integer between 1 and 100. Digits only.',
  'Reply with exactly one word: a city.',
  'Reply with exactly one word: a fruit.',
  'Reply with one common English first name. One word only.',
  'Answer with a single integer between 1 and 10. Digits only.',
  'Reply with exactly one word: a musical instrument.',
  'Name one open-source library. One word only.',
  'Reply with exactly one word: any noun that comes to mind.',
  'Pick one and reply with it only: north, south, east, west.',
  'Reply with exactly one word: a country.',
]

export interface ProbeSample { probe: number; answer: string }

export interface ProbeReference {
  schema: 'dsh-eval-probe/1'
  model: string
  baseUrl: string
  /** sha256 of the probe battery this reference was built from; a different battery is not comparable. */
  batterySha?: string
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
  verdict: 'matches' | 'differs' | 'no-reference' | 'not-completed'
  /** Why the battery could not be collected, when the verdict is not-completed. */
  error?: string
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
export async function collectProbes(chat: ChatCall, samples = 8, log?: (line: string) => void, concurrency = 8): Promise<{ samples: ProbeSample[]; usd: number; failures: string[] }> {
  const jobs: Array<{ probe: number }> = []
  for (let p = 0; p < PROBES.length; p += 1) for (let i = 0; i < samples; i += 1) jobs.push({ probe: p })
  const out: ProbeSample[] = []
  const failures: string[] = []
  let usd = 0
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      const job = jobs[i]
      if (job === undefined) return
      // A probe is a pre-flight check, not the measurement: transient network failures are retried, and a
      // sample that will not come back is dropped rather than allowed to abort the run.
      let text: string | null = null
      let usage = { hit: 0, miss: 0, output: 0 }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { const r = await chat([{ role: 'user', content: `${PROBES[job.probe]!} Answer with JSON: {"answer": "<your answer>"}` }]); text = r.text; usage = r.usage; break }
        catch (e) { failures.push(e instanceof Error ? e.message : String(e)); await new Promise(r => setTimeout(r, 500 * (attempt + 1))) }
      }
      if (text === null) continue
      usd += (usage.miss * 0.44 + usage.hit * 0.014 + usage.output * 1.32) / 1e6
      let answer = ''
      try { answer = String((JSON.parse(text) as { answer?: unknown }).answer ?? '') } catch { answer = text }
      out.push({ probe: job.probe, answer: normalize(answer) })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
  out.sort((a, b) => a.probe - b.probe)
  for (let p = 0; p < PROBES.length; p += 1) log?.(`probe ${p + 1}/${PROBES.length}: ${out.filter(s => s.probe === p).map(s => s.answer).join(', ')}`)
  if (failures.length > 0) log?.(`${failures.length} probe call(s) failed after retries: ${[...new Set(failures)].slice(0, 2).join('; ')}`)
  return { samples: out, usd, failures }
}

/** sha256 of the battery itself: changing, adding or reordering a probe makes old references incomparable. */
export function batterySha(probes: string[] = PROBES): string {
  return createHash('sha256').update(probes.join('\n')).digest('hex')
}

export function referenceKey(model: string, baseUrl: string): string {
  return createHash('sha256').update(`${model}|${baseUrl}|${batterySha()}`).digest('hex').slice(0, 16)
}

/** Compare fresh probes with an enrolled reference; alpha 0.01 keeps false alarms rare on a check that blocks verdicts. */
export function compareWithReference(fresh: ProbeSample[], reference: ProbeReference | null, model: string, usd: number, alpha = 0.01): ProbeVerdict {
  const comparedAt = new Date().toISOString()
  // Too few answers to compare is not evidence of a substitution; say so rather than deciding either way.
  const expected = PROBES.length
  if (new Set(fresh.map(s => s.probe)).size < expected || fresh.length < expected * 2) {
    return { model, distance: 0, p: 1, probes: expected, samplesPerSide: 0, verdict: 'not-completed', error: `only ${fresh.length} answers across ${new Set(fresh.map(s => s.probe)).size} of ${expected} probes came back`, comparedAt, usd }
  }
  // A reference from a different battery is not evidence of anything: the probe indices no longer mean the same questions.
  if (reference === null || (reference.batterySha !== undefined && reference.batterySha !== batterySha())) return { model, distance: 0, p: 1, probes: PROBES.length, samplesPerSide: 0, verdict: 'no-reference', comparedAt, usd }
  const { distance, p } = probePermutationTest(reference.samples, fresh)
  return { model, distance, p, probes: PROBES.length, samplesPerSide: Math.round(fresh.length / PROBES.length), verdict: p < alpha ? 'differs' : 'matches', enrolledAt: reference.enrolledAt, comparedAt, usd }
}
