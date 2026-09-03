# UI patterns for evaluation & comparison tools — survey and recommendations for a local paired-A/B UI

Date: 2026-09-04. Method: ~50 WebSearch/WebFetch calls against official docs, changelogs, GitHub READMEs and blog walkthroughs (source list at the end). Where a claim comes from my own use of a product rather than a fetched page it is marked *(from use)*. Where docs were thin (Weave's eval compare, Phoenix OSS compare) that is stated rather than papered over.

---

## 1. Survey: how each tool presents evaluation / comparison results

### 1.1 promptfoo — `promptfoo view`
Docs: https://www.promptfoo.dev/docs/usage/web-ui/ · Repo: https://github.com/promptfoo/promptfoo

**On screen.** One big table ("prompt evaluation matrix"): rows = test cases (the `vars`), columns = prompt × provider combinations. Every cell holds the model output text for that (test, prompt/provider) plus a PASS/FAIL badge and score; column headers carry the per-column aggregate (pass rate; token/latency/cost stats *(from use)*). Launched with `npx promptfoo@latest view` against a local SQLite DB of past evals; an eval picker switches between evals.

**Interactions.**
- Toolbar display-mode dropdown: **All / Failures / Passes / Errors / Different / Highlights**. "Different" (only rows where columns disagree) is the single most useful mode for A/B work.
- Text/regex search; metric filters with operators (`=`, `contains`, `>`, `<`).
- Hover a cell → action icons: mark pass/fail, set custom score 0–1, comment, highlight for review, copy output, shareable link. Ratings/comments persist and are included in exports.
- Click a cell → **details modal**: full output, rendered prompt, variables, grading (assertion-by-assertion) results.
- Table settings: toggle variable/prompt columns, zoom 50–200 %, truncation, markdown/JSON rendering, image size limits.
- Charts: pass rates, score histograms, inference details (tokens, latency, cost, tokens/s); a **scatter plot** for head-to-head prompt comparison (green = prompt 2 higher, red = prompt 1 higher, gray = tie).
- Eval actions menu → **compare/diff against another eval** (green = added, red = removed).

**Take-away.** The matrix-with-column-aggregates + "Different"/"Failures" modes + hover-to-override is the archetype; everything else in this survey is a variation.

### 1.2 Braintrust — experiment comparison
Docs: https://www.braintrust.dev/docs/evaluate/compare-experiments · https://www.braintrust.dev/docs/guides/evals/interpret · trace view: https://www.braintrust.dev/docs/guides/traces/view · https://www.braintrust.dev/foundations/how-to-read-a-trace

**On screen.** Experiment page = table of test cases with score columns. Choosing a comparison experiment turns on comparison mode: a **score-delta column** appears per score, rows tinted green (improvement) / red (regression), each cell shows the numeric change; column headers show the aggregate and counts. A "Comparisons" sidebar lists candidate experiments.

**Baseline.** Hover an experiment in the sidebar → **Set as baseline** (persists per experiment); or a project-wide default baseline; with neither, Braintrust auto-picks the most recent experiment on the same git branch. Test cases are aligned across experiments by `input` by default, or a custom comparison key (SQL expression, e.g. `[input.query, metadata.category]`).

**Interactions.**
- Click a score value in a column header → filter to "X regressions" / "X improvements". **Sort by regressions** puts the most-affected cases on top.
- **Diff** toggle: the table shows sub-rows per experiment with additions/removals relative to the base; sub-modes Base→Comparison, Comparison→Base, Expected→Output; character-level diffs in the detail panel, optionally side-by-side columns.
- Aggregate layouts: **Summary** (score cards per experiment with improvement/regression/matching filters), **Summary table** (rows = metrics, columns = experiments, plus a **"Comparison grade"** row: Improvement / Regression / Tradeoff / Tie), **Grid** (stacked cards).
- **Trial grouping**: repeated evaluations of the same input collapse into one row with aggregate stats and expandable individual trials — explicitly "to detect model inconsistency". This is the closest existing pattern to "repeats".
- **Pairwise scoring card**: human head-to-head preference while in diff mode, surfaced as a Pairwise score column / aggregate %.
- Preset filters: All traces, Non-errors, Errors, Scorer errors, Unreviewed, Assigned to me. Display menu: group by metadata, compact/tall density, list/grid/summary layouts, show/hide columns, custom SQL columns, shareable saved views.
- Trace page: two panes — **span tree left, span details right**; **Timeline** view (bars, width = duration, colored by span type); **Thread** view (spans as chat messages); Find + filter by span type/field. Span kinds: root (top-level I/O + final scores), LLM (model, full message history, prompt/completion tokens, latency, **cache status**, estimated cost), scoring (score name, value, chain-of-thought), function/task/tool.

### 1.3 LangSmith — comparative experiments & pairwise annotation queues
Docs: https://docs.langchain.com/langsmith/compare-experiment-results · https://docs.langchain.com/langsmith/evaluate-pairwise · https://docs.langchain.com/langsmith/annotation-queues · blog: https://www.langchain.com/blog/pairwise-evaluations-with-langsmith

**Comparison view (on screen).** Dataset → Experiments tab → tick 2+ experiments → **Compare**. Columns = experiments (one output column each plus feedback/score columns), rows = dataset examples. The first selected experiment is the **source** (baseline); hover the experiment icon at the top → "Set as source experiment". Runs that regressed on any feedback key vs source are tinted **red**, improved **green**. Above each feedback column: **counters of improved / regressed runs, clickable to filter**.

**Interactions.**
- Table view modes: **Compact** (preview), **Full** (complete inputs/outputs/reference, expandable), **Diff** (text diff, two experiments only, JSON/YAML aware). Display type Default/YAML/JSON.
- Filter icon: by input/output content, execution status, latency, metadata, tags, feedback; per-column filters via the column's vertical dots; a columns icon toggles feedback keys and metrics.
- Click a row → detail panel with two modes: **Details** (feedback keys, scores, metrics, inputs, outputs, reference, attributes) and **Traces** (the two experiments' traces **side by side**; with >2 experiments, two at a time with header controls to switch pairs).
- Per feedback key: configure "higher is better" (stored).
- **Charts** dropdown: choose an experiment-metadata field as the x-axis label so trend charts across experiments read as "by model" / "by prompt version".

**Pairwise experiments.** A dedicated **Pairwise Experiments** tab on the dataset page; opening one gives the comparison view where the header of each column carries **thumbs up/down + color** indicating which side was preferred; clicking the thumbs filters to rows where that side won. Scores are 0/1/2 (tie / A / B). Clicking the `ranked_preference` score under an answer opens the judge trace with its explanation.

**Pairwise annotation queues (human A/B).** Each queue item shows **Run A on the left, Run B on the right, rubric below**; per rubric item choose **A is better / B is better / Equal**; hotkeys `A`, `B`, `E`, `Enter` to advance, **Done**; **Requeue**; comments attach to either run; a Details view opens the full trace; reservations stop two reviewers judging the same pair.

### 1.4 Inspect AI — `inspect view`
Docs: https://inspect.aisi.org.uk/log-viewer.html · walkthrough: https://hamel.dev/notes/llm/evals/inspect.html · changelog: https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/CHANGELOG.md

**On screen.** `inspect view --log-dir ./logs --port 6565` (also a VS Code panel). Header = task name, model, aggregate metrics (e.g. accuracy with bootstrap stderr); a **history menu** (top right) switches between log files in the directory. Below, the **samples table**: input, target, extracted **Answer** (surfaces extraction failures that caused wrong scoring), score (Correct/Incorrect). During a running eval the viewer shows completed samples with **incremental metric calculations** and lets you follow transcripts live.

**Interactions.**
- **Sort** picker: chronological (grouped by epoch), by score, or **by sample** — which groups all epochs of one sample together, "especially valuable for diagnosing the sources of inconsistency".
- **Scores** picker: filter to specific score values (e.g. only Incorrect).
- Click a sample → detail panel with tabs: **Messages** (full transcript: system/user/assistant/tool messages incl. tool calls and outputs, assistant "thinking"), **Scoring** (input, target, extracted answer, scorer explanation), **Metadata** (from solvers/tools/scorers), plus a **Transcript** (event) tab in current versions where spans are auto-created and visually delineated for sample init, solvers, scorers, subtasks, tool calls and agent execution, with event timestamps in tooltips (changelog), and a JSON tab.
- **Info** panel: dataset, solver, scorer, git revision, model token usage.
- `inspect view bundle` produces a **self-contained static site** (GitHub Pages/S3/HF Spaces) for sharing a result set.

**Take-away.** Best-in-class for *epochs* (repeats): the "by sample" sort is exactly the consistency view a repeats-aware tool needs; and the static bundle is the cheapest possible "share a run".

### 1.5 Langfuse — datasets / experiments compare
Docs: https://langfuse.com/docs/evaluation/experiments/experiments-via-ui · https://langfuse.com/docs/datasets/overview · changelogs: https://langfuse.com/changelog/2024-11-18-dataset-runs-comparison-view · https://langfuse.com/changelog/2025-11-06-compare-view-baseline-support · https://langfuse.com/changelog/2026-04-13-experiments-rebuild · workflow post: https://langfuse.com/blog/2025-11-06-experiment-interpretation

**Setup (UI-run experiments).** Dataset → **Start Experiment**: name, prompt (from Prompt Management), LLM connection, dataset, optional structured-output schema, optional evaluators (LLM-as-judge / code). Since 2026-04 "Experiments" is a top-level section that runs with or without a dataset and lists runs from datasets, production traces and local runs in one list.

**On screen.** **Experiments table**: one row per run with aggregate scores, cost, latency. Select two → **Compare** → set one as **baseline**. The compare page has tabs: **Charts** (aggregate baseline vs candidate: score, cost, latency distributions) and **Outputs** (the main table: each row = one dataset item, baseline and candidate outputs side by side, matched by stable item id, with **green/red deltas for score, cost and latency** and column-header summaries).

**Interactions.** Filter by score thresholds (`Candidate Hallucination > 0.0`) or performance deltas (`Cost Delta > 10 %`) to build a regression work-queue; row click opens the two traces; **Annotation Mode** for a two-pass triage (engineer marks `review_status: fail`, SME adds `failure_mode`). Sorting by worst items was "coming soon" as of the 2025-11 post — a sign that regressions-first sorting is felt as essential.

### 1.6 Arize Phoenix (and Arize AX) — experiments compare
Phoenix docs: https://arize.com/docs/phoenix/datasets-and-experiments/overview-datasets · https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments · repo: https://github.com/Arize-ai/phoenix · fullest compare description (AX, same product family): https://arize.com/docs/ax/develop/datasets-and-experiments/compare-experiments · blog: https://arize.com/blog/new-in-arize-ax-experiment-comparisons-better-data-visualization-and-a-dedicated-agent-graph-tab/

**On screen.** Dataset → **Experiments** tab: one row per experiment with aggregate evaluator scores (plus optional binary-classification metrics F1/Accuracy/Precision/Recall); evaluators can be added after the fact (**Add Evaluator**), winning runs tagged (e.g. "production"). Select experiments → **Compare Experiments**: rows = examples, one column per experiment showing output, evaluator results and metadata; each run links to its trace.

**Interactions.** **Table View** vs **Charting View** (box plots per experiment: median, quartiles, spread, outliers — to tell consistent improvement from outlier-driven change). Column chooser; operational columns (latency, tokens, cost, error rate) fetched on demand. **Diff Mode**: pick a baseline → evaluator differences highlighted, **aggregated deltas vs baseline at the top**. **Diff Output Mode**: insertions/deletions/changes in output text vs baseline. (Phoenix OSS docs I could fetch describe the same per-example, column-per-experiment table with evaluator scores and trace links but not the AX Diff Mode wording — treat the AX page as the richest description of the layout.)

### 1.7 W&B Weave — evaluations compare
Docs: https://docs.wandb.ai/weave/guides/tools/comparison · https://docs.wandb.ai/weave/guides/core-types/evaluations · https://docs.wandb.ai/weave/guides/core-types/leaderboards · product page: https://wandb.ai/site/evaluations/

**On screen.** Evals tab → select evaluations → **Compare**. The generic comparison view lays out **objects as columns, properties as rows**; at most six objects visible, an interactive comparison bar with draggable call-ID tokens to reorder/remove. In the eval compare you add/remove evaluations, show/hide metrics, and **page through individual examples** to see each model's output for the same input; summary charts per metric sit above (W&B materials also show a radar-style summary; I could not confirm that in the fetched docs).

**Interactions.** Baseline via an object's action menu → it moves to the leftmost column labelled **Baseline**; otherwise each column compares to its left neighbour ("Compare with previous" vs "Compare with baseline"). View modes: **Summary** (I/O + tokens, cost, latency), **Calls** (full trace trees, text search, per-call metrics toggle), **Side-by-side** vs **Unified** (two objects). **Diff only** toggle hides unchanged rows; clicking a numeric diff cycles integer ↔ percent. **Leaderboards** (Leaders tab): rows = models, columns = (evaluation, scorer, metric).

### 1.8 OpenAI Evals dashboard
Docs: https://developers.openai.com/api/docs/guides/evals · dashboard: https://platform.openai.com/evaluations · community walkthrough: https://community.openai.com/t/how-to-use-new-evals-ui-in-dashboard/1258284 · cookbook: https://developers.openai.com/cookbook/examples/evaluation/use-cases/responses-evaluation

**On screen.** Create an eval once (data source = uploaded JSONL or stored completions/responses logs; **testing criteria** = string check, similarity, model graders incl. a generic o3-mini "auto-grader", custom prompts), then run it repeatedly against different models/prompts. Each run has a `report_url` page with per-row results, per-criterion pass/fail and grader output (e.g. a JSON with a 1–7 score against a 5.5 threshold), pass-rate summary and **API usage** (tokens, model invocations) per run; runs of the same eval are listed together for comparison.

**Signal.** The docs now carry a sunset notice: "Evals will become read-only for existing users on October 31, 2026, and the platform is scheduled to shut down on November 30, 2026." Hosted eval dashboards come and go — a strong argument for a local, file-based tool with static export.

### 1.9 Harbor / Terminal-Bench ecosystem
Harbor: https://www.harborframework.com/ · viewer docs: https://www.harborframework.com/docs/run-jobs/run-evals · ATIF spec: https://www.harborframework.com/docs/agents/trajectory-format · hub: https://hub.harborframework.com · repo: https://github.com/harbor-framework/harbor · non-linear-history issue: https://github.com/laude-institute/harbor/issues/239 · Terminal-Bench: https://www.tbench.ai/ · ATIF viewer demo: https://github.com/Slimshilin/ATIF-trajectory-viewer (live: https://atif-trajectory-viewer.vercel.app/) · Trajectories.sh: https://www.trajectories.sh/

**`harbor view jobs`** starts a local server (default http://127.0.0.1:8080). Screens: **Jobs** list (filter/search by agent, model, dataset, date range) → **Trials** (per task: reward, durations, errors) → **Trajectory** (step through tool calls, observations, text+images). Select multiple jobs → **side-by-side comparison matrix** of task performance across agent/model combinations. Also artifact browsing, AI failure summarization, keyboard `j`/`k`, `Enter`, `Esc`. Trial view shows per-step source (system/user/agent), message, reasoning, tool calls with args, observations linked to calls, **token usage (prompt / completion / cached / USD)**, and three timings (setup, agent execution, verification) plus verifier output. On-disk layout: `jobs/{job}/{trial}/trajectory.json`, `agent/recording.cast`, `logs/verifier/reward.txt`.

**ATIF v1.8** (the trajectory format) is worth adopting outright: `steps[]` with `step_id`, `timestamp`, `source`, `message`, `reasoning_content`, `tool_calls[]`, `observation`, `metrics{prompt_tokens, completion_tokens, cached_tokens, cost_usd}`, `model_name`, `llm_call_count`; `final_metrics` totals; `trajectory_id` for embedded subagent trajectories. Issue #239 flags a real gap: when context is summarized/compacted the history becomes non-linear (`continued_trajectory_ref`) and linear viewers break.

**ATIF trajectory viewer** (static, browser-only): three panels — **left: scrubbable step timeline; middle: agent workspace** (terminal output + reconstructed filesystem with GitHub-style A/M/T/D badges, Human ⇄ Agent toggle; it parses Write/Edit/apply_patch *and* shell writes); **right: step detail** (messages, reasoning, tool calls, observations, reward and verifier logs, rubric subscores, step-level annotations). A failure taxonomy (Stage · Root cause · Behaviour · Impact) with evidence quotes that link to steps. Specialized renderers for spreadsheets, ARC grids, web fetches, computer-use screenshots.

**tbench.ai leaderboard**: RANK · MODEL · AGENT · RESOLUTION RATE (bar with **95 % CI whiskers**) · COST · TOKENS; tasks link to the Harbor Hub dataset viewer. **Trajectories.sh** wraps each uploaded Harbor run in the viewer (step replay, screenshots, agent logs, verifier output, terminal recordings) and adds pass-rate/run-count comparisons against public benchmarks.

### 1.10 Open-source agent trace / trajectory viewers (2026)
- **AgentPrism** (Evil Martians, React component library): https://github.com/evilmartians/agent-prism · https://evilmartians.com/chronicles/debug-ai-fast-agent-prism-open-source-library-visualize-agent-traces — `TraceViewer` = `TraceList` + `TreeView` (hierarchy, search, expand/collapse, red highlighting of problematic patterns, **collapsed summary for repetitive sequences**) + `TimelineView` (Gantt bars, green/red/yellow status, **running cost accumulation in dollars**) + `DetailsView` (input/output, cost breakdown, attributes) + a sequence-diagram replay with play/pause. Adapters for OTLP, OpenInference and Langfuse. React 19 + Tailwind.
- **claude-tap** (~3.2k stars): https://github.com/liaohch3/claude-tap — local proxy + viewer for Claude Code / Codex CLI / Gemini CLI / Cursor etc. Sidebar grouped by model; `j`/`k` navigation; one request/response per view; system prompt and history as expandable sections; tool schemas as cards; tool calls/results with folding; **token usage split input / output / cache read / cache creation**; a **structural diff modal between consecutive requests** (added/removed messages, system-prompt diff, character-level highlighting); full-text search; single self-contained HTML; live mode over SSE; embed mode. Sibling: **claude-trace** https://github.com/hanqunfeng/claude-trace.
- **OrcaReplay** (announced 2026-09-02): https://github.com/Continuum-AI-Corp/OrcaReplay — `orca ui` opens a self-contained HTML **timeline** of model turns (with token counts), tool calls, shell commands (exit code, timing) and filesystem changes; filter events; step or press space to replay at original pace; **fork from step N onto another model**; `orca compare --models a,b --verify "npm test"` yields a side-by-side verdict table with tokens and cost; divergence report (`reused=2/2 exact=2 divergences=0`); causal-chain SVG cards.
- **OpenHands trajectory-visualizer**: https://github.com/OpenHands/trajectory-visualizer — timeline with actions in blue, observations gray/red; each step shows timestamp, title, content, metadata; arrow-key navigation; load by upload, `fileUrl`, or base64 `data` param; dark/light.
- **SWE-agent inspector**: https://swe-agent.com/latest/usage/inspector/ — `sweagent inspector` web UI at :8000 listing `.traj` files with ✅/❌ from `results.json`; a CLI pager with vim keys (`H`/`L` trajectories, `h`/`l` steps, `v` reduced/full view).
- **AgentTrace**: https://github.com/Rxflex/agenttrace — run list + expandable span tree + details (type, timestamps, attributes JSON, prompt/response events); timeline, filtering and run comparison still on the roadmap.
- **agent-trace / `agent-strace`**: https://github.com/Siddhant-K-code/agent-trace — replay to terminal/HTML, phase-by-phase **timeline with costs and retries**, `replay a --diff b` side-by-side session diff of tool args/outputs, VS Code status-bar live cost.
- **agentlens**: https://github.com/tranhoangtu-it/agentlens — decision-tree + trace views, per-span tokens/cost/latency, replay sandbox (edit inputs at a span and compare), trace diff, LLM "Autopsy".
- Also on the GitHub topic pages (https://github.com/topics/trace-viewer, https://github.com/topics/agent-tracing): *tracelens* (local-first, zero-backend: call tree, flamegraph, diff, search, shareable links), *debrief* (Claude Code session logs), *AgentScope*, *browsertrace*, *clens*, *causetrace*, *waggle* (local OTel viewer, SQLite, waterfall).

---

## 2. Cross-cutting patterns

1. **The unit is a row per test case, a column per arm, a cell per output** (promptfoo, LangSmith, Langfuse, Phoenix, Weave, Harbor compare matrix). Column headers double as aggregate scoreboards and as filter buttons.
2. **Baseline is a first-class, persistent setting** (Braintrust "Set as baseline", LangSmith "source experiment", Langfuse baseline, Phoenix Diff Mode, Weave "Baseline" leftmost). Deltas are always relative to it; green/red row tint is universal.
3. **Regressions get their own entrance**: header counters that filter (LangSmith), "Sort by regressions" (Braintrust), threshold filters like `Cost Delta > 10 %` (Langfuse), "Different"/"Failures" modes (promptfoo).
4. **Three densities of the same table**: compact preview → full text → text diff (LangSmith Compact/Full/Diff; Braintrust Diff toggle; Phoenix Diff Output Mode; Weave Diff only).
5. **Row → detail panel with two modes**: scores/explanations vs side-by-side traces (LangSmith Details/Traces; Braintrust trace pane; Langfuse row → traces).
6. **Repeats/epochs are handled by grouping**: Braintrust trial grouping (aggregate row, expandable trials), Inspect sort-by-sample across epochs. Nobody renders repeats inline as compact glyphs — an opening.
7. **Uncertainty is rare in eval UIs**: Inspect prints bootstrap stderr, tbench.ai draws 95 % CI whiskers, Phoenix charts box plots; the comparison tables show point deltas only.
8. **Trace viewers converge on tree/timeline left + detail right**, colored by span kind, with fold/unfold, `j`/`k`, and per-span tokens/cost; the 2026 crop adds cache-token splits (claude-tap), request-to-request diffs (claude-tap), running cost (AgentPrism), and replay/fork (OrcaReplay).
9. **Local-first + static export is the norm for OSS tools** (`promptfoo view`, `inspect view` + `bundle`, `harbor view jobs`, claude-tap single HTML, OrcaReplay `orca ui`). Hosted dashboards are the ones getting sunset (OpenAI Evals).
10. **Performance is a feature**: Braintrust shipped "Experiments UI: now 10x faster", Langfuse rebuilt experiments to "load quickly on large runs", Weave caps compare at six columns. Virtualize the matrix from day one.

---

## 3. Recommendations for the local paired-A/B UI

Assumptions: a run = {baseline arm, candidate arm} × scenario pool × k repeats; each trial produces a verdict (pass/fail, optionally a score), cost, tokens (incl. cache read/write), duration and an ATIF-style trajectory. Everything is local (SQLite + trajectory files) and served by one CLI command (`<tool> view`), like promptfoo/Inspect/Harbor.

### 3.1 Run-setup screen
**Layout (single page, top to bottom):**
1. **Run name** (auto-filled from the diff, e.g. `planner-model: sonnet-4 → opus-4.1`), editable.
2. **Two arm cards side by side — "Baseline" | "Candidate"** — each a resolved config view (component under test, model, prompt hash/version, tool set, temperature, max steps, price table). Pick each from saved arms or "duplicate baseline and edit". Baseline defaults to the persistent project baseline (Braintrust pattern).
3. **"What differs" strip between/below the cards**: a Weave-style *diff-only* property table listing exactly the keys whose values differ, old → new, with a text diff for prompt fields (LangSmith Diff / Braintrust Base→Comparison). If the count ≠ 1, show an amber banner: "2 variables differ (model, temperature) — the result won't isolate a cause" with one-click "reset X to baseline". Allowing >1 is fine; the UI should make the single-variable discipline visible, not mandatory.
4. **Scenario pool**: table with checkbox, id, name, tags, last verdicts for these arms (mini pips from history), estimated cost from prior runs; tag filter and search; "select all / by tag". Show the pool version/hash.
5. **Repeats** stepper (default 3) and **pairing** note ("each scenario × repeat runs both arms with the same inputs/seed"). Next to it, a live footer: `N scenarios × k repeats × 2 arms = T trials · est. cost $X · est. time Y` (from history) and a rough minimum-detectable-effect hint from N·k (so 5 scenarios × 1 repeat is visibly underpowered).
6. Footer: concurrency, budget cap (stop when spend > $Z), **Start run** (primary) and a "copy as CLI / YAML" so the run is reproducible outside the UI.

### 3.2 Live-run screen
**Header bar:** run name; elapsed / ETA; `completed / total trials`; **cost so far** as two stacked figures (baseline $, candidate $) with a budget bar; **Cancel** (confirm dialog; cancel keeps finished trials, marks the rest "cancelled", and drops straight into the results screen on partial data — Inspect's incremental-metrics behaviour).

**Main grid:** rows = scenarios; two column groups **Baseline | Candidate**; inside each group one small cell per repeat. Cell states: queued (empty), running (spinner + elapsed seconds), pass (green), fail (red), error (amber, icon), cancelled (hatched). A running summary row at the top: pass rate so far per arm (with the wide, honest interval and "n so far"), mean cost/trial, mean steps. Click a running cell → the trace drill-down in **live mode** (steps append as they happen; SSE like claude-tap) with a live cost counter (AgentPrism's "real-time cost accumulation").

**Side rail (collapsible):** event feed of the last ~50 steps across all trials (trial, step, tool, tokens, cost), errors pinned; per-arm rate-limit/retry counters. Keyboard: `j`/`k` rows, `Enter` opens trace, `Esc` back.

### 3.3 Results screen
**Verdict header (the one thing a visitor must read):**
- A **dumbbell/forest strip**: baseline pass rate and candidate pass rate as two dots with 95 % CI whiskers (tbench.ai idiom), and beneath it the **paired delta with its band**: `Δ pass = +7.5 pp [−2.1, +17.1]`. Compute by cluster bootstrap over scenarios (resample scenarios with replacement, keeping all repeats of both arms together — that respects pairing and repeats). Color the delta badge green/red **only when the band excludes 0**; otherwise gray with "not significant at n=…".
- The same for **Δ cost/trial** and Δ duration, and a Braintrust-style **comparison grade**: Improvement / Regression / Tradeoff (quality up, cost up) / Tie.
- Per-arm summary cards: pass rate, mean cost, p50/p95 duration, mean steps, mean tokens with **cache-hit share**.

**Filter chip row** (counts in the chips, like LangSmith header counters): All · **Regressions (n)** · Improvements (n) · Unchanged · **Flaky (n)** · Errors; a search box; tag filter; threshold filters (`Δ cost > 10 %`, `steps > 30`, Langfuse-style); saved views.

**Paired matrix** (virtualized), default sort = regressions first by magnitude, then flaky, then improvements, then unchanged (Braintrust "sort by regressions"):

| Scenario | Baseline (k pips + `2/3`) | Candidate (k pips + `3/3`) | Δ pass | Base $ | Cand $ | Δ $ | steps B→C | tags |

- Repeats render as **pips** (●●○) so a row shows both the fraction and the pattern; hover a pip → verdict reason, cost, duration; click → that trial's trace.
- Row status computed on pass fractions: improved / regressed / tie; **"flaky" badge** when repeats disagree within one arm (Inspect's epochs-by-sample idea, Braintrust trial grouping), so an apparent regression that is really noise is labelled as such.
- Row tint (left border) red/green; column headers show aggregate + clickable improved/regressed counts.
- **Row expand** (inline, not modal): side-by-side final outputs of baseline vs candidate for a chosen repeat with a **Diff toggle** (LangSmith Diff / Phoenix Diff Output Mode), the judge/verifier rationale for each (Inspect Scoring tab, Braintrust scoring span CoT), and "Open trace" buttons per repeat plus "Compare traces".
- **Human override** on any trial: mark pass/fail, score, comment, highlight (promptfoo hover actions) — stored locally and included in exports; overrides re-flow into the header statistics with an "includes N manual overrides" note.
- Optional **pairwise judgment mode** for scenarios without automatic verdicts: A | B side by side, `A`/`B`/`E` hotkeys, `Enter` next (LangSmith pairwise queue).
- **Export**: JSON/CSV, and a **self-contained static HTML bundle** of the run (Inspect `view bundle`, claude-tap single-file) for pasting into a PR.

### 3.4 Trace drill-down (one trial)
**Header:** scenario · arm · repeat · verdict badge · total cost · tokens as a stacked bar (**cache read | cache write | uncached input | output**) · duration · step count · **"Compare with paired trial"** toggle (opens the same scenario/repeat from the other arm in a split view).

**Left: step timeline** (vertical, ATIF steps). Each row: step index, source icon (agent / tool / user / system), one-line summary (tool name + arg preview, or first line of message), a duration bar, per-step tokens with a small cache-hit glyph, per-step cost, status color. Above it a thin **waterfall strip** (Braintrust Timeline / AgentPrism TimelineView) showing where wall-clock went, with a **"context size" sparkline** (prompt tokens per step) so context bloat and cache misses are visible at a glance. Repeated sequences collapse into "×7 read_file …" summaries (AgentPrism). `j`/`k`, `Enter`, `Esc`; step filter (LLM / tool / errors only); full-text search across the trace (Braintrust Find, claude-tap search).

**Right: step detail**
- **Reasoning** block in a distinct muted style, collapsed to a 2-line preview by default, expandable; a global "show reasoning" toggle.
- Assistant message (markdown rendered, raw toggle).
- **Tool calls as cards**: name, pretty-printed args with copy; the **result folded by default** with a size line ("12.4 KB · 300 lines · 1.9 s"), "show 280 more lines", per-kind defaults (file reads folded, errors expanded), "expand all / collapse all", images rendered inline (Harbor multimodal).
- Per-step **token panel**: prompt tokens split into cache read (hit) / cache write / uncached, completion tokens, step cost, cumulative cost; a hit-rate figure for the step and the trial.
- Tabs across the detail pane: **Steps** (default) · **Messages** (raw API view, what the model actually saw — claude-tap) · **Verdict** (judge/verifier input, output, rubric, explanation) · **Raw JSON** (the ATIF file, downloadable).

**Paired diff view** (the differentiator): two step timelines aligned side by side; alignment by tool-call sequence (LCS on tool names) with a **"diverged at step 4"** marker (OrcaReplay's divergence idea; claude-tap's request-to-request structural diff), and per-step token/cost deltas. Design the step model to tolerate compaction/subagents (ATIF `continued_trajectory_ref`, `trajectory_id`) so the timeline can render a fold "context compacted here" instead of breaking (Harbor issue #239).

### 3.5 History / compare across runs
- **Runs table**: name, date, `baseline → candidate` one-line diff, scenario pool (version), repeats, Δ pass with a mini CI bar, Δ cost, grade (Improvement / Regression / Tradeoff / Tie), status (complete / partial / cancelled). Filters by component, arm, pool, date. Persistent **"set as baseline"** on an arm (Braintrust) so later candidates auto-compare to the known-good arm.
- **Trend view** for a component: pass rate and cost per run over time with CI bars, x-axis label chosen from run metadata (LangSmith Charts dropdown), so "planner prompt v3 → v7" reads as a series.
- **Multi-run compare**: select 2–6 runs → scenarios × runs matrix (pass fraction pips per cell), baseline column leftmost (Weave), "diff only" rows; column headers with counts.
- **Scenario history**: per scenario, its verdicts across all runs as a strip — surfaces chronically failing or chronically flaky scenarios (worth removing or fixing rather than re-testing).
- **Import/export** of run bundles so a colleague's static export appears in your history.

### 3.6 Global choices
- One command (`<tool> view`) serving a single-page app over a local SQLite DB and trajectory files; **ATIF v1.8 as the on-disk trajectory format** so Harbor's viewer and the ATIF viewer can open your trials, and cached-token/cost fields are already defined.
- Virtualized tables; dense/comfortable density toggle; dark mode; every list keyboard-navigable (`j`/`k`/`Enter`/`Esc`), pairwise hotkeys `A`/`B`/`E`.
- If the front end is React, AgentPrism's `TreeView`/`TimelineView`/`DetailsView` are a plausible starting point for the trace pane; otherwise copy its span-kind colouring and repeated-sequence folding.
- Never a modal for the primary drill-down — inline expand (row) then a route (trace) so URLs are shareable/bookmarkable.

---

## 4. Table stakes vs differentiators

**Table stakes (every serious tool has these; users will expect them):**
- Matrix: rows per scenario, column per arm, pass/fail colour, per-column aggregate header (promptfoo, LangSmith, Langfuse, Phoenix, Harbor).
- Baseline selection with green/red deltas and header counters that filter (Braintrust, LangSmith, Langfuse, Phoenix).
- Failures/regressions filters and regressions-first sort (Braintrust, promptfoo "Failures/Different").
- Row → side-by-side outputs with a text-diff toggle (LangSmith Diff, Braintrust Diff, Phoenix Diff Output Mode).
- Cost, tokens, latency columns per arm (Langfuse, Phoenix, Weave, tbench).
- Trace viewer: step tree/timeline + detail, tool calls/results foldable, per-step tokens and cost, search, `j`/`k` (Braintrust, Harbor, claude-tap, AgentPrism).
- Judge rationale visible next to the verdict (Inspect Scoring, Braintrust scoring span).
- Human override / comments persisted and exported (promptfoo, Langfuse annotation).
- Local launch with one command; export/share (Inspect bundle, promptfoo share link, claude-tap HTML).
- Live incremental results while running (Inspect).

**Differentiators (few or none of the surveyed tools do these; they follow directly from the paired-A/B-with-repeats design):**
1. **One-variable diff surfaced at setup time**, with a warning when arms differ in more than one key.
2. **Repeats as inline pips + a "flaky" state** per scenario, separating noise from regression (only Braintrust trial grouping and Inspect's by-sample sort come close, and both are drill-downs, not the default view).
3. **Delta with a confidence band computed by paired/cluster bootstrap, and a "not significant" state** shown in the header by default (tbench draws CIs on a leaderboard; no comparison table in this survey does).
4. **Cost delta with its own band and a four-way comparison grade** (Improvement / Regression / Tradeoff / Tie) so "better but 3× cost" is named.
5. **Cache-aware token accounting per step** (cache read / write / uncached) plus a context-size sparkline per trace — the data exists in ATIF and claude-tap, but no eval UI plots it.
6. **Paired trace diff with a first-divergence marker** and per-step cost deltas (OrcaReplay/claude-tap have the primitives; no eval tool aligns two trials).
7. **Cancel that yields a usable partial result** with the same statistics and an honest "partial" label.
8. **Scenario-level history across runs** (chronic fails / chronic flakes).
9. **Static single-file bundle of a whole run** including traces, importable into another user's history.

---

## 5. Sources (all fetched or searched on 2026-09-04)
- promptfoo web UI docs: https://www.promptfoo.dev/docs/usage/web-ui/ ; repo README: https://github.com/promptfoo/promptfoo
- Braintrust compare experiments: https://www.braintrust.dev/docs/evaluate/compare-experiments ; interpret: https://www.braintrust.dev/docs/guides/evals/interpret ; trace view: https://www.braintrust.dev/docs/guides/traces/view ; how to read a trace: https://www.braintrust.dev/foundations/how-to-read-a-trace ; "10x faster" blog: https://www.braintrust.dev/blog/faster-experiments
- LangSmith compare: https://docs.langchain.com/langsmith/compare-experiment-results ; pairwise: https://docs.langchain.com/langsmith/evaluate-pairwise ; annotation queues: https://docs.langchain.com/langsmith/annotation-queues ; pairwise blog: https://www.langchain.com/blog/pairwise-evaluations-with-langsmith
- Inspect AI log viewer: https://inspect.aisi.org.uk/log-viewer.html ; Hamel Husain walkthrough: https://hamel.dev/notes/llm/evals/inspect.html ; changelog: https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/CHANGELOG.md
- Langfuse: https://langfuse.com/docs/evaluation/experiments/experiments-via-ui ; https://langfuse.com/docs/datasets/overview ; https://langfuse.com/changelog/2024-11-18-dataset-runs-comparison-view ; https://langfuse.com/changelog/2025-11-06-compare-view-baseline-support ; https://langfuse.com/changelog/2026-04-13-experiments-rebuild ; https://langfuse.com/blog/2025-11-06-experiment-interpretation
- Arize Phoenix / AX: https://arize.com/docs/phoenix/datasets-and-experiments/overview-datasets ; https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments ; https://github.com/Arize-ai/phoenix ; https://arize.com/docs/ax/develop/datasets-and-experiments/compare-experiments ; https://arize.com/blog/new-in-arize-ax-experiment-comparisons-better-data-visualization-and-a-dedicated-agent-graph-tab/
- W&B Weave: https://docs.wandb.ai/weave/guides/tools/comparison ; https://docs.wandb.ai/weave/guides/core-types/evaluations ; https://docs.wandb.ai/weave/guides/core-types/leaderboards ; https://docs.wandb.ai/weave/tutorial-eval ; https://wandb.ai/site/evaluations/
- OpenAI Evals: https://developers.openai.com/api/docs/guides/evals ; https://platform.openai.com/evaluations ; https://community.openai.com/t/how-to-use-new-evals-ui-in-dashboard/1258284 ; https://developers.openai.com/cookbook/examples/evaluation/use-cases/responses-evaluation
- Harbor / Terminal-Bench: https://www.harborframework.com/ ; https://www.harborframework.com/docs/run-jobs/run-evals ; https://www.harborframework.com/docs/agents/trajectory-format ; https://hub.harborframework.com ; https://github.com/harbor-framework/harbor ; https://github.com/laude-institute/harbor/issues/239 ; https://deepwiki.com/laude-institute/harbor/8-trajectories-and-output ; https://www.tbench.ai/ ; https://www.tbench.ai/benchmarks ; https://github.com/Slimshilin/ATIF-trajectory-viewer ; https://atif-trajectory-viewer.vercel.app/ ; https://www.trajectories.sh/
- 2026 trace viewers: https://github.com/evilmartians/agent-prism ; https://evilmartians.com/chronicles/debug-ai-fast-agent-prism-open-source-library-visualize-agent-traces ; https://github.com/liaohch3/claude-tap ; https://github.com/hanqunfeng/claude-trace ; https://github.com/Continuum-AI-Corp/OrcaReplay ; https://github.com/OpenHands/trajectory-visualizer ; https://swe-agent.com/latest/usage/inspector/ ; https://github.com/Rxflex/agenttrace ; https://github.com/Siddhant-K-code/agent-trace ; https://github.com/tranhoangtu-it/agentlens ; https://github.com/topics/trace-viewer ; https://github.com/topics/agent-tracing
- Surveys used for discovery only: https://www.braintrust.dev/articles/best-llm-tracing-tools-2026 ; https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/ ; https://latitude.so/blog/best-ai-agent-observability-tools-2026-comparison
