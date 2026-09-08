/**
 * Terminal-Bench 2.0 (Laude Institute / Harbor), Apache-2.0: 89 command-line
 * tasks, each a directory with instruction.md, task.toml, tests/ (test.sh +
 * pytest) and solution/solve.sh, and each with a prebuilt Docker image named
 * in task.toml. The registry pins the git commit; the files are read at that
 * commit. Our scenario for a task is its own files plus a meta.json that
 * says `runtime: container`, so the runner opens the image, runs the dsh
 * runtime inside it and grades with the task's tests — the benchmark's own
 * harness contract, not a translation of it.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '../project.js'
import { defaultFetch, type BenchAdapter, type BenchIndex, type BenchTask, type Fetcher, type MaterializeOptions } from './types.js'

const REGISTRY = 'https://raw.githubusercontent.com/harbor-framework/harbor/main/registry.json'
const DATASET = 'terminal-bench'
const VERSION = '2.0'
const LICENSE = 'Apache-2.0'

/** Minimal TOML: scalars, arrays of scalars, inline tables skipped, [section] headers. Enough for a task.toml. */
export function parseToml(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { '': {} }
  let section = ''
  const scalar = (raw: string): unknown => {
    const v = raw.trim()
    if (/^".*"$/.test(v)) return v.slice(1, -1)
    if (/^'.*'$/.test(v)) return v.slice(1, -1)
    if (v === 'true') return true
    if (v === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    return v
  }
  for (const line of text.split('\n')) {
    const l = line.replace(/^\s*#.*$/, '').trim()
    if (l === '') continue
    const h = /^\[([^\]]+)\]$/.exec(l)
    if (h) { section = h[1]!.trim(); out[section] ??= {}; continue }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(l)
    if (!kv) continue
    const key = kv[1]!
    const raw = kv[2]!.trim()
    if (raw.startsWith('[')) {
      const inner = raw.replace(/^\[/, '').replace(/,?\s*\]\s*$/, '')
      out[section]![key] = inner.trim() === '' ? [] : inner.split(',').map(x => scalar(x)).filter(x => x !== '')
    } else if (raw.startsWith('{')) {
      continue
    } else out[section]![key] = scalar(raw.replace(/\s+#.*$/, ''))
  }
  return out
}

interface RegistryTask { name: string; git_url: string; git_commit_id: string; path: string }

function rawUrl(t: RegistryTask, file: string): string {
  const repo = t.git_url.replace(/\.git$/, '').replace('https://github.com/', '')
  return `https://raw.githubusercontent.com/${repo}/${t.git_commit_id}/${t.path}/${file}`
}

function contentsUrl(t: RegistryTask, dir: string): string {
  const repo = t.git_url.replace(/\.git$/, '').replace('https://github.com/', '')
  return `https://api.github.com/repos/${repo}/contents/${t.path}/${dir}?ref=${t.git_commit_id}`
}

async function registryTasks(fetcher: Fetcher): Promise<RegistryTask[]> {
  const parsed = JSON.parse(await fetcher(REGISTRY)) as unknown
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>).find(v => Array.isArray(v)) as unknown[] | undefined
  const dataset = (list ?? []).find((d): d is { name: string; version: string; tasks: RegistryTask[] } => typeof d === 'object' && d !== null && (d as { name?: string }).name === DATASET && (d as { version?: string }).version === VERSION)
  if (!dataset) throw new Error(`registry has no ${DATASET}@${VERSION}`)
  return dataset.tasks
}

function taskFromToml(t: RegistryTask, toml: string): BenchTask {
  const cfg = parseToml(toml)
  const meta = cfg['metadata'] ?? {}
  const env = cfg['environment'] ?? {}
  const agent = cfg['agent'] ?? {}
  const verifier = cfg['verifier'] ?? {}
  const memory = typeof env['memory'] === 'string' ? /^(\d+)\s*([GgMm])/.exec(env['memory']) : null
  const memoryMb = typeof env['memory_mb'] === 'number' ? env['memory_mb'] : memory ? Number(memory[1]) * (memory[2]!.toLowerCase() === 'g' ? 1024 : 1) : undefined
  const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined
  const category = typeof meta['category'] === 'string' ? meta['category'] : undefined
  const difficulty = typeof meta['difficulty'] === 'string' ? meta['difficulty'] : undefined
  const cpus = num(env['cpus'])
  const agentTimeoutS = num(agent['timeout_sec'])
  const verifierTimeoutS = num(verifier['timeout_sec'])
  const expertMinutes = num(meta['expert_time_estimate_min'])
  return {
    id: t.name,
    title: t.name.replace(/[-_]+/g, ' '),
    ...(category !== undefined ? { category } : {}),
    ...(difficulty !== undefined ? { difficulty } : {}),
    tags: Array.isArray(meta['tags']) ? (meta['tags'] as unknown[]).map(String) : [],
    image: typeof env['docker_image'] === 'string' ? env['docker_image'] : '',
    ...(cpus !== undefined ? { cpus } : {}),
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(agentTimeoutS !== undefined ? { agentTimeoutS } : {}),
    ...(verifierTimeoutS !== undefined ? { verifierTimeoutS } : {}),
    ...(expertMinutes !== undefined ? { expertMinutes } : {}),
    source: { gitUrl: t.git_url, commit: t.git_commit_id, path: t.path },
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => { for (;;) { const i = next++; const item = items[i]; if (item === undefined) return; out[i] = await fn(item) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

function dockerRun(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null
      resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : 1, stderr: String(stderr ?? '') })
    })
  })
}

export const terminalBench: BenchAdapter = {
  id: DATASET,
  title: 'Terminal-Bench',
  version: VERSION,
  license: LICENSE,

  poolDir(project) { return join(project.benchRoot, `${DATASET}-${VERSION}`) },

  async index(project, options = {}) {
    const fetcher = options.fetcher ?? defaultFetch
    const cacheDir = join(project.evalDir, 'bench', `${DATASET}-${VERSION}`)
    const cache = join(cacheDir, 'index.json')
    if (!options.refresh && existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as BenchIndex
    options.log?.(`fetching the ${DATASET} ${VERSION} task index (89 small files, no images)`)
    const tasks = await registryTasks(fetcher)
    // A task whose task.toml cannot be read right now is listed by name with no image, not dropped: the index says what exists.
    const failed: string[] = []
    const entries = await mapLimit(tasks, 8, async (t) => {
      try { return taskFromToml(t, await fetcher(rawUrl(t, 'task.toml'))) }
      catch (e) { failed.push(`${t.name}: ${e instanceof Error ? e.message : String(e)}`); return { id: t.name, title: t.name.replace(/[-_]+/g, ' '), tags: [], image: '', source: { gitUrl: t.git_url, commit: t.git_commit_id, path: t.path } } satisfies BenchTask }
    })
    if (failed.length > 0) options.log?.(`${failed.length} task(s) could not be indexed this time (run with --refresh to retry): ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}`)
    const index: BenchIndex = { dataset: DATASET, version: VERSION, license: LICENSE, fetchedAt: new Date().toISOString(), tasks: entries }
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cache, JSON.stringify(index, null, 2))
    return index
  },

  async describeImage(image, fetcher = defaultFetch) {
    const m = /^([^:]+):(.+)$/.exec(image)
    if (!m) return null
    const repo = m[1]!.includes('/') ? m[1]! : `library/${m[1]!}`
    try {
      const d = JSON.parse(await fetcher(`https://hub.docker.com/v2/repositories/${repo}/tags/${m[2]!}`)) as { images?: Array<{ architecture: string; size: number }> }
      const images = d.images ?? []
      if (images.length === 0) return null
      const platforms = [...new Set(images.map(i => i.architecture))].filter((a): a is 'amd64' | 'arm64' => a === 'amd64' || a === 'arm64')
      return { platforms, sizeMb: Math.round(Math.max(...images.map(i => i.size)) / 1e6) }
    } catch { return null }
  },

  async materialize(project, id, options = {}) {
    const fetcher = options.fetcher ?? defaultFetch
    const log = options.log ?? (() => { /* quiet */ })
    const index = await this.index(project, { fetcher, log })
    const task = index.tasks.find(t => t.id === id)
    if (!task) throw new Error(`${DATASET}: no task "${id}" (run: dsh-eval bench list ${DATASET})`)
    if (task.image === '') throw new Error(`${DATASET}/${id}: task.toml names no docker_image`)
    const reg: RegistryTask = { name: task.id, git_url: task.source.gitUrl, git_commit_id: task.source.commit, path: task.source.path }
    const dir = join(this.poolDir(project), id)
    const files = new Map<string, string>()
    files.set('instruction.md', await fetcher(rawUrl(reg, 'instruction.md')))
    files.set('task.toml', await fetcher(rawUrl(reg, 'task.toml')))
    for (const sub of ['tests', 'solution']) {
      const listing = JSON.parse(await fetcher(contentsUrl(reg, sub))) as Array<{ type: string; name: string; download_url: string | null; path: string }>
      for (const f of listing) {
        if (f.type !== 'file' || f.download_url === null) continue
        files.set(`${sub}/${f.name}`, await fetcher(f.download_url))
      }
    }
    if (!files.has('tests/test.sh')) throw new Error(`${DATASET}/${id}: no tests/test.sh at commit ${task.source.commit.slice(0, 10)}`)
    const hash = createHash('sha256')
    for (const name of [...files.keys()].sort()) hash.update(name).update('\0').update(files.get(name)!).update('\0')
    const taskHash = hash.digest('hex')
    if (options.pull !== false) {
      log(`pulling ${task.image} (linux/amd64${task.imageMb ? `, ${task.imageMb} MB compressed` : ''})…`)
      const pulled = await (options.docker ?? dockerRun)(['pull', '--platform', 'linux/amd64', task.image])
      if (pulled.code !== 0) throw new Error(`docker pull ${task.image} failed: ${pulled.stderr.trim().split('\n').at(-1) ?? pulled.code}`)
    }
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'tests'), { recursive: true })
    mkdirSync(join(dir, 'solution'), { recursive: true })
    for (const [name, text] of files) writeFileSync(join(dir, name), text)
    const instruction = files.get('instruction.md')!.split('\n').filter(l => !/^(<!--.*canary.*-->|#.*canary.*)$/i.test(l.trim())).join('\n').trim()
    const meta = {
      name: id,
      title: `${task.title} (${index.dataset} ${index.version})`,
      turns: 1,
      category: 'public',
      tags: [index.dataset, ...(task.category ? [task.category.toLowerCase()] : []), ...task.tags],
      ...(task.difficulty ? { stressor: `${index.dataset} ${index.version} · ${task.category ?? 'uncategorised'} · ${task.difficulty}` } : {}),
      runtime: 'container',
      image: task.image,
      platform: 'amd64',
      ...(task.cpus !== undefined ? { cpus: task.cpus } : {}),
      ...(task.memoryMb !== undefined ? { memory_mb: task.memoryMb } : {}),
      turn_timeout_s: task.agentTimeoutS ?? 900,
      verifier_timeout_s: task.verifierTimeoutS ?? 900,
      network: true,
      oracle: files.has('solution/solve.sh') ? 'required' : 'none',
      origin: { benchmark: index.dataset, version: index.version, id, gitUrl: task.source.gitUrl, commit: task.source.commit, path: task.source.path, license: index.license, taskHash },
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    writeFileSync(join(dir, 'prompts.json'), JSON.stringify([instruction], null, 2) + '\n')
    log(`wrote ${dir} (${files.size} files, task hash ${taskHash.slice(0, 12)})`)
    return { dir, task, taskHash }
  },

  remove(project, id) {
    const dir = join(this.poolDir(project), id)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    const pool = this.poolDir(project)
    if (existsSync(pool) && readdirSync(pool).length === 0) rmSync(pool, { recursive: true, force: true })
    return true
  },
}
