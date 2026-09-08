import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    const r = await terminalBench.materialize(p, 'alpha-task', { fetcher: fakeFetcher(), docker: async (args) => { pulled.push(args); return args[0] === 'image' ? { code: 1, stderr: 'no such image' } : args[0] === 'inspect' ? { code: 0, stderr: '', stdout: '/app/repo\n' } : { code: 0, stderr: '' } } })
    // the same task materialises when GitHub's listing is unavailable (anonymous limit): names come from the mirror, files from the pinned commit
    const gh = fakeFetcher()
    const noApi = async (url: string): Promise<string> => { if (url.startsWith('https://api.github.com/')) throw new Error(`${url}: HTTP 403`); return gh(url) }
    const viaMirror = await terminalBench.materialize(project(), 'alpha-task', { fetcher: noApi, pull: false })
    expect(viaMirror.taskHash).toBe(r.taskHash)
    expect(pulled[0]).toEqual(['image', 'inspect', 'alexgshaw/alpha-task:20251031'])   // present? no → pull
    expect(pulled[1]).toEqual(['pull', '--platform', 'linux/amd64', 'alexgshaw/alpha-task:20251031'])
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
    // reward 0 with a pytest session behind it is a fail; reward 0 with no session (the verifier's download failed) is infrastructure, after one retry
    const failed = fakeEnvironment(() => '0')
    failed.readFile = async (path: string) => path.endsWith('reward.txt') ? '0' : path.endsWith('test-stdout.txt') ? '=== 2 failed, 1 passed in 0.3s ===' : null
    expect(await verifyInEnvironment(failed, '/nowhere/tests', 5000)).toMatchObject({ ok: false, testsRan: true })
    const noBootstrap = fakeEnvironment(() => '0')
    noBootstrap.readFile = async (path: string) => path.endsWith('reward.txt') ? '0' : path.endsWith('test-stdout.txt') ? 'E: Some index files failed to download.\ncurl: (35) SSL_ERROR_SYSCALL' : null
    const infra = await verifyInEnvironment(noBootstrap, '/nowhere/tests', 5000)
    expect(infra).toMatchObject({ ok: false, testsRan: false })
    expect(infra.detail).toMatch(/did not reach its tests \(twice\)/)
    expect(noBootstrap.uploads).toEqual(['/tests', '/tests'])
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
      taskRuntimeFactory: async (input) => {
        const env = fakeEnvironment(() => (input.arm.name === 'cand' ? '0' : '1'))
        // the candidate's verifier ran its tests and failed them; that is a fail, not an error
        env.readFile = async (path: string) => path.endsWith('reward.txt') ? (input.arm.name === 'cand' ? '0' : '1') : path.endsWith('ctrf.json') ? '{"results":{}}' : path.endsWith('test-stdout.txt') ? '=== 1 failed ===' : null
        envs.push(env); return { environment: env, driverFactory: scripted }
      },
    })
    expect(progress.status).toBe('done')
    const ledgers = readLedgers(paths)
    expect(ledgers.find(l => l.arm === 'baseline')!.verdict).toMatchObject({ ok: true })
    expect(ledgers.find(l => l.arm === 'cand')!.verdict?.ok).toBe(false)
    expect(ledgers.find(l => l.arm === 'cand')!.error).toBeUndefined()
    expect(envs).toHaveLength(2)
    expect(envs.every(e => e.stopped)).toBe(true)
    expect(envs.every(e => e.uploads.includes('/tests'))).toBe(true)
    // a verifier that never reached its tests is infrastructure: the trial is an error of that kind, the pair incomplete, no regression
    const plan2: RunPlan = { ...plan, id: 'c2' }
    const paths2 = runPaths(p.runsRoot, plan2.id)
    const arms2 = [resolveArm(plan2.baseline, paths2.arms), resolveArm(plan2.candidates[0]!, paths2.arms)]
    await executeRun(plan2, [scenario], arms2, {
      driverFactory: scripted, evalHome: p.home, paths: paths2, env: {}, workRoot: join(p.root, 'work'),
      taskRuntimeFactory: async (input) => {
        const env = fakeEnvironment(() => '1')
        if (input.arm.name === 'cand') env.readFile = async (path: string) => path.endsWith('reward.txt') ? '0' : path.endsWith('test-stdout.txt') ? 'E: Some index files failed to download' : null
        return { environment: env, driverFactory: scripted }
      },
    })
    const l2 = readLedgers(paths2)
    expect(l2.find(l => l.arm === 'cand')).toMatchObject({ errorKind: 'infrastructure' })
    const { buildReport } = await import('../src/core/report.js')
    const rep = buildReport(plan2, l2)
    expect(rep.candidates[0]!.scenarios[0]!.class).toBe('incomplete')
    expect(rep.candidates[0]!.gate).toBe('incomplete')
    expect(rep.notes.join(' ')).toMatch(/could not be graded/)
    rmSync(p.root, { recursive: true, force: true })
  })

  it('builds the container and exec arguments: image platform, resources, mounted node, dsh under --expose-internals', () => {
    const p = project()
    ensureEvalProfile(p.home, 'eval')
    const src = mkdtempSync(join(tmpdir(), 'dsh-src-'))
    const nodeDir = mkdtempSync(join(tmpdir(), 'node-'))
    const overlayDir = mkdtempSync(join(tmpdir(), 'overlays-'))
    writeFileSync(join(overlayDir, 'b.patch.yml'), '[]\n')
    const input = { arm: resolveArm({ name: 'b' }, join(p.evalDir, 'arms')), scenario: { name: 's', dir: '', meta: { name: 's', turns: 1 }, prompts: ['x'], hasOracle: false, hasSetup: false }, workdir: p.evalDir, evalHome: p.home, overlays: [join(overlayDir, 'b.patch.yml')], env: {} }
    const args = taskContainerArgs(input, { image: 'alexgshaw/alpha-task:20251031', platform: 'amd64', nodeDir, dsh: { dshSource: src }, cpus: 2, memoryMb: 2048 })
    expect(args.slice(0, 5)).toEqual(['run', '-d', '--init', '--platform', 'linux/amd64'])
    expect(args).toContain('--cpus'); expect(args).toContain('2048m')
    expect(args.some(a => a.includes('target=/opt/dsh-node'))).toBe(true)
    expect(args.slice(-4)).toEqual(['alexgshaw/alpha-task:20251031', 'tail', '-f', '/dev/null'])
    expect(args.some(a => a.startsWith(`type=bind,source=${realpathSync(overlayDir)},target=`) && a.endsWith(',readonly'))).toBe(true)   // the overlay's directory rides along
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

describe('swebench-verified adapter', () => {
  const ROW = {
    instance_id: 'psf__requests-2317', repo: 'psf/requests', base_commit: '091991be0da19de9108dbe5e3752917fea3d7fdc', patch: 'diff --git a/requests/sessions.py b/requests/sessions.py\n--- a/requests/sessions.py\n+++ b/requests/sessions.py\n@@ -1 +1 @@\n-x\n+y\n', test_patch: 'diff --git a/test_requests.py b/test_requests.py\n', problem_statement: 'method = builtin_str(method) problem\n\nIn requests/sessions.py …', hints_text: '', created_at: '2014-11-01T00:00:00Z', version: '2.4', FAIL_TO_PASS: '["test_requests.py::RequestsTestCase::test_nonzero"]', PASS_TO_PASS: '["test_requests.py::RequestsTestCase::test_a", "test_requests.py::RequestsTestCase::test_b"]', environment_setup_commit: '091991be', difficulty: '<15 min fix',
    image: 'swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest', eval_script: '#!/bin/bash\nset -uxo pipefail\ncd /testbed\ngit apply -v - <<\'EOF_1\'\ndiff\nEOF_1\npytest -rA test_requests.py\n', log_parser: 'parse_log_requests', eval_type: 'pass_and_fail',
  }
  const page = (rows: unknown[], total: number): string => JSON.stringify({ num_rows_total: total, features: [], rows: rows.map(row => ({ row })) })
  const fetcher = async (url: string): Promise<string> => {
    const u = new URL(url)
    if (u.hostname === 'huggingface.co') return JSON.stringify({ sha: 'abcdef1234567890' })
    if (!u.hostname.startsWith('datasets-server')) throw new Error(`unexpected ${url}`)
    const offset = Number(u.searchParams.get('offset')); const length = Number(u.searchParams.get('length'))
    const all = [{ ...ROW, instance_id: 'astropy__astropy-1', repo: 'astropy/astropy', image: 'swebench/sweb.eval.x86_64.astropy_1776_astropy-1:latest' }, ROW]
    return page(all.slice(offset, offset + length), all.length)
  }

  it('indexes the dataset by rows and materialises a task graded by the official harness in a fresh container', async () => {
    const { swebenchVerified } = await import('../src/core/bench/swebench.js')
    const p = project()
    const index = await swebenchVerified.index(p, { fetcher })
    expect(index.tasks.map(t => t.id)).toEqual(['astropy__astropy-1', 'psf__requests-2317'])
    expect(index.tasks[1]).toMatchObject({ category: 'psf/requests', difficulty: '<15 min fix', image: ROW.image, platforms: ['amd64'], cpus: 2, memoryMb: 4096 })
    const docker: string[][] = []
    const r = await swebenchVerified.materialize(p, 'psf__requests-2317', { fetcher, verifierPython: 'python3', docker: async (args) => { docker.push(args); return args[0] === 'image' ? { code: 1, stderr: 'no such image' } : { code: 0, stderr: '' } } })
    expect(docker[1]).toEqual(['pull', '--platform', 'linux/amd64', ROW.image])
    expect(r.dir).toBe(join(p.benchRoot, 'swebench-verified', 'psf__requests-2317'))
    const meta = JSON.parse(readFileSync(join(r.dir, 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta).toMatchObject({ runtime: 'container', image: ROW.image, platform: 'amd64', workdir: '/testbed', verifier_python: 'python3', turn_timeout_s: 1800, verifier_timeout_s: 1800, category: 'public' })
    expect(meta['origin']).toMatchObject({ benchmark: 'swebench-verified', version: 'abcdef123456', id: 'psf__requests-2317', commit: ROW.base_commit, license: 'MIT', taskHash: r.taskHash })
    expect(existsSync(join(r.dir, 'verify.py'))).toBe(true)
    expect(existsSync(join(r.dir, 'tests', 'test.sh'))).toBe(false)              // host-side grading, no in-container test.sh
    expect(readFileSync(join(r.dir, 'solution', 'patch.diff'), 'utf8')).toBe(ROW.patch)
    expect(JSON.parse(readFileSync(join(r.dir, 'prompts.json'), 'utf8'))[0]).toMatch(/\/testbed.*psf\/requests[\s\S]*<issue>[\s\S]*builtin_str/)
    expect(JSON.parse(readFileSync(join(r.dir, 'prompts.json'), 'utf8'))[0]).not.toMatch(/hints/)
    const s = loadScenario(r.dir)
    expect(s.meta.runtime).toBe('container'); expect(s.hasOracle).toBe(true)
    // the grader is the benchmark's own protocol, written in full
    const verify = readFileSync(join(r.dir, 'verify.py'), 'utf8')
    expect(verify).toMatch(/get_eval_report/); expect(verify).toMatch(/make_test_spec/); expect(verify).toMatch(/GIT_APPLY_CMDS/); expect(verify).toMatch(/DSH_EVAL_CONTAINER/)
    rmSync(p.root, { recursive: true, force: true })
  })
})

describe('host-side verifiers for container scenarios', () => {
  /** A container scenario graded by a verify.py on the host that is handed the container through the environment. */
  function hostGradedScenario(root: string, body: string): string {
    const dir = join(root, 'bench', 'public', 'x', 'host-graded')
    mkdirSync(join(dir, 'solution'), { recursive: true })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: 'host-graded', turns: 1, runtime: 'container', image: 'example/image:1', workdir: '/testbed', verifier_timeout_s: 30 }))
    writeFileSync(join(dir, 'prompts.json'), JSON.stringify(['do it']))
    writeFileSync(join(dir, 'solution', 'solve.sh'), '#!/bin/bash\ntrue\n')
    writeFileSync(join(dir, 'verify.py'), body)
    return dir
  }

  it('hands the container to verify.py and reads INFRA: as an infrastructure error', async () => {
    const p = project()
    ensureEvalProfile(p.home, 'eval')
    const dir = hostGradedScenario(p.root, 'import os\ndef verify(workdir):\n    if os.environ.get("DSH_EVAL_CONTAINER") == "cid-infra": return False, "INFRA: grading container would not start"\n    return True, f"cid={os.environ.get(\'DSH_EVAL_CONTAINER\')} wd={os.environ.get(\'DSH_EVAL_WORKDIR\')} t={os.environ.get(\'DSH_EVAL_VERIFIER_TIMEOUT_S\')}"\n')
    const scenario = loadScenario(dir)
    const plan: RunPlan = { id: 'h1', createdAt: new Date().toISOString(), baseline: { name: 'baseline' }, candidates: [{ name: 'cand' }], scenarios: [scenario.name], repeats: 1, concurrency: 1, scenarioRoot: dir }
    const paths = runPaths(p.runsRoot, plan.id)
    const arms = [resolveArm(plan.baseline, paths.arms), resolveArm(plan.candidates[0]!, paths.arms)]
    const scripted = scriptedDriverFactory()
    await executeRun(plan, [scenario], arms, {
      driverFactory: scripted, evalHome: p.home, paths, env: {}, workRoot: join(p.root, 'work'),
      taskRuntimeFactory: async (input) => { const env = fakeEnvironment(() => '1'); env.id = input.arm.name === 'cand' ? 'cid-infra' : 'cid-base'; env.workdir = '/testbed'; return { environment: env, driverFactory: scripted } },
    })
    const ledgers = readLedgers(paths)
    expect(ledgers.find(l => l.arm === 'baseline')!.verdict).toMatchObject({ ok: true, detail: 'cid=cid-base wd=/testbed t=30' })
    expect(ledgers.find(l => l.arm === 'cand')).toMatchObject({ errorKind: 'infrastructure' })
    expect(ledgers.find(l => l.arm === 'cand')!.error).toMatch(/could not grade/)
    rmSync(p.root, { recursive: true, force: true })
  })

  it('selfchecks a host-graded container scenario: the oracle must pass, the untouched environment must not', async () => {
    const p = project()
    // verify.py sees the world through the fake environment: solve.sh leaves a marker the grader reads
    const dir = hostGradedScenario(p.root, 'import os\ndef verify(workdir):\n    here = os.path.dirname(os.path.abspath(__file__))\n    return os.path.exists(os.path.join(here, ".solved")), "marker"\n')
    const scenario = loadScenario(dir)
    const env = fakeEnvironment(() => '1'); env.id = 'cid'
    env.exec = async (command: string) => { env.commands.push(command); if (command.includes('solve.sh')) writeFileSync(join(dir, '.solved'), ''); return { code: 0, stdout: '', stderr: '' } }
    const r = await selfcheckScenario(scenario, tmpdir(), { taskEnvironment: async () => env })
    expect(r).toMatchObject({ ok: true, blankPasses: false, oraclePasses: true })
    expect(env.stopped).toBe(true)
    rmSync(p.root, { recursive: true, force: true })
  })
})
