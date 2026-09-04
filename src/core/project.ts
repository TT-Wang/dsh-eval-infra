/**
 * Project layout: a project (any directory, usually a plugin repo) keeps its
 * eval state under `.dsh-eval/` — an isolated dsh home with the `eval`
 * profile, the run archive, and a small config — while arms and scenarios
 * live in version control under `bench/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEEPSEEK_PRICES, type ModelPrice, type PriceTable } from './pricing.js'

export interface ProjectConfig {
  profile: string
  scenarioRoot?: string
  armsDir?: string
  dshBin?: string
  repeats: number
  concurrency: number
  /** Extra scenario roots (pools) searched after the project's own. */
  pools?: string[]
  /** Directories scanned for local dsh plugin checkouts (defaults to ~/code and ~/src). */
  pluginRoots?: string[]
  /** Judge models available to `dsh-eval judge`: OpenAI-compatible endpoints from any provider family. */
  judges?: Array<{ name?: string; model: string; baseUrl?: string; apiKeyEnv?: string; family?: string }>
  /** Extra or overriding prices (USD per million tokens, peak/off-peak) merged over the built-in DeepSeek table. */
  prices?: { asOf?: string; models: Record<string, ModelPrice>; peak?: PriceTable['peak'] }
}

/** The project's price table: the built-in DeepSeek table with the config's models merged over it (undefined when the config adds nothing). */
export function projectPrices(config: ProjectConfig): PriceTable | undefined {
  if (!config.prices) return undefined
  return { ...DEEPSEEK_PRICES, ...(config.prices.asOf ? { asOf: config.prices.asOf } : {}), models: { ...DEEPSEEK_PRICES.models, ...config.prices.models }, peak: config.prices.peak ?? DEEPSEEK_PRICES.peak }
}

export interface Project {
  root: string
  evalDir: string
  home: string
  runsRoot: string
  config: ProjectConfig
  configPath: string
  armsDir: string
  scenarioRoot: string
  bundledScenarioRoot: string
}

/**
 * Bundles a profile activates for every arm. A plugin that declares `dsh.bundle`
 * is added here the moment it is installed, which puts it in both arms of every
 * comparison and makes it impossible to measure. `setProfileBundles` is how an
 * eval project takes it back out while keeping the package installed, so an arm
 * can still reference it.
 */
export function profileBundles(evalHome: string, profile: string): string[] {
  const manifest = join(evalHome, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return []
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    return parsed.dsh?.profile?.bundles ?? []
  } catch { return [] }
}

export function setProfileBundles(evalHome: string, profile: string, bundles: string[]): void {
  const manifest = join(evalHome, 'profiles', profile, 'package.json')
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
  const dsh = (parsed['dsh'] ?? {}) as Record<string, unknown>
  const prof = (dsh['profile'] ?? {}) as Record<string, unknown>
  parsed['dsh'] = { ...dsh, profile: { ...prof, bundles } }
  writeFileSync(manifest, JSON.stringify(parsed, null, 2) + '\n')
}

export const DEFAULT_CONFIG: ProjectConfig = { profile: 'eval', repeats: 3, concurrency: 2 }

/** The scenario library shipped with this package. */
export function bundledScenarioRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // lib/core → ../../bench/scenarios ; src/core → same
  return resolve(here, '..', '..', 'bench', 'scenarios')
}

export function loadProject(root = process.cwd()): Project {
  const abs = resolve(root)
  const evalDir = join(abs, '.dsh-eval')
  const configPath = join(evalDir, 'config.json')
  const config: ProjectConfig = existsSync(configPath) ? { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, 'utf8')) as Partial<ProjectConfig>) } : { ...DEFAULT_CONFIG }
  const armsDir = config.armsDir !== undefined ? resolve(abs, config.armsDir) : join(abs, 'bench', 'arms')
  const ownScenarios = config.scenarioRoot !== undefined ? resolve(abs, config.scenarioRoot) : join(abs, 'bench', 'scenarios')
  const bundled = bundledScenarioRoot()
  return {
    root: abs,
    evalDir,
    home: join(evalDir, 'home'),
    runsRoot: evalDir,
    config,
    configPath,
    armsDir,
    scenarioRoot: existsSync(ownScenarios) ? ownScenarios : bundled,
    bundledScenarioRoot: bundled,
  }
}

export function saveProjectConfig(project: Project): void {
  mkdirSync(project.evalDir, { recursive: true })
  writeFileSync(project.configPath, JSON.stringify(project.config, null, 2) + '\n')
}

/** Files of the eval profile inside the isolated home (same shape dsh's own initProfile writes). */
export function ensureEvalProfile(home: string, profile: string): string {
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' } },
    }, null, 2) + '\n')
  }
  const patch = join(dir, 'cordis.patch.yml')
  if (!existsSync(patch)) writeFileSync(patch, '# Profile-level patch layer shared by every arm. Put per-arm differences in bench/arms/*.yml instead.\n[]\n')
  const workspace = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) writeFileSync(workspace, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  return dir
}

export const STARTER_BASELINE = `# Baseline arm: the stock dsh composition (dsh-base + sdk-app) with no changes.
name: baseline
description: stock dsh, nothing added
# model: deepseek-v4-flash
# effort: high
`

export function starterCandidate(pluginName: string | undefined): string {
  const insert = pluginName !== undefined
    ? `patches:
  - insert:
      - id: ${pluginName.replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/gi, '-')}
        name: '${pluginName}'
        # config: {}
`
    : `patches:
  # Example: change one thing. A row is addressed by its id in \`dsh --dump-config\`.
  - id: system-prompt
    config:
      persona: >-
        You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
        Verify your work by re-reading files before you report done.
`
  return `# Candidate arm: baseline plus exactly one change.
name: candidate
description: ${pluginName !== undefined ? `baseline + ${pluginName}` : 'baseline + a persona change'}
${insert}`
}
