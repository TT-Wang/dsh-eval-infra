# dsh-eval-infra

Paired A/B evaluation for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) components — plugins, system prompts, loop and context designs, tool sets, memory backends, safety guards. Two configurations of the agent run the same scenarios back to back through the real dsh SDK runtime; the tool checks the verifiers before the first trial, refuses comparisons that change more than one thing, gates on regressions before it talks about cost, prices every call the way DeepSeek bills it, and rebuilds every number from the ledgers on disk.

English | [中文](README.zh.md) · [design](docs/design.md) · [results](docs/results.md) · [landscape survey](docs/landscape.md) · [methodology](docs/methodology.md)

## What you get

- **Arms** are dsh patch overlays (`bench/arms/*.yml`): the same rows `dsh --patch` accepts. Insert your plugin, disable a row, change a config field, change the model or reasoning effort.
- **One-variable check**: each arm is composed through `dsh --dump-config` and diffed row by row; more than one differing row is refused unless you ask for it.
- **Scenarios** with deterministic verifiers and an oracle; **selfcheck** proves every verifier rejects an untouched workspace and accepts the reference answer. 35 scenarios ship in `bench/scenarios` (context, tools, coding, prompt, memory, safety, cost, verification) — see [docs/scenarios.md](docs/scenarios.md).
- **Paired, interleaved, repeated runs**: scenario → repeat → arm, A B on odd repeats and B A on even ones, each trial in a fresh workspace and a fresh runtime process under an isolated `DSH_HOME`. A/A mode measures the noise floor.
- **Ledgers**: per-step cache-hit / cache-miss / output / reasoning tokens, price at the DeepSeek peak or off-peak rate of that minute plus both fixed-band re-pricings, tool histogram, session events, per-step trace with reasoning text.
- **Report**: regressions first, cost compared only on repeat-pairs both arms passed, bootstrap intervals over scenarios for cost and pass rate, a one-word grade (improvement / regression / tradeoff / tie / inconclusive), pass^k, tokens and dollars per solved task, cache-hit share, flaky-scenario flags, grouped failure reasons, behaviour signatures (tool errors, repeated calls, no-action steps), the minimum detectable effect of the design, and the A/A noise floor when one exists. Markdown and JSON.
- **Guard rails**: `selfcheck --strict` mutates every oracle output to catch verifiers that ignore it; `--max-usd` caps spend; dsh's workspace-write sandbox confines every trial's shell to its own workspace; scenarios marked `"holdout": true` stay sealed until `--include-holdout`, and the report shows the dev–holdout gap; with several candidates the intervals are read at α/m (Bonferroni); a directional cost call is withheld when its interval reaches into the A/A noise band.
- **Human review**: mark any trial pass/fail with a note from the trace page; the report applies the override and says so.
- **Sequential mode** (`--sequential`): scenarios run in a seeded random order (or by archive signal with `--order signal`) and the run stops as soon as an anytime-valid confidence sequence decides the comparison: a hedged betting sequence on the paired cost ratio (non-asymptotic, the deciding one) and a betting sequence on the pass difference; the report then reads the sequence, which stays valid under early stopping, instead of the fixed-sample bootstrap.
- **Wire meter**: every trial's provider calls pass through a local proxy that records the provider's own usage, served model and fingerprint per request in a hash-chained ledger; the runtime's self-reported usage is reconciled against it and any cost call is withheld when they disagree. `--fault-rate` injects 429s and stalls through the same proxy.
- **Sealed evidence**: a finished run is hashed into `manifest.json`; `dsh-eval verify` recomputes every hash and re-derives the report from the ledgers, so a report can be checked by someone who did not run it. `dsh-eval regrade` re-runs verifiers on kept workspaces without re-running agents and re-seals.
- **Record, replay, fork**: every trial's provider responses are recorded through the meter; `run --replay <id>` re-executes a whole run keylessly and without spend, `--fork-at N` replays N responses per trial and goes live from there (the trace page offers "fork from step k").
- **Rerun validation** (`dsh-eval rerun <id> <scenario>`): runs a failing pair again and reports whether the failure and its first divergence recur; **publish** (`dsh-eval publish <id>`) writes a bundle with `report.html` and `VERIFY.md` that `dsh-eval verify <dir>` checks anywhere.
- **Judge safeguards**: same-family judges are refused by default; conformal abstention from bidirectional preference entropy calibrated on human labels, anchor-set re-grading that attributes drift to the judge, win rate at equal length, TPR/TNR, inter-judge κ and the panel's effective number of independent votes.
- **Served-model checks**: the meter records the model, fingerprint and client identity of every provider exchange; `dsh-eval probe` fingerprints the route's answer distribution against an enrolled reference; after every run the baseline's tool-use distribution is permutation-tested against the archive. A report reads nothing when any of the three says the conditions changed.
- **Signed receipts**: every finished run is sealed and receipted with its analysis contract and an Ed25519 signature; `dsh-eval verify` answers PASS, INVALID or INCONCLUSIVE, and `dsh-eval publish` writes a bundle a third party can check.
- **Patterns**: the history view mines every archived run for recurring failure signatures and behaviour regimes, ranked by how unevenly they hit the arms.
- **Perturbation floor**: `dsh-eval perturb` drafts paraphrases of a scenario's prompts; `--perturb` runs a seeded variant on repeats above 1, the same one for every arm, and `--aa --perturb` measures how much of the spread is prompt-wording sensitivity rather than rerun noise.
- **Blinded judge** (`dsh-eval judge <run>`): for scenarios that declare a rubric and artifacts, judge models that never see arm or model names compare the baseline's and the candidate's files in both orders; disagreement between orders counts as a tie, several `--model` flags form a panel decided by a strict majority, the order-disagreement and unanimity rates are reported, and `--mode absolute` grades each trial and rectifies pass rates with the run's human annotations (PPI++).
- **Container isolation** (`--sandbox docker`): each trial's dsh runtime runs in its own container with only the read-only dsh checkout and plugins, the eval home and the trial workspace mounted.
- **Web UI** (`dsh-eval ui`, or `/eval` inside the dsh web app): new-run wizard with the live diff and an archive-based cost estimate, live trial matrix, verdict banner with a forest strip (intervals, ±10% band, MDE lines, A/A floor), regressions-first paired table with flaky/failure filters, per-scenario history with cost sparklines, trace viewer with folded tool results, keyboard navigation, and side-by-side compare with a first-divergence marker; self-contained HTML and ATIF export.
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
3. **Interval.** The per-scenario Δ% is bootstrapped over scenarios as clusters (each carrying all its repeat pairs; B=2000, seeded), with the intraclass correlation and design effect of the repeats reported. *Cheaper* / *more expensive* need at least five comparable scenarios, an interval that excludes zero, and an interval that stays outside the A/A noise band when one has been measured; *equivalent* needs five scenarios and an interval inside ±10%; below ten scenarios the interval is a Student-t interval rather than a bootstrap; anything else is *inconclusive*, which is the honest default with few scenarios. The notes state the minimum detectable effect of the design, the resolution q = n/N* of the observed effect, and, when an A/A run exists, its noise floor. Paired pass/fail is tested with McNemar's mid-p on discordant pairs and read as a posterior P(candidate wins).
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
| `run --baseline a --arm b [--arm c] [globs] [--repeats N] [--concurrency N] [--label L] [--aa] [--allow-multi] [--resume id] [--turn-timeout S] [--keep-workdirs] [--max-usd N] [--sequential --seed N] [--include-holdout]` | the paired run; prints the report |
| `report <id> [--json]` | rebuild the report from the ledgers |
| `judge <id> [--model M] [--arm A] [--seed N]` | blinded pairwise judge over scenarios with `meta.judge` |
| `probe [--model M] [--samples N] [--enroll]` | fingerprint the route's served model against an enrolled reference (exit 1 when it differs) |
| `rerun <id> <scenario> [--repeats 3] [--fork]` | rerun one scenario's pair to validate a failure; `--fork` replays the identical prefix and goes live at the divergence, separating a cause from resampling luck |
| `publish <id> [--out dir]` | copy the sealed run with `report.html` and `VERIFY.md` into a bundle anyone can verify with `verify <dir>` |
| `perturb <globs> [--n N] [--model M]` | write semantics-preserving paraphrases of a scenario's prompts (`prompts.variants.json`) for `--perturb`; review them by hand |
| `verify <id \| dir> [--json]` | check the sealed hashes, re-derive the report and check the signed receipt: PASS (0), INVALID (1) or INCONCLUSIVE (2) |
| `regrade <id>` | re-run verifiers on kept workspaces (`--keep-workdirs`), rebuild the report, re-seal |
| `runs` | list runs |
| `ui [--port 4177] [--open]` | local web UI |
| `export <id> [--out dir]` | ATIF v1.8 trajectories of every trial |

## How it compares

Harbor runs whole agents on task sets in containers; promptfoo, Braintrust, LangSmith, Langfuse, Weave and Phoenix compare experiments after the fact; Inspect has epochs, bootstrap errors and a judge panel per log; Claude Code's `plugin eval` (early access) ablates its own plugins with and without. Among tools built on dsh itself, muou000/dsh-eval pairs and interleaves cases with seeded AB/BA order and content-addressed artifacts, hccccc01333/dsh-eval replays recorded chunks keylessly, BiBoyang/dsh-eval-harness gates with TPR/TNR-validated judges, and dsheval.ai publishes a public plugin ledger. None of them combines paired interleaving with a one-variable check on the composed configuration, verifier self-checks with mutation, a regression-first gate that prices only matched passes, an A/A floor that can veto a directional call, a non-asymptotic sequential stop, usage metered on the wire and reconciled before any cost call, and sealed evidence with an independent report check. Where they are ahead is listed row by row in [docs/sota-scorecard.md](docs/sota-scorecard.md); sources in [docs/landscape.md](docs/landscape.md), [docs/landscape-2.md](docs/landscape-2.md) and the [adversarial review](docs/adversarial-review.md).

## Status and limitations

Every capability above is exercised by keyless tests and has been run at least once against the real DeepSeek runtime ([docs/results.md](docs/results.md)); [docs/sota-scorecard.md](docs/sota-scorecard.md) scores the tool row by row against the tools and papers in the two surveys and states, narrowly, where it leads and where it does not. Known limits, stated rather than hidden:

- Third-party plugins run in a container per trial by default when Docker is available (dsh's SAFETY.md does not call the host sandbox a security boundary); `--docker-keep-sandbox` stacks dsh's own sandbox inside the container, and `--docker-runtime runsc|kata` uses a microVM or gVisor runtime when the host has one. The microVM path is passed through but has not been exercised here, for lack of such a host.
- Usage is metered on the wire by a per-trial local proxy and reconciled with the runtime's own figures; a cost call is withheld when they disagree. `--no-meter` returns to self-reported usage, and the report says so.
- A judge from the arms' model family is refused unless `--allow-same-family`; a second-family endpoint must be configured by you, and none was available here, so only the refusal and the panel mechanics have been run. Abstention needs human-labelled pairs to calibrate; anchors need annotated trials in the archive.
- Replay re-runs each scenario's setup rather than restoring a per-turn workspace snapshot, so it reproduces scenarios whose setup is deterministic.
- Deliberately not done, each with a reason: within-run adaptive scenario selection (it changes the estimand the confidence sequence covers unless inverse-probability weighted, and uniform ordering is competitive), predicted early termination (a predicted failure is not a measured one), simulated users (both arms must see identical inputs for the pairing to hold).
- DeepSeek prices only; other providers are recorded with cost 0 and flagged.
- Intervals below ten scenarios are Student-t; the bootstrap is used from ten. With fewer than five comparable scenarios the tool refuses to state a direction, by design. The sequential cost decision uses a non-asymptotic betting sequence and therefore needs more scenarios than a fixed-sample interval would; that is the price of validity at every look.

## Development

```bash
npm test                 # keyless engine tests (scripted driver)
npm run typecheck        # host + UI
npm run build            # lib/ (tsc) + lib/ui (esbuild)
```

License: BSD-3-Clause.
