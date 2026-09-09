/**
 * dsh-eval as an MCP server over stdio: the surface the agent in the user's
 * conversation drives the evaluation through (docs/agent-interface.md).
 *
 * Written against the wire rather than the SDK. MCP over stdio is
 * newline-delimited JSON-RPC 2.0 with five methods, this repository already
 * speaks that protocol in `rpc-driver.ts`, and the whole runtime dependency list
 * is one YAML parser — a dependency whose surface is a hundred times what is used
 * here would be the larger cost.
 *
 * Two rules the transport imposes: stdout carries protocol frames and nothing
 * else (every log goes to stderr), and a tool call answers promptly. A run takes
 * minutes to hours, so `run_start` returns its id at once and the caller polls
 * `run_status`; the run belongs to this process, so it ends when the client
 * disconnects, exactly as it would if the CLI were interrupted.
 */
import { createInterface } from 'node:readline'
import { loadProject, type Project } from '../core/project.js'

/** Protocol versions this server knows. An unknown one from a client is answered with the newest of these. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

interface Tool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  run(project: Project, args: Record<string, unknown>): Promise<unknown>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)

export const TOOLS: Tool[] = [
  {
    name: 'status',
    description: 'Where the evaluation project is, what its evidence could support claiming, and the single call to make next. Free: reads the project from disk, runs nothing. Call this first in a session with no context.',
    inputSchema: { type: 'object', properties: { runs: { type: 'number', description: 'How many recent runs to describe (default 5).' } } },
    async run(project, args) {
      const { projectStatus } = await import('../core/status.js')
      return projectStatus(project, { ...(num(args['runs']) !== undefined ? { runs: num(args['runs'])! } : {}) })
    },
  },
  {
    name: 'scenarios_list',
    description: 'The scenarios this project would run, each with its category, turns, whether it has an oracle or a judge rubric, and the state of its last selfcheck (ok / failing / stale / never).',
    inputSchema: { type: 'object', properties: { scenarios: { type: 'array', items: { type: 'string' }, description: 'Name globs; all of them when omitted.' } } },
    async run(project, args) {
      const { collectScenarios } = await import('../core/orchestrate.js')
      const { readChecks, selfcheckStateOf } = await import('../core/checks.js')
      const names = strs(args['scenarios'])
      const { scenarios, invalid } = collectScenarios(project, names && names.length ? { scenarios: names } : {})
      const checks = readChecks(project)
      return {
        root: project.scenarioRoot,
        scenarios: scenarios.map(s => ({
          name: s.name, turns: s.prompts.length, category: s.meta.category ?? null, tags: s.meta.tags ?? [],
          oracle: s.hasOracle, setup: s.hasSetup, judge: s.meta.judge !== undefined, holdout: s.meta.holdout === true,
          runtime: s.meta.runtime ?? 'host', selfcheck: selfcheckStateOf(checks.selfcheck[s.name], s.dir),
        })),
        invalid,
      }
    },
  },
  {
    name: 'scenarios_selfcheck',
    description: "Check scenarios the way a run would: an untouched workspace must fail and the reference answer must pass. Returns `findings` per scenario as codes — blank.accepted, oracle.rejected, strict.blind_to_output, scenario.threw — which is the loop to iterate a verify.py against. A container scenario opens its own image and needs Docker.",
    inputSchema: { type: 'object', properties: { scenarios: { type: 'array', items: { type: 'string' } }, strict: { type: 'boolean', description: 'Also delete and blank each oracle output and require the verifier to notice.' } } },
    async run(project, args) {
      const { collectScenarios } = await import('../core/orchestrate.js')
      const { selfcheckAll } = await import('../core/selfcheck.js')
      const { recordSelfcheck } = await import('../core/checks.js')
      const names = strs(args['scenarios'])
      const { scenarios } = collectScenarios(project, names && names.length ? { scenarios: names } : {})
      if (scenarios.length === 0) return { error: { code: 'scenarios.none_matched', asked: names ?? [] } }
      const strict = args['strict'] === true
      const results = await selfcheckAll(scenarios, 4, { strict })
      recordSelfcheck(project, results, Object.fromEntries(scenarios.map(s => [s.name, s.dir])), { strict })
      return {
        strict,
        scenarios: results.map(r => ({ name: r.name, ok: r.ok, blankPasses: r.blankPasses, oraclePasses: r.oraclePasses, ...(r.findings ? { findings: r.findings } : {}) })),
      }
    },
  },
  {
    name: 'arms_diff',
    description: 'Compose both arms through dsh and diff them row by row: a fair A/B changes one thing. `state` is ok, identical, or multi_variable. Costs a second or two.',
    inputSchema: { type: 'object', properties: { baseline: { type: 'string' }, candidates: { type: 'array', items: { type: 'string' } } }, required: ['baseline', 'candidates'] },
    async run(project, args) {
      const { resolveArmPath } = await import('../core/orchestrate.js')
      const { loadArmFile } = await import('../core/arms.js')
      const { prepareArms } = await import('../core/plan.js')
      const { withPreviewArms } = await import('../core/project.js')
      const baseName = str(args['baseline'])
      const candNames = strs(args['candidates']) ?? []
      if (baseName === undefined || candNames.length === 0) return { error: { code: 'arms.missing', need: ['baseline', 'candidates'] } }
      const baseline = loadArmFile(resolveArmPath(project, baseName))
      const candidates = candNames.map(c => loadArmFile(resolveArmPath(project, c)))
      const prepared = await withPreviewArms(project, armsDir => prepareArms(baseline, candidates, { evalHome: project.home, armsDir }))
      return {
        baseline: baseline.name,
        candidates: prepared.diffs.map(d => ({ candidate: d.candidate, variables: d.variables, state: d.variables === 1 ? 'ok' : d.variables === 0 ? 'identical' : 'multi_variable', rows: d.rows, route: d.route })),
      }
    },
  },
  {
    name: 'run_start',
    description: 'Start a run and return its id at once; poll run_status. `aa: true` runs the baseline against a copy of itself to measure the A/A floor, which a direction cannot be read without. There is no way to skip a gate.',
    inputSchema: {
      type: 'object',
      properties: {
        baseline: { type: 'string' }, candidates: { type: 'array', items: { type: 'string' } },
        scenarios: { type: 'array', items: { type: 'string' } }, repeats: { type: 'number' },
        aa: { type: 'boolean', description: 'Measure this baseline\'s A/A noise floor.' },
        northStar: { type: 'string', description: 'cost (default), efficiency or quality — registered before the data.' },
        maxUsd: { type: 'number' }, label: { type: 'string' },
      },
      required: ['baseline'],
    },
    async run(project, args) {
      const { launchRun } = await import('../core/orchestrate.js')
      const baseline = str(args['baseline'])
      if (baseline === undefined) return { error: { code: 'arms.missing', need: ['baseline'] } }
      const aa = args['aa'] === true
      const candidates = strs(args['candidates']) ?? []
      if (!aa && candidates.length === 0) return { error: { code: 'arms.no_candidate', hint: 'pass candidates, or aa: true to measure the floor' } }
      const launched = await launchRun(project, {
        baseline, candidates, aa,
        ...(strs(args['scenarios'])?.length ? { scenarios: strs(args['scenarios'])! } : {}),
        ...(num(args['repeats']) !== undefined ? { repeats: num(args['repeats'])! } : {}),
        ...(num(args['maxUsd']) !== undefined ? { maxUsd: num(args['maxUsd'])! } : {}),
        ...(str(args['northStar']) !== undefined ? { northStar: str(args['northStar']) as 'cost' | 'efficiency' | 'quality' } : {}),
        ...(str(args['label']) !== undefined ? { label: str(args['label'])! } : {}),
      }, { log: (line) => process.stderr.write(`${line}\n`) })
      // The run owns itself from here; the caller polls. Failures land in the run's own progress file.
      void launched.done.catch(() => undefined)
      return { runId: launched.id, scenarios: launched.scenarios.length, repeats: launched.plan.repeats, arms: 1 + launched.plan.candidates.length, trials: launched.scenarios.length * launched.plan.repeats * (1 + launched.plan.candidates.length) }
    },
  },
  {
    name: 'run_status',
    description: 'How a run is going: trials done, spend, active trials, early-stop decision. `abandoned` means the process behind a "running" run is gone.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
    async run(project, args) {
      const { existsSync, statSync } = await import('node:fs')
      const { runPaths, readJson } = await import('../core/store.js')
      const id = str(args['runId'])
      if (id === undefined) return { error: { code: 'run.missing_id' } }
      const paths = runPaths(project.runsRoot, id)
      if (!existsSync(paths.progress)) return { error: { code: 'run.not_found', runId: id } }
      const progress = readJson<import('../core/store.js').Progress>(paths.progress)
      const idleMs = Date.now() - statSync(paths.progress).mtimeMs
      return {
        runId: id, status: progress.status, completed: progress.completed, total: progress.total,
        failed: progress.failed, usd: progress.usd, active: progress.active, idleMs,
        ...(progress.status === 'running' && idleMs > 30 * 60 * 1000 ? { abandoned: true } : {}),
        ...(progress.error !== undefined ? { error: progress.error } : {}),
        ...(progress.stoppedEarly !== undefined ? { stoppedEarly: progress.stoppedEarly } : {}),
      }
    },
  },
  {
    name: 'report_read',
    description: 'What a finished run licenses anyone to say, and what it withholds. Relay `licensed` in the user\'s own words; for anything in `withheld` say only that no conclusion is available and why — its `observed` numbers are real but do not support a direction, and rewriting "inconclusive" as "about the same" is the error this tool exists to prevent.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
    async run(project, args) {
      const { deriveReport } = await import('../core/orchestrate.js')
      const { claimsOf } = await import('../core/claims.js')
      const id = str(args['runId'])
      if (id === undefined) return { error: { code: 'run.missing_id' } }
      return claimsOf(deriveReport(project, id))
    },
  },
  {
    name: 'runs_list',
    description: 'Every run in this project, newest first, each with its gate and whether it is sealed.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    async run(project, args) {
      const { existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { listRuns, runPaths, readJson } = await import('../core/store.js')
      const limit = num(args['limit']) ?? 20
      return {
        runs: listRuns(project.runsRoot).slice(0, limit).map((r) => {
          const paths = runPaths(project.runsRoot, r.id)
          let gate: string | undefined
          if (existsSync(paths.report)) { try { gate = readJson<import('../core/report.js').Report>(paths.report).candidates[0]?.gate } catch { /* unreadable report */ } }
          return { ...r, sealed: existsSync(join(paths.dir, 'manifest.json')), ...(gate !== undefined ? { gate } : {}) }
        }),
      }
    },
  },
  {
    name: 'verify',
    description: 'Recompute a sealed run: every evidence hash from the bytes on disk, the whole report re-derived, and the receipt checked against a key this verifier trusts. PASS, INVALID or INCONCLUSIVE — an unknown signing key is INCONCLUSIVE, never PASS.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, keys: { type: 'array', items: { type: 'string' }, description: 'Trusted public keys: PEM text or paths.' } }, required: ['runId'] },
    async run(project, args) {
      const { verifyRunIntegrity } = await import('../core/orchestrate.js')
      const id = str(args['runId'])
      if (id === undefined) return { error: { code: 'run.missing_id' } }
      return verifyRunIntegrity(project, id, { ...(strs(args['keys'])?.length ? { keys: strs(args['keys'])! } : {}) })
    },
  },
]

interface Frame { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }

/** Serve MCP over the given streams until the input ends. Resolves when the client disconnects. */
export function serveMcp(options: { projectRoot?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const send = (frame: Frame): void => { output.write(JSON.stringify(frame) + '\n') }
  const project = (): Project => loadProject(options.projectRoot)

  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const tool = TOOLS.find(t => t.name === name)
    if (tool === undefined) return { text: JSON.stringify({ error: { code: 'tool.unknown', name, known: TOOLS.map(t => t.name) } }), isError: true }
    try {
      const result = await tool.run(project(), args)
      // A refusal is a normal answer here: a gate, a missing floor, a scenario that needs Docker. Only a
      // fault in this tool is an error, so the agent reads reasons as data instead of as failures.
      return { text: JSON.stringify(result, null, 2), isError: false }
    } catch (error) {
      const e = error as { code?: string; message?: string }
      return { text: JSON.stringify({ error: { code: e.code ?? 'tool.threw', message: e.message ?? String(error) } }, null, 2), isError: true }
    }
  }

  return new Promise<void>((resolve) => {
    const rl = createInterface({ input })
    // A tool call is answered asynchronously, and the input can end while one is still running — a client
    // that closes the pipe, or a piped script. Finish what is in flight before resolving, or its reply is lost.
    const inFlight = new Set<Promise<void>>()
    rl.on('close', () => { void Promise.allSettled([...inFlight]).then(() => resolve()) })
    rl.on('line', (line) => {
      const handled = (async () => {
        if (line.trim() === '') return
        let frame: Frame
        try { frame = JSON.parse(line) as Frame } catch { return }
        if (frame.method === undefined) return                       // a response to something we never asked
        const id = frame.id
        const reply = (result: unknown): void => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }) }
        switch (frame.method) {
          case 'initialize': {
            const asked = (frame.params?.['protocolVersion'] as string | undefined) ?? ''
            reply({
              protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
              capabilities: { tools: {} },
              serverInfo: { name: 'dsh-eval', version: (await import('../core/env.js')).evalInfraVersion() },
              instructions: 'Paired A/B evaluation of dsh components. Call `status` first: it says where the project is, which readings its evidence could support, and the next call. Gates are answers, not failures — a refusal comes with the reason and the way forward, and no tool can skip one. From `report_read`, relay `licensed` in the user\'s language and never turn a `withheld` claim into a direction.',
            })
            return
          }
          case 'notifications/initialized':
            return
          case 'ping':
            reply({})
            return
          case 'tools/list':
            reply({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
            return
          case 'tools/call': {
            const name = String(frame.params?.['name'] ?? '')
            const args = (frame.params?.['arguments'] as Record<string, unknown> | undefined) ?? {}
            const { text, isError } = await call(name, args)
            reply({ content: [{ type: 'text', text }], isError })
            return
          }
          default:
            if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${frame.method}` } })
        }
      })()
      inFlight.add(handled)
      void handled.finally(() => inFlight.delete(handled))
    })
  })
}
