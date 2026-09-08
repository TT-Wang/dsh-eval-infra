/**
 * SWE-bench Verified (MIT): 500 human-validated GitHub issues from 12 Python
 * repositories. The dataset's current form names each task's prebuilt image
 * and ships the exact evaluation script and the name of the log parser the
 * official harness uses, so grading needs no repository tables of our own.
 *
 * The agent works in /testbed inside the task's image. Grading follows the
 * benchmark's own protocol: the agent's diff against the base commit is
 * applied to a fresh container of the same image, the dataset's eval script
 * runs there, and the official parser and report decide `resolved`. That
 * grader is the `swebench` package, kept in a venv this adapter manages.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultFetch, dockerHubImage, ensureImage } from './types.js';
const DATASET = 'swebench-verified';
const HF_DATASET = 'SWE-bench/SWE-bench_Verified';
/** The dataset has no version of its own; the index records the Hugging Face revision it was read at. */
const VERSION = '';
const LICENSE = 'MIT';
/** The grading package, pinned: it is the benchmark's own harness, so a version is a protocol. */
export const SWEBENCH_PACKAGE = 'swebench==5.0.2';
const ROWS_API = 'https://datasets-server.huggingface.co/rows';
function rowsUrl(offset, length) {
    return `${ROWS_API}?dataset=${encodeURIComponent(HF_DATASET)}&config=default&split=test&offset=${offset}&length=${length}`;
}
async function fetchRows(fetcher, offset, length) {
    const d = JSON.parse(await fetcher(rowsUrl(offset, length)));
    if (d.rows === undefined)
        throw new Error(`${HF_DATASET}: the rows API answered without rows${d.error ? ` (${d.error})` : ''}`);
    return { rows: d.rows.map(r => r.row), total: d.num_rows_total ?? d.rows.length };
}
function taskOf(row, offset) {
    const count = (s) => { try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v.length : 0;
    }
    catch {
        return 0;
    } };
    return {
        id: row.instance_id,
        title: row.instance_id,
        category: row.repo,
        ...(row.difficulty ? { difficulty: row.difficulty } : {}),
        tags: [row.repo.split('/')[1] ?? row.repo, `v${row.version}`, row.log_parser],
        image: row.image,
        platforms: ['amd64'],
        cpus: 2,
        memoryMb: 4096,
        agentTimeoutS: 1800,
        verifierTimeoutS: 1800,
        source: { gitUrl: `https://github.com/${row.repo}`, commit: row.base_commit, path: `${offset}` },
        row: offset,
    };
}
function run(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            const e = err;
            resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}
/**
 * The grading package in a venv of its own under the eval dir, built once:
 * `uv` when the machine has it (seconds), else python3 -m venv and pip.
 * Returns the interpreter path.
 */
export async function ensureSwebenchVenv(project, log = () => { }) {
    const dir = join(project.evalDir, 'bench', 'swebench', 'venv');
    const python = join(dir, 'bin', 'python');
    if (existsSync(python)) {
        const ok = await run(python, ['-c', 'import swebench.harness.grading'], 60_000);
        if (ok.code === 0)
            return python;
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(project.evalDir, 'bench', 'swebench'), { recursive: true });
    const uv = await run('uv', ['--version'], 10_000);
    if (uv.code === 0) {
        log(`building the SWE-bench grading environment with uv (${SWEBENCH_PACKAGE}, once per project)…`);
        const v = await run('uv', ['venv', '-q', '--python', '3.12', dir], 300_000);
        if (v.code !== 0)
            throw new Error(`uv venv failed: ${v.stderr.trim().split('\n').at(-1) ?? v.code}`);
        const p = await run('uv', ['pip', 'install', '-q', '--python', python, SWEBENCH_PACKAGE], 900_000);
        if (p.code !== 0)
            throw new Error(`uv pip install ${SWEBENCH_PACKAGE} failed: ${p.stderr.trim().split('\n').at(-1) ?? p.code}`);
    }
    else {
        log(`building the SWE-bench grading environment with python3 -m venv (${SWEBENCH_PACKAGE}, once per project; uv would be faster)…`);
        const v = await run('python3', ['-m', 'venv', dir], 300_000);
        if (v.code !== 0)
            throw new Error(`python3 -m venv failed: ${v.stderr.trim().split('\n').at(-1) ?? v.code}`);
        const p = await run(python, ['-m', 'pip', 'install', '-q', SWEBENCH_PACKAGE], 1_800_000);
        if (p.code !== 0)
            throw new Error(`pip install ${SWEBENCH_PACKAGE} failed: ${p.stderr.trim().split('\n').at(-1) ?? p.code}`);
    }
    const check = await run(python, ['-c', 'import swebench.harness.grading, swebench.harness.utils'], 60_000);
    if (check.code !== 0)
        throw new Error(`the grading environment does not import swebench: ${check.stderr.trim().split('\n').at(-1) ?? check.code}`);
    return python;
}
/** What the agent is told: the issue, where the checkout is, and that the maintainers' tests decide. Hints are not given. */
export function instructionFor(row) {
    return [
        `You are working in /testbed, a checkout of ${row.repo} at commit ${row.base_commit.slice(0, 12)} (version ${row.version}) with its environment already installed.`,
        'Fix the issue below by changing the source under /testbed. Do not modify or add tests: the maintainers\' tests for this issue will be run afterwards and decide whether the fix is complete.',
        '',
        '<issue>',
        row.problem_statement.trim(),
        '</issue>',
    ].join('\n');
}
/**
 * The host-side grader, written into each task directory. It runs in the
 * managed venv and is handed the agent's container through the environment.
 */
export const VERIFY_PY = String.raw `"""dsh-eval grader for a SWE-bench Verified task: the benchmark's own protocol.

The agent's diff against the base commit is taken from its container, applied
to a fresh container of the same image, the dataset's evaluation script runs
there, and the official parser and report decide whether the task is resolved.
Grading needs the swebench package (this file runs in the venv dsh-eval built).
"""
import json
import os
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
INFRA = "INFRA:"


def _docker(args, timeout=600, check=False):
    p = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:2])} failed: {(p.stderr or p.stdout).strip()[-400:]}")
    return p


def _agent_patch(cid, workdir, base_commit):
    """The model patch, the way agents produce it: everything in the tree, staged, diffed against the base commit."""
    script = f"cd {workdir} && git add -A >/dev/null 2>&1; git -c core.fileMode=false diff --cached --binary {base_commit}"
    p = _docker(["exec", "-w", workdir, cid, "bash", "-lc", script], timeout=300)
    if p.returncode != 0:
        raise RuntimeError(f"{INFRA} could not read the agent's diff: {(p.stderr or p.stdout).strip()[-300:]}")
    return p.stdout


def _proxy_env():
    """The host's proxy, as the grading container must see it: loopback rewritten to the host gateway (the same rule the agent's container gets)."""
    import re
    out = []
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        v = os.environ.get(key)
        if not v:
            continue
        if key.lower() == "no_proxy":
            out += ["-e", f"{key}={v},host.docker.internal"]
        else:
            out += ["-e", f"{key}={re.sub(r'//(127\\.0\\.0\\.1|localhost|\\[::1\\])(?=[:/]|$)', '//host.docker.internal', v)}"]
    return out


def _keep(workdir, name, text):
    """The full report and test log go beside the trial for anyone who wants to read past the summary."""
    try:
        d = os.path.join(workdir, "swebench")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "w") as f:
            f.write(text)
    except OSError:
        pass


def _grade(instance, patch, image, platform, timeout_s, workdir_host="."):
    from swebench.harness.grading import get_eval_report
    from swebench.harness.utils import make_test_spec
    try:
        from swebench.harness.run_evaluation import GIT_APPLY_CMDS
    except Exception:  # older layouts
        GIT_APPLY_CMDS = ["git apply --verbose", "git apply --verbose --3way", "git apply --verbose --reject", "patch --batch --forward --fuzz=5 -p1 -i"]
    from swebench.harness.constants import APPLY_PATCH_FAIL, APPLY_PATCH_PASS, TESTS_TIMEOUT

    spec = make_test_spec(instance)
    workdir = "/testbed"
    # Default networking, as the official harness grades: a proxy changes what the repositories' own HTTP tests see
    # (requests' suite talks to httpbin directly). DSH_EVAL_GRADER_PROXY=1 forwards the host's proxy for networks that need it.
    proxy = _proxy_env() if os.environ.get("DSH_EVAL_GRADER_PROXY") == "1" else []
    started = _docker(["run", "-d", "--platform", f"linux/{platform}", "--add-host", "host.docker.internal:host-gateway", *proxy, "-w", workdir, image, "tail", "-f", "/dev/null"], timeout=300)
    if started.returncode != 0:
        raise RuntimeError(f"{INFRA} could not start a grading container from {image}: {(started.stderr or started.stdout).strip()[-300:]}")
    cid = started.stdout.strip()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            patch_path = os.path.join(tmp, "patch.diff")
            with open(patch_path, "w") as f:
                f.write(patch)
            eval_path = os.path.join(tmp, "eval.sh")
            with open(eval_path, "w") as f:
                f.write(spec.eval_script)
            _docker(["cp", patch_path, f"{cid}:/tmp/patch.diff"], timeout=120, check=True)
            _docker(["cp", eval_path, f"{cid}:/eval.sh"], timeout=120, check=True)
            log_path = os.path.join(tmp, "test_output.txt")
            log = []
            applied = False
            for attempt, cmd in enumerate(GIT_APPLY_CMDS):
                if attempt:
                    _docker(["exec", "-w", workdir, cid, "bash", "-c", "git checkout -- . ; git clean -fd"], timeout=300)
                p = _docker(["exec", "-w", workdir, cid, "bash", "-c", f"{cmd} /tmp/patch.diff"], timeout=600)
                if p.returncode == 0:
                    applied = True
                    log.append(f"{APPLY_PATCH_PASS}:\n{p.stdout}")
                    break
            if not applied:
                rev = _docker(["exec", "-w", workdir, cid, "bash", "-c", "git apply --check --reverse /tmp/patch.diff"], timeout=300)
                applied = rev.returncode == 0
            if not applied:
                return False, "patch did not apply to a clean checkout: " + (p.stderr or p.stdout).strip()[-300:]
            try:
                t = subprocess.run(["docker", "exec", "-w", workdir, cid, "bash", "/eval.sh"], capture_output=True, text=True, timeout=timeout_s)
                log.append(t.stdout + t.stderr)
            except subprocess.TimeoutExpired as e:
                log.append((e.stdout or "") + (e.stderr or "") + f"\n{TESTS_TIMEOUT} after {timeout_s}s\n")
            with open(log_path, "w") as f:
                f.write("\n".join(log))
            report = get_eval_report(spec, {"instance_id": instance["instance_id"], "model_name_or_path": "dsh-eval", "model_patch": patch}, log_path, True)
            r = report[instance["instance_id"]]
            _keep(workdir_host, "test_output.txt", "\n".join(log))
            _keep(workdir_host, "report.json", json.dumps(report, indent=2))
            _keep(workdir_host, "patch.diff", patch)
            if r.get("infra_failure"):
                raise RuntimeError(f"{INFRA} the harness classified the run as an infrastructure failure")
            ts = r.get("tests_status", {})
            f2p = ts.get("FAIL_TO_PASS", {})
            p2p = ts.get("PASS_TO_PASS", {})
            detail = (
                f"FAIL_TO_PASS {len(f2p.get('success', []))}/{len(f2p.get('success', [])) + len(f2p.get('failure', []))} · "
                f"PASS_TO_PASS {len(p2p.get('success', []))}/{len(p2p.get('success', [])) + len(p2p.get('failure', []))}"
            )
            if not r.get("patch_successfully_applied", False):
                detail = "patch did not apply · " + detail
            if r.get("resolved"):
                return True, "resolved · " + detail
            failing = (f2p.get("failure", []) + p2p.get("failure", []))[:3]
            return False, "not resolved · " + detail + (" · first failing: " + ", ".join(failing) if failing else "")
    finally:
        _docker(["rm", "-f", cid], timeout=120)


def verify(workdir):
    """verify(workdir) -> (ok, detail); the container comes from the environment, workdir is the host scratch dir."""
    instance = json.load(open(os.path.join(HERE, "instance.json")))
    cid = os.environ.get("DSH_EVAL_CONTAINER")
    if not cid:
        return False, f"{INFRA} no container in the environment (DSH_EVAL_CONTAINER); this task is graded through its container"
    image = os.environ.get("DSH_EVAL_IMAGE") or instance["image"]
    platform = os.environ.get("DSH_EVAL_PLATFORM") or "amd64"
    container_workdir = os.environ.get("DSH_EVAL_WORKDIR") or "/testbed"
    timeout_s = int(os.environ.get("DSH_EVAL_VERIFIER_TIMEOUT_S") or "1800")
    try:
        patch = _agent_patch(cid, container_workdir, instance["base_commit"])
        if patch.strip() == "":
            return False, "no changes in /testbed (empty patch)"
        return _grade(instance, patch, image, platform, timeout_s, workdir)
    except RuntimeError as e:
        msg = str(e)
        return False, msg if msg.startswith(INFRA) else f"{INFRA} {msg}"
    except subprocess.TimeoutExpired as e:
        return False, f"{INFRA} docker did not answer in time: {e}"
`;
export const swebenchVerified = {
    id: DATASET,
    title: 'SWE-bench Verified',
    version: VERSION,
    license: LICENSE,
    note: '500 GitHub issues from 12 Python repositories, each in its own image (about 1 GB); graded by the official harness in a fresh container of that image. Needs python3 (uv makes the one-time setup fast).',
    poolDir(project) { return join(project.benchRoot, DATASET); },
    async index(project, options = {}) {
        const fetcher = options.fetcher ?? defaultFetch;
        const cacheDir = join(project.evalDir, 'bench', DATASET);
        const cache = join(cacheDir, 'index.json');
        if (!options.refresh && existsSync(cache))
            return JSON.parse(readFileSync(cache, 'utf8'));
        options.log?.(`fetching the ${HF_DATASET} index (five pages of rows, no images)`);
        const tasks = [];
        let offset = 0;
        let total = Infinity;
        while (offset < total) {
            const page = await fetchRows(fetcher, offset, 100);
            total = page.total;
            page.rows.forEach((row, i) => tasks.push(taskOf(row, offset + i)));
            if (page.rows.length === 0)
                break;
            offset += page.rows.length;
        }
        // Best effort: the revision the rows were read at, so a receipt can say which data it was.
        let revision = 'main';
        try {
            const meta = JSON.parse(await fetcher(`https://huggingface.co/api/datasets/${HF_DATASET}`));
            if (typeof meta.sha === 'string')
                revision = meta.sha.slice(0, 12);
        }
        catch { /* the rows are what matter */ }
        const index = { dataset: DATASET, version: revision, license: LICENSE, fetchedAt: new Date().toISOString(), tasks };
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cache, JSON.stringify(index, null, 2));
        return index;
    },
    describeImage(image, fetcher = defaultFetch) { return dockerHubImage(image, fetcher); },
    async materialize(project, id, options = {}) {
        const fetcher = options.fetcher ?? defaultFetch;
        const log = options.log ?? (() => { });
        const index = await this.index(project, { fetcher, log });
        const task = index.tasks.find(t => t.id === id);
        if (!task)
            throw new Error(`${DATASET}: no task "${id}" (run: dsh-eval bench list ${DATASET})`);
        // The full row (patch, tests, eval script) is read on demand: the index keeps only what a shelf shows.
        let row;
        if (task.row !== undefined) {
            const page = await fetchRows(fetcher, task.row, 1);
            row = page.rows[0]?.instance_id === id ? page.rows[0] : undefined;
        }
        if (row === undefined) {
            for (let offset = 0; offset < 500 && row === undefined; offset += 100) {
                const page = await fetchRows(fetcher, offset, 100);
                row = page.rows.find(r => r.instance_id === id);
            }
        }
        if (row === undefined)
            throw new Error(`${DATASET}: task ${id} is not in the dataset any more`);
        const python = options.verifierPython ?? await ensureSwebenchVenv(project, log);
        if (options.pull !== false)
            await ensureImage(row.image, options.docker ?? (async (args) => run('docker', args, 1_800_000)), log, ', about 1 GB');
        const hash = createHash('sha256');
        for (const k of ['instance_id', 'base_commit', 'patch', 'test_patch', 'eval_script', 'problem_statement', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'image', 'log_parser', 'eval_type'])
            hash.update(k).update('\0').update(String(row[k] ?? '')).update('\0');
        const taskHash = hash.digest('hex');
        const dir = join(this.poolDir(project), id);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(join(dir, 'solution'), { recursive: true });
        writeFileSync(join(dir, 'instance.json'), JSON.stringify(row, null, 2) + '\n');
        writeFileSync(join(dir, 'verify.py'), VERIFY_PY);
        writeFileSync(join(dir, 'solution', 'patch.diff'), row.patch.endsWith('\n') ? row.patch : row.patch + '\n');
        writeFileSync(join(dir, 'solution', 'solve.sh'), '#!/bin/bash\n# The reference fix, applied the way the harness applies a prediction.\nset -e\ncd /testbed\ngit apply --verbose /solution/patch.diff || git apply --verbose --3way /solution/patch.diff || (git checkout -- . && patch --batch --forward --fuzz=5 -p1 -i /solution/patch.diff)\n');
        const meta = {
            name: id,
            title: `${id} (${row.repo})`,
            turns: 1,
            category: 'public',
            tags: [DATASET, row.repo.split('/')[1] ?? row.repo, ...(row.difficulty ? [row.difficulty] : [])],
            stressor: `SWE-bench Verified (${index.version}) · ${row.repo} ${row.version} · ${row.difficulty ?? 'unrated'}`,
            runtime: 'container',
            image: row.image,
            platform: 'amd64',
            workdir: '/testbed',
            cpus: 2,
            memory_mb: 4096,
            turn_timeout_s: 1800,
            verifier_timeout_s: 1800,
            verifier_python: python,
            network: true,
            oracle: 'required',
            origin: { benchmark: DATASET, version: index.version, id, gitUrl: `https://github.com/${row.repo}`, commit: row.base_commit, path: `${HF_DATASET}#${task.row ?? '?'}`, license: LICENSE, taskHash },
        };
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
        writeFileSync(join(dir, 'prompts.json'), JSON.stringify([instructionFor(row)], null, 2) + '\n');
        log(`wrote ${dir} (task hash ${taskHash.slice(0, 12)})`);
        return { dir, task, taskHash };
    },
    remove(project, id) {
        const dir = join(this.poolDir(project), id);
        if (!existsSync(dir))
            return false;
        rmSync(dir, { recursive: true, force: true });
        const pool = this.poolDir(project);
        if (existsSync(pool) && readdirSync(pool).length === 0)
            rmSync(pool, { recursive: true, force: true });
        return true;
    },
};
