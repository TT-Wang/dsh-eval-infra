/**
 * One entry point for "start a run": used by the CLI and by the web API so
 * both follow the same discipline — scenarios self-checked, arms composed and
 * diffed through dsh, environment recorded, ledgers written, report built.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadArmFile, type ArmError } from './arms.js'
import { resolveApiKey } from './env.js'
import { describeDiff, evalProfileManifest, prepareArms, recordEnvironment, type ArmDiff } from './plan.js'
import { projectPrices, type Project } from './project.js'
import { buildReport, noiseFloorOf, renderMarkdown, type NoiseFloor, type Report } from './report.js'
import { fileSha, sealRun, verifyRun, type VerifyResult } from './manifest.js'
import { archiveSignalOrder } from './signal.js'
import { driftTest } from './drift.js'
import { executeRun, type RunDeps } from './runner.js'
import { listScenarios, scenarioVerify } from './scenario.js'
import { sdkDriverFactory } from './sdk-driver.js'
import { selfcheckAll, type SelfcheckResult } from './selfcheck.js'
import { applyAnnotations, listRuns, newRunId, readAnnotations, readLedgers, readPlan, runPaths, writeJsonAtomic, writeLedger, type Progress } from './store.js'
import type { ArmSpec, RunLedger, RunPlan, Scenario } from './types.js'

export interface RunRequest {
  /** Arm file path, or a name resolved against the project's arms dir. */
  baseline: string
  candidates: string[]
  scenarios?: string[]
  categories?: string[]
  tags?: string[]
  repeats?: number
  concurrency?: number
  label?: string
  allowMulti?: boolean
  skipSelfcheck?: boolean
  keepWorkdirs?: boolean
  turnTimeoutS?: number
  /** Resume an existing run id (skips finished jobs). */
  resume?: string
  /** A/A: run the baseline against an identical copy of itself to measure the noise floor. */
  aa?: boolean
  /** Budget cap in USD; the run stops scheduling trials once exceeded. */
  maxUsd?: number
  /** Include sealed holdout scenarios (meta.holdout) in the run. */
  includeHoldout?: boolean
  /** Anytime-valid sequential mode: shuffled scenario order, early stop once the paired comparison is decided. */
  sequential?: boolean
  /** Where each trial's dsh runtime runs: on the host under dsh's own sandbox (default) or inside a Docker container. */
  sandbox?: 'host' | 'docker'
  /** Route the runtime's provider calls through the independent usage meter (default on for real runs). */
  meter?: boolean
  /** Prompt perturbation: repeats above 1 use a seeded paraphrase variant (prompts.variants.json), identical across arms. */
  perturb?: boolean
  /** Replay another run's recorded provider responses (keyless); forkAt serves that many recorded responses per trial, then goes live. */
  replay?: { runId: string; forkAt?: number }
  /** Per-trial spend cap in USD (observed usage after each turn). */
  maxUsdPerTrial?: number
  /** Sequential scenario order: seeded shuffle (default) or archive signal-to-noise, strongest first. */
  order?: 'seed' | 'signal'
  /** Fault injection through the meter: share of provider requests answered with 429 or a stall. */
  faultRate?: number
  faultSeed?: number
  /** Container image for docker mode (default node:22-bookworm-slim). */
  dockerImage?: string
  /** Seed for the sequential shuffle (default 42). */
  seed?: number
}

export interface LaunchHooks {
  log?: (line: string) => void
  onProgress?: (p: Progress) => void
  onLedger?: (l: RunLedger) => void
  signal?: AbortSignal
  /** Test seam: replace the SDK driver. */
  driverFactory?: RunDeps['driverFactory']
  /** Test seam: replace the dsh CLI used to compose trees. */
  invoke?: Parameters<typeof prepareArms>[2]['invoke']
}

export class LaunchError extends Error {
  constructor(message: string, readonly code: 'usage' | 'selfcheck' | 'arms' | 'env' = 'usage') {
    super(message)
  }
}

export interface Launched {
  id: string
  plan: RunPlan
  diffs: ArmDiff[]
  scenarios: Scenario[]
  selfcheck: SelfcheckResult[]
  /** Resolves with the final report when the run ends (or is cancelled). */
  done: Promise<{ progress: Progress; report: Report }>
}

export function resolveArmPath(project: Project, ref: string): string {
  const direct = resolve(project.root, ref)
  if (existsSync(direct) && /\.(ya?ml|json)$/.test(direct)) return direct
  for (const ext of ['.yml', '.yaml', '.json']) {
    const p = join(project.armsDir, ref + ext)
    if (existsSync(p)) return p
  }
  throw new LaunchError(`arm not found: ${ref} (looked for a file, then ${project.armsDir}/${ref}.yml)`, 'arms')
}

export function collectScenarios(project: Project, request: Pick<RunRequest, 'scenarios' | 'categories' | 'tags' | 'includeHoldout'>): { scenarios: Scenario[]; invalid: Array<{ dir: string; error: string }> } {
  const filter: { names?: string[]; categories?: string[]; tags?: string[]; includeHoldout?: boolean } = {}
  if (request.scenarios && request.scenarios.length) filter.names = request.scenarios
  if (request.categories && request.categories.length) filter.categories = request.categories
  if (request.tags && request.tags.length) filter.tags = request.tags
  if (request.includeHoldout) filter.includeHoldout = true
  const roots = [project.scenarioRoot, ...(project.config.pools ?? []).map(p => resolve(project.root, p))]
  const seen = new Set<string>()
  const scenarios: Scenario[] = []
  const invalid: Array<{ dir: string; error: string }> = []
  for (const root of roots) {
    const r = listScenarios(root, filter)
    for (const s of r.scenarios) if (!seen.has(s.name)) { seen.add(s.name); scenarios.push(s) }
    invalid.push(...r.invalid)
  }
  return { scenarios, invalid }
}

/** Prepare everything, then start the run in the background; `done` resolves with the report. */
export async function launchRun(project: Project, request: RunRequest, hooks: LaunchHooks = {}): Promise<Launched> {
  const log = hooks.log ?? ((): void => {})
  const profile = project.config.profile
  if (!evalProfileManifest(project.home, profile).exists) {
    throw new LaunchError(`eval profile "${profile}" is not initialised under ${project.home}; run: dsh-eval init [--plugin <path>]`, 'env')
  }
  const pureReplay = request.replay !== undefined && request.replay.forkAt === undefined
  // A pure replay never reaches the provider: the meter serves recorded responses, so a placeholder credential satisfies the adapter.
  const apiKey = resolveApiKey() ?? (pureReplay ? 'replay-no-key' : undefined)
  if (apiKey === undefined && hooks.driverFactory === undefined) {
    throw new LaunchError('DEEPSEEK_API_KEY not found (env, $DSH_HOME/.env or ~/.dsh/.env)', 'env')
  }

  let plan: RunPlan
  let id: string
  let baselineSpec: ArmSpec
  let candidateSpecs: ArmSpec[]
  const sources: Record<string, string> = {}
  if (request.resume !== undefined) {
    id = request.resume
    const paths = runPaths(project.runsRoot, id)
    if (!existsSync(paths.plan)) throw new LaunchError(`run ${id} not found under ${paths.root}`, 'usage')
    plan = readPlan(paths)
    baselineSpec = plan.baseline
    candidateSpecs = plan.candidates
  } else {
    if (request.candidates.length === 0 && !request.aa) throw new LaunchError('at least one candidate arm is required', 'usage')
    const baselinePath = resolveArmPath(project, request.baseline)
    baselineSpec = loadArmFile(baselinePath)
    sources[baselineSpec.name] = baselinePath
    if (request.aa) {
      const twin: ArmSpec = { ...baselineSpec, name: `${baselineSpec.name}-aa`, description: `identical copy of ${baselineSpec.name} (A/A noise floor)` }
      sources[twin.name] = baselinePath
      candidateSpecs = [twin]
    } else candidateSpecs = request.candidates.map((c) => {
      const p = resolveArmPath(project, c)
      const spec = loadArmFile(p)
      sources[spec.name] = p
      return spec
    })
    id = newRunId()
    plan = {
      id,
      createdAt: new Date().toISOString(),
      baseline: baselineSpec,
      candidates: candidateSpecs,
      scenarios: [],
      repeats: request.repeats ?? project.config.repeats,
      concurrency: request.concurrency ?? project.config.concurrency,
      scenarioRoot: project.scenarioRoot,
    }
    if (request.label !== undefined) plan.label = request.label
    if (request.sandbox === 'docker') plan.sandbox = 'docker'
    if (request.perturb) plan.perturb = true
    if (request.replay) plan.replay = request.replay
  }
  if (plan.repeats < 1) throw new LaunchError('repeats must be at least 1', 'usage')

  const { scenarios, invalid } = request.resume !== undefined
    ? collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true })
    : collectScenarios(project, request)
  for (const i of invalid) log(`!! skipping invalid scenario ${i.dir}: ${i.error}`)
  if (scenarios.length === 0) throw new LaunchError(`no scenarios matched under ${project.scenarioRoot}`, 'usage')
  plan.scenarios = scenarios.map(s => s.name)

  let selfcheck: SelfcheckResult[] = []
  if (!request.skipSelfcheck) {
    log(`selfcheck: ${scenarios.length} scenario(s)…`)
    selfcheck = await selfcheckAll(scenarios)
    const broken = selfcheck.filter(r => !r.ok)
    for (const r of selfcheck) log(`  ${r.ok ? 'OK ' : 'BAD'} ${r.name.padEnd(28)} blank→${r.blankPasses === null ? '?' : r.blankPasses ? 'PASS?!' : 'fail'} oracle→${r.oraclePasses === null ? 'n/a' : r.oraclePasses ? 'pass' : 'FAIL'} ${r.error ?? r.detail}`)
    if (broken.length > 0) throw new LaunchError(`${broken.length} scenario(s) failed selfcheck: ${broken.map(b => b.name).join(', ')} (fix them or pass --skip-selfcheck)`, 'selfcheck')
  }

  const paths = runPaths(project.runsRoot, id)
  mkdirSync(paths.dir, { recursive: true })
  const prepareOptions: Parameters<typeof prepareArms>[2] = { evalHome: project.home, armsDir: paths.arms, sources }
  if (hooks.invoke !== undefined) prepareOptions.invoke = hooks.invoke
  let prepared: Awaited<ReturnType<typeof prepareArms>>
  try {
    prepared = await prepareArms(baselineSpec, candidateSpecs, prepareOptions)
  } catch (error) {
    throw new LaunchError(`could not compose arms through dsh: ${(error as ArmError).message}`, 'arms')
  }
  for (const d of prepared.diffs) {
    log(`arm ${d.candidate} vs ${prepared.baseline.name}: ${d.variables} variable(s)`)
    for (const line of describeDiff(d)) log(`    ${line}`)
    if (d.variables === 0 && !request.aa) log(`!! arm ${d.candidate} is identical to the baseline; this is an A/A run in effect`)
    if (d.variables > 1 && !request.allowMulti) {
      throw new LaunchError(`arm ${d.candidate} differs from ${prepared.baseline.name} in ${d.variables} variables; a fair A/B changes one thing (pass --allow-multi to run anyway, the report will be marked multi-variable)`, 'arms')
    }
  }
  writeJsonAtomic(paths.plan, plan)
  const env = await recordEnvironment(prepared.composed)
  writeJsonAtomic(paths.env, { ...env, sandbox: request.sandbox ?? 'host', ...(request.sandbox === 'docker' ? { dockerImage: request.dockerImage ?? 'node:22-bookworm-slim' } : {}), diffs: prepared.diffs, multiVariable: prepared.diffs.some(d => d.variables > 1) })
  for (const [arm, text] of Object.entries(prepared.composed)) writeFileSync(join(paths.arms, `${arm}.composed.yml`), text)

  const runEnv: Record<string, string> = { DSH_TELEMETRY_DISABLED: '1' }
  if (apiKey !== undefined) runEnv['DEEPSEEK_API_KEY'] = apiKey
  const sandbox = request.sandbox ?? 'host'
  let driverFactory = hooks.driverFactory
  let baseOverlayRows: Array<Record<string, unknown>> = []
  if (driverFactory === undefined && sandbox === 'docker') {
    const { dockerAvailable, dockerDriverFactory, prepareNativeShims, CONTAINER_OVERLAY_ROWS } = await import('./docker.js')
    const { dshSourceRoot } = await import('./env.js')
    const avail = await dockerAvailable()
    if (!avail.ok) throw new LaunchError(`docker sandbox requested but docker is not usable: ${avail.detail}`, 'env')
    const source = dshSourceRoot({ realpath: false })
    if (source === null) throw new LaunchError('docker sandbox needs a dsh source checkout (DSH_SOURCE or ~/.dsh/source/current)', 'env')
    const arch = process.arch === 'x64' ? 'x64' : 'arm64'
    const nativeShims = prepareNativeShims(project.home, source, arch, log)
    log(`docker sandbox: ${avail.detail}; image ${request.dockerImage ?? 'node:22-bookworm-slim'}; ${nativeShims.length} native shim(s)`)
    driverFactory = dockerDriverFactory({ dshSource: source, nativeShims, ...(request.dockerImage !== undefined ? { image: request.dockerImage } : {}) }, paths.dir)
    baseOverlayRows = CONTAINER_OVERLAY_ROWS
  }
  const deps: RunDeps = {
    driverFactory: driverFactory ?? sdkDriverFactory(project.config.dshBin !== undefined ? { dshBin: project.config.dshBin } : {}),
    evalHome: project.home,
    paths,
    env: runEnv,
    log,
    workRoot: join(project.evalDir, 'work'),
  }
  if (hooks.signal !== undefined) deps.signal = hooks.signal
  if (hooks.onProgress !== undefined) deps.onProgress = hooks.onProgress
  if (hooks.onLedger !== undefined) deps.onLedger = hooks.onLedger
  if (request.keepWorkdirs) deps.keepWorkdirs = true
  const prices = projectPrices(project.config)
  if (prices) deps.prices = prices
  if (request.perturb) deps.perturb = { seed: request.seed ?? 42 }
  if (request.maxUsdPerTrial !== undefined) deps.maxUsdPerTrial = request.maxUsdPerTrial
  const meterOn = request.meter ?? driverFactory === undefined
  if (meterOn) {
    deps.meter = {
      upstream: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
      ...(sandbox === 'docker' ? { exposed: true, hostFromContainer: 'host.docker.internal' } : {}),
      ...(request.faultRate !== undefined && request.faultRate > 0 ? { faults: { rate: request.faultRate, seed: request.faultSeed ?? 7 } } : {}),
    }
  if (request.replay) {
    const source = runPaths(project.runsRoot, request.replay.runId)
    if (!existsSync(source.plan)) throw new LaunchError(`replay source run ${request.replay.runId} not found`, 'usage')
    if (!meterOn) throw new LaunchError('replay needs the meter (do not pass --no-meter)', 'usage')
    deps.replay = { runId: request.replay.runId, recordingFor: (sc, arm, rep) => join(source.dir, 'meter', sc, arm, `rep${rep}.responses.jsonl`), ...(request.replay.forkAt !== undefined ? { forkAt: request.replay.forkAt } : {}), liveAllowed: request.replay.forkAt !== undefined }
  }
  }
  if (request.turnTimeoutS !== undefined) deps.turnTimeoutMs = request.turnTimeoutS * 1000
  if (request.resume !== undefined) deps.resume = true
  if (request.maxUsd !== undefined) deps.maxUsd = request.maxUsd
  if (baseOverlayRows.length > 0) deps.baseOverlayRows = baseOverlayRows
  const decisions: Array<{ scenarios: number; cost: { mean: number; lo: number; hi: number } | null; ratio: { mean: number; lo: number; hi: number } | null; pass: { lo: number; hi: number } | null; decided: boolean; reason: string }> = []
  if (request.sequential) {
    deps.sequential = { seed: request.seed ?? 42, ...(request.order === 'signal' ? { order: archiveSignalOrder(project.runsRoot, plan.id) } : {}), onDecision: (d) => { decisions.push(d); log(`sequential: after ${d.scenarios} scenarios · cost ratio betting CS ${d.ratio ? `${d.ratio.mean.toFixed(2)} [${d.ratio.lo.toFixed(2)}, ${d.ratio.hi.toFixed(2)}]` : '—'} · Δ% asymptotic ${d.cost ? `[${d.cost.lo.toFixed(1)}, ${d.cost.hi.toFixed(1)}]` : '—'} · pass seq ${d.pass ? `[${d.pass.lo.toFixed(2)}, ${d.pass.hi.toFixed(2)}]` : '—'} · ${d.decided ? 'DECIDED: ' + d.reason : 'continue'}`) } }
    log('sequential mode: scenarios in seeded random order; the run stops once the anytime-valid sequences decide the comparison')
  }

  const done = (async (): Promise<{ progress: Progress; report: Report }> => {
    const progress = await executeRun(plan, scenarios, [prepared.baseline, ...prepared.candidates], deps)
    if (request.sequential) writeJsonAtomic(join(paths.dir, 'sequential.json'), { seed: request.seed ?? 42, candidate: candidateSpecs[0]?.name ?? null, decisions })
    const report = buildReport(plan, readLedgers(paths), { noiseFloors: archiveNoiseFloors(project, plan.id), priorBaselineUsd: archiveBaselineCosts(project, plan.baseline.name, plan.id), holdout: new Set(scenarios.filter(s => s.meta.holdout).map(s => s.name)), drift: baselineDrift(project, plan, readLedgers(paths)), ...sequencesOf(paths) })
    if (request.sequential) {
      const last = decisions.at(-1)
      if (progress.stoppedEarly) report.notes.unshift(`Sequential mode stopped after ${progress.stoppedEarly.after} of ${progress.stoppedEarly.of} scenarios: ${progress.stoppedEarly.reason}. The estimate applies to the scenario pool the shuffle drew from; unrun scenarios are not "incomplete", they were not needed.`)
      else if (last) report.notes.unshift(`Sequential mode ran every scenario without an early decision (last sequence: cost Δ% ${last.cost ? `[${last.cost.lo.toFixed(1)}, ${last.cost.hi.toFixed(1)}]` : '—'}).`)
    }
    if (prepared.diffs.some(d => d.variables > 1)) report.notes.unshift('Multi-variable comparison: at least one candidate differs from the baseline in more than one row; the result cannot be attributed to a single change.')
    writeJsonAtomic(paths.report, report)
    writeFileSync(paths.reportMd, renderMarkdown(report))
    sealRun(paths, plan.id)
    return { progress, report }
  })()
  return { id, plan, diffs: prepared.diffs, scenarios, selfcheck, done }
}

/** Per-scenario mean cost of an arm across earlier runs (excluding `exceptRunId`) — the CUPED covariate. */
export function archiveBaselineCosts(project: Project, arm: string, exceptRunId?: string): Record<string, number> {
  const sums = new Map<string, { usd: number; n: number }>()
  for (const r of listRuns(project.runsRoot)) {
    if (r.id === exceptRunId) continue
    const paths = runPaths(project.runsRoot, r.id)
    for (const l of readLedgers(paths)) {
      if (l.arm !== arm || l.error !== undefined) continue
      const e = sums.get(l.scenario) ?? { usd: 0, n: 0 }
      e.usd += l.totals.usd
      e.n += 1
      sums.set(l.scenario, e)
    }
  }
  return Object.fromEntries([...sums.entries()].map(([k, v]) => [k, v.usd / v.n]))
}

/** The most recent A/A noise floor per baseline arm found in the archive (excluding `exceptRunId`). */
/** Behavioural drift of this run's baseline arm against archived trials of the same arm name and model. */
export function baselineDrift(project: Project, plan: RunPlan, ledgers: RunLedger[]): import('./drift.js').DriftResult | null {
  const current = ledgers.filter(l => l.arm === plan.baseline.name && l.error === undefined)
  if (current.length < 2) return null
  const archive: RunLedger[] = []
  for (const r of listRuns(project.runsRoot)) {
    if (r.id === plan.id) continue
    try {
      for (const l of readLedgers(runPaths(project.runsRoot, r.id))) if (l.arm === plan.baseline.name && l.model === current[0]!.model && l.error === undefined) archive.push(l)
    } catch { /* unreadable run */ }
  }
  if (archive.length < 2) return null
  return driftTest(current, archive)
}

export function archiveNoiseFloors(project: Project, exceptRunId?: string): Record<string, NoiseFloor> {
  const out: Record<string, NoiseFloor> = {}
  for (const r of listRuns(project.runsRoot)) {
    if (r.id === exceptRunId || r.status !== 'done') continue
    const paths = runPaths(project.runsRoot, r.id)
    if (!existsSync(paths.plan)) continue
    try {
      const plan = readPlan(paths)
      const kind = plan.perturb ? 'perturbation' : 'rerun'
      if (out[`${plan.baseline.name}|${kind}`] !== undefined) continue
      const floor = noiseFloorOf(plan, readLedgers(paths))
      if (floor === null) continue
      // Newest floor of each kind per baseline; the bare key stays the rerun floor (or the only one) for callers that do not ask for a kind.
      out[`${plan.baseline.name}|${kind}`] = floor
      if (kind === 'rerun' || out[plan.baseline.name] === undefined) out[plan.baseline.name] = floor
    } catch { /* unreadable run */ }
  }
  return out
}

export interface JudgeOptions {
  /** Judge models; several form a panel. Each may be `model` or `model@baseUrl` with the key from `<NAME>_API_KEY` env, or a name from project config `judges`. */
  models?: string[]
  candidate?: string
  seed?: number
  /** pairwise (default), absolute (per-trial grades + PPI++), or both. */
  mode?: 'pairwise' | 'absolute' | 'both'
  log?: (line: string) => void
  /** Test seam: replace the chat calls (one per model). */
  chats?: Record<string, import('./judge.js').ChatCall>
  /** Allow judges from the same model family as the arms (refused by default: self-preference and preference leakage). */
  allowSameFamily?: boolean
}

/** Model family from a model id or a configured `family` (deepseek-* → deepseek, gpt-* → openai, claude-* → anthropic, gemini-* → google). */
export function modelFamily(model: string, configured?: string): string {
  if (configured) return configured.toLowerCase()
  const m = model.toLowerCase()
  if (m.startsWith('deepseek')) return 'deepseek'
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai'
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gemini')) return 'google'
  if (m.startsWith('qwen')) return 'alibaba'
  if (m.startsWith('llama')) return 'meta'
  if (m.startsWith('mistral') || m.startsWith('mixtral')) return 'mistral'
  return m.split(/[-_/:]/)[0] ?? m
}

function resolveJudgeModels(project: Project, models: string[] | undefined, chats: Record<string, import('./judge.js').ChatCall> | undefined, deepseekChat: (c: { model: string; baseUrl?: string; apiKey: string }) => import('./judge.js').ChatCall): import('./judge.js').JudgeModel[] {
  const names = models && models.length ? models : ['deepseek-v4-pro']
  return names.map((spec) => {
    if (chats?.[spec]) return { model: spec, chat: chats[spec]! }
    const configured = (project.config.judges ?? []).find(j => j.model === spec || j.name === spec)
    const model = configured?.model ?? spec.split('@')[0]!
    const baseUrl = configured?.baseUrl ?? (spec.includes('@') ? spec.slice(spec.indexOf('@') + 1) : undefined)
    const keyEnv = configured?.apiKeyEnv
    const apiKey = keyEnv !== undefined ? process.env[keyEnv] : baseUrl === undefined ? resolveApiKey() : process.env['JUDGE_API_KEY'] ?? resolveApiKey()
    if (apiKey === undefined) throw new LaunchError(`no API key for judge ${spec} (set ${keyEnv ?? 'DEEPSEEK_API_KEY or JUDGE_API_KEY'})`, 'env')
    return { model, chat: deepseekChat({ model, apiKey, ...(baseUrl !== undefined ? { baseUrl } : {}) }) }
  })
}

/**
 * Run the blinded pairwise judge over every scenario of a finished run that
 * declares `meta.judge`. Writes `judge-<candidate>.json` next to the report and
 * returns it. The judge model defaults to deepseek-v4-pro so it differs from
 * the usual v4-flash arms (same family: a stated limitation).
 */
export async function runJudge(project: Project, id: string, options: JudgeOptions = {}): Promise<import('./judge.js').JudgeReport[]> {
  const { judgeRun, deepseekChat, absoluteJudge } = await import('./judge.js')
  const paths = runPaths(project.runsRoot, id)
  if (!existsSync(paths.plan)) throw new LaunchError(`run ${id} not found`, 'usage')
  const plan = readPlan(paths)
  const ledgers = readLedgers(paths)
  const { scenarios } = collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true })
  const specs: Record<string, import('./judge.js').JudgeSpec> = {}
  for (const s of scenarios) if (s.meta.judge) specs[s.name] = s.meta.judge
  if (Object.keys(specs).length === 0) throw new LaunchError('no scenario in this run declares meta.judge', 'usage')
  const judges = resolveJudgeModels(project, options.models, options.chats, deepseekChat)
  const armFamilies = new Set([plan.baseline, ...plan.candidates].map(a => modelFamily(a.model ?? 'deepseek-v4-flash')))
  const sameFamily = judges.filter(j => armFamilies.has(modelFamily(j.model, (project.config.judges ?? []).find(c => c.model === j.model || c.name === j.model)?.family)))
  if (sameFamily.length > 0 && !options.allowSameFamily) {
    throw new LaunchError(`judge ${sameFamily.map(j => j.model).join(', ')} shares a model family with the arms (${[...armFamilies].join(', ')}); self-preference and preference leakage bias such judgments. Configure a judge from another family in .dsh-eval/config.json (judges: [{model, baseUrl, apiKeyEnv, family}]) or pass --allow-same-family to proceed with the bias stated in the report.`, 'usage')
  }
  const annotations = readAnnotations(paths)
  const anchors = collectAnchors(project, id)
  if (anchors.length) options.log?.(`judge anchors: ${anchors.length} archived human-labelled trial(s) will be re-graded for the drift check`)
  const mode = options.mode ?? 'pairwise'
  const out: import('./judge.js').JudgeReport[] = []
  const artifactDir = (scenario: string, arm: string, rep: number): string => join(paths.ledgers, scenario, arm, `rep${rep}.artifacts`)
  if (mode === 'pairwise' || mode === 'both') {
    for (const cand of plan.candidates.filter(c => options.candidate === undefined || c.name === options.candidate)) {
      const report = await judgeRun({ plan, candidate: cand.name, ledgers, specs, artifactDir, judges, ...(options.seed !== undefined ? { seed: options.seed } : {}), annotations, ...(anchors.length ? { anchors } : {}), ...(options.log !== undefined ? { log: options.log } : {}) })
      const { anchorAnswers, ...stored } = report
      if (anchorAnswers) rememberAnchorAnswers(project, anchorAnswers)
      writeJsonAtomic(join(paths.dir, `judge-${cand.name}.json`), { ...stored, sameFamilyAsArms: sameFamily.length > 0 })
      out.push(report)
    }
  }
  if (mode === 'absolute' || mode === 'both') {
    const abs = await absoluteJudge({ plan, ledgers, specs, artifactDir, judges, annotations, ...(options.log !== undefined ? { log: options.log } : {}) })
    writeJsonAtomic(join(paths.dir, 'judge-absolute.json'), abs)
  }
  rebuildReport(project, id)
  return out
}

/** Absolute judge report stored with a run, if any. */
export function readAbsoluteJudge(paths: ReturnType<typeof runPaths>): import('./judge.js').AbsoluteReport | null {
  const file = join(paths.dir, 'judge-absolute.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) as import('./judge.js').AbsoluteReport } catch { return null }
}

/** Final confidence sequences of a sequential run, as report options (empty when the run was not sequential). */
export function sequencesOf(paths: ReturnType<typeof runPaths>): { sequences?: Record<string, { cost: { mean: number; lo: number; hi: number } | null; pass: { lo: number; hi: number } | null; scenarios: number }> } {
  const file = join(paths.dir, 'sequential.json')
  if (!existsSync(file)) return {}
  try {
    const seqFile = JSON.parse(readFileSync(file, 'utf8')) as { candidate: string | null; decisions: Array<{ scenarios: number; cost: { mean: number; lo: number; hi: number } | null; ratio?: { mean: number; lo: number; hi: number } | null; pass: { lo: number; hi: number } | null }> }
    const last = seqFile.decisions.at(-1)
    if (!last || !seqFile.candidate) return {}
    // The finite-sample ratio sequence decides; it is expressed as Δ% for the report. Older files without it fall back to the asymptotic one.
    const cost = last.ratio ? { mean: (last.ratio.mean - 1) * 100, lo: (last.ratio.lo - 1) * 100, hi: (last.ratio.hi - 1) * 100 } : last.cost
    return { sequences: { [seqFile.candidate]: { cost, pass: last.pass, scenarios: last.scenarios } } }
  } catch { return {} }
}

/** Judge reports stored with a run, keyed by candidate. */
export function readJudgeReports(paths: ReturnType<typeof runPaths>): Record<string, import('./judge.js').JudgeReport> {
  const out: Record<string, import('./judge.js').JudgeReport> = {}
  if (!existsSync(paths.dir)) return out
  for (const f of readdirSync(paths.dir)) {
    const m = /^judge-(.+)\.json$/.exec(f)
    if (m) { try { out[m[1]!] = JSON.parse(readFileSync(join(paths.dir, f), 'utf8')) as import('./judge.js').JudgeReport } catch { /* skip */ } }
  }
  return out
}

/**
 * Re-derive every ledger of a run from its stored events (the ledger schema
 * evolves; the events are the durable record). Keeps verdict, timing, route
 * and error facts from the existing ledger; recomputes usage, prices, steps,
 * behaviour, observations and invariants. Then rebuilds the report.
 */
export async function rebuildLedgers(project: Project, id: string): Promise<number> {
  const { buildLedger } = await import('./ledger.js')
  const paths = runPaths(project.runsRoot, id)
  if (!existsSync(paths.plan)) throw new LaunchError(`run ${id} not found`, 'usage')
  let n = 0
  for (const old of readLedgers(paths)) {
    const eventsFile = join(paths.dir, old.eventsFile)
    if (!existsSync(eventsFile)) continue
    const events = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as import('./ledger.js').EventLike)
    const turnWall = new Map(old.turns.map(t => [t.turn, t.wallMs]))
    const { ledger, trace } = buildLedger({
      runId: old.runId, scenario: old.scenario, arm: old.arm, rep: old.rep, order: old.order,
      startedAt: new Date(old.startedAt), endedAt: new Date(old.endedAt), provider: old.provider, model: old.model,
      events, turnWall, verdict: old.machineVerdict ?? old.verdict, sessionId: old.sessionId, workdir: old.workdir,
      eventsFile: old.eventsFile, traceFile: old.traceFile, sessions: old.sessions ?? 1, ...(old.error !== undefined ? { error: old.error } : {}),
      ...(projectPrices(project.config) !== undefined ? { prices: projectPrices(project.config)! } : {}),
    })
    writeFileSync(join(paths.dir, old.traceFile), trace.map(t => JSON.stringify(t)).join('\n') + (trace.length ? '\n' : ''))
    writeJsonAtomic(join(paths.ledgers, old.scenario, old.arm, `rep${old.rep}.json`), ledger)
    n += 1
  }
  rebuildReport(project, id)
  return n
}

/** Rebuild the report of a finished (or partial) run from its ledgers. */
/** Re-derive the report from the ledgers, annotations and judge files without writing anything. */
export function deriveReport(project: Project, id: string): Report {
  const paths = runPaths(project.runsRoot, id)
  if (!existsSync(paths.plan)) throw new LaunchError(`run ${id} not found`, 'usage')
  const plan = readPlan(paths)
  const holdout = new Set(collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true }).scenarios.filter(s => s.meta.holdout).map(s => s.name))
  const report = buildReport(plan, applyAnnotations(readLedgers(paths), readAnnotations(paths)), { noiseFloors: archiveNoiseFloors(project, plan.id), priorBaselineUsd: archiveBaselineCosts(project, plan.baseline.name, plan.id), holdout, drift: baselineDrift(project, plan, readLedgers(paths)), ...sequencesOf(paths) })
  const judges = readJudgeReports(paths)
  const absolute = readAbsoluteJudge(paths)
  for (const c of report.candidates) {
    const j = judges[c.arm]
    if (j) {
      const models = j.models ?? [j.model]
      const jj = j as typeof j & { sameFamilyAsArms?: boolean; longerWinsShare?: number | null; interJudgeKappa?: number | null; lengthBalancedWinRate?: number | null; abstention?: NonNullable<Report['candidates'][number]['judge']>['abstention']; anchors?: NonNullable<Report['candidates'][number]['judge']>['anchors'] }
      c.judge = { model: models.join(' + '), models, panelAgreement: j.panelAgreement ?? 1, wins: j.wins, losses: j.losses, ties: j.ties, midP: j.midP, pWin: j.pWin, inconsistentShare: j.inconsistentShare, usd: j.usd, humanAgreement: j.humanAgreement, sameFamilyAsArms: jj.sameFamilyAsArms ?? false, longerWinsShare: jj.longerWinsShare ?? null, interJudgeKappa: jj.interJudgeKappa ?? null, lengthBalancedWinRate: jj.lengthBalancedWinRate ?? null, abstention: jj.abstention ?? null, anchors: jj.anchors ?? null }
      if (jj.abstention) report.notes.push(`${c.arm}: conformal abstention at α = ${jj.abstention.alpha} calibrated on ${jj.abstention.calibratedOn} human-labelled pair${jj.abstention.calibratedOn === 1 ? '' : 's'}: ${Number.isFinite(jj.abstention.tau) ? `threshold ${jj.abstention.tau.toFixed(2)}, ${jj.abstention.abstained} of ${jj.abstention.of} judgments withheld` : `no threshold meets the bound, all ${jj.abstention.of} judgments withheld`}.`)
      else report.notes.push(`${c.arm}: no human-labelled pairs on this run, so the judge cannot calibrate an abstention threshold; only order disagreement and panel splits abstain.`)
      if (jj.anchors) report.notes.push(`${c.arm}: judge anchors — ${jj.anchors.n} archived human-labelled trials re-graded: agreement with humans ${(jj.anchors.humanAgreement * 100).toFixed(0)}%${jj.anchors.stability !== null ? `, stability vs the previous judge run ${(jj.anchors.stability * 100).toFixed(0)}% on ${jj.anchors.comparedWithPrevious}` : ' (first run on these anchors, no previous answers yet)'}${jj.anchors.attribution === 'judge' ? ' → JUDGE DRIFT: the judge changed its mind on the anchors, so differences against earlier judge runs are attributed to the judge, not the system' : ''}.`)
      if (jj.lengthBalancedWinRate !== null && jj.lengthBalancedWinRate !== undefined) report.notes.push(`${c.arm}: length-balanced candidate win rate ${(jj.lengthBalancedWinRate * 100).toFixed(0)}% (average of the candidate-longer and candidate-shorter strata).`)
      report.notes.push(`${c.arm}: blinded pairwise judge${models.length > 1 ? ` panel (${models.join(', ')}; majority of decided votes, panel unanimous on ${(j.panelAgreement * 100).toFixed(0)}% of pairs${jj.interJudgeKappa !== null && jj.interJudgeKappa !== undefined ? `, inter-judge κ ${jj.interJudgeKappa.toFixed(2)}` : ''})` : ` (${models[0]})`}, both orders, inconsistent orders count as ties: prefers the candidate on ${j.wins}, the baseline on ${j.losses}, ties ${j.ties} (mid-p ${j.midP.toFixed(2)}); order disagreement ${(j.inconsistentShare * 100).toFixed(0)}% of votes${jj.longerWinsShare !== null && jj.longerWinsShare !== undefined ? `; the longer submission won ${(jj.longerWinsShare * 100).toFixed(0)}% of decided pairs` : ''}${j.humanAgreement ? `; agreement with ${j.humanAgreement.n} human-reviewed pairs ${(j.humanAgreement.agree * 100).toFixed(0)}% (κ ${j.humanAgreement.kappa === null ? '—' : j.humanAgreement.kappa.toFixed(2)})` : '; no human labels to calibrate against yet'}${jj.sameFamilyAsArms ? '. WARNING: the judge shares a model family with the arms; self-preference bias applies' : ''}.`)
    }
    if (absolute) {
      const b = absolute.arms[plan.baseline.name]
      const a = absolute.arms[c.arm]
      if (b && a) {
        const cal = (absolute as typeof absolute & { calibration?: { labelled: number; tpr: number | null; tnr: number | null } }).calibration
        c.absolute = { baseline: b, candidate: a, diff: a.estimate - b.estimate, diffSe: Math.sqrt(a.se * a.se + b.se * b.se), models: absolute.models, ...(cal ? { calibration: cal } : {}) }
        report.notes.push(`${c.arm}: absolute judge grades (${absolute.models.join(' + ')}) give pass rates ${(b.estimate * 100).toFixed(0)}% → ${(a.estimate * 100).toFixed(0)}% (${b.n + a.n > 0 ? `PPI++ rectified with ${b.n}/${a.n} human labels, λ ${b.lambda.toFixed(2)}/${a.lambda.toFixed(2)}${cal ? `; judge TPR ${cal.tpr === null ? '—' : (cal.tpr * 100).toFixed(0) + '%'} / TNR ${cal.tnr === null ? '—' : (cal.tnr * 100).toFixed(0) + '%'} on ${cal.labelled} labels` : ''}` : 'judge only, no human labels — uncalibrated'}), Δ ${((a.estimate - b.estimate) * 100).toFixed(0)} pp ± ${(Math.sqrt(a.se * a.se + b.se * b.se) * 100).toFixed(0)} (1 SE).`)
      }
    }
  }
  return report
}

export function rebuildReport(project: Project, id: string): Report {
  const paths = runPaths(project.runsRoot, id)
  const report = deriveReport(project, id)
  writeJsonAtomic(paths.report, report)
  writeFileSync(paths.reportMd, renderMarkdown(report))
  return report
}

/** Check the sealed evidence against the files on disk and the stored report against a fresh derivation. */
export function verifyRunIntegrity(project: Project, id: string): VerifyResult {
  const paths = runPaths(project.runsRoot, id)
  if (!existsSync(paths.plan)) throw new LaunchError(`run ${id} not found`, 'usage')
  const pick = (r: Report): Record<string, unknown> => ({
    candidates: r.candidates.map(c => ({ arm: c.arm, gate: c.gate, costReading: c.costReading, grade: c.grade, verdict: c.verdict })),
  })
  return verifyRun(paths, () => {
    const fresh = pick(deriveReport(project, id))
    const stored = existsSync(paths.report) ? pick(JSON.parse(readFileSync(paths.report, 'utf8')) as Report) : null
    return { fresh, stored }
  })
}

/** Archived human-labelled trials with judge artifacts, newest first, for the judge drift check. */
export function collectAnchors(project: Project, exceptRunId: string, limit = 20): Array<{ key: string; rubric: string; artifactDir: string; humanPass: boolean; previousJudgePass?: boolean }> {
  const anchorsFile = join(project.evalDir, 'judge-anchors.json')
  const previous: Record<string, boolean> = existsSync(anchorsFile) ? (JSON.parse(readFileSync(anchorsFile, 'utf8')) as Record<string, boolean>) : {}
  const out: ReturnType<typeof collectAnchors> = []
  for (const r of listRuns(project.runsRoot)) {
    if (r.id === exceptRunId) continue
    const paths = runPaths(project.runsRoot, r.id)
    if (!existsSync(paths.plan)) continue
    let plan: RunPlan
    try { plan = readPlan(paths) } catch { continue }
    const annotations = readAnnotations(paths)
    const keys = Object.keys(annotations).filter(k => typeof annotations[k]?.verdict === 'boolean')
    if (keys.length === 0) continue
    const specs = new Map(collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true }).scenarios.filter(s => s.meta.judge).map(s => [s.name, s.meta.judge!]))
    for (const k of keys) {
      const [scenario, arm, rep] = k.split('|')
      const spec = scenario !== undefined ? specs.get(scenario) : undefined
      if (!spec || scenario === undefined || arm === undefined || rep === undefined) continue
      const dir = join(paths.dir, 'ledgers', scenario, arm, `rep${rep}.artifacts`)
      if (!existsSync(dir)) continue
      const key = `${r.id}|${k}`
      out.push({ key, rubric: spec.rubric, artifactDir: dir, humanPass: annotations[k]!.verdict === true, ...(previous[key] !== undefined ? { previousJudgePass: previous[key]! } : {}) })
      if (out.length >= limit) return out
    }
  }
  return out
}

export function rememberAnchorAnswers(project: Project, answers: Record<string, boolean>): void {
  const anchorsFile = join(project.evalDir, 'judge-anchors.json')
  const previous: Record<string, boolean> = existsSync(anchorsFile) ? (JSON.parse(readFileSync(anchorsFile, 'utf8')) as Record<string, boolean>) : {}
  writeJsonAtomic(anchorsFile, { ...previous, ...answers })
}

export interface RegradeResult {
  at: string
  regradable: number
  skipped: number
  changed: Array<{ scenario: string; arm: string; rep: number; before: boolean | null; after: boolean; detail: string }>
  verifiers: Record<string, string>
}

/**
 * Re-run each scenario's verifier on the kept workspace of every trial (runs
 * made with --keep-workdirs), without re-running any agent, then rebuild the
 * report and re-seal the evidence with the regrade recorded in the manifest.
 */
export async function regradeRun(project: Project, id: string, options: { log?: (line: string) => void } = {}): Promise<RegradeResult> {
  const paths = runPaths(project.runsRoot, id)
  if (!existsSync(paths.plan)) throw new LaunchError(`run ${id} not found`, 'usage')
  const plan = readPlan(paths)
  const byName = new Map(collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true }).scenarios.map(s => [s.name, s]))
  const at = new Date().toISOString()
  const result: RegradeResult = { at, regradable: 0, skipped: 0, changed: [], verifiers: {} }
  for (const ledger of readLedgers(paths)) {
    const scenario = byName.get(ledger.scenario)
    if (!scenario || !ledger.workdir || !existsSync(ledger.workdir)) { result.skipped += 1; continue }
    result.regradable += 1
    const vf = join(scenario.dir, 'verify.py')
    if (existsSync(vf)) result.verifiers[scenario.name] = fileSha(vf)
    const before = ledger.verdict
    const after = await scenarioVerify(scenario, ledger.workdir)
    if ((before?.ok ?? null) !== after.ok) result.changed.push({ scenario: ledger.scenario, arm: ledger.arm, rep: ledger.rep, before: before?.ok ?? null, after: after.ok, detail: after.detail })
    options.log?.(`${after.ok ? '✓' : '✗'} ${ledger.scenario}/${ledger.arm}#${ledger.rep}${(before?.ok ?? null) !== after.ok ? ` (was ${before?.ok ?? 'none'})` : ''}`)
    writeLedger(paths, { ...ledger, verdict: after, regrade: { at, previous: before }, ...(result.verifiers[scenario.name] !== undefined ? { verifierSha: result.verifiers[scenario.name]! } : {}) })
  }
  writeJsonAtomic(join(paths.dir, `regrade-${at.replace(/[:.]/g, '-')}.json`), result)
  rebuildReport(project, id)
  sealRun(paths, plan.id, { at, changed: result.changed.length, regradable: result.regradable, verifiers: result.verifiers })
  return result
}
