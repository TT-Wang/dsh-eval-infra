# dsh-eval-infra

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

**Verifiers you can trust.** Scenarios carry a deterministic verifier and a reference oracle. `selfcheck` proves that an untouched workspace fails and the oracle passes; `--strict` deletes or blanks each oracle output in turn and requires the verifier to notice, which is what catches a grader that always says pass. Ground truth lives outside the workspace, so the agent cannot read it. 35 scenarios ship across context, tools, coding, prompt, memory, safety, cost and verification, four of them sealed as a confirmation pool.

**Measurement that is not self-reported.** Every provider call passes through a local proxy that records the provider's own usage, the served model, the system fingerprint and the client identity in a hash-chained ledger. The runtime's own numbers are reconciled against it, and a cost conclusion is withheld when the two disagree. Ledgers hold per-step cache-hit, cache-miss, output and reasoning tokens, priced at the DeepSeek rate of that minute plus both fixed-band re-pricings, along with tool histograms, behaviour counters and a per-step trace.

**Statistics that refuse to overclaim.** Regressions gate the report before cost is discussed, and cost is compared only on repeat-pairs both arms passed. Intervals cluster by scenario and carry the intraclass correlation and design effect of the repeats. A direction needs at least five comparable scenarios, an interval excluding zero, and an interval that stays clear of the measured A/A floor; equivalence needs an interval inside ±10%; everything else reads inconclusive. Reports state the minimum detectable effect of the design and the resolution of the observed one, test paired outcomes with McNemar's mid-p and a posterior, and adjust with CUPED when the archive supports it. Sequential mode stops as soon as a non-asymptotic confidence sequence decides, and stays valid under that early stopping.

**Judges with guard rails.** For scenarios that code cannot grade, blinded judge models compare the two submissions without seeing arm or model names, in both orders, with disagreement counted as a tie. Several models form a panel decided by strict majority, reported with its unanimity rate, inter-judge agreement and effective number of independent votes. A judge from the arms' own model family is refused by default. Uncertain judgments are withheld under conformal risk control, a frozen anchor set catches the judge drifting between runs, and length effects are reported both stratified and at zero length difference. Absolute mode grades each trial and rectifies pass rates with human labels through PPI++.

**Evidence you can hand to someone else.** A finished run is hashed into a manifest and receipted with its analysis contract and an Ed25519 signature. `verify` recomputes every hash, re-derives the report from the ledgers, checks the signature and the claims, and answers PASS, INVALID or INCONCLUSIVE. `regrade` re-runs verifiers on kept workspaces without re-running any agent. Recorded provider responses make a whole run replayable without a key or spend, and forkable at any step.

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

```
bench/scenarios/<name>/
  meta.json     {"name": "...", "turns": 2, "category": "tools", "stressor": "...", "oracle": "required",
                 "network": false, "new_session_before_turns": [3]}   # last two optional
  prompts.json  ["turn 1 …", "turn 2 …"]
  setup.py      def setup(root): …            # deterministic workspace; ground truth may live in root/.truth
  verify.py     def verify(root): return ok, detail   # grades the end state only
  oracle.py     def solve(root): …            # the reference answer
```

`new_session_before_turns` ends the runtime process and starts a fresh one on the same workspace, which is the way to test what a memory plugin actually stored. `meta.judge` names a rubric and the artifacts a judge should read, `meta.holdout` seals a scenario into the confirmation pool, and `prompts.variants.json` supplies the paraphrases `--perturb` uses.

## Reading the report

1. **Gate.** Any scenario the baseline passes by majority and the candidate fails is a regression; the candidate fails the gate and no cost summary is offered.
2. **Cost pairs.** Only repeat-pairs where both arms passed count. Δ$ and Δ% are per-scenario means over those pairs.
3. **Interval.** Per-scenario Δ% is bootstrapped over scenarios as clusters, each carrying all its repeat pairs. *Cheaper* and *more expensive* need at least five comparable scenarios, an interval excluding zero, and an interval outside the measured A/A noise band; *equivalent* needs an interval inside ±10%; below ten scenarios the interval is Student-t rather than bootstrap; anything else is *inconclusive*. The notes state the minimum detectable effect and the resolution of the observed one.
4. **Provenance.** A cost reading is withheld when the wire meter and the runtime disagree, when the two arms were served different models, or when a route probe says the served model changed.
5. **Bands.** Runs straddling the DeepSeek peak and off-peak boundary get a note; use the fixed-band columns.
6. **Repeats.** Three is the floor, five is recommended for binary outcomes. Run `--aa` first to see what "no change" looks like on your setup.

## Inside dsh

Install the package into a web profile with `dsh plugin --profile web add @dsh-external/dsh-eval-infra` and insert the row:

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
| `verify <id \| dir> [--json]` | sealed hashes, report re-derivation and signed receipt: PASS (0), INVALID (1), INCONCLUSIVE (2) |
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

- DeepSeek prices ship built in; other providers are configurable per project and otherwise recorded with cost 0 and flagged.
- Cross-family judges need an endpoint you configure. Conformal abstention needs human-labelled pairs to calibrate, and drift anchors need annotated trials in the archive.
- The gVisor and Kata runtimes are passed through to Docker and therefore need a host that provides them.
- Replay re-runs each scenario's setup rather than restoring a per-turn workspace snapshot, so it reproduces scenarios whose setup is deterministic.
- With fewer than five comparable scenarios the tool refuses to state a direction. Sequential mode uses a non-asymptotic sequence and therefore needs more scenarios than a fixed-sample interval would, which is the price of a result that stays valid at every look.
- Three things are deliberately absent, each for a reason: within-run adaptive scenario selection changes the estimand a confidence sequence covers unless inverse-probability weighted; predicted early termination records a prediction where a measurement belongs; simulated users break the requirement that both arms see identical inputs.

## Development

```bash
npm test                 # keyless engine tests (scripted driver)
npm run typecheck        # host + UI
npm run build            # lib/ (tsc) + lib/ui (esbuild)
```

License: BSD-3-Clause.
