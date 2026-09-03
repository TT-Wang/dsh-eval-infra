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
| Reproducibility | the run directory holds the plan, the composed tree per arm and its SHA, the dsh version and source path, the price table date, every session event, and a per-step trace; the report is recomputed from ledgers on demand |

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
- Candidate aggregate: mean over comparable scenarios of the per-scenario Δ; 95% percentile bootstrap over scenarios; `significant` when the interval excludes zero; `equivalent` when it lies inside ±SESOI (10%) with ≥2 scenarios; otherwise `inconclusive`. A single comparable scenario is reported as a point with no interval.
- Discordant pairs: exact two-sided sign test.
- pass^k: share of scenarios where every repeat passed; pass@k: share with at least one pass.
- Notes appended automatically: runtime errors, repeats below 3, peak/off-peak straddling, more than one model or effort observed, multi-variable comparison, A/A.

## 7. What it does not do (yet)

- No LLM judge. Verifiers are deterministic by design; scenarios that need judgment are out of scope until a blinded, calibrated judge exists (see methodology §A3).
- No sandboxing beyond a fresh directory and network tools off; scenarios run bash locally through dsh's own tools. Containers are a Harbor-shaped addition.
- No cross-run trend view yet; runs are self-contained directories that can be compared by rebuilding reports.
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
