# dsh-eval-infra

[![bench-smoke](https://github.com/TT-Wang/dsh-eval-infra/actions/workflows/bench-smoke.yml/badge.svg)](https://github.com/TT-Wang/dsh-eval-infra/actions/workflows/bench-smoke.yml)

Paired A/B evaluation for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) components: plugins, system prompts, loop and context designs, tool sets, memory backends, safety guards.

Two configurations of the agent run the same scenarios back to back through the real dsh SDK runtime. The tool checks the verifiers before the first trial, refuses comparisons that change more than one thing, gates on regressions before it talks about cost, prices every call the way DeepSeek bills it, meters usage on the wire, and rebuilds every number from the ledgers on disk. When the evidence does not support a conclusion, it says so instead of producing one.

English | [中文](README.zh.md) · [design](docs/design.md) · [scenarios](docs/scenarios.md) · [scorecard](docs/sota-scorecard.md) · [results](docs/results.md)

## Typical uses

**Does my plugin actually save money?** The baseline is stock dsh, the candidate inserts one plugin row. The report answers whether the pass rate held and whether the cost difference is real or inside the noise floor of your own setup.

```bash
dsh-eval run --baseline baseline --arm fold --repeats 3
```

**Is my safety guard doing anything?** One persona sentence is the only variable; the injection scenarios are the workload. The pass columns also tell you whether your injection pool can discriminate at all, or whether the baseline already resists everything in it.

```bash
dsh-eval run --baseline baseline --arm guard-persona 'x*' --repeats 5
```

**Is the bigger model worth it?** Put `model: deepseek-v4-pro` at the top of the arm file and nothing else changes. The grade comes back as a tradeoff when quality rises and cost rises with it, with dollars and tokens per solved task on both sides.

```bash
dsh-eval run --baseline baseline --arm pro --repeats 3
```

**Which setting of this knob is best?** Several candidates share one baseline and one set of trials, and the intervals are read at α/m so the family-wise error stays at 5%.

```bash
dsh-eval run --baseline baseline --arm compact-60 --arm compact-75 --arm compact-90
```

**Does my memory plugin actually remember?** Scenarios can end the runtime process mid-scenario and start a fresh one on the same workspace, so what the agent recalls after the break is what the plugin really stored, not what was still in context.

```bash
dsh-eval run --baseline baseline --arm memory 'm*' --repeats 5
```

**Gate a pull request.** Exit code 1 on any regression and 2 on incomplete runs, with a spend cap so a stuck trial cannot drain a budget. A GitHub workflow is in [docs/ci](docs/ci/github-workflow.yml).

```bash
dsh-eval run --baseline main --arm pr --repeats 3 --max-usd 5
```

**Evaluate a plugin you did not write.** With Docker available, third-party plugins get a container per trial by default, and `--docker-keep-sandbox` stacks dsh's own sandbox inside that container.

```bash
dsh-eval init --plugin ./third-party-plugin
dsh-eval run --baseline baseline --arm third-party --docker-keep-sandbox
```

**Did the provider quietly change the model?** Enrol a fingerprint of the route once, then check it before a run. A route whose answer distribution no longer matches blocks the readings rather than silently shifting them.

```bash
dsh-eval probe --enroll
dsh-eval run --baseline baseline --arm candidate --probe
```

**Was that failure a cause or bad luck?** A rerun resamples everything; a fork replays the identical prefix and goes live at the exact call where the two arms parted. A failure that recurs after the fork but not after a plain rerun is caused by what happened there.

```bash
dsh-eval rerun <runId> f9_docs_research --repeats 3 --fork
```

**Publish a claim someone else can check.** The bundle carries the report, the evidence hashes, the analysis contract and a signature, and `verify` answers PASS, INVALID or INCONCLUSIVE on any machine. To re-examine a run without spending anything, replay it from its recordings with no API key at all.

```bash
dsh-eval publish <runId> --out ./bundle
dsh-eval run --replay <runId>
```

## What it gives you

**Fair comparison by construction.** Arms are dsh patch overlays, the same rows `dsh --patch` accepts. Each arm is composed through `dsh --dump-config` and diffed row by row, and more than one differing row is refused unless you ask for it. Trials interleave scenario, repeat and arm, A B on odd repeats and B A on even ones, each in a fresh workspace and a fresh runtime process under an isolated `DSH_HOME`. An A/A run measures what "no change" looks like on your own setup, and `--perturb` extends that floor to prompt-wording sensitivity using paraphrases every arm sees identically.

**Verifiers you can trust.** Scenarios carry a deterministic verifier and a reference oracle. `selfcheck` proves that an untouched workspace fails and the oracle passes; `--strict` deletes or blanks each oracle output in turn and requires the verifier to notice, which is what catches a grader that always says pass. Ground truth is moved out of the workspace into a private temporary directory before the agent runs and back before the verifier, and a scenario that ends a session on purpose has that session's transcript (and the plaintext cache of its first prompt) moved out of the eval home too, so a memory question cannot be answered by reading the harness's own files; on the host that keeps it out of the agent's working tree, not out of reach of a process running as the same user, so the container sandbox — which mounts the workspace and nothing else — is where the answer key is actually unreachable. 35 scenarios ship across context, tools, coding, prompt, memory, safety, cost and verification, four of them sealed as a confirmation pool.

**Measurement that is not self-reported.** Every provider call passes through a local proxy that records the provider's own usage, the served model, the system fingerprint and the client identity in a hash-chained ledger. The runtime's own numbers are reconciled against it, and a cost conclusion is withheld when the two disagree. Ledgers hold per-step cache-hit, cache-miss, output and reasoning tokens, priced at the DeepSeek rate of that minute plus both fixed-band re-pricings, along with tool histograms, behaviour counters and a per-step trace.

**Statistics that refuse to overclaim.** Regressions gate the report before cost is discussed, and cost is compared only on repeat-pairs both arms passed. Intervals cluster by scenario and carry the intraclass correlation and design effect of the repeats. A direction needs at least five comparable scenarios, an interval excluding zero, and an A/A floor measured on the same baseline whose interval it stays clear of — without a floor on file no direction is read, only that one is missing; equivalence needs an interval inside ±10%; everything else reads inconclusive. The regression gate is a screening rule and says so: a regression is called only when the baseline passed every repeat and the candidate failed every one, a majority-fail without that consistency blocks the readings as *suspected* until a rerun settles it, and the report states the probability that a consistent failure would arise by chance at the pass rates it observed. Reports state the minimum detectable effect of the design and the resolution of the observed one, test paired outcomes with McNemar's mid-p and a posterior, and adjust with CUPED when the archive supports it. Sequential mode stops as soon as a non-asymptotic confidence sequence decides, and stays valid under that early stopping.

**Judges with guard rails.** For scenarios that code cannot grade, blinded judge models compare the two submissions without seeing arm or model names, in both orders, with disagreement counted as a tie. Several models form a panel decided by strict majority, reported with its unanimity rate, inter-judge agreement and effective number of independent votes. A judge from the arms' own model family is refused by default. Uncertain judgments are withheld under conformal risk control, a frozen anchor set catches the judge drifting between runs, and length effects are reported both stratified and at zero length difference. Absolute mode grades each trial and rectifies pass rates with human labels through PPI++.

**Evidence you can hand to someone else.** A finished run is hashed into a manifest and receipted with its analysis contract and an Ed25519 signature. Everything the report derives from — ledgers, events, traces, meter ledgers, annotations, judge, rerun and regrade files, and the archive context the readings used (A/A floor, CUPED covariates, drift, holdouts), pinned into the run as `context.json` — is sealed, and whatever adds such a file re-seals and re-issues the receipt. `verify` recomputes every hash from the bytes on disk, re-derives the whole report from that evidence and compares its digest with the receipted one, and checks the signature against a key the verifier trusts — the project's own for local runs, the author's published key (`--key`) for a bundle; a receipt signed by an unknown key is self-consistent, not verified, and reads INCONCLUSIVE. It answers PASS, INVALID or INCONCLUSIVE. `regrade` re-runs verifiers on kept workspaces without re-running any agent. Recorded provider responses make a whole run replayable without a key or spend, and forkable at any step.

**Execution and safety.** A container per trial is the default for third-party plugins, with optional gVisor or Kata runtimes and the option to keep dsh's in-process sandbox active inside the container. Network tools are off unless a scenario asks for them. Spend caps apply per run and per trial, on observed usage. Provider faults such as rate limits and stalls can be injected through the same proxy that meters the run.

**A UI built for reading results.** The run page opens in a plain summary: whether anything broke, what the cost difference was, whether it is conclusive, and the one command that would make it conclusive. A switch in the header reveals the full statistics, intervals, notes, environment and logs for anyone who wants them. New-run wizard with the live configuration diff and an archive-based cost estimate. Live trial matrix. A verdict banner with a forest strip showing intervals, the equivalence band, the detectable effect and the noise floor. Regressions-first paired table with filters. Trace viewer with folded tool results, keyboard navigation, side-by-side arm comparison and a first-divergence marker with a fork action. Cross-run history with cost sparklines, per-scenario signal-to-noise and automatic mining of recurring failure signatures and behaviour regimes. Self-contained HTML and ATIF export.

## Quick start

```bash
npm install
npm run link:dsh        # symlink the dsh peers from ~/.dsh/source/current
npm run build

cd /path/to/your-plugin
dsh-eval init --plugin .            # .dsh-eval/home with an `eval` profile, your plugin added, starter arms
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

A scenario is a directory of five files. `root` is the workspace path as a string.

```
bench/scenarios/<name>/
  meta.json     {"name": "...", "title": "Reconcile two exports", "turns": 2, "category": "tools",
                 "stressor": "what it puts pressure on", "oracle": "required",
                 "network": false, "new_session_before_turns": [3]}   # last two optional
  prompts.json  ["turn 1 …", "turn 2 …"]
  setup.py      def setup(root): …            # deterministic workspace; ground truth may live in <root>/.truth
  verify.py     def verify(root): return ok, detail   # grades the end state only
  oracle.py     def solve(root): …            # the reference answer
```

`dsh-eval scenarios new <name>` writes a working example of all five into the project's own library and
selfchecks it; the web UI takes a folder you already have under **Add your own** on the scenarios step.
Either way the scenario is checked on arrival: an untouched workspace must fail and the reference answer
must pass, because a verifier that always says pass turns every later comparison into noise. Your scenarios
add to the shipped library rather than replacing it, unless `scenarioRoot` in `.dsh-eval/config.json` names
a root explicitly.

`new_session_before_turns` ends the runtime process and starts a fresh one on the same workspace, which is the way to test what a memory plugin actually stored. `meta.judge` names a rubric and the artifacts a judge should read, `meta.holdout` seals a scenario into the confirmation pool, and `prompts.variants.json` supplies the paraphrases `--perturb` uses.

### Public benchmarks

The library above is the **default bench**. Public benchmarks are separate pools beside it, integrated lightly: the index is a few kilobytes and nothing else is downloaded until you pick a task.

```bash
dsh-eval bench list terminal-bench                    # the 89-task index of Terminal-Bench 2.0 (Apache-2.0)
dsh-eval bench get terminal-bench build-pmars         # this task's files at the pinned commit + its prebuilt image
dsh-eval selfcheck build-pmars                        # its tests must fail on the untouched image and pass after its solution
dsh-eval run --baseline baseline --arm candidate build-pmars --repeats 3
```

A benchmark task is a scenario that ships its own image (`meta.runtime: container`). It runs the way the benchmark's own harness runs it: the image is started and kept alive for the trial, the dsh runtime runs inside it, and the benchmark's own grading decides — for Terminal-Bench the task's `tests/test.sh` in the same container; for SWE-bench Verified the official `swebench` harness, which applies the agent's diff to a fresh container of the same image, runs the dataset's evaluation script and reads the result with the repository's parser. The task's commit, hash and license go into the receipt; the task's files are never edited.

```bash
dsh-eval bench list swebench-verified                 # 500 issues from 12 Python repositories
dsh-eval bench get swebench-verified psf__requests-2317   # the row, the grading environment (once), the image (about 1 GB)
dsh-eval selfcheck psf__requests-2317                 # the reference fix must resolve the issue, an empty change must not
```

Two things to know. Every published Terminal-Bench image is linux/amd64: on an amd64 host it runs natively, elsewhere Docker emulates it and every trial is slower. And many verifiers install their own tooling at grading time (uv, pytest), so they are as reliable as the container's network. A slice of a public benchmark run here is a paired comparison of your two arms on those tasks — not a leaderboard score.

## Reading the report

1. **Gates.** A scenario the baseline passes on every repeat and the candidate fails on every repeat is a regression. One where the baseline passes at least half and the candidate fails at least half, without that consistency, is *suspected*: it blocks the readings but is not called until `dsh-eval rerun` confirms or clears it, because with three repeats no single scenario can separate breakage from flakiness. The report states the chance level of the gate — the probability, at the pass rates it observed, that a consistent regression would appear on some scenario with no real difference. Any trial that did something it was not asked to — wrote outside its workspace (read from `docker diff` of its container), ran a destructive command, obeyed an instruction planted in its inputs — is unsafe, whatever its verifier said. Either fails the gate and no other reading is offered.
2. **Reliability.** The first line of every report: pass^k per arm, the share of scenarios that pass on every one of the k repeats, compared on the scenarios where only one arm is reliable. A component that turns "always" into "usually" has changed something, whatever it did to the cost. k is 3 by default; set it per run.
3. **North star.** The one reading the run is registered for, chosen before the data and sealed into the receipt: cost per solved task (default), steps per solved task, or the blinded judge's preference. The grade, the verdict and the forest plot follow it; everything else in the report is diagnostic.
4. **Cost pairs.** Only repeat-pairs where both arms passed count. Δ$ and Δ% are per-scenario means over those pairs; steps are paired the same way.
5. **Interval.** Per-scenario Δ% is bootstrapped over scenarios as clusters, each carrying all its repeat pairs. *Cheaper* and *more expensive* need at least five comparable scenarios, an interval excluding zero at the planned-claim α, and an A/A floor on file for this baseline (from `--aa`, at least five scenarios, measured before any detected drift) whose own interval the reading does not overlap; with no usable floor the interval is shown and the direction is declared unread rather than read. *Equivalent* needs an interval inside ±10% and no floor. Below ten scenarios the interval is Student-t with the exact quantile at that α; anything else is *inconclusive*. The same rule reads steps for the efficiency north star. The notes state the minimum detectable effect and the resolution of the observed one, both at the reading's α; the pass-rate difference interval is descriptive, the two planned claims per candidate being the north star and reliability.
6. **Provenance.** A cost reading is withheld when the wire meter and the runtime disagree, when the two arms were served different models, or when a route probe says the served model changed.
7. **Bands.** Runs straddling the DeepSeek peak and off-peak boundary get a note; use the fixed-band columns.
8. **Repeats.** Three is the floor, five is recommended for binary outcomes. Run `--aa` first to see what "no change" looks like on your setup.

## Inside dsh

Two surfaces, one API. Install the package into a web profile with `dsh plugin --profile web add @dsh-external/dsh-eval-infra` and insert the row:

```yaml
- insert:
    - id: dsh-eval-infra
      name: '@dsh-external/dsh-eval-infra'
      config:
        projectRoot: /path/to/your-plugin   # holds .dsh-eval/ and bench/
```

The full UI is then at `<host>/eval/`, `/eval runs` works as a slash command, and a seat appears at the foot of the dsh sidebar showing the last comparison, its one-line verdict, and shortcuts to start a new one or open the result. The sidebar seat reads the same HTTP API the standalone UI does, so the two cannot drift apart; run `dsh-eval ui` instead when you want the tool on its own.

## Commands

| command | does |
|---|---|
| `init [--plugin <path\|pkg>]…` | create `.dsh-eval/home` with the `eval` profile, add plugins, write starter arms |
| `add <path\|pkg>` | add a plugin to the eval profile |
| `scenarios [globs] [--category c]` | list scenarios |
| `selfcheck [globs] [--strict]` | oracle must pass, untouched workspace must fail; `--strict` mutates each oracle output |
| `diff <baseline> <candidate>…` | composed-tree diff and variable count |
| `run --baseline a --arm b [--arm c] [globs]` | the paired run; prints the report |
| ↳ budget | `[--max-usd N] [--max-usd-per-trial X]` |
| ↳ statistics | `[--sequential [--seed N]] [--order signal] [--perturb] [--aa] [--include-holdout]` |
| ↳ provenance | `[--probe] [--no-meter] [--fault-rate P]` |
| ↳ isolation | `[--sandbox host\|docker] [--docker-runtime runsc\|kata] [--docker-keep-sandbox]` |
| ↳ replay | `[--replay <id> [--fork-at N]]` |
| `report <id> [--json] [--rebuild-ledgers]` | rebuild the report from the ledgers |
| `judge <id> [--model M]… [--mode pairwise\|absolute\|both]` | blinded judge over scenarios with `meta.judge` |
| `probe [--model M] [--samples N] [--enroll]` | fingerprint the route's served model; exit 1 when it differs |
| `verify <id \| dir> [--json] [--key <public.pem>]` | sealed hashes from the bytes on disk, whole-report re-derivation against the receipted digest, signature against a trusted key: PASS (0), INVALID (1), INCONCLUSIVE (2) |
| `regrade <id>` | re-run verifiers on kept workspaces, rebuild the report, re-seal |
| `rerun <id> <scenario> [--repeats N] [--fork]` | validate a failure; `--fork` replays the identical prefix and goes live at the divergence |
| `publish <id> [--out dir]` | bundle the sealed run with `report.html` and `VERIFY.md` for a third party |
| `perturb <globs> [--n N]` | draft paraphrases of a scenario's prompts for `--perturb` |
| `runs` | list runs |
| `ui [--port 4177] [--open]` | local web UI |
| `export <id> [--out dir] [--html]` | ATIF v1.8 trajectories, or a self-contained HTML report |

## How it compares

Harbor runs whole agents on task sets in containers. promptfoo, Braintrust, LangSmith, Langfuse, Weave and Phoenix compare experiments after the fact. Inspect has epochs, bootstrap errors and judge panels per log. Claude Code's `plugin eval` ablates its own plugins with and without them. Among tools built on dsh itself, muou000/dsh-eval pairs and interleaves cases with a seeded AB/BA order and content-addressed artifacts, hccccc01333/dsh-eval replays recorded chunks keylessly, BiBoyang/dsh-eval-harness gates on judges validated by true-positive and true-negative rates, and dsheval.ai publishes a public plugin ledger.

What none of them combines is paired interleaving with a one-variable check on the composed configuration, verifier self-checks with mutation, a regression-first gate that prices only matched passes, an A/A floor that can veto a directional call, a non-asymptotic sequential stop, usage metered on the wire and reconciled before any cost conclusion, and sealed evidence with signed claims an outsider can re-derive. [docs/sota-scorecard.md](docs/sota-scorecard.md) scores every capability row by row against those tools and the literature, and names where each of them is ahead.

## Limits, stated rather than hidden

- DeepSeek prices ship built in; other providers are configurable per project. A model with no price entry is recorded with cost 0 and marked `unpriced` on every trial, and the report withholds the cost reading instead of reading 0 as equivalent.
- Cross-family judges need an endpoint you configure. Conformal abstention needs human-labelled pairs to calibrate, and drift anchors need annotated trials in the archive.
- The gVisor and Kata runtimes are passed through to Docker and therefore need a host that provides them.
- On the host, three of the evaluation's own directories sit beside the workspace and answer questions the task is asking: the session store (this trial's transcript), the scenario directory (`prompts.json` carries every turn's text, `verify.py` the criteria) and the run directory. A deliberately ended session is moved out of reach; the other two cannot be, because concurrent trials share them. A trial that opens any of them is recorded on its ledger and named in the report's notes, so a verdict that came from reading rather than doing is visible — but it is a flag, not a wall. Under `--sandbox docker` none of the three is mounted, which is the actual boundary.
- Host mode (`--sandbox host`, the default without third-party plugins) is not a security boundary: the agent runs as you, and can in principle find the stashed answer key, sibling workspaces and the scenario library. The container sandbox is the boundary, and the report says which mode each trial ran in.
- The safety gate's write check needs a container diff. Benchmark tasks own their container, so their write scope is unrestricted by contract and only destructive commands and obeyed injections are checked there; host trials have no diff at all. The report's notes say what the gate could check on each run.
- The UI server is a single-user tool on loopback without accounts: state-changing requests must be same-origin and JSON (a page on another site cannot make your browser add a scenario or delete a pool), scenario and task names are single path segments, and adding a scenario runs its verifier on your machine — scenarios are code you chose to run.
- Scenario code (setup, verify, oracle) runs with an allowlisted environment: interpreter, temp, proxy, Docker and `DSH_EVAL_*` variables, never the host's keys. The sandbox base image is pinned by digest and the Node build mounted into task containers by checksum; the API key reaches containers through the process environment, never on a command line.
- Replay re-runs each scenario's setup rather than restoring a per-turn workspace snapshot, so it reproduces scenarios whose setup is deterministic.
- With fewer than five comparable scenarios, or without an A/A floor on the baseline, the tool refuses to state a direction. Sequential mode uses non-asymptotic sequences (cost ratio, pass difference, reliability, at α/3 each) and therefore needs more scenarios than a fixed-sample interval would, which is the price of a result that stays valid at every look; it compares one candidate on the cost north star, and every other interval in a sequential report is descriptive because it was computed on optionally-stopped data.
- Three things are deliberately absent, each for a reason: within-run adaptive scenario selection changes the estimand a confidence sequence covers unless inverse-probability weighted; predicted early termination records a prediction where a measurement belongs; simulated users break the requirement that both arms see identical inputs.

## Development

```bash
npm test                 # keyless engine tests (scripted driver)
npm run typecheck        # host + UI
npm run build            # lib/ (tsc) + lib/ui (esbuild)
```

License: BSD-3-Clause. Third-party components are listed in [THIRD_PARTY.md](THIRD_PARTY.md); the web UI's design system is Franken UI, vendored under `src/ui/vendor` with its own licence.
