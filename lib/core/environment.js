/**
 * A task environment for scenarios that ship their own container image — the
 * public benchmarks. The container is started once per trial and kept alive;
 * the dsh runtime runs inside it through `docker exec`, the benchmark's own
 * tests run in the same container afterwards, and only then is it removed.
 * The runtime itself is not in the image: a pinned Node build and the dsh
 * checkout are bind-mounted in, the same way the plain container mode does it.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { dshRuntimeMounts } from './docker.js';
import { RpcDriver } from './rpc-driver.js';
const execFileAsync = promisify(execFile);
/** The Node build mounted into task images. Official Linux builds need glibc; every Terminal-Bench 2.0 image has it. */
export const NODE_VERSION = 'v22.23.2';
export const NODE_MOUNT = '/opt/dsh-node';
function run(cmd, args, timeoutMs = 120_000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            const e = err;
            resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : e.killed ? 124 : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}
/**
 * Download the pinned Node build for a container platform once per eval home.
 * Nothing is fetched until a container scenario actually runs.
 */
export async function ensureNodeRuntime(evalHome, platform, log) {
    const arch = platform === 'amd64' ? 'x64' : 'arm64';
    const dir = join(evalHome, 'docker', 'node', `${NODE_VERSION}-linux-${arch}`);
    if (existsSync(join(dir, 'bin', 'node')))
        return dir;
    const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${arch}.tar.xz`;
    log?.(`fetching Node ${NODE_VERSION} for linux/${platform} containers (once per eval home, ~30 MB)`);
    mkdirSync(dir, { recursive: true });
    const tarball = join(dir, 'node.tar.xz');
    const dl = await run('curl', ['-fsSL', '-o', tarball, url], 600_000);
    if (dl.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`could not download ${url}: ${dl.stderr.trim().split('\n').at(-1) ?? dl.code}`);
    }
    const ex = await run('tar', ['-xJf', tarball, '-C', dir, '--strip-components', '1'], 300_000);
    rmSync(tarball, { force: true });
    if (ex.code !== 0 || !existsSync(join(dir, 'bin', 'node'))) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`could not unpack ${url}: ${ex.stderr.trim().split('\n').at(-1) ?? ex.code}`);
    }
    return dir;
}
/** Is the image's platform the host's? When not, Docker emulates it and every trial is slower. */
export function platformIsEmulated(platform) {
    return (process.arch === 'x64' ? 'amd64' : 'arm64') !== platform;
}
/** The `docker run -d` arguments for a task container: image, resources, the runtime mounts, kept alive until removed. */
export function taskContainerArgs(input, options) {
    const args = ['run', '-d', '--init', '--platform', `linux/${options.platform}`];
    if (options.cpus !== undefined)
        args.push('--cpus', String(options.cpus));
    if (options.memoryMb !== undefined)
        args.push('--memory', `${options.memoryMb}m`);
    args.push('--mount', `type=bind,source=${realpathSync(options.nodeDir)},target=${NODE_MOUNT},readonly`);
    const mounts = new Map(dshRuntimeMounts(input, options.dsh));
    // The arm's overlays (base rows, the arm's patch, the meter row, any patch files) are host files the runtime reads by
    // path: their directories are mounted read-only, as the container sandbox mounts the run directory.
    for (const overlay of input.overlays) {
        const dir = dirname(realpathSync(overlay));
        if (!mounts.has(dir))
            mounts.set(dir, 'ro');
    }
    for (const [path, mode] of mounts)
        args.push('--mount', `type=bind,source=${path},target=${path}${mode === 'ro' ? ',readonly' : ''}`);
    for (const [source, target] of options.dsh.nativeShims ?? [])
        args.push('--mount', `type=bind,source=${source},target=${target},readonly`);
    args.push('-e', `DSH_HOME=${realpathSync(input.evalHome)}`, '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'NODE_OPTIONS=--max-old-space-size=2048');
    args.push('--add-host', 'host.docker.internal:host-gateway');
    // A task's verifier or oracle often installs its own tooling (apt, uv, pip) from inside the container. Behind a
    // proxy that traffic has to go the same way the host's does, so the host's proxy variables are forwarded with a
    // loopback address rewritten to the host gateway — a proxy on 127.0.0.1 is unreachable from the container by that name.
    for (const [k, v] of proxyEnvForContainer(process.env))
        args.push('-e', `${k}=${v}`);
    for (const k of ['DEEPSEEK_API_KEY'])
        if (input.env[k] !== undefined)
            args.push('-e', `${k}=${input.env[k]}`);
    for (const [k, v] of Object.entries(input.arm.env ?? {}))
        args.push('-e', `${k}=${v}`);
    args.push(options.image, 'tail', '-f', '/dev/null');
    return args;
}
/** The host's proxy settings as a container sees them: loopback rewritten to the host gateway, both spellings kept. */
export function proxyEnvForContainer(env) {
    const out = [];
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
        const v = env[key];
        if (v === undefined || v === '')
            continue;
        out.push([key, key.toLowerCase() === 'no_proxy' ? `${v},host.docker.internal` : v.replace(/\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/, '//host.docker.internal')]);
    }
    return out;
}
/** The runtime command inside a running task container: the mounted Node, dsh's CLI with the arm's overlays. */
export function taskRuntimeExecArgs(containerId, input, options) {
    const src = realpathSync(options.dsh.dshSource);
    const args = ['exec', '-i', '-w', options.workdir ?? '/app', containerId, `${NODE_MOUNT}/bin/node`, '--expose-internals', join(src, 'apps', 'cli', 'lib', 'bin.js'), '--profile', input.arm.profile];
    for (const overlay of input.overlays)
        args.push('--patch', realpathSync(overlay));
    return args;
}
class ContainerEnvironment {
    id;
    workdir;
    image;
    platform;
    log;
    constructor(id, workdir, image, platform, log) {
        this.id = id;
        this.workdir = workdir;
        this.image = image;
        this.platform = platform;
        this.log = log;
    }
    async exec(command, options = {}) {
        const args = ['exec', '-w', options.cwd ?? this.workdir];
        for (const [k, v] of Object.entries(options.env ?? {}))
            args.push('-e', `${k}=${v}`);
        args.push(this.id, 'bash', '-lc', command);
        return run('docker', args, options.timeoutMs ?? 900_000);
    }
    async upload(localDir, target) {
        await this.exec(`mkdir -p ${JSON.stringify(target)}`, { timeoutMs: 30_000 });
        const r = await run('docker', ['cp', `${realpathSync(localDir)}/.`, `${this.id}:${target}`], 120_000);
        if (r.code !== 0)
            throw new Error(`docker cp into ${this.id}:${target} failed: ${r.stderr.trim()}`);
    }
    async readFile(path) {
        const r = await this.exec(`cat ${JSON.stringify(path)}`, { timeoutMs: 30_000 });
        return r.code === 0 ? r.stdout : null;
    }
    async stop() {
        const r = await run('docker', ['rm', '-f', this.id], 60_000);
        if (r.code !== 0)
            this.log?.(`container ${this.id.slice(0, 12)} was not removed: ${r.stderr.trim()}`);
    }
}
/**
 * Start the task container for one trial and hand back the environment plus a
 * driver factory whose dsh runtime runs inside it. The caller stops the
 * environment after verification.
 */
/** The image's own working directory — where the task's files are and where its tests expect to run. */
export async function imageWorkdir(image) {
    const r = await run('docker', ['inspect', '--format', '{{.Config.WorkingDir}}', image], 60_000);
    const dir = r.stdout.trim();
    return r.code === 0 && dir !== '' ? dir : null;
}
export async function openContainerTask(input, options) {
    // The task's working directory is the image's unless the scenario says otherwise; /app is only the last resort.
    if (options.workdir === undefined) {
        const wd = await imageWorkdir(options.image);
        options = { ...options, workdir: wd ?? '/app' };
    }
    const started = await run('docker', taskContainerArgs(input, options), 300_000);
    if (started.code !== 0)
        throw new Error(`docker run ${options.image} failed: ${started.stderr.trim().split('\n').at(-1) ?? started.code}`);
    const id = started.stdout.trim();
    const environment = new ContainerEnvironment(id, options.workdir ?? '/app', options.image, options.platform, options.log);
    const driverFactory = () => new RpcDriver({
        command: 'docker',
        args: taskRuntimeExecArgs(id, input, options),
        env: { ...process.env, ...input.env },
        runtimeCwd: options.workdir ?? '/app',
        provider: input.arm.provider,
        model: input.arm.model,
        initializeTimeoutMs: 180_000,
        ...(input.arm.effort !== undefined ? { effort: input.arm.effort } : {}),
        ...(input.arm.maxTokens !== undefined ? { maxTokens: input.arm.maxTokens } : {}),
        ...(options.dsh.onStderr !== undefined ? { onStderr: options.dsh.onStderr } : {}),
    });
    return { environment, driverFactory };
}
/** Where the benchmark's own verifier writes; the same paths Harbor uses, so a task's test.sh works unchanged. */
export const TESTS_DIR = '/tests';
export const VERIFIER_DIR = '/logs/verifier';
export const SOLUTION_DIR = '/solution';
/** Did a pytest session happen? Harbor's test.sh templates write a CTRF report; the session banner is the fallback signal. */
function testsRanIn(output, ctrf) {
    if (ctrf !== null && ctrf.trim() !== '')
        return true;
    return /test session starts|\b\d+ (passed|failed|errors?)\b|\bcollected \d+ items?\b|\bPASSED\b|\bFAILED\b|\bno tests ran\b/.test(output);
}
export async function verifyInEnvironment(environment, testsDir, timeoutMs) {
    const first = await verifyOnce(environment, testsDir, timeoutMs);
    if (first.ok || first.testsRan)
        return first;
    // The tests never ran: usually the verifier's own download failed. One more try before calling it infrastructure.
    const second = await verifyOnce(environment, testsDir, timeoutMs);
    return second.ok || second.testsRan ? second : { ...second, detail: `verifier did not reach its tests (twice): ${second.detail}` };
}
async function verifyOnce(environment, testsDir, timeoutMs) {
    await environment.upload(testsDir, TESTS_DIR);
    await environment.exec(`mkdir -p ${VERIFIER_DIR} && rm -f ${VERIFIER_DIR}/reward.txt ${VERIFIER_DIR}/reward.json ${VERIFIER_DIR}/ctrf.json && chmod +x ${TESTS_DIR}/test.sh`, { timeoutMs: 30_000 });
    // Run from the task's working directory, as Harbor does: a test.sh may check $PWD or read the agent's files relatively.
    const r = await environment.exec(`bash ${TESTS_DIR}/test.sh > ${VERIFIER_DIR}/test-stdout.txt 2>&1`, { cwd: environment.workdir, timeoutMs });
    const rewardText = await environment.readFile(`${VERIFIER_DIR}/reward.txt`);
    const rewardJson = rewardText === null ? await environment.readFile(`${VERIFIER_DIR}/reward.json`) : null;
    let reward = null;
    if (rewardText !== null && rewardText.trim() !== '')
        reward = Number(rewardText.trim());
    else if (rewardJson !== null) {
        try {
            const parsed = JSON.parse(rewardJson);
            reward = typeof parsed === 'number' ? parsed : parsed !== null && typeof parsed === 'object' ? Number(Object.values(parsed)[0]) : null;
        }
        catch {
            reward = null;
        }
    }
    const output = ((await environment.readFile(`${VERIFIER_DIR}/test-stdout.txt`)) ?? '').trim();
    const tail = output.split('\n').slice(-12).join('\n').slice(-1200);
    const testsRan = testsRanIn(output, await environment.readFile(`${VERIFIER_DIR}/ctrf.json`));
    if (reward === null || !Number.isFinite(reward))
        return { ok: false, detail: `verifier wrote no reward${r.code === 124 ? ' (timed out)' : ''}: ${tail || r.stderr.trim().slice(-400)}`, reward: null, testsRan };
    return { ok: reward >= 1, detail: reward >= 1 ? 'reward 1' : `reward ${reward}: ${tail}`, reward, testsRan: reward >= 1 || testsRan };
}
/** Environment variables a host-side verifier of a container scenario receives. */
export function hostVerifierEnv(environment) {
    return {
        ...(environment.id !== undefined ? { DSH_EVAL_CONTAINER: environment.id } : {}),
        ...(environment.image !== undefined ? { DSH_EVAL_IMAGE: environment.image } : {}),
        ...(environment.platform !== undefined ? { DSH_EVAL_PLATFORM: environment.platform } : {}),
        DSH_EVAL_WORKDIR: environment.workdir,
    };
}
/** The same, plus the verifier's own time budget. */
export function hostVerifierEnvWithTimeout(environment, timeoutS) {
    return { ...hostVerifierEnv(environment), DSH_EVAL_VERIFIER_TIMEOUT_S: String(timeoutS) };
}
/** A host-side verifier says a grade could not be made (its own container or tooling failed) by starting its reason with this. */
export const INFRA_PREFIX = 'INFRA:';
/** Apply the benchmark's reference solution inside the environment (the oracle). */
export async function solveInEnvironment(environment, solutionDir, timeoutMs) {
    await environment.upload(solutionDir, SOLUTION_DIR);
    return environment.exec(`chmod +x ${SOLUTION_DIR}/solve.sh && bash ${SOLUTION_DIR}/solve.sh`, { cwd: environment.workdir, timeoutMs });
}
// A spawn import keeps the door open for streaming exec output; unused today.
void spawn;
