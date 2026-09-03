# dsh-eval-infra — design

Paired A/B evaluation infrastructure for DeepSeek Harness (dsh) components. This document records what the tool is for, what it measures, how it stays fair, and how it is built. The landscape and methodology surveys it draws on are in [landscape.md](landscape.md), [methodology.md](methodology.md) and [ui-patterns.md](ui-patterns.md).

## 1. Problem

A dsh plugin developer changes one thing — a system prompt, a compaction ratio, a tool description, a memory backend, a safety guard, an agent loop — and wants to know two things: did any task that used to pass now fail, and what did the change do to cost. Today the answer is a hand-written script and a number in a README that nobody else can reproduce or compare. The ecosystem (deepseek-harness ★210k, ~1,200 plugins) has no evaluation tool; the general tools (promptfoo, Braintrust, LangSmith, Inspect, Harbor) evaluate models or opaque task functions after the fact and none of them runs two configurations paired, enforces a single variable, checks the verifier, gates on regressions, or prices with cache and time-of-day awareness ([landscape.md §Gaps](landscape.md)).

Two facts from the literature shape everything below: harness/scaffold choice moves tokens per solved task by up to 40× while pass rates move 0–8 points with intervals covering zero (Scaffold Effect, arXiv 2607.22585), and single runs of an agent vary by tens of percent even at temperature 0, so unpaired single numbers are noise.

## 2. What is compared

**Unit of comparison: an arm.** An arm is one complete dsh composition plus its model route. It is written as a small YAML file:

```yaml
name: fold
description: baseline + in-turn tool-result folding
model: deepseek-v4-flash      # optional, default
effort: high                  # optional
patches:                      # dsh loader patch rows, applied after the profile
  - insert:
      - id: tool-result-fold
        name: '@dsh-external/dsh-tool-result-fold'
        config: { pinSteps: 2 }
```

Patch rows are exactly what dsh's own profile layering accepts (`dsh --profile X --patch file`), so anything that can be expressed as a composition difference is an arm: a plugin inserted or disabled, a config field on any row (compaction thresholds, spill limits, tool sets, the persona of `system-prompt`), a different model or reasoning effort at the SDK route. The tool never hand-wires plugins; it lets dsh mount the arm and reads back what was mounted.

**One variable.** Before a run the tool composes each arm through `dsh --dump-config` under the isolated eval home and diffs the composed trees row by row, plus the route fields (model, effort, maxTokens, env). A candidate that differs from the baseline in more than one row is refused unless `--allow-multi`, and the report is then marked multi-variable. An identical composition is flagged as an A/A run.

**Scenarios.** A scenario is a directory: `meta.json`, `prompts.json` (the user turns), `setup.py` (builds the workspace deterministically), `verify.py` (grades the end state), `oracle.py` (writes the reference answer). Verifiers grade state, never path. Categories: prompt, tools, coding, context, memory, safety, cost, verification. A scenario may declare `new_session_before_turns` so the runner restarts the runtime process between turns — what survives a restart is what a memory plugin stored.

## 3. Fairness rules the tool enforces

| Rule | Mechanism |
|---|---|
| Only one variable differs | composed-tree diff through dsh itself; refuse otherwise |
| Same conditions for both arms | one isolated `DSH_HOME` (no user settings, no user credentials file, no telemetry), same profile, same tool roster, same model route recorded from the first request header, network tools off unless the scenario asks |
| Interleaved, back-to-back | job order is scenario → repeat → arm; odd repeats run A then B, even repeats B then A |
| Repeats | default 3, warn below 3, recommend 5; A/A mode to measure the noise floor |
| Verifier validity | `selfcheck` before every run: the oracle must pass and an untouched workspace must fail; a failing scenario blocks the run |
| Ground truth hidden | `<workdir>/.truth` is moved out of the workspace after setup and back before verify |
| Correctness first | a scenario the baseline passes by majority and the candidate fails is a regression; any regression fails the gate and suppresses the cost summary |
| Cost only on comparable pairs | per-repeat pairs where both arms passed; a run that failed early never looks cheap |
| Honest aggregates | percentile bootstrap over scenarios (B=2000, seeded); a CI covering zero reads *inconclusive*, and *equivalent* only when the CI sits inside ±10% (the smallest effect of interest); sign test on discordant pairs; Wilson intervals on pass rates |
| Price drift | every call is priced at the DeepSeek list price of its band (peak/off-peak by UTC calendar) **and** re-priced at both fixed bands, so runs straddling a boundary stay comparable |
| Reproducibility | the run directory holds the plan, the composed tree per arm and its SHA, the dsh version, source path and git revision, the price table date, every session event, and a per-step trace with what the model saw back from each tool; the report is recomputed from ledgers on demand |
| Verifier validity, strict | `selfcheck --strict` deletes and blanks every file the oracle produced, one at a time, and requires the verifier to fail each time; files it ignores are listed as non-discriminating |
| Budget | `--max-usd` stops scheduling trials once spend crosses the cap; finished trials stay and the run resumes with `--resume` |
| Sandbox | dsh's own `workspace-write` confinement (Seatbelt on macOS, bwrap/Landlock on Linux): a trial's bash cannot write outside its workspace, verified by an escape probe (home dir and sibling dirs denied, platform temp dirs allowed); network tools off unless the scenario asks. This is same-world confinement, not a container |
| Human review | per-trial annotations (mark pass / fail / note) stored with the run; the report applies overrides, keeps the machine verdict, and states how many were overridden |

## 4. Architecture

```
dsh-eval (CLI)  ─┐                       ┌─ dsh SDK runtime (subprocess, stdio JSON-RPC)
web UI (Preact)  ├─ core/orchestrate ──── runner ─┤   profile: eval  bundles: dsh-base + dsh-sdk-app
dsh plugin route ┘        │                       └─ overlays: base + arm patches
                          ├─ scenario (python bridge: setup / verify / oracle)
                          ├─ arms + plan (compose, diff, record environment)
                          ├─ ledger (events → usage, price, trace)  ← pricing, usage
                          ├─ report (paired stats)                   ← stats
                          └─ store (runs/<id>/…)
```

- **Runner** (`src/core/runner.ts`): schedules jobs, runs each in a fresh temp workspace, drives the turns through a `Driver`, verifies, writes the ledger. Concurrency is a worker pool that dequeues in interleaved order. Cancellation keeps finished trials; `--resume` skips them.
- **SDK driver** (`src/core/sdk-driver.ts`): one `DeepSeekHarness` process per trial from `@deepseek-ai/dsh-sdk-client`, launched with `--profile eval --patch <base> --patch <arm…>` and `DSH_HOME=<project>/.dsh-eval/home`. Every session event streams back; the ledger is built from `assistant/message` usage, `tool/call`, `turn/end` and the first `request/header`.
- **Ledger** (`src/core/ledger.ts`, `types.ts`): per step hit/miss/output/reasoning tokens, band, USD; per turn; totals with peak/off-peak re-pricing; tool histogram; event counts; verdict; error. Sidecars: `events.jsonl` (raw), `trace.jsonl` (per-step text, reasoning, calls).
- **Report** (`src/core/report.ts`): per-scenario pairing and classification, candidate summaries (pass, pass^k, tokens and $ per solved task, cache-hit share), CIs, gate, one-sentence verdict; Markdown and JSON renderings.
- **Server** (`src/server/index.ts`): HTTP JSON API + SSE progress + static UI, prefix-agnostic so it mounts at `/` (`dsh-eval ui`) or at `/eval` inside the dsh web host (`src/index.ts`, the host plugin, also registers the `/eval` slash command).
- **UI** (`src/ui`): runs list; new-run wizard with the live composed diff, scenario pool, repeats; run page with live trial matrix (pips per repeat), verdict banner with paired statistics, regressions-first paired table with filter chips, environment facts, log; trace page with per-step prompt-size bars (cache-hit share inside), tool calls, reasoning, and a side-by-side compare against the paired trial with a first-divergence marker; ATIF export per trial.
- **Interchange**: `dsh-eval export <run>` writes every trial as an ATIF v1.8 trajectory (Harbor's format) so other viewers can open them.

Tests inject a scripted driver (`tests/helpers.ts`) so the whole engine — scheduling, ledgers, stashing, pricing, report classification, resume, cancel, session breaks — runs keyless in seconds; the real-runtime path is exercised by `dsh-eval run` itself.

## 5. Run layout

```
<project>/
  bench/arms/*.yml            arms (version-controlled)
  bench/scenarios/<name>/     scenarios (optional; the bundled library is used otherwise)
  .dsh-eval/
    config.json               profile name, defaults
    home/                     isolated DSH_HOME with profiles/eval (plugins installed by `dsh-eval add`)
    runs/<id>/
      plan.json  env.json  progress.json  report.json  report.md
      arms/<arm>.patch.yml  arms/<arm>.composed.yml  arms/_base-*.patch.yml
      ledgers/<scenario>/<arm>/rep<N>.json  .events.jsonl  .trace.jsonl
```

## 6. Statistics, precisely

- Per scenario and arm: n runs, passes, Wilson 95% interval, cost list, means, medians, peak-prompt max.
- Classification: `regression` (baseline majority pass, candidate majority fail), `improvement` (reverse), `same`, `both-fail`, `incomplete`.
- Cost pairs: repeat i of baseline with repeat i of candidate when both passed; per-scenario mean Δ$ and Δ% and Δsteps; fixed-band Δ at peak and at off-peak.
- Candidate aggregate: mean over comparable scenarios of the per-scenario Δ; Student-t interval below ten scenarios, percentile cluster bootstrap from ten; `significant` when the interval excludes zero and, when an A/A floor with ≥5 scenarios exists, stays outside its |Δ%| band; `equivalent` when it lies inside ±SESOI (10%); any direction or equivalence needs ≥5 comparable scenarios; otherwise `inconclusive`. A single comparable scenario is reported as a point with no interval.
- Discordant pairs: exact two-sided sign test.
- pass^k: share of scenarios where every repeat passed; pass@k: share with at least one pass.
- Δpass: per-scenario pass-rate difference in percentage points, bootstrapped over scenarios like cost.
- Grade: one word combining both axes — improvement (better correctness, or cheaper without regressions), regression (worse correctness, or dearer), tradeoff (better correctness but dearer), tie (equivalent), inconclusive.
- Flaky: repeats disagree within an arm on a scenario; listed and filterable, and a regression on a flaky scenario is a reason for more repeats before it counts.
- Minimum detectable effect: from the observed spread of per-scenario paired cost differences, MDE ≈ (t₀.₉₇₅,ₙ₋₁ + 0.84) · s/√n, reported as ±% so a reader knows what the design could have seen.
- Noise floor: when the archive holds an A/A run on the same baseline, its |Δ%| and interval are quoted in the notes and drawn in the forest strip.
- Behaviour signature per arm: tool errors, consecutive repeated calls, no-action steps, characters of tool output the model was shown, compactions — the "failure fingerprint" view the Scaffold Effect paper asks for.
- Notes appended automatically: runtime errors, repeats below 3, peak/off-peak straddling, more than one model or effort observed, multi-variable comparison, A/A.

## 6b. Sequential mode, judge, and variance reduction

- **Sequential mode** (`--sequential --seed N`): scenarios are shuffled with the seed and run one at a time on all arms. After each scenario, an asymptotic confidence sequence (Waudby-Smith et al. 2021) is updated on the per-scenario paired cost Δ% and a betting confidence sequence (Waudby-Smith & Ramdas 2020) on x = (Δpass + 1)/2. The run stops once, with at least three scenarios done, the pass sequence excludes 1/2, or the pass sequence contains 1/2 and the cost sequence excludes 0 or lies inside ±SESOI. The final report then uses the sequence as the cost interval, because only a time-uniform interval keeps its coverage under optional stopping; the fixed-sample bootstrap on the same data would be too narrow (`docs/results.md` shows a real run where the two disagree). The decision trace is stored in `sequential.json` and shown in the UI.
- **Blinded pairwise judge** (`dsh-eval judge <run>`): scenarios may declare `meta.judge = { rubric, artifacts }`; the runner copies the artifacts out of every trial's workspace. The judge sees the rubric and the two artifact sets under the names "Submission 1/2", never an arm, model or scenario name; which arm is shown first is drawn from a seed; the judge is asked twice with the order swapped; answers that disagree count as a tie. The report carries wins/losses/ties, McNemar mid-p, the order-disagreement rate, cost, and Cohen's κ against human annotations when the same trials have been reviewed. A single judge model is used (default deepseek-v4-pro), so judge and arms share a model family — a stated limitation; a panel across families is the next step.
- **CUPED**: when the archive holds earlier runs of the baseline arm, each scenario's historical baseline cost is a pre-experiment covariate; the adjusted per-scenario differences d̃ᵢ = dᵢ − θ(xᵢ − x̄) and the variance removed (ρ²) are reported beside the raw interval. Never used as the headline claim.
- **Statistics summary**: cluster t/bootstrap intervals over scenarios with ICC and design effect; ≥5 comparable scenarios and no overlap with a measured A/A noise band before any direction; McNemar mid-p and a Beta posterior on discordant pairs; resolution q = n/N*; MDE; Bonferroni across candidates; holdout gap; tool-sequence similarity within and between arms.

## 6c. Container isolation

`--sandbox docker` runs each trial's whole dsh runtime inside `docker run` (default image `node:22-bookworm-slim`, one container per trial, removed on exit). Mounts: the dsh source checkout and the directory holding its `current` link (read-only), every plugin directory the eval profile links (read-only), the run directory with the overlays (read-only), the eval home (read-write: profile, sessions) and the trial workspace (read-write). Nothing else from the host is visible; the escape probe in the results log shows `/Users/<you>` containing only the mounted paths. The container talks to the model API over the normal network; network *tools* remain governed by the scenario's flag. Two adaptations are needed and made automatically: dsh's loader reaches Node's internal ESM loader through a per-platform native addon, so inside Linux the runtime is started with `--expose-internals` (the loader's documented alternative); dsh's Koffi dependency is per-platform, so the Linux package of the same version is fetched once per eval home and bind-mounted over the checkout's platform directory. Inside the container dsh's in-process sandbox has no backend (no bubblewrap, no Landlock on stock Docker kernels), so the overlay switches to the plain bash executor and turns off the permission-preset row; the container is the boundary. The driver is a self-contained JSON-RPC stdio client (`src/core/rpc-driver.ts`) that mirrors the official SDK client's activity interval, so the same driver can launch any command.

## 6d. Judge panel, absolute grading, and PPI++

`dsh-eval judge --model A --model B …` forms a panel: each model is asked in both orders; a model's vote is a tie when its two orders disagree; the pair's preference is the majority of decided votes only when that majority is a strict majority of the whole panel, so a single confident judge cannot carry a panel of two. The report shows the panel's unanimity rate and the order-disagreement rate of all votes. Judges from other provider families are added in `.dsh-eval/config.json` (`judges: [{name, model, baseUrl, apiKeyEnv}]`) or inline as `model@baseUrl`. `--mode absolute` grades every trial on its own against the rubric; per-arm pass rates are then rectified with prediction-powered inference (PPI++, Angelopoulos, Duchi & Zrnic 2023): θ̂ = ȳ_labelled + λ̂ (f̄_all − f̄_labelled) with λ̂ = Cov(y,f)/((1+n/N)Var(f)) clipped to [0,1] and the standard error from the residuals, where the labels are the human annotations already stored with the run. Without labels the estimate is judge-only and marked uncalibrated.

## 6e. Wire meter, sealed evidence, regrade

**Meter.** The runtime's usage report comes from inside the process that hosts the component under test, so it is self-reported. Every trial can instead run through a local HTTP proxy (`src/core/meter.ts`) that forwards to the provider unchanged, records the provider's own `usage` from each response (streamed or plain) with latency and status, and chains the entries with sha256. The runtime is pointed at the proxy by an `llm-deepseek` `baseURL` overlay row that is identical in both arms, so the one-variable diff is unaffected; inside containers the row names `host.docker.internal`. After the trial the ledger totals are compared with the meter totals (1% tolerance) and the ledger carries `usageProvenance`. The report prints the provenance, and a directional or equivalence cost call is withheld when any comparable trial did not reconcile. The same proxy injects provider faults (`--fault-rate`: seeded 429s and stalls) so a component's behaviour under provider trouble can be measured; faults are counted per trial.

**Seal.** When a run finishes, `manifest.json` records the sha256 of every evidence file (plan, environment, arms, ledgers, events, traces, artifacts, meter ledgers, progress, sequential trace) and one evidence sha over the set. `dsh-eval verify <run>` recomputes every hash, lists missing, changed and added files, re-derives the report from the sealed ledgers plus the current annotations and judge files, and compares the readings (gate, cost reading, grade, verdict text) with the stored report. Report, annotations and judge files are derived or added later and are checked through the re-derivation rather than by hash.

**Regrade.** `dsh-eval regrade <run>` re-runs each scenario's verifier on the kept workspace of every trial (`--keep-workdirs`), without touching any agent, records old → new verdicts and the verifier hashes, rebuilds the report and re-seals with the regrade in the manifest. Ledgers store the verifier's sha at run time so a regrade can say which verifier version graded what.

## 7. What it does not do (yet)

- A same-family judge is refused by default; a cross-family panel needs endpoints the user configures (the mechanism exists, the models are the user's). No conformal abstention, no anchor-set drift attribution.
- Host mode confines through dsh's own sandbox; container mode isolates through Docker mounts but cannot use dsh's in-process sandbox inside the container; no microVM path.
- No prompt-perturbation floor, served-model fingerprinting, active scenario selection, simulated user, record/replay/fork, within-trial early termination, or failure attribution with rerun validation.
- DeepSeek pricing only; other providers price at zero and are reported as unknown.

## 8. Gap checklist

The landscape survey ended with eight gaps no surveyed tool fills. Status here:

| gap | dsh-eval-infra |
|---|---|
| paired, interleaved same-window runs | yes — one process schedules scenario → repeat → arm with alternating order |
| one-variable enforcement between arms | yes — composed-tree diff through `dsh --dump-config`, refused above one row |
| oracle / null verifier self-checks | yes — `selfcheck` gates every run; ground truth stashed out of the workspace |
| never-worse gating | yes — regression classification blocks the cost summary; CLI exit code 1 |
| cache-aware cost with time-of-day pricing | yes — per-call band pricing plus fixed-band re-pricing; hit/miss/output split |
| public comparable ledgers | partly — self-contained run directories, JSON report, static HTML export; no shared registry yet |
| component-level (not model-level) evaluation | yes — the unit is a dsh composition difference |
| multi-session memory scenarios | yes — `new_session_before_turns` restarts the runtime; `m1_cross_session_recall` |
| prompt-injection safety scenarios | yes — `x1_injected_readme`, `x2_tool_result_injection` with state-inspecting verifiers |

## 9. Positioning

Harbor runs whole agents on task sets in containers; promptfoo and the observability platforms compare experiments after the fact; Claude's `plugin eval` (early access) does with/without ablation for its own plugins. dsh-eval-infra sits between them: the comparison unit is a dsh composition difference, the two arms are run paired and interleaved by one process, the verifier is checked before the first trial, cost is cache- and calendar-aware, and everything is recomputable from the ledgers.
