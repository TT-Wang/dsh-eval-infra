#!/usr/bin/env node
/**
 * Link the DeepSeek Harness peer packages into node_modules for local development.
 * Peers are provided by the host at runtime and are declared only as peerDependencies.
 * Resolution order for the harness checkout: $DSH_SOURCE, $DSH_HOME/source/current, ~/.dsh/source/current.
 * Usage: npm run link:dsh
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Peer package name → fallback path inside the harness checkout (discovery by manifest name comes first). */
const PEERS = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-sdk-client': 'packages/sdk/client',
  '@deepseek-ai/dsh-sdk-protocol': 'packages/sdk/protocol',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
}

function resolveHarness() {
  const candidates = [
    process.env.DSH_SOURCE,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(homedir(), '.dsh', 'source', 'current'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'packages', 'core', 'agent', 'package.json'))) return candidate
  }
  console.error('Could not find a DeepSeek Harness checkout. Set DSH_SOURCE or install dsh (~/.dsh/source/current).\nTried:\n' + candidates.map(c => `  ${c}`).join('\n'))
  process.exit(1)
}

const harness = resolveHarness()
const modules = join(REPO, 'node_modules')
const byName = new Map()
for (const root of ['packages', 'vendor']) {
  const rootDir = join(harness, root)
  if (!existsSync(rootDir)) continue
  for (const lvl1 of readdirSync(rootDir)) {
    const d = join(rootDir, lvl1)
    let subs = []
    try { subs = readdirSync(d).map(x => join(d, x)) } catch { subs = [] }
    for (const dir of [d, ...subs]) {
      const manifest = join(dir, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        const name = JSON.parse(readFileSync(manifest, 'utf8')).name
        if (name && !byName.has(name)) byName.set(name, dir)
      } catch { /* skip */ }
    }
  }
}
let linked = 0
for (const [name, subpath] of Object.entries(PEERS)) {
  const target = byName.get(name) ?? (existsSync(join(harness, subpath, 'package.json')) ? join(harness, subpath) : undefined)
  if (target === undefined) { console.error(`✗ ${name}: not found under ${harness}`); process.exitCode = 1; continue }
  const link = join(modules, name)
  mkdirSync(dirname(link), { recursive: true })
  try { if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) rmSync(link, { recursive: true, force: true }) } catch { /* nothing */ }
  symlinkSync(relative(dirname(link), target), link, 'dir')
  linked += 1
  console.log(`✓ ${name} -> ${relative(REPO, target)}`)
}
console.log(`\nlinked ${linked}/${Object.keys(PEERS).length} harness peers from ${harness}`)
