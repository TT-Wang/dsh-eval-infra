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
}

export interface BenchAdapter {
  /** Dataset id used on the command line and as the pool directory name. */
  id: string
  title: string
  version: string
  license: string
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
