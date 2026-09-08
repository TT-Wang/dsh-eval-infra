import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseToml, terminalBench } from '../src/core/bench/terminal-bench.js'
import { loadProject, ensureEvalProfile, benchPools } from '../src/core/project.js'
import { loadScenario } from '../src/core/scenario.js'
import { selfcheckScenario } from '../src/core/selfcheck.js'
import { verifyInEnvironment, taskContainerArgs, taskRuntimeExecArgs, type TaskEnvironment } from '../src/core/environment.js'
import { executeRun } from '../src/core/runner.js'
import { resolveArm } from '../src/core/arms.js'
import { runPaths, readLedgers } from '../src/core/store.js'
import type { RunPlan } from '../src/core/types.js'
import { scriptedDriverFactory } from './helpers.js'

const REGISTRY = JSON.stringify([{ name: 'terminal-bench', version: '2.0', tasks: [
  { name: 'alpha-task', git_url: 'https://github.com/laude-institute/terminal-bench-2.git', git_commit_id: 'abc123', path: 'alpha-task' },
  { name: 'beta-task', git_url: 'https://github.com/laude-institute/terminal-bench-2.git', git_commit_id: 'abc123', path: 'beta-task' },
] }])
const TOML = `version = "1.0"
[metadata]
difficulty = "medium"
category = "scientific-computing"
tags = [ "applied-statistics", "simulation",]
expert_time_estimate_min = 180.0
[verifier]
timeout_sec = 900.0
[agent]
timeout_sec = 1200.0
[environment]
docker_image = "alexgshaw/alpha-task:20251031"
cpus = 2
memory = "2G"
`
/** A fetcher that answers the registry, the task files and GitHub's directory listings without the network. */
function fakeFetcher(): (url: string) => Promise<string> {
  return async (url) => {
    if (url.endsWith('registry.json')) return REGISTRY
    if (url.endsWith('/task.toml')) return TOML
    if (url.endsWith('/instruction.md')) return '<!-- canary GUID 123 -->\n\nWrite a sampler to /app/sampler.py.\n'
    if (url.includes('/contents/') && url.includes('/tests?')) return JSON.stringify([{ type: 'file', name: 'test.sh', download_url: 'https://raw/tests/test.sh', path: 'x' }, { type: 'file', name: 'test_outputs.py', download_url: 'https://raw/tests/test_outputs.py', path: 'y' }])
    if (url.includes('/contents/') && url.includes('/solution?')) return JSON.stringify([{ type: 'file', name: 'solve.sh', download_url: 'https://raw/solution/solve.sh', path: 'z' }])
    if (url.endsWith('/tests/test.sh')) return '#!/usr/bin/env bash\npytest /tests && echo 1 > /logs/verifier/reward.txt || echo 0 > /logs/verifier/reward.txt\n'
    if (url.endsWith('/tests/test_outputs.py')) return 'def test_it(): assert True\n'
    if (url.endsWith('/solution/solve.sh')) return '#!/usr/bin/env bash\ncp /solution/sampler.py /app/\n'
    if (url.includes('huggingface.co/api/datasets/') && url.endsWith('/tests')) return JSON.stringify([{ type: 'file', path: 'alpha-task/tests/test.sh' }, { type: 'file', path: 'alpha-task/tests/test_outputs.py' }])
    if (url.includes('huggingface.co/api/datasets/') && url.endsWith('/solution')) return JSON.stringify([{ type: 'file', path: 'alpha-task/solution/solve.sh' }])
    throw new Error(`unexpected fetch ${url}`)
  }
}

function project(): ReturnType<typeof loadProject> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-bench-'))
  mkdirSync(join(root, '.dsh-eval'), { recursive: true })
  writeFileSync(join(root, '.dsh-eval', 'config.json'), JSON.stringify({ profile: 'eval', repeats: 1, concurrency: 1 }))
  return loadProject(root)
}

describe('terminal-bench adapter', () => {
  it('parses a task.toml and builds the index from the registry without touching the network', async () => {
    const cfg = parseToml(TOML)
    expect(cfg['environment']!['docker_image']).toBe('alexgshaw/alpha-task:20251031')
    expect(cfg['metadata']!['tags']).toEqual(['applied-statistics', 'simulation'])
    expect(cfg['agent']!['timeout_sec']).toBe(1200)
    const p = project()
    const index = await terminalBench.index(p, { fetcher: fakeFetcher() })
    expect(index.tasks.map(t => t.id)).toEqual(['alpha-task', 'beta-task'])
    expect(index.tasks[0]).toMatchObject({ image: 'alexgshaw/alpha-task:20251031', cpus: 2, memoryMb: 2048, agentTimeoutS: 1200, verifierTimeoutS: 900, difficulty: 'medium', category: 'scientific-computing', expertMinutes: 180 })
    // cached: a second call needs no fetcher
    expect((await terminalBench.index(p)).tasks).toHaveLength(2)
    rmSync(p.root, { recursive: true, force: true })
  })

  it('materialises a task into a container scenario the loader accepts, in its own pool, with provenance', async () => {
    const p = project()
    const pulled: string[][] = []
    const r = await terminalBench.materialize(p, 'alpha-task', { fetcher: fakeFetcher(), docker: async (args) => { pulled.push(args); return { code: 0, stderr: '' } } })
    // the same task materialises when GitHub's listing is unavailable (anonymous limit): names come from the mirror, files from the pinned commit
    const gh = fakeFetcher()
    const noApi = async (url: string): Promise<string> => { if (url.startsWith('https://api.github.com/')) throw new Error(`${url}: HTTP 403`); return gh(url) }
    const viaMirror = await terminalBench.materialize(project(), 'alpha-task', { fetcher: noApi, pull: false })
    expect(viaMirror.taskHash).toBe(r.taskHash)
    expect(pulled[0]).toEqual(['pull', '--platform', 'linux/amd64', 'alexgshaw/alpha-task:20251031'])
    expect(pulled.some(a => a[0] === 'inspect')).toBe(true)   // the working directory is read from the pulled image
    expect(r.dir).toBe(join(p.benchRoot, 'terminal-bench-2.0', 'alpha-task'))
    const meta = JSON.parse(readFileSync(join(r.dir, 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta).toMatchObject({ name: 'alpha-task', runtime: 'container', image: 'alexgshaw/alpha-task:20251031', platform: 'amd64', cpus: 2, memory_mb: 2048, turn_timeout_s: 1200, verifier_timeout_s: 900, category: 'public', workdir: '/app/repo' })
    expect((meta['origin'] as Record<string, unknown>)).toMatchObject({ benchmark: 'terminal-bench', version: '2.0', id: 'alpha-task', commit: 'abc123', license: 'Apache-2.0', taskHash: r.taskHash })
    // the canary line is stripped from the prompt, the task's own files are kept verbatim
    expect(JSON.parse(readFileSync(join(r.dir, 'prompts.json'), 'utf8'))).toEqual(['Write a sampler to /app/sampler.py.'])
    expect(existsSync(join(r.dir, 'tests', 'test.sh'))).toBe(true)
    expect(existsSync(join(r.dir, 'solution', 'solve.sh'))).toBe(true)
    const s = loadScenario(r.dir)
    expect(s.meta.runtime).toBe('container')
    expect(s.hasOracle).toBe(true)
    // the pool is discovered, and stays separate from the default bench
    expect(benchPools(p)).toEqual([join(p.benchRoot, 'terminal-bench-2.0')])
    expect(terminalBench.remove(p, 'alpha-task')).toBe(true)
    expect(benchPools(p)).toEqual([])
    rmSync(p.root, { recursive: true, force: true })
  })
})

/** An environment that records what ran and answers with a scripted reward. */
function fakeEnvironment(reward: () => string): TaskEnvironment & { commands: string[]; uploads: string[]; stopped: boolean } {
  const env = {
    workdir: '/app', commands: [] as string[], uploads: [] as string[], stopped: false,
    async exec(command: string) { env.commands.push(command); return { code: 0, stdout: '', stderr: '' } },
    async upload(_local: string, target: string) { env.uploads.push(target) },
    async readFile(path: string) { return path.endsWith('reward.txt') ? reward() : path.endsWith('test-stdout.txt') ? '2 passed' : null },
    async stop() { env.stopped = true },
  }
  return env
}

describe('container scenarios', () => {
  it('grades with the benchmark verifier: tests uploaded, test.sh run, reward read', async () => {
    const env = fakeEnvironment(() => '1\n')
    const v = await verifyInEnvironment(env, '/nowhere/tests', 5000)
    expect(v).toMatchObject({ ok: true, reward: 1 })
    expect(env.uploads).toEqual(['/tests'])
    expect(env.commands.some(c => c.includes('bash /tests/test.sh'))).toBe(true)
    const zero = await verifyInEnvironment(fakeEnvironment(() => '0'), '/nowhere/tests', 5000)
    expect(zero.ok).toBe(false)
    expect(zero.detail).toMatch(/^reward 0/)
    const none = await verifyInEnvironment(fakeEnvironment(() => ''), '/nowhere/tests', 5000)
    expect(none).toMatchObject({ ok: false, reward: null })
  })

  it('selfchecks a container scenario in its environment: nop must fail, the oracle must pass', async () => {
    const p = project()
    const r = await terminalBench.materialize(p, 'alpha-task', { fetcher: fakeFetcher(), pull: false })
    const scenario = loadScenario(r.dir)
    let solved = false
    const env = fakeEnvironment(() => (solved ? '1' : '0'))
    env.exec = async (command: string) => { env.commands.push(command); if (command.includes('solve.sh')) solved = true; return { code: 0, stdout: '', stderr: '' } }
    const ok = await selfcheckScenario(scenario, tmpdir(), { taskEnvironment: async () => env })
    expect(ok).toMatchObject({ ok: true, blankPasses: false, oraclePasses: true })
    expect(env.stopped).toBe(true)
    // a task whose tests pass on the untouched image measures nothing
    const broken = await selfcheckScenario(scenario, tmpdir(), { taskEnvironment: async () => fakeEnvironment(() => '1') })
    expect(broken.ok).toBe(false)
    expect(broken.detail).toMatch(/untouched image/)
    // and without Docker the check says so instead of pretending
    const noDocker = await selfcheckScenario(scenario, tmpdir(), {})
    expect(noDocker.error).toMatch(/needs Docker/)
    rmSync(p.root, { recursive: true, force: true })
  })

  it('runs a trial inside the task environment and stops it after grading', async () => {
    const p = project()
    ensureEvalProfile(p.home, 'eval')
    const r = await terminalBench.materialize(p, 'alpha-task', { fetcher: fakeFetcher(), pull: false })
    const scenario = loadScenario(r.dir)
    const plan: RunPlan = { id: 'c1', createdAt: new Date().toISOString(), baseline: { name: 'baseline' }, candidates: [{ name: 'cand' }], scenarios: [scenario.name], repeats: 1, concurrency: 1, scenarioRoot: r.dir }
    const paths = runPaths(p.runsRoot, plan.id)
    const arms = [resolveArm(plan.baseline, paths.arms), resolveArm(plan.candidates[0]!, paths.arms)]
    const envs: ReturnType<typeof fakeEnvironment>[] = []
    const scripted = scriptedDriverFactory()
    const progress = await executeRun(plan, [scenario], arms, {
      driverFactory: scripted, evalHome: p.home, paths, env: {}, workRoot: join(p.root, 'work'),
      taskRuntimeFactory: async (input) => { const env = fakeEnvironment(() => (input.arm.name === 'cand' ? '0' : '1')); envs.push(env); return { environment: env, driverFactory: scripted } },
    })
    expect(progress.status).toBe('done')
    const ledgers = readLedgers(paths)
    expect(ledgers.find(l => l.arm === 'baseline')!.verdict).toMatchObject({ ok: true })
    expect(ledgers.find(l => l.arm === 'cand')!.verdict?.ok).toBe(false)
    expect(envs).toHaveLength(2)
    expect(envs.every(e => e.stopped)).toBe(true)
    expect(envs.every(e => e.uploads.includes('/tests'))).toBe(true)
    rmSync(p.root, { recursive: true, force: true })
  })

  it('builds the container and exec arguments: image platform, resources, mounted node, dsh under --expose-internals', () => {
    const p = project()
    ensureEvalProfile(p.home, 'eval')
    const src = mkdtempSync(join(tmpdir(), 'dsh-src-'))
    const nodeDir = mkdtempSync(join(tmpdir(), 'node-'))
    const input = { arm: resolveArm({ name: 'b' }, join(p.evalDir, 'arms')), scenario: { name: 's', dir: '', meta: { name: 's', turns: 1 }, prompts: ['x'], hasOracle: false, hasSetup: false }, workdir: p.evalDir, evalHome: p.home, overlays: [], env: {} }
    const args = taskContainerArgs(input, { image: 'alexgshaw/alpha-task:20251031', platform: 'amd64', nodeDir, dsh: { dshSource: src }, cpus: 2, memoryMb: 2048 })
    expect(args.slice(0, 5)).toEqual(['run', '-d', '--init', '--platform', 'linux/amd64'])
    expect(args).toContain('--cpus'); expect(args).toContain('2048m')
    expect(args.some(a => a.includes('target=/opt/dsh-node'))).toBe(true)
    expect(args.slice(-4)).toEqual(['alexgshaw/alpha-task:20251031', 'tail', '-f', '/dev/null'])
    const exec = taskRuntimeExecArgs('cid123', input, { image: 'x', platform: 'amd64', nodeDir, dsh: { dshSource: src } })
    expect(exec.slice(0, 6)).toEqual(['exec', '-i', '-w', '/app', 'cid123', '/opt/dsh-node/bin/node'])
    expect(exec).toContain('--expose-internals')
    rmSync(p.root, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); rmSync(nodeDir, { recursive: true, force: true })
  })
})

describe('proxy forwarding into task containers', () => {
  it('rewrites a loopback proxy to the host gateway and exempts the gateway from no_proxy', async () => {
    const { proxyEnvForContainer } = await import('../src/core/environment.js')
    expect(proxyEnvForContainer({ HTTPS_PROXY: 'http://127.0.0.1:7890', http_proxy: 'http://localhost:7890', NO_PROXY: 'localhost,127.0.0.1', OTHER: 'x' })).toEqual([
      ['HTTPS_PROXY', 'http://host.docker.internal:7890'],
      ['NO_PROXY', 'localhost,127.0.0.1,host.docker.internal'],
      ['http_proxy', 'http://host.docker.internal:7890'],
    ])
    expect(proxyEnvForContainer({ HTTPS_PROXY: 'http://proxy.corp:3128' })).toEqual([['HTTPS_PROXY', 'http://proxy.corp:3128']])
    expect(proxyEnvForContainer({})).toEqual([])
  })
})
