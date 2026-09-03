/**
 * Containerised trials: the whole dsh runtime of one trial runs inside
 * `docker run` with three mounts — the dsh source checkout (read-only), the
 * eval home (profile, sessions) and the trial workspace — plus read-only
 * mounts of any plugin the eval profile links from the host. The container is
 * the confinement, so the arm overlay swaps dsh's in-process bash sandbox for
 * the plain executor. Network stays on (the model API must be reachable);
 * network *tools* are still governed by the scenario's `network` flag.
 */
import { existsSync, readdirSync, readlinkSync, lstatSync, realpathSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DriverFactory, DriverInput } from './runner.js'
import { RpcDriver, type RpcLaunch } from './rpc-driver.js'

export interface DockerOptions {
  image?: string
  /** dsh source checkout on the host (resolved like the CLI does). */
  dshSource: string
  /** Extra `docker run` arguments (e.g. `--memory 2g`). */
  extraArgs?: string[]
  /** Extra host paths to mount read-only at the same path (plugins linked into the profile are discovered automatically). */
  mounts?: string[]
  /** Linux native-module shims from `prepareNativeShims`: [hostDir, containerTarget] pairs mounted over the checkout. */
  nativeShims?: Array<[string, string]>
  onStderr?: (line: string) => void
}

export const DEFAULT_IMAGE = 'node:22-bookworm-slim'

/** Host directories the eval profile links (pnpm `link:` symlinks) — they must exist inside the container at the same path. */
export function linkedPluginPaths(evalHome: string, profile: string): string[] {
  const out = new Set<string>()
  const modules = join(evalHome, 'profiles', profile, 'node_modules')
  const walk = (dir: string, depth: number): void => {
    if (!existsSync(dir) || depth > 2) return
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(p)
        const abs = isAbsolute(target) ? target : resolve(dirname(p), target)
        let real = abs
        try { real = realpathSync(abs) } catch { /* dangling */ }
        if (!real.startsWith(evalHome)) out.add(real)
      } else if (st.isDirectory() && e.startsWith('@')) walk(p, depth + 1)
    }
  }
  walk(modules, 0)
  return [...out]
}

/**
 * dsh depends on Koffi (FFI) whose native binary comes from a per-platform
 * package; the host checkout only carries the host's. For the container we
 * fetch the Linux package of the same version once per eval home (npm pack)
 * and bind-mount it over the checkout's `@koromix` directory, shadowing the
 * macOS build. Returns the mount pairs, or [] when the checkout has no Koffi.
 */
export function prepareNativeShims(evalHome: string, dshSource: string, arch: 'arm64' | 'x64' = 'arm64', log?: (line: string) => void): Array<[string, string]> {
  const pnpm = join(realpathSync(dshSource), 'node_modules', '.pnpm')
  if (!existsSync(pnpm)) return []
  const mounts: Array<[string, string]> = []
  for (const entry of readdirSync(pnpm)) {
    const m = /^koffi@(\d+\.\d+\.\d+)$/.exec(entry)
    if (!m) continue
    const version = m[1]!
    const target = join(pnpm, entry, 'node_modules', '@koromix')
    if (!existsSync(target)) continue
    const shim = join(evalHome, 'docker', 'shims', `koffi-${version}-linux-${arch}`, '@koromix')
    const pkgDir = join(shim, `koffi-linux-${arch}`)
    if (!existsSync(join(pkgDir, 'package.json'))) {
      mkdirSync(shim, { recursive: true })
      const name = `@koromix/koffi-linux-${arch}@${version}`
      log?.(`fetching ${name} for the container (once per eval home)`)
      const tarball = execFileSync('npm', ['pack', name, '--pack-destination', shim, '--silent'], { encoding: 'utf8', timeout: 180_000 }).trim().split('\n').at(-1)!
      mkdirSync(pkgDir, { recursive: true })
      execFileSync('tar', ['-xzf', join(shim, tarball), '-C', pkgDir, '--strip-components', '1'], { timeout: 60_000 })
    }
    // keep the host's own platform package visible too, so the same mount works for host-side tooling that inspects it
    for (const e of readdirSync(target)) {
      const dest = join(shim, e)
      if (!existsSync(dest)) {
        try { execFileSync('cp', ['-R', join(target, e) + '/', dest], { timeout: 60_000 }) } catch { /* optional */ }
      }
    }
    mounts.push([shim, target])
  }
  return mounts
}

export function dockerArgs(input: DriverInput, options: DockerOptions, runDir: string): string[] {
  const image = options.image ?? DEFAULT_IMAGE
  const args = ['run', '-i', '--rm', '--init', '--platform', 'linux/arm64']
  const mounts = new Map<string, 'ro' | 'rw'>()
  mounts.set(realpathSync(options.dshSource), 'ro')
  // Plugins linked into the profile resolve their dsh peers through the install's symlink path (e.g. ~/.dsh/source/current), so
  // that path must exist inside the container too: mount the directory holding the `current` link, read-only.
  const given = resolve(options.dshSource)
  if (realpathSync(given) !== given) {
    const linkParent = dirname(given)
    if (existsSync(linkParent)) mounts.set(realpathSync(linkParent), 'ro')
  }
  mounts.set(realpathSync(input.evalHome), 'rw')
  mounts.set(realpathSync(input.workdir), 'rw')
  mounts.set(realpathSync(runDir), 'ro')
  for (const p of linkedPluginPaths(input.evalHome, input.arm.profile)) if (existsSync(p)) mounts.set(p, 'ro')
  for (const p of options.mounts ?? []) if (existsSync(p)) mounts.set(realpathSync(p), 'ro')
  // `--mount` rather than `-v`: Docker's -v parser mangles a same-path spec that ends in ":ro" (observed: target "…rc1o").
  for (const [path, mode] of mounts) args.push('--mount', `type=bind,source=${path},target=${path}${mode === 'ro' ? ',readonly' : ''}`)
  for (const [source, target] of options.nativeShims ?? []) args.push('--mount', `type=bind,source=${source},target=${target},readonly`)
  args.push('-w', realpathSync(input.workdir))
  args.push('-e', `DSH_HOME=${realpathSync(input.evalHome)}`)
  args.push('-e', 'DSH_TELEMETRY_DISABLED=1')
  args.push('-e', 'NODE_OPTIONS=--max-old-space-size=2048')
  for (const k of ['DEEPSEEK_API_KEY']) if (input.env[k] !== undefined) args.push('-e', k)
  for (const [k, v] of Object.entries(input.arm.env ?? {})) args.push('-e', `${k}=${v}`)
  args.push(...(options.extraArgs ?? []))
  // dsh's loader imports plugins through Node's internal ESM loader; on the host it reaches it via a native addon built for that
  // platform, inside a Linux container it needs `--expose-internals` (the loader checks execArgv for exactly this flag).
  args.push(image, 'node', '--expose-internals', join(realpathSync(options.dshSource), 'apps', 'cli', 'lib', 'bin.js'), '--profile', input.arm.profile)
  for (const overlay of input.overlays) args.push('--patch', realpathSync(overlay))
  return args
}

/** Docker-backed driver: one container per trial. */
export function dockerDriverFactory(options: DockerOptions, runDir: string): DriverFactory {
  return (input: DriverInput) => {
    const launch: RpcLaunch = {
      command: 'docker',
      args: dockerArgs(input, options, runDir),
      env: { ...process.env as Record<string, string>, ...input.env },
      runtimeCwd: realpathSync(input.workdir),
      provider: input.arm.provider,
      model: input.arm.model,
      initializeTimeoutMs: 180_000,
      ...(input.arm.effort !== undefined ? { effort: input.arm.effort } : {}),
      ...(input.arm.maxTokens !== undefined ? { maxTokens: input.arm.maxTokens } : {}),
      ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
    }
    return new RpcDriver(launch)
  }
}

/** Overlay rows that make a profile run inside a container: the in-process sandbox off, the plain bash executor on. */
export const CONTAINER_OVERLAY_ROWS = [
  // Rows that need native modules built for the host platform (sharp for image attachments); text scenarios do not use them.
  { id: 'attachment-local', disabled: true },
  // The container is the confinement boundary: dsh's in-process sandbox needs bubblewrap or Landlock, neither of which a stock
  // Docker kernel provides, so the plain bash executor runs and the permission-preset row (which refuses an unconfined executor) is off.
  { id: 'bash-sandbox', disabled: true },
  { id: 'permission', disabled: true },
  { insert: [{ id: 'bash-local', name: '@deepseek-ai/dsh-bash-local', config: { timeoutMs: 60000 } }] },
]

/** Whether the docker CLI and daemon are reachable. */
export async function dockerAvailable(): Promise<{ ok: boolean; detail: string }> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolveP) => {
    execFile('docker', ['info', '--format', '{{.ServerVersion}} {{.OSType}}/{{.Architecture}}'], { timeout: 20_000 }, (err, stdout) => {
      if (err) resolveP({ ok: false, detail: err.message.split('\n')[0] ?? 'docker unavailable' })
      else resolveP({ ok: true, detail: stdout.trim() })
    })
  })
}
