/**
 * A task environment for scenarios that ship their own container image — the
 * public benchmarks. The container is started once per trial and kept alive;
 * the dsh runtime runs inside it through `docker exec`, the benchmark's own
 * tests run in the same container afterwards, and only then is it removed.
 * The runtime itself is not in the image: a pinned Node build and the dsh
 * checkout are bind-mounted in, the same way the plain container mode does it.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { dshRuntimeMounts, type DockerOptions } from './docker.js'
import type { Driver, DriverFactory, DriverInput } from './runner.js'
import { RpcDriver } from './rpc-driver.js'

const execFileAsync = promisify(execFile)

/** The Node build mounted into task images. Official Linux builds need glibc; every Terminal-Bench 2.0 image has it. */
export const NODE_VERSION = 'v22.23.2'
export const NODE_MOUNT = '/opt/dsh-node'

export type ImagePlatform = 'amd64' | 'arm64'

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface TaskEnvironment {
  /** Working directory inside the environment (the image's WORKDIR, /app by convention). */
  workdir: string
  exec(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>
  /** Copy a host directory's contents to a directory inside the environment (created if missing). */
  upload(localDir: string, target: string): Promise<void>
  readFile(path: string): Promise<string | null>
  stop(): Promise<void>
}

export interface TaskRuntime {
  environment: TaskEnvironment
  /** Drivers whose runtime process runs inside this environment. */
  driverFactory: DriverFactory
}

export interface ContainerTaskOptions {
  image: string
  /** Platform of the image; amd64 for every published Terminal-Bench image. Emulated when it is not the host's. */
  platform: ImagePlatform
  /** Directory holding the Linux Node build for `platform` (see ensureNodeRuntime). */
  nodeDir: string
  dsh: Pick<DockerOptions, 'dshSource' | 'nativeShims' | 'mounts' | 'onStderr'>
  cpus?: number
  memoryMb?: number
  workdir?: string
  log?: (line: string) => void
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null
      resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : e.killed ? 124 : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * Download the pinned Node build for a container platform once per eval home.
 * Nothing is fetched until a container scenario actually runs.
 */
export async function ensureNodeRuntime(evalHome: string, platform: ImagePlatform, log?: (line: string) => void): Promise<string> {
  const arch = platform === 'amd64' ? 'x64' : 'arm64'
  const dir = join(evalHome, 'docker', 'node', `${NODE_VERSION}-linux-${arch}`)
  if (existsSync(join(dir, 'bin', 'node'))) return dir
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${arch}.tar.xz`
  log?.(`fetching Node ${NODE_VERSION} for linux/${platform} containers (once per eval home, ~30 MB)`)
  mkdirSync(dir, { recursive: true })
  const tarball = join(dir, 'node.tar.xz')
  const dl = await run('curl', ['-fsSL', '-o', tarball, url], 600_000)
  if (dl.code !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`could not download ${url}: ${dl.stderr.trim().split('\n').at(-1) ?? dl.code}`) }
  const ex = await run('tar', ['-xJf', tarball, '-C', dir, '--strip-components', '1'], 300_000)
  rmSync(tarball, { force: true })
  if (ex.code !== 0 || !existsSync(join(dir, 'bin', 'node'))) { rmSync(dir, { recursive: true, force: true }); throw new Error(`could not unpack ${url}: ${ex.stderr.trim().split('\n').at(-1) ?? ex.code}`) }
  return dir
}

/** Is the image's platform the host's? When not, Docker emulates it and every trial is slower. */
export function platformIsEmulated(platform: ImagePlatform): boolean {
  return (process.arch === 'x64' ? 'amd64' : 'arm64') !== platform
}

/** The `docker run -d` arguments for a task container: image, resources, the runtime mounts, kept alive until removed. */
export function taskContainerArgs(input: DriverInput, options: ContainerTaskOptions): string[] {
  const args = ['run', '-d', '--init', '--platform', `linux/${options.platform}`]
  if (options.cpus !== undefined) args.push('--cpus', String(options.cpus))
  if (options.memoryMb !== undefined) args.push('--memory', `${options.memoryMb}m`)
  args.push('--mount', `type=bind,source=${realpathSync(options.nodeDir)},target=${NODE_MOUNT},readonly`)
  for (const [path, mode] of dshRuntimeMounts(input, options.dsh)) args.push('--mount', `type=bind,source=${path},target=${path}${mode === 'ro' ? ',readonly' : ''}`)
  for (const [source, target] of options.dsh.nativeShims ?? []) args.push('--mount', `type=bind,source=${source},target=${target},readonly`)
  args.push('-e', `DSH_HOME=${realpathSync(input.evalHome)}`, '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'NODE_OPTIONS=--max-old-space-size=2048')
  args.push('--add-host', 'host.docker.internal:host-gateway')
  // A task's verifier or oracle often installs its own tooling (apt, uv, pip) from inside the container. Behind a
  // proxy that traffic has to go the same way the host's does, so the host's proxy variables are forwarded with a
  // loopback address rewritten to the host gateway — a proxy on 127.0.0.1 is unreachable from the container by that name.
  for (const [k, v] of proxyEnvForContainer(process.env)) args.push('-e', `${k}=${v}`)
  for (const k of ['DEEPSEEK_API_KEY']) if (input.env[k] !== undefined) args.push('-e', `${k}=${input.env[k]}`)
  for (const [k, v] of Object.entries(input.arm.env ?? {})) args.push('-e', `${k}=${v}`)
  args.push(options.image, 'tail', '-f', '/dev/null')
  return args
}

/** The host's proxy settings as a container sees them: loopback rewritten to the host gateway, both spellings kept. */
export function proxyEnvForContainer(env: Record<string, string | undefined>): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    const v = env[key]
    if (v === undefined || v === '') continue
    out.push([key, key.toLowerCase() === 'no_proxy' ? `${v},host.docker.internal` : v.replace(/\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/, '//host.docker.internal')])
  }
  return out
}

/** The runtime command inside a running task container: the mounted Node, dsh's CLI with the arm's overlays. */
export function taskRuntimeExecArgs(containerId: string, input: DriverInput, options: ContainerTaskOptions): string[] {
  const src = realpathSync(options.dsh.dshSource)
  const args = ['exec', '-i', '-w', options.workdir ?? '/app', containerId, `${NODE_MOUNT}/bin/node`, '--expose-internals', join(src, 'apps', 'cli', 'lib', 'bin.js'), '--profile', input.arm.profile]
  for (const overlay of input.overlays) args.push('--patch', realpathSync(overlay))
  return args
}

class ContainerEnvironment implements TaskEnvironment {
  constructor(readonly id: string, readonly workdir: string, private readonly log?: (line: string) => void) {}

  async exec(command: string, options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecResult> {
    const args = ['exec', '-w', options.cwd ?? this.workdir]
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`)
    args.push(this.id, 'bash', '-lc', command)
    return run('docker', args, options.timeoutMs ?? 900_000)
  }

  async upload(localDir: string, target: string): Promise<void> {
    await this.exec(`mkdir -p ${JSON.stringify(target)}`, { timeoutMs: 30_000 })
    const r = await run('docker', ['cp', `${realpathSync(localDir)}/.`, `${this.id}:${target}`], 120_000)
    if (r.code !== 0) throw new Error(`docker cp into ${this.id}:${target} failed: ${r.stderr.trim()}`)
  }

  async readFile(path: string): Promise<string | null> {
    const r = await this.exec(`cat ${JSON.stringify(path)}`, { timeoutMs: 30_000 })
    return r.code === 0 ? r.stdout : null
  }

  async stop(): Promise<void> {
    const r = await run('docker', ['rm', '-f', this.id], 60_000)
    if (r.code !== 0) this.log?.(`container ${this.id.slice(0, 12)} was not removed: ${r.stderr.trim()}`)
  }
}

/**
 * Start the task container for one trial and hand back the environment plus a
 * driver factory whose dsh runtime runs inside it. The caller stops the
 * environment after verification.
 */
export async function openContainerTask(input: DriverInput, options: ContainerTaskOptions): Promise<TaskRuntime> {
  const started = await run('docker', taskContainerArgs(input, options), 300_000)
  if (started.code !== 0) throw new Error(`docker run ${options.image} failed: ${started.stderr.trim().split('\n').at(-1) ?? started.code}`)
  const id = started.stdout.trim()
  const environment = new ContainerEnvironment(id, options.workdir ?? '/app', options.log)
  const driverFactory: DriverFactory = (): Driver => new RpcDriver({
    command: 'docker',
    args: taskRuntimeExecArgs(id, input, options),
    env: { ...process.env as Record<string, string>, ...input.env },
    runtimeCwd: options.workdir ?? '/app',
    provider: input.arm.provider,
    model: input.arm.model,
    initializeTimeoutMs: 180_000,
    ...(input.arm.effort !== undefined ? { effort: input.arm.effort } : {}),
    ...(input.arm.maxTokens !== undefined ? { maxTokens: input.arm.maxTokens } : {}),
    ...(options.dsh.onStderr !== undefined ? { onStderr: options.dsh.onStderr } : {}),
  })
  return { environment, driverFactory }
}

/** Where the benchmark's own verifier writes; the same paths Harbor uses, so a task's test.sh works unchanged. */
export const TESTS_DIR = '/tests'
export const VERIFIER_DIR = '/logs/verifier'
export const SOLUTION_DIR = '/solution'

/**
 * Run a Harbor-style verifier in the environment: upload `tests/`, run
 * test.sh, read the reward. Reward 1 is a pass; anything else, or no reward
 * file at all, is a fail with the test output as the reason.
 */
export async function verifyInEnvironment(environment: TaskEnvironment, testsDir: string, timeoutMs: number): Promise<{ ok: boolean; detail: string; reward: number | null }> {
  await environment.upload(testsDir, TESTS_DIR)
  await environment.exec(`mkdir -p ${VERIFIER_DIR} && rm -f ${VERIFIER_DIR}/reward.txt ${VERIFIER_DIR}/reward.json && chmod +x ${TESTS_DIR}/test.sh`, { timeoutMs: 30_000 })
  // Run from the task's working directory, as Harbor does: a test.sh may check $PWD or read the agent's files relatively.
  const r = await environment.exec(`bash ${TESTS_DIR}/test.sh > ${VERIFIER_DIR}/test-stdout.txt 2>&1`, { cwd: environment.workdir, timeoutMs })
  const rewardText = await environment.readFile(`${VERIFIER_DIR}/reward.txt`)
  const rewardJson = rewardText === null ? await environment.readFile(`${VERIFIER_DIR}/reward.json`) : null
  let reward: number | null = null
  if (rewardText !== null && rewardText.trim() !== '') reward = Number(rewardText.trim())
  else if (rewardJson !== null) { try { const parsed = JSON.parse(rewardJson) as unknown; reward = typeof parsed === 'number' ? parsed : parsed !== null && typeof parsed === 'object' ? Number(Object.values(parsed as Record<string, unknown>)[0]) : null } catch { reward = null } }
  const output = ((await environment.readFile(`${VERIFIER_DIR}/test-stdout.txt`)) ?? '').trim()
  const tail = output.split('\n').slice(-12).join('\n').slice(-1200)
  if (reward === null || !Number.isFinite(reward)) return { ok: false, detail: `verifier wrote no reward${r.code === 124 ? ' (timed out)' : ''}: ${tail || r.stderr.trim().slice(-400)}`, reward: null }
  return { ok: reward >= 1, detail: reward >= 1 ? 'reward 1' : `reward ${reward}: ${tail}`, reward }
}

/** Apply the benchmark's reference solution inside the environment (the oracle). */
export async function solveInEnvironment(environment: TaskEnvironment, solutionDir: string, timeoutMs: number): Promise<ExecResult> {
  await environment.upload(solutionDir, SOLUTION_DIR)
  return environment.exec(`chmod +x ${SOLUTION_DIR}/solve.sh && bash ${SOLUTION_DIR}/solve.sh`, { cwd: environment.workdir, timeoutMs })
}

// A spawn import keeps the door open for streaming exec output; unused today.
void spawn
