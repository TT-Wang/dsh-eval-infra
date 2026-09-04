/**
 * Taking in a scenario someone else wrote.
 *
 * A scenario is five files in a directory, and the only one that can quietly
 * ruin a run is `verify.py`: a verifier that always says pass turns every
 * comparison into noise. So intake does not just copy files in. It writes them
 * into the project's own library, then runs the same selfcheck the runner
 * demands: the untouched workspace must fail and the reference answer must
 * pass. A scenario that cannot show both is reported, not silently accepted.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadScenario } from './scenario.js'
import { selfcheckScenario } from './selfcheck.js'
import type { Project } from './project.js'

/** Files a scenario directory may contain; anything else is refused rather than written. */
export const SCENARIO_FILES = ['meta.json', 'prompts.json', 'setup.py', 'verify.py', 'oracle.py', 'prompts.variants.json'] as const
const REQUIRED = ['meta.json', 'prompts.json', 'verify.py'] as const

export interface IntakeResult {
  name: string
  dir: string
  written: string[]
  /** The selfcheck the runner would demand before using this scenario. */
  selfcheck: { ok: boolean; blankFails: boolean; oraclePasses: boolean; detail: string }
}

export async function addScenario(project: Project, name: string, files: Record<string, string>): Promise<IntakeResult> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error('the scenario name must be a short identifier: letters, digits, _ or -')
  const given = Object.keys(files)
  for (const f of REQUIRED) if (!given.includes(f)) throw new Error(`${f} is required; a scenario needs at least meta.json, prompts.json and verify.py`)
  const unknown = given.filter(f => !(SCENARIO_FILES as readonly string[]).includes(f))
  if (unknown.length > 0) throw new Error(`unexpected file(s): ${unknown.join(', ')}. A scenario holds only ${SCENARIO_FILES.join(', ')}`)

  // The project's own library, never the bundled one: an installed package must stay as shipped.
  const root = project.ownScenarioRoot
  const dir = resolve(root, name)
  if (existsSync(dir)) throw new Error(`${dir} already exists; delete it or choose another name`)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  try {
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(dir, file), text.endsWith('\n') ? text : `${text}\n`)
      written.push(file)
    }
    // Parsing is part of validation: meta.turns must match prompts.json, and the name must match the directory.
    const scenario = loadScenario(dir)
    if (scenario.name !== name) throw new Error(`meta.json names the scenario "${scenario.name}" but it is being added as "${name}"`)
    const workRoot = join(project.evalDir, 'work')
    mkdirSync(workRoot, { recursive: true })
    const check = await selfcheckScenario(scenario, workRoot)
    return {
      name,
      dir,
      written,
      selfcheck: {
        ok: check.ok,
        blankFails: check.blankPasses === false,
        oraclePasses: check.oraclePasses === true,
        detail: check.ok
          ? 'the untouched workspace fails and the reference answer passes, so this verifier discriminates'
          : [
            check.blankPasses === true ? 'an untouched workspace already passes, so the verifier cannot tell work from no work' : '',
            check.oraclePasses === false ? `the reference answer does not pass: ${check.detail}` : '',
            check.oraclePasses === null ? 'no oracle.py, so nothing proves the verifier accepts a correct answer' : '',
          ].filter(Boolean).join('; ') || check.detail,
      },
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

/** A commented starting point, so a first scenario is an edit rather than a blank page. */
export function scenarioTemplate(name: string): Record<string, string> {
  return {
    'meta.json': JSON.stringify({
      name,
      title: 'One short line naming the task',
      turns: 1,
      category: 'coding',
      tags: [],
      stressor: 'what this scenario puts pressure on, and why a component might change the outcome',
      max_steps_per_turn: 40,
      oracle: 'required',
    }, null, 2),
    'prompts.json': JSON.stringify(['The task, exactly as a user would put it. One string per turn.'], null, 2),
    'setup.py': [
      '"""Build the workspace this scenario starts from.',
      '',
      '`root` is the workspace path as a string. Be deterministic: the same bytes',
      'every run, or the two arms are not solving the same task.',
      '"""',
      'import os',
      '',
      '',
      'def setup(root):',
      '    with open(os.path.join(root, "input.txt"), "w") as f:',
      '        f.write("3\\n4\\n")',
      '    # Ground truth the agent must not see goes under <root>/.truth; it is moved',
      '    # out of the workspace before the agent starts and put back before verify.',
      '',
    ].join('\n'),
    'verify.py': [
      '"""Grade the end state only: never the path taken, never the transcript.',
      '',
      'Return (ok, detail). The detail is what the report quotes when it fails, so',
      'say what was wrong, not that something was.',
      '"""',
      'import os',
      '',
      '',
      'def verify(root):',
      '    path = os.path.join(root, "answer.txt")',
      '    if not os.path.isfile(path):',
      '        return False, "answer.txt was never written"',
      '    text = open(path, encoding="utf-8").read().strip()',
      '    return (text == "7", "answer.txt is %r, expected \'7\'" % text)',
      '',
    ].join('\n'),
    'oracle.py': [
      '"""The reference answer: what a correct agent would leave behind.',
      '',
      'Selfcheck runs this to prove the verifier accepts a correct answer, and',
      'mutates its outputs to prove the verifier notices when they are wrong.',
      '"""',
      'import os',
      '',
      '',
      'def solve(root):',
      '    total = sum(int(n) for n in open(os.path.join(root, "input.txt")).read().split())',
      '    with open(os.path.join(root, "answer.txt"), "w") as f:',
      '        f.write("%d\\n" % total)',
      '',
    ].join('\n'),
  }
}
