# dsh-eval-infra

Paired A/B evaluation for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) components — plugins, system prompts, loop and context designs, tool sets, memory backends, safety guards. Two configurations of the agent run the same scenarios back to back through the real dsh SDK runtime; the tool checks the verifiers before the first trial, refuses comparisons that change more than one thing, gates on regressions before it talks about cost, prices every call the way DeepSeek bills it, and rebuilds every number from the ledgers on disk.

English | [中文](README.zh.md) · [design](docs/design.md) · [results](docs/results.md) · [landscape survey](docs/landscape.md) · [methodology](docs/methodology.md)

## What you get

- **Arms** are dsh patch overlays (`bench/arms/*.yml`): the same rows `dsh --patch` accepts. Insert your plugin, disable a row, change a config field, change the model or reasoning effort.
- **One-variable check**: each arm is composed through `dsh --dump-config` and diffed row by row; more than one differing row is refused unless you ask for it.
- **Scenarios** with deterministic verifiers and an oracle; **selfcheck** proves every verifier rejects an untouched workspace and accepts the reference answer. 35 scenarios ship in `bench/scenarios` (context, tools, coding, prompt, memory, safety, cost, verification) — see [docs/scenarios.md](docs/scenarios.md).
- **Paired, interleaved, repeated runs**: scenario → repeat → arm, A B on odd repeats and B A on even ones, each trial in a fresh workspace and a fresh runtime process under an isolated `DSH_HOME`. A/A mode measures the noise floor.
- **Ledgers**: per-step cache-hit / cache-miss / output / reasoning tokens, price at the DeepSeek peak or off-peak rate of that minute plus both fixed-band re-pricings, tool histogram, session events, per-step trace with reasoning text.
- **Report**: regressions first, cost compared only on repeat-pairs both arms passed, bootstrap interval over scenarios, pass^k, tokens and dollars per solved task, cache-hit share, a one-sentence verdict that says *inconclusive* when the interval covers zero. Markdown and JSON.
- **Web UI** (`dsh-eval ui`, or `/eval` inside the dsh web app): new-run wizard with the live diff, live trial matrix, verdict banner, paired table with filter chips, trace viewer with prompt-size bars and side-by-side compare against the paired trial, ATIF export.
- **CLI exit codes for CI**: 0 no regressions, 1 regressions, 2 incomplete or errors.

## Quick start

```bash
npm install
npm run link:dsh        # symlink the dsh peers from ~/.dsh/source/current
npm run build

cd /path/to/your-plugin
dsh-eval init --plugin .            # .dsh-eval/home with an `eval` profile (dsh-base + dsh-sdk-app), your plugin added, starter arms
$EDITOR bench/arms/candidate.yml    # the candidate inserts your plugin row; the baseline is stock dsh
dsh-eval selfcheck                  # every scenario: untouched → fail, oracle → pass
dsh-eval diff baseline candidate    # composed-tree diff; must be exactly one variable
dsh-eval run --baseline baseline --arm candidate --repeats 3
dsh-eval ui --open                  # browse runs, traces, compare arms
```

`dsh-eval` is `lib/cli.js`; during development run `node_modules/.bin/tsx src/cli.ts …`. The API key is read from `DEEPSEEK_API_KEY`, then `$DSH_HOME/.env`, then `~/.dsh/.env`, and only ever passed to the runtime subprocess.

### Arm file

```yaml
name: fold
description: baseline + in-turn tool-result folding
# model: deepseek-v4-flash
# effort: high
patches:
  - insert:
      - id: tool-result-fold
        name: '@dsh-external/dsh-tool-result-fold'
        config: { pinSteps: 2 }
```

Other single-variable arms: `- id: system-prompt` with a new `persona`; `- id: compaction-basic` with `thresholdRatio`; `- id: tool-web` with `disabled: true`; `model: deepseek-v4-pro` at the top level.

### Scenario

```
bench/scenarios/<name>/
  meta.json     {"name": "...", "turns": 2, "category": "tools", "stressor": "...", "oracle": "required",
                 "network": false, "new_session_before_turns": [3]}   # last two optional
  prompts.json  ["turn 1 …", "turn 2 …"]
  setup.py      def setup(root): …            # deterministic workspace; ground truth may live in root/.truth (hidden from the agent)
  verify.py     def verify(root): return ok, detail   # grades the end state only
  oracle.py     def solve(root): …            # the reference answer
```

`new_session_before_turns` ends the runtime process and starts a fresh one on the same workspace — the way to test what a memory plugin actually stored.

## The report, read correctly

1. **Gate.** Any scenario the baseline passes by majority and the candidate fails is a regression; the candidate fails the gate and no cost summary is offered.
2. **Cost pairs.** Only repeat-pairs where both arms passed count. Δ$ and Δ% are per-scenario means over those pairs.
3. **Interval.** The per-scenario Δ% is bootstrapped over scenarios (B=2000, seeded). *Cheaper* / *more expensive* need the interval to exclude zero; *equivalent* needs it inside ±10%; anything else is *inconclusive*, which is the honest default with few scenarios.
4. **Bands.** Runs straddling the DeepSeek peak/off-peak boundary get a note; use the fixed-band columns.
5. **Repeats.** Three is the floor; five is recommended for binary outcomes; run `--aa` first to see what "no change" looks like on your setup.

## Inside dsh

Install the package into a web profile (`dsh plugin --profile web add @dsh-external/dsh-eval-infra`) and insert the row:

```yaml
- insert:
    - id: dsh-eval-infra
      name: '@dsh-external/dsh-eval-infra'
      config:
        projectRoot: /path/to/your-plugin   # holds .dsh-eval/ and bench/
```

The UI is then at `<host>/eval/` and `/eval runs` works as a slash command.

## Commands

| command | does |
|---|---|
| `init [--plugin <path\|pkg>]…` | create `.dsh-eval/home` with the `eval` profile, add plugins, write starter arms |
| `add <path\|pkg>` | add a plugin to the eval profile (`dsh plugin … add` under the hood) |
| `scenarios [globs] [--category c]` | list scenarios |
| `selfcheck [globs]` | oracle must pass, untouched workspace must fail |
| `diff <baseline> <candidate>…` | composed-tree diff and variable count |
| `run --baseline a --arm b [--arm c] [globs] [--repeats N] [--concurrency N] [--label L] [--aa] [--allow-multi] [--resume id] [--turn-timeout S] [--keep-workdirs]` | the paired run; prints the report |
| `report <id> [--json]` | rebuild the report from the ledgers |
| `runs` | list runs |
| `ui [--port 4177] [--open]` | local web UI |
| `export <id> [--out dir]` | ATIF v1.8 trajectories of every trial |

## How it compares

Harbor runs whole agents on task sets in containers; promptfoo, Braintrust, LangSmith, Langfuse, Weave and Phoenix compare experiments after the fact; Inspect has epochs and bootstrap errors per log; Claude Code's `plugin eval` (early access) ablates its own plugins with and without. None of them pairs and interleaves two configurations in one run, enforces one variable, self-checks the verifier, gates on regressions, or prices with cache and calendar awareness. Details and sources: [docs/landscape.md](docs/landscape.md).

## Development

```bash
npm test                 # keyless engine tests (scripted driver)
npm run typecheck        # host + UI
npm run build            # lib/ (tsc) + lib/ui (esbuild)
```

License: BSD-3-Clause.
