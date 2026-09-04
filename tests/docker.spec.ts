import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTAINER_OVERLAY_ROWS, dockerArgs, linkedPluginPaths } from '../src/core/docker.js'
import { writeBaseOverlays } from '../src/core/runner.js'

const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('docker sandbox', () => {
  it('builds a docker command that mounts only the checkout (ro), eval home, workspace, run dir and linked plugins, with --mount syntax and --expose-internals', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-eval-docker-'))); tmp.push(root)
    const src = join(root, 'dsh'); mkdirSync(join(src, 'apps', 'cli', 'lib'), { recursive: true }); writeFileSync(join(src, 'apps', 'cli', 'lib', 'bin.js'), '')
    const home = join(root, 'home'); const plugin = join(root, 'my-plugin'); mkdirSync(plugin)
    mkdirSync(join(home, 'profiles', 'eval', 'node_modules', '@x'), { recursive: true })
    symlinkSync(plugin, join(home, 'profiles', 'eval', 'node_modules', '@x', 'my-plugin'))
    const work = join(root, 'work'); mkdirSync(work)
    const runDir = join(root, 'run'); mkdirSync(runDir)
    const overlay = join(runDir, 'a.patch.yml'); writeFileSync(overlay, '[]')
    expect(linkedPluginPaths(home, 'eval')).toEqual([plugin])
    const input = { arm: { name: 'a', profile: 'eval', provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high', overlayPath: overlay, patchFilePaths: [] }, scenario: {} as never, workdir: work, evalHome: home, overlays: [overlay], env: { DEEPSEEK_API_KEY: 'k' } }
    const args = dockerArgs(input as never, { dshSource: src, nativeShims: [[join(root, 'shim'), join(src, 'node_modules', '.pnpm', 'koffi@1', 'node_modules', '@koromix')]] }, runDir)
    const joined = args.join(' ')
    expect(args[0]).toBe('run')
    expect(joined).not.toContain(' -v ')
    expect(joined).toContain(`type=bind,source=${src},target=${src},readonly`)
    expect(joined).toContain(`type=bind,source=${home},target=${home}`)
    expect(joined).toContain(`type=bind,source=${plugin},target=${plugin},readonly`)
    expect(joined).toContain(`type=bind,source=${runDir},target=${runDir},readonly`)
    // a checkout reached through a symlink also mounts the link's directory so plugin dependency links resolve inside the container
    const linkDir = join(root, 'dshhome', 'source'); mkdirSync(linkDir, { recursive: true }); symlinkSync(src, join(linkDir, 'current'))
    const viaLink = dockerArgs(input as never, { dshSource: join(linkDir, 'current') }, runDir).join(' ')
    expect(viaLink).toContain(`type=bind,source=${linkDir},target=${linkDir},readonly`)
    expect(viaLink).toContain(`type=bind,source=${src},target=${src},readonly`)
    expect(joined).toContain('--expose-internals')
    expect(joined).toContain(`-e DSH_HOME=${home}`)
    expect(joined).toContain('-e DEEPSEEK_API_KEY')
    expect(joined).not.toContain('DEEPSEEK_API_KEY=k')
    expect(args.slice(-2)).toEqual(['--patch', overlay])
    expect(args).toContain('node:22-bookworm-slim')
  })
  it('container overlay rows switch off the in-process sandbox and the permission presets and add the plain executor', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-docker-')); tmp.push(root)
    const base = writeBaseOverlays(join(root, 'arms'), CONTAINER_OVERLAY_ROWS)
    const text = readFileSync(base.noNetwork, 'utf8')
    expect(text).toContain('bash-sandbox')
    expect(text).toContain('permission')
    expect(text).toContain('dsh-bash-local')
    expect(text).toContain('tool-web')
  })
})

describe('container runtime options', () => {
  it('passes the runtime and the keep-sandbox security options through', async () => {
    const { dockerArgs } = await import('../src/core/docker.js')
    const { mkdtempSync, mkdirSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-docker-'))
    const src = join(root, 'src'); mkdirSync(join(src, 'apps', 'cli', 'lib'), { recursive: true })
    const home = join(root, 'home'); mkdirSync(home)
    const work = join(root, 'work'); mkdirSync(work)
    const run = join(root, 'run'); mkdirSync(run)
    const input = { arm: { name: 'a', profile: 'eval', provider: 'deepseek', model: 'deepseek-v4-flash', overlays: [], env: {} } as any, scenario: {} as any, workdir: work, evalHome: home, overlays: [], env: {} }
    const args = dockerArgs(input, { dshSource: realpathSync(src), runtime: 'runsc', keepDshSandbox: true }, run)
    expect(args).toContain('--runtime')
    expect(args[args.indexOf('--runtime') + 1]).toBe('runsc')
    expect(args).toContain('seccomp=unconfined')
    expect(args).toContain('SYS_ADMIN')
    const plain = dockerArgs(input, { dshSource: realpathSync(src) }, run)
    expect(plain).not.toContain('--runtime')
    expect(plain).not.toContain('SYS_ADMIN')
  })
})

describe('portability', () => {
  it('asks Docker for this machine\'s architecture, not the one it was written on', async () => {
    const { dockerArgs } = await import('../src/core/docker.js')
    const { mkdtempSync, mkdirSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-arch-'))
    for (const d of ['src/apps/cli/lib', 'home', 'work', 'run']) mkdirSync(join(root, d), { recursive: true })
    const input = { arm: { name: 'a', profile: 'eval', provider: 'deepseek', model: 'm', overlays: [], env: {} } as any, scenario: {} as any, workdir: join(root, 'work'), evalHome: join(root, 'home'), overlays: [], env: {} }
    const args = dockerArgs(input, { dshSource: realpathSync(join(root, 'src')) }, join(root, 'run'))
    const platform = args[args.indexOf('--platform') + 1]
    expect(platform).toBe(process.arch === 'x64' ? 'linux/amd64' : 'linux/arm64')
    // and an explicit platform still wins, for cross-architecture runs
    const forced = dockerArgs(input, { dshSource: realpathSync(join(root, 'src')), platform: 'amd64' }, join(root, 'run'))
    expect(forced[forced.indexOf('--platform') + 1]).toBe('linux/amd64')
  })

  it('never puts this machine\'s home directory in text meant for someone else', async () => {
    const { tilde } = await import('../src/core/env.js')
    const { homedir } = await import('node:os')
    const home = homedir()
    expect(tilde(`${home}/code/thing`)).toBe('~/code/thing')
    expect(tilde(`ledgers: ${home}/a and ${home}/b`)).toBe('ledgers: ~/a and ~/b')
    expect(tilde('/opt/elsewhere')).toBe('/opt/elsewhere')
  })
})
