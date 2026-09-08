/**
 * Scenario library: directories holding meta.json, prompts.json, setup.py,
 * verify.py and (normally) oracle.py. Setup, verify and oracle run out of
 * process through python3 so a scenario can never touch the runner's state.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Scenario, ScenarioMeta, Verdict } from './types.js'

const execFileAsync = promisify(execFile)

export class ScenarioError extends Error {}

/** Load one scenario directory and validate its shape. */
export function loadScenario(dir: string): Scenario {
  const abs = resolve(dir)
  const metaPath = join(abs, 'meta.json')
  const promptsPath = join(abs, 'prompts.json')
  if (!existsSync(metaPath)) throw new ScenarioError(`${abs}: missing meta.json`)
  if (!existsSync(promptsPath)) throw new ScenarioError(`${abs}: missing prompts.json`)
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ScenarioMeta
  const container = meta.runtime === 'container'
  if (container) {
    if (typeof meta.image !== 'string' || meta.image === '') throw new ScenarioError(`${abs}: a container scenario needs meta.image`)
    // Graded either inside the container by the benchmark's own tests/test.sh, or by a host-side verify.py that is handed the container.
    if (!existsSync(join(abs, 'tests', 'test.sh')) && !existsSync(join(abs, 'verify.py'))) throw new ScenarioError(`${abs}: missing tests/test.sh or verify.py (a container scenario is graded by the benchmark's own tests)`)
  } else if (!existsSync(join(abs, 'verify.py'))) throw new ScenarioError(`${abs}: missing verify.py`)
  const prompts = JSON.parse(readFileSync(promptsPath, 'utf8')) as unknown
  if (!Array.isArray(prompts) || prompts.some(p => typeof p !== 'string' || p.length === 0)) {
    throw new ScenarioError(`${abs}: prompts.json must be a non-empty array of strings`)
  }
  if (typeof meta.turns !== 'number' || meta.turns !== prompts.length) {
    throw new ScenarioError(`${abs}: meta.turns (${String(meta.turns)}) must equal prompts.json length (${prompts.length})`)
  }
  const name = basename(abs)
  if (meta.name !== undefined && meta.name !== name) {
    throw new ScenarioError(`${abs}: meta.name (${meta.name}) must equal the directory name (${name})`)
  }
  const hasOracle = container ? existsSync(join(abs, 'solution', 'solve.sh')) : existsSync(join(abs, 'oracle.py'))
  if ((meta.oracle ?? 'required') === 'required' && !hasOracle) {
    throw new ScenarioError(`${abs}: ${container ? 'solution/solve.sh' : 'oracle.py'} is required (set meta.oracle to "none" to opt out)`)
  }
  const variantsPath = join(abs, 'prompts.variants.json')
  let variants: string[][] | undefined
  if (existsSync(variantsPath)) {
    const raw = JSON.parse(readFileSync(variantsPath, 'utf8')) as unknown
    if (!Array.isArray(raw) || raw.some(v => !Array.isArray(v) || v.length !== prompts.length || v.some(x => typeof x !== 'string' || x.length === 0))) {
      throw new ScenarioError(`${abs}: prompts.variants.json must be an array of prompt lists, each with ${prompts.length} non-empty strings`)
    }
    variants = raw as string[][]
  }
  return { name, dir: abs, meta: { ...meta, name }, prompts: prompts as string[], ...(variants ? { variants } : {}), hasOracle, hasSetup: existsSync(join(abs, 'setup.py')) }
}

export interface ScenarioFilter {
  /** Exact names or simple globs (`f*`, `*_amnesia`). */
  names?: string[]
  categories?: string[]
  tags?: string[]
  /** Include sealed holdout scenarios (meta.holdout); default false. */
  includeHoldout?: boolean
}

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
}

/** List scenarios under a root directory (one level deep), optionally filtered. Invalid scenarios are reported, not thrown. */
export function listScenarios(root: string, filter: ScenarioFilter = {}): { scenarios: Scenario[]; invalid: Array<{ dir: string; error: string }> } {
  const abs = resolve(root)
  const scenarios: Scenario[] = []
  const invalid: Array<{ dir: string; error: string }> = []
  if (!existsSync(abs)) return { scenarios, invalid }
  const patterns = (filter.names ?? []).map(globToRegExp)
  for (const entry of readdirSync(abs).sort()) {
    const dir = join(abs, entry)
    if (!statSync(dir).isDirectory() || entry.startsWith('.') || entry === '__pycache__') continue
    if (!existsSync(join(dir, 'meta.json'))) continue
    if (patterns.length > 0 && !patterns.some(p => p.test(entry))) continue
    try {
      const s = loadScenario(dir)
      if (filter.categories && filter.categories.length > 0 && !filter.categories.includes(s.meta.category ?? '')) continue
      if (filter.tags && filter.tags.length > 0 && !(s.meta.tags ?? []).some(t => filter.tags!.includes(t))) continue
      if (s.meta.holdout && !filter.includeHoldout) continue
      scenarios.push(s)
    } catch (error) {
      invalid.push({ dir, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { scenarios, invalid }
}

export interface PythonRunOptions {
  timeoutMs?: number
  python?: string
  /** Extra environment for the verifier process (a container scenario's host-side verifier gets the container's id this way). */
  env?: Record<string, string>
}

/**
 * The environment scenario code (setup, verify, oracle) runs with: what a Python process needs to find its
 * interpreter, packages, temp dir, proxy and Docker (host-side benchmark verifiers drive `docker`), and the
 * DSH_EVAL_* variables the runner sets — never the host's secrets. Anything whose name says key, token,
 * secret or password is dropped whatever else it matches.
 */
export function scenarioProcessEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TMP|TEMP|PWD|PYTHON[A-Z_]*|VIRTUAL_ENV|CONDA_[A-Z_]+|UV_[A-Z_]+|PIP_[A-Z_]+|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|DOCKER_HOST|DOCKER_CONFIG|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|DOCKER_DEFAULT_PLATFORM|(HTTP|HTTPS|ALL|NO|FTP)_PROXY|(http|https|all|no|ftp)_proxy|DSH_EVAL_[A-Z0-9_]+|SYSTEMROOT|COMSPEC|WINDIR)$/
  const secret = /key|token|secret|password|passwd|credential/i
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || !keep.test(k) || secret.test(k)) continue
    out[k] = v
  }
  return out
}

/** Run a python snippet with the scenario directory on sys.path; returns stdout. */
export async function runScenarioPython(scenario: Scenario, code: string, options: PythonRunOptions = {}): Promise<string> {
  const program = ['import sys, json', `sys.path.insert(0, ${JSON.stringify(scenario.dir)})`, code].join('\n')
  try {
    const { stdout } = await execFileAsync(options.python ?? 'python3', ['-c', program], {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      cwd: scenario.dir,
      env: { ...scenarioProcessEnv(), PYTHONDONTWRITEBYTECODE: '1', ...(options.env ?? {}) },
    })
    return stdout
  } catch (error) {
    const e = error as { stderr?: string; message?: string; killed?: boolean }
    throw new ScenarioError(`${scenario.name}: python failed${e.killed ? ' (timeout)' : ''}: ${(e.stderr ?? e.message ?? '').trim().split('\n').slice(-6).join('\n')}`)
  }
}

export async function scenarioSetup(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<void> {
  if (!scenario.hasSetup) return
  await runScenarioPython(scenario, `import setup; setup.setup(${JSON.stringify(workdir)})`, options)
}

export async function scenarioVerify(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<Verdict> {
  const out = await runScenarioPython(
    scenario,
    `import verify; ok, detail = verify.verify(${JSON.stringify(workdir)}); print('\\n__DSH_EVAL_VERDICT__' + json.dumps({'ok': bool(ok), 'detail': str(detail)}))`,
    options,
  )
  const line = out.split('\n').map(l => l.trim()).filter(l => l.startsWith('__DSH_EVAL_VERDICT__')).at(-1)
  if (line === undefined) throw new ScenarioError(`${scenario.name}: verify.py printed no verdict`)
  return JSON.parse(line.slice('__DSH_EVAL_VERDICT__'.length)) as Verdict
}

export async function scenarioOracle(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<void> {
  if (!scenario.hasOracle) throw new ScenarioError(`${scenario.name}: no oracle.py`)
  await runScenarioPython(scenario, `import oracle; oracle.solve(${JSON.stringify(workdir)})`, options)
}

/** Total bytes of a generated workspace (diagnostic for the selfcheck table). */
export function workspaceBytes(dir: string): number {
  let n = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.truth' || e.name === '.git' || e.name === '.spill') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) n += statSync(p).size
    }
  }
  if (existsSync(dir)) walk(dir)
  return n
}
