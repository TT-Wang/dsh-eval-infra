/**
 * Project layout: a project (any directory, usually a plugin repo) keeps its
 * eval state under `.dsh-eval/` — an isolated dsh home with the `eval`
 * profile, the run archive, and a small config — while arms and scenarios
 * live in version control under `bench/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ProjectConfig {
  profile: string
  scenarioRoot?: string
  armsDir?: string
  dshBin?: string
  repeats: number
  concurrency: number
  /** Extra scenario roots (pools) searched after the project's own. */
  pools?: string[]
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
