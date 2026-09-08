/**
 * The contract a public-benchmark adapter fulfils: a dataset's task index,
 * what each task needs (image, size, platform), and how one task becomes a
 * scenario directory — nothing is downloaded until a task is picked.
 */
import type { Project } from '../project.js'

export interface BenchTask {
  id: string
  title: string
  category?: string
  difficulty?: string
  tags: string[]
  /** Prebuilt image the task runs in, and what is known about it. */
  image: string
  platforms?: Array<'amd64' | 'arm64'>
  imageMb?: number
  cpus?: number
  memoryMb?: number
  agentTimeoutS?: number
  verifierTimeoutS?: number
  /** The dataset's own estimate of an expert's time, in minutes. */
  expertMinutes?: number
  /** Provenance for the receipt. */
  source: { gitUrl: string; commit: string; path: string }
}

export interface BenchIndex {
  dataset: string
  version: string
  license: string
  fetchedAt: string
  tasks: BenchTask[]
}

export interface Fetcher { (url: string): Promise<string> }

export interface MaterializeOptions {
  fetcher?: Fetcher
  log?: (line: string) => void
  /** Pull the task image (default true); false writes the scenario only. */
  pull?: boolean
  /** Docker command runner, replaceable in tests; `stdout` carries `docker inspect` answers. */
  docker?: (args: string[]) => Promise<{ code: number; stderr: string; stdout?: string }>
  /** Interpreter for a host-side verifier that needs its own environment (tests pass one so no venv is built). */
  verifierPython?: string
}

export interface BenchAdapter {
  /** Dataset id used on the command line and as the pool directory name. */
  id: string
  title: string
  version: string
  license: string
  /** One line the shelf shows under the title: what a task costs to get, what it needs. */
  note: string
  /** The task index: fetched once and cached in the project; `refresh` refetches. */
  index(project: Project, options?: { fetcher?: Fetcher; refresh?: boolean; log?: (line: string) => void }): Promise<BenchIndex>
  /** Facts about the task's image from its registry (size, platforms); null when the registry does not answer. */
  describeImage(image: string, fetcher?: Fetcher): Promise<{ platforms: Array<'amd64' | 'arm64'>; sizeMb: number } | null>
  /** Download the task's files and image and write the scenario directory; returns its path. */
  materialize(project: Project, id: string, options?: MaterializeOptions): Promise<{ dir: string; task: BenchTask; taskHash: string }>
  remove(project: Project, id: string): boolean
  /** Directory of this dataset's pool inside the project. */
  poolDir(project: Project): string
}


/** What Docker Hub knows about an image tag: the platforms it is built for and its compressed size. Null when it does not answer. */
export async function dockerHubImage(image: string, fetcher: Fetcher = defaultFetch): Promise<{ platforms: Array<'amd64' | 'arm64'>; sizeMb: number } | null> {
  const m = /^([^:]+):(.+)$/.exec(image)
  if (!m) return null
  const repo = m[1]!.includes('/') ? m[1]! : `library/${m[1]!}`
  try {
    const d = JSON.parse(await fetcher(`https://hub.docker.com/v2/repositories/${repo}/tags/${m[2]!}`)) as { images?: Array<{ architecture: string; size: number }> }
    const images = (d.images ?? []).filter(i => i.size > 0)
    if (images.length === 0) return null
    const platforms = [...new Set(images.map(i => i.architecture))].filter((a): a is 'amd64' | 'arm64' => a === 'amd64' || a === 'arm64')
    return { platforms, sizeMb: Math.round(Math.max(...images.map(i => i.size)) / 1e6) }
  } catch { return null }
}

/** Pull an image unless it is already present: a registry that will not answer must not block a task whose image is on the machine. */
export async function ensureImage(image: string, docker: (args: string[]) => Promise<{ code: number; stderr: string; stdout?: string }>, log: (line: string) => void, sizeNote = ''): Promise<void> {
  const present = await docker(['image', 'inspect', image])
  if (present.code === 0) { log(`${image} is already on this machine`); return }
  log(`pulling ${image} (linux/amd64${sizeNote})…`)
  let pulled = await docker(['pull', '--platform', 'linux/amd64', image])
  if (pulled.code !== 0) { await new Promise(r => setTimeout(r, 3000)); pulled = await docker(['pull', '--platform', 'linux/amd64', image]) }
  if (pulled.code !== 0) throw new Error(`docker pull ${image} failed: ${pulled.stderr.trim().split('\n').at(-1) ?? pulled.code}`)
}

/** Plain GET with three attempts: an index is dozens of small files, and one dropped connection must not fail it. */
export async function defaultFetch(url: string): Promise<string> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // A GitHub token, when the environment has one (CI usually does), lifts the API's 60-an-hour anonymous limit.
      const token = url.startsWith('https://api.github.com/') ? (process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']) : undefined
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-eval', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
      if (res.status === 404) throw new Error(`${url}: HTTP 404`)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      last = e
      if (String(e).includes('HTTP 404')) break
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}
