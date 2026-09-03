/**
 * Runtime environment helpers: API key discovery (never printed), the eval
 * home layout, and reproducibility facts recorded once per run.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Parse a dotenv-style file into a map (quotes stripped, `export` allowed). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m === null) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]!] = v
  }
  return out
}

/** The user's real dsh home (credentials live there); eval runs use a separate home. */
export function userDshHome(): string {
  const env = process.env['DSH_HOME']
  return env !== undefined && env.trim() !== '' ? resolve(env.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), '.dsh')
}

/**
 * Resolve the DeepSeek API key: process env first, then `$DSH_HOME/.env`, then `~/.dsh/.env`.
 * Returns undefined when none is found; callers decide whether that is fatal.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env['DEEPSEEK_API_KEY']
  if (direct !== undefined && direct.trim() !== '') return direct.trim()
  for (const file of [join(userDshHome(), '.env'), join(homedir(), '.dsh', '.env')]) {
    if (!existsSync(file)) continue
    const parsed = parseDotenv(readFileSync(file, 'utf8'))
    const k = parsed['DEEPSEEK_API_KEY']
    if (k !== undefined && k !== '') return k
  }
  return undefined
}

/** `dsh --version` output, or null when the CLI is unavailable. */
export async function dshVersion(bin = process.env['DSH_BIN'] ?? 'dsh'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 30_000 })
    return stdout.trim().split('\n').at(-1) ?? null
  } catch {
    return null
  }
}

/**
 * The dsh source checkout the local install points at, when discoverable.
 * By default the real path; `{ realpath: false }` returns the path as configured
 * (usually the `~/.dsh/source/current` link), which plugins' dependency links go
 * through and which container mounts therefore need.
 */
export function dshSourceRoot(options: { realpath?: boolean } = {}): string | null {
  const candidates = [process.env['DSH_SOURCE'], join(userDshHome(), 'source', 'current'), join(homedir(), '.dsh', 'source', 'current')].filter((c): c is string => c !== undefined)
  for (const c of candidates) {
    if (existsSync(join(c, 'packages', 'core', 'agent', 'package.json'))) {
      if (options.realpath === false) return c
      try { return realpathSync(c) } catch { return c }
    }
  }
  return null
}

/** Git revision of the dsh source checkout, when it is a git worktree. */
export async function dshSourceRevision(root: string | null): Promise<string | null> {
  if (root === null) return null
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { timeout: 10_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export function evalInfraVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
