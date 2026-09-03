# Landscape: paired A/B evaluation infrastructure for agent components

Survey date: 2026-09-04. Scope: tools that could serve as, or compete with, a paired A/B evaluation layer for dsh components (plugins, system prompts, loop/context designs, tools, memory, safety guards). Star counts are from the GitHub API on 2026-09-03/04. "Not documented" means the official pages fetched do not state it; it is not a claim that the feature is absent.

Legend used below: **Unit** = what is varied/evaluated; **Paired** = two configurations on the same task set with per-task alignment; **Repeats** = trials per task; **Stats** = what is reported; **Cost** = token/cost accounting (and whether cache read/write are split); **Graders**; **Sandbox**; **CI**; **Storage**; **UI**; **License / stars**.

---

## 1. Harbor (harbor-framework)

- **What**: "Framework for evaluating and improving agents" from the Terminal-Bench authors; runs any container-installable agent (Claude Code, OpenHands, Codex CLI, …) against task datasets. https://github.com/harbor-framework/harbor
- **Unit**: agent × model on a dataset; `harbor run --dataset terminal-bench@2.0 --agent claude-code --model anthropic/claude-opus-4-1 --n-concurrent 4 --env daytona`. https://github.com/harbor-framework/harbor
- **Paired**: no. Each job is one agent/model; comparison is by running separate jobs. Varying a prompt requires duplicating task definitions and verifiers, which a user reports "adds a layer of complexity" and risks test drift. https://rmoff.net/2026/04/09/kicking-the-tyres-on-harbor-for-agent-evals/
- **Repeats**: `--n-attempts N` (alias `-k`). https://rmoff.net/2026/04/09/kicking-the-tyres-on-harbor-for-agent-evals/ ; `-k 5` in official docs. https://www.tbench.ai/docs
- **Stats**: post-run table with Agent, Dataset, Trials, Errors, Mean score, Reward Distribution. https://rmoff.net/2026/04/09/kicking-the-tyres-on-harbor-for-agent-evals/ No CI/bootstrap in the CLI; the public leaderboard draws 95% CI whiskers (see §2).
- **Cost**: leaderboard columns COST and TOKENS exist (https://www.tbench.ai/leaderboard/terminal-bench/2.0), so per-trial usage is captured; the per-trial `result.json` field list is not documented on the artifacts page. https://www.harborframework.com/docs/run-jobs/results-and-artifacts No cache read/write split documented.
- **Graders**: task-level verifier `tests/test.sh` run after the agent; reward-details.json can hold per-criterion scores and judge reasoning (deterministic + LLM-judge verifiers seen in practice). https://www.harborframework.com/docs/tasks ; https://rmoff.net/2026/04/09/kicking-the-tyres-on-harbor-for-agent-evals/
- **Oracle/null checks**: built-in `oracle` agent runs the task's `solution/solve.sh` to confirm the verifier awards the expected reward; `nop` agent does nothing (verifier-in-isolation check). https://deepwiki.com/harbor-framework/harbor/4.4-oracle-agent ; https://www.harborframework.com/docs/tasks
- **Sandbox**: local Docker; cloud envs Daytona, Modal, LangSmith, Blaxel, Novita Sandbox, Tensorlake; "thousands of environments in parallel". https://github.com/harbor-framework/harbor
- **CI/exit codes**: not documented.
- **Storage/sharing**: per-trial `result.json`, `config.json`, `artifacts/manifest.json`, `agent/`, `verifier/`. https://www.harborframework.com/docs/run-jobs/results-and-artifacts `harbor upload jobs/<name>` (private by default) → Harbor Hub. https://www.tbench.ai/docs Hub Jobs table columns: Job Name, Source, Agents, Providers, Models, Started, Trials, Result. https://hub.harborframework.com/jobs Packages are private to the org or public. https://www.harborframework.com/docs/sharing/sharing
- **UI**: `harbor view jobs`: status/timing panel, trajectory view (step-by-step), results table per trial, Artifacts tab, Verifier Logs → Rewards tree. https://rmoff.net/2026/04/09/kicking-the-tyres-on-harbor-for-agent-evals/ ; https://www.harborframework.com/docs/run-jobs/results-and-artifacts No two-job diff view documented.
- **License / stars**: Apache-2.0, 4,901 stars. https://github.com/harbor-framework/harbor

## 2. Terminal-Bench 2.0 harness

- **What**: 89-task terminal benchmark launched 2025-11-07; Harbor is "the accompanying runtime framework". https://venturebeat.com/ai/terminal-bench-2-0-launches-alongside-harbor-a-new-framework-for-testing The official site has moved on to Terminal-Bench 4.0 (`harbor run -d terminal-bench/terminal-bench@4.0.0 -e modal -a claude-code -m anthropic/claude-sonnet-5 -k 5`; GPU sandbox required). https://www.tbench.ai/docs
- **Unit**: agent × model (leaderboard entries are `<agent>__<model>`). https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard
- **Paired**: no; leaderboard ranks independent submissions.
- **Repeats**: "Each task must be evaluated with a minimum of five trials. We recommend the -k 5 flag". Constraints: `timeout_multiplier must equal 1.0`, no resource overrides, "Agents cannot access the Terminal-Bench website or GitHub repository". https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard
- **Stats**: leaderboard columns RANK, MODEL, AGENT, RESOLUTION RATE, COST, TOKENS; "The whiskers span the 95% confidence interval." https://www.tbench.ai/leaderboard/terminal-bench/2.0
- **Storage**: submission = `metadata.yaml` + job folder with `config.json` and per-trial `result.json`. https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard
- **License / stars**: TB 1 repo Apache-2.0, 2,561 stars (https://github.com/laude-institute/terminal-bench); TB 2.1 repo Apache-2.0, 105 stars (https://github.com/harbor-framework/terminal-bench-2-1).

## 3. promptfoo

- **Unit**: prompt × provider × test case matrix; agents via custom/HTTP providers, with trajectory assertions read from OpenTelemetry traces. https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/
- **Paired**: partial. One eval runs all prompts/providers over the same tests; the UI offers "Compare - Diff against another eval (green = added, red = removed)" and a Scatter Plot to "Compare two prompts head-to-head". https://www.promptfoo.dev/docs/usage/web-ui/ No paired statistics. `select-best` is an LLM assertion that picks the best of several outputs. https://www.promptfoo.dev/docs/configuration/expected-outputs/
- **Repeats**: `--repeat <number>` ("Run each test multiple times"); config `repeat` defaults to 1. https://www.promptfoo.dev/docs/usage/command-line/ ; https://www.promptfoo.dev/docs/configuration/reference/
- **Stats**: pass rate = "Percentage of tests where all assertions passed"; per-assertion `weight` and `threshold`. https://www.promptfoo.dev/docs/usage/web-ui/ ; https://www.promptfoo.dev/docs/configuration/expected-outputs/ No CI/bootstrap.
- **Cost**: per-result `cost`; `TokenUsage {prompt, completion, cached, total, numRequests, completionDetails{reasoning, acceptedPrediction, rejectedPrediction, cacheReadInputTokens, cacheCreationInputTokens}}` — cache read/write split exists. https://www.promptfoo.dev/docs/configuration/reference/ `cost` assertion "only supported by OpenAI GPT models and custom providers". https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/
- **Graders**: deterministic (equals, contains, regex, is-json, javascript/python/ruby, webhook, latency, cost, rouge/bleu, is-refusal…), model-graded (llm-rubric, g-eval, factuality, similar, select-best, moderation…), trajectory (`trajectory:tool-used`, `tool-args-match` with `partial|exact` + `defaults`/`ignore`, `tool-sequence` `in_order|exact`, `step-count`), trace (`trace-span-count`, `trace-span-duration` with percentile, `trace-error-spans`), human Pass/Fail + custom score + notes in UI. https://www.promptfoo.dev/docs/configuration/expected-outputs/ ; https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/ ; https://www.promptfoo.dev/docs/usage/web-ui/
- **Sandbox**: none (calls providers; no task container).
- **CI**: exit code 100 on assertion failures or pass rate below `PROMPTFOO_PASS_RATE_THRESHOLD`; other errors exit 1; override via `PROMPTFOO_FAILED_TEST_EXIT_CODE`. GitHub Action posts a before/after PR comment with a viewer link. https://www.promptfoo.dev/docs/usage/command-line/ ; https://www.promptfoo.dev/docs/integrations/github-action/
- **Storage/sharing**: outputs to csv/json/yaml/html/xml/junit; `--share` URLs hosted at promptfoo.app or self-hosted. https://www.promptfoo.dev/docs/usage/command-line/ ; https://www.promptfoo.dev/docs/usage/web-ui/
- **UI**: `promptfoo view`: matrix, filter modes All/Failures/Passes/Errors/Different/Highlights, regex search, "Inference details" (tokens, latency, cost, tokens/sec), eval-vs-eval diff. https://www.promptfoo.dev/docs/usage/web-ui/
- **Safety**: red-team `indirect-prompt-injection` plugin (injects into a named context variable) and `indirect-web-pwn` strategy (hostile pages fetched by the agent). https://www.promptfoo.dev/docs/red-team/plugins/indirect-prompt-injection/ ; https://www.promptfoo.dev/docs/red-team/strategies/indirect-web-pwn/
- **License / stars**: MIT, 24,787. https://github.com/promptfoo/promptfoo

## 4. Braintrust

- **Unit**: any `task` function over a dataset (app/prompt/model); `Eval(data, task, scores, experimentName, metadata, maxConcurrency=10, trialCount/trial_count, baseExperimentName/base_experiment_name, update, timeout)`; `bt eval` / `npx braintrust eval`. https://www.braintrust.dev/docs/evaluate/run-in-code
- **Paired**: post-hoc, per-row. "Set as baseline" (experiment or project default; "Auto-select a comparison experiment by default" = most recent on the same git branch); "a score delta column appears in the table and each row is color-coded: green for improvements, red for regressions"; header filters "X regressions"/"X improvements"; SDK `summarize()` returns improvements, regressions, diffs. Diff toggle: "Base -> Comparison", side-by-side, 4,096-char limit per field. https://www.braintrust.dev/docs/evaluate/compare-experiments "Experiment comparisons and diff mode are only available when viewing traces." https://www.braintrust.dev/docs/guides/evals/interpret
- **Repeats**: `trial_count` "runs task multiple times per case for averaging"; grouping by input "collapses all trials for the same input into a single expandable group". https://www.braintrust.dev/docs/evaluate/run-in-code ; https://www.braintrust.dev/docs/evaluate/compare-experiments
- **Stats**: means; aggregate-of-experiments is "a simple mean (average of averages), not weighted". No CI/bootstrap. https://braintrust.dev/docs/kb/understanding-experiment-score-aggregation-simple-vs.md
- **Cost**: automatic "token metrics, and estimated cost". https://www.braintrust.dev/docs/guides/evals/interpret Cache split not documented.
- **Graders**: code scorers, LLM-as-judge (autoevals), human review; CI/CD mode "to catch regressions automatically on every pull request". https://www.braintrust.dev/docs/guides/evals/run
- **Sandbox**: none. **CI**: exit behavior not documented. **Storage**: hosted experiments (SaaS; self-host option). **UI**: as above plus Summary layout (experiments as columns).
- **License / stars**: SDK Apache-2.0 (https://github.com/braintrustdata/braintrust-sdk); platform proprietary.

## 5. LangSmith evals

- **Unit**: any target function/chain over a dataset. https://docs.langchain.com/langsmith/evaluate-pairwise
- **Paired**: yes, post-hoc. `evaluate()` with `target=[exp_a, exp_b]` (existing experiments, "uuids or experiment names") or `evaluate_comparative()` for more than two; evaluator returns per-run `scores`; `randomize_order` to reduce position bias; "Pairwise Experiments" tab with thumbs-up/down filter. https://docs.langchain.com/langsmith/evaluate-pairwise Comparison view for "two or more experiments": "Set as source experiment", red/green regressions/improvements, counts of "how many runs did better or worse than your source experiment", filter to regressed/improved only, side-by-side "Traces" mode. https://docs.langchain.com/langsmith/compare-experiment-results
- **Repeats**: `num_repetitions`/`numRepetitions`; table shows the average and lets you "view the standard deviation across repetitions"; "Repetition Summary shows a metrics table". https://docs.langchain.com/langsmith/repetition ; https://docs.langchain.com/langsmith/analyze-an-experiment
- **Stats**: mean, std across repetitions; no CI/significance. https://docs.langchain.com/langsmith/compare-experiment-results
- **Cost**: per-example "cost, token counts, latency and status"; grouped "average feedback scores, latency, total tokens, and cost". https://docs.langchain.com/langsmith/analyze-an-experiment Cache split not documented.
- **Graders**: code, LLM-judge, pairwise LLM-judge, human annotation. **Sandbox**: none. **CI**: not documented in fetched pages. **Storage**: hosted.
- **License / stars**: SDK MIT, 1,044 (https://github.com/langchain-ai/langsmith-sdk); platform proprietary.

## 6. Inspect AI (UK AISI)

- **Unit**: Task = dataset + solver (incl. `react()` agents, bash/python/web/computer tools, MCP, bridges to Claude Code/Codex CLI/Gemini CLI) + scorer. https://inspect.aisi.org.uk/
- **Paired**: no built-in; separate eval logs per configuration, compare via dataframes.
- **Repeats**: `epochs` at Task, `task_with()`, `eval(epochs=5)` or `--epochs 5`; `Epochs(n, reducer)`. https://inspect.aisi.org.uk/tasks.html Reducers: `mean_score`, `median_score`, `mode_score`, `max_score`, `at_least`, `pass_at` ("Probability of at least 1 correct sample given k epochs"), `pass_k` ("Probability that all k epoch attempts succeed"), `majority_score`, `collect_score`. https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html
- **Stats**: `accuracy`, `mean`, `std`, `stderr` (with `cluster`), `bootstrap_stderr`, `ci`, `ci_wilson`, `grouped`, `frequency`. https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html
- **Cost**: `ModelUsage`: `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_cache_write`, `input_tokens_cache_read`, `reasoning_tokens` — cache split exists. https://inspect.aisi.org.uk/eval-logs.html `cost_limit` listed among execution limits. https://inspect.aisi.org.uk/tasks.html
- **Graders**: `includes`, `match`, `pattern`, `answer`, `exact`, `f1`, `choice`, `math`, `model_graded_qa`, `model_graded_fact`, perplexity; custom. https://inspect.aisi.org.uk/scorers.html
- **Sandbox**: Docker, Kubernetes, Modal, Proxmox, Vagrant, extensible. https://inspect.aisi.org.uk/
- **CI**: eval sets with retries/early stopping; exit codes not documented.
- **Storage/sharing**: `.eval` binary (default) or `.json`; `inspect log list|dump|convert|schema`; `inspect view bundle --output-dir …` publishes a static site, including to HuggingFace Spaces. https://inspect.aisi.org.uk/eval-logs.html ; https://inspect.aisi.org.uk/log-viewer.html
- **UI**: `inspect view`: sample list, scores filter, message/tool-call transcript, scorer explanation, token usage; sort "by sample" to reveal "consistency issues across epochs". https://inspect.aisi.org.uk/log-viewer.html No cross-log diff view.
- **Safety**: AgentDojo port in inspect_evals. https://github.com/UKGovernmentBEIS/inspect_evals/tree/main/src/inspect_evals/agentdojo
- **License / stars**: MIT, 2,695. https://github.com/UKGovernmentBEIS/inspect_ai

## 7. OpenAI Evals

- **Repo**: `oaieval <model> <eval>`, `oaievalset <model> <set>`, JSONL logs (`--record_path`), optional Snowflake logging, `EVALS_THREADS`; "we are currently not accepting evals with custom code". No comparison or repeat features. https://github.com/openai/evals ; https://github.com/openai/evals/blob/main/docs/run-evals.md MIT per README; 19,373 stars; last push 2026-04-14.
- **Hosted Evals API**: graders such as `string_check`; runs report per-criterion pass/fail counts and usage; "Evals will become read-only for existing users on October 31, 2026, and the platform is scheduled to shut down on November 30, 2026." https://developers.openai.com/api/docs/guides/evals

## 8. DeepEval

- **Unit**: LLM test cases and agent traces (`@observe`); component-level metrics attach to spans (`@observe(type="llm", metrics=[...])`), trajectory metrics score the whole trace. https://deepeval.com/guides/guides-ai-agent-evaluation-metrics
- **Paired**: no in OSS; hyperparameters are logged "for run comparison on Confident AI" (proprietary). https://deepeval.com/docs/evaluation-flags-and-configs
- **Repeats**: `deepeval test run -r <n>` "Repeat each test case" (Python only); `-n` parallel, `-c` cache, `-i` identifier, `--ignore-errors`, `-s`, `-d all|passing|failing`. https://deepeval.com/docs/evaluation-flags-and-configs
- **Stats**: per-metric score vs threshold; no CI.
- **Graders**: `PlanQualityMetric`, `PlanAdherenceMetric`, `ToolCorrectnessMetric` (hybrid; reference-based when `expected_tools` given), `ArgumentCorrectnessMetric` (LLM, referenceless), `TaskCompletionMetric`, `StepEfficiencyMetric` (LLM, referenceless). https://deepeval.com/guides/guides-ai-agent-evaluation-metrics
- **Sandbox**: none. **CI**: pytest-based (`deepeval test run`). **Cost**: not documented in fetched pages.
- **License / stars**: Apache-2.0, 18,083. https://github.com/confident-ai/deepeval

## 9. Anthropic `claude plugin eval` (early access)

Public information only:
- No public docs page: https://code.claude.com/docs/en/plugin-eval returns 404 (checked 2026-09-04).
- A third-party write-up states: enable with `export CLAUDE_CODE_WALNUT_SPIRE=1` then `claude plugin eval .`; became user-accessible in Claude Code 2.1.207 (2026-07-10); "A case is a directory under `evals/` holding a prompt and at least one grader" (`evals/<case>/prompt.md`, `graders/*.md`); grader types `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`; `--ablation with-without` "runs every case twice, once with your plugin loaded and once without, then reports the difference"; the authors reported 83.3% → 91.7% over 16 cases across three repeated runs. https://bopen.ai/blog/plugin-context-reduction
- Claude Code's built-in guide reference (product-embedded, not a public web page; treat as unverified) additionally lists flags `--runs n`, `--judge-model`, `--max-cost-usd`, `--threshold 0..1`, `--json`, `--report`, `--mocks record|off`; defaults `runs: 3`, `max_turns: 10`, `timeout_seconds: 300`; LLM grader "a judge model votes 2-of-3"; output `results/<timestamp>/aggregate-result.json` with `cases[].arms.{with,without}[].graders[]` plus `report.html`; per-run throwaway workspace with fresh `CLAUDE_CONFIG_DIR`/`HOME` ("Not an OS sandbox; network is not blocked"); exit codes 0 (all cases ≥ threshold), 1 (below threshold/load error), 2 (cost ceiling hit), 130, 143. It does not describe comparing two plugin versions.
- Related public Anthropic tooling: the `skill-creator` skill runs with-skill and without-skill subagents "in the same turn" ("Launch everything at once"), records `timing.json` (`total_tokens`, `duration_ms`), grades `grading.json`, aggregates `pass_rate`, time and tokens "mean ± stddev" and deltas into `benchmark.json/.md`, flags "non-discriminating assertions (always pass regardless of skill)", ships an HTML eval-viewer and an optional blind comparator agent. https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md Anthropic's guidance defines trials, pass@k, pass^k, and "create a reference solution … This proves that the task is solvable". https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

## 10. SWE-bench / SWE-agent

- **SWE-bench harness**: unit = patch predictions per instance; `swebench eval verified -p <preds> --run-id <id> -j <workers>` (legacy `python -m swebench.harness.run_evaluation`); Docker (≈120 GB disk, 16 GB RAM, 8 CPU recommended); `logs/evaluation/<run_id>/results.json`; cloud via sb-cli (AWS) or Modal; no comparison of two prediction sets; MIT, 5,768 stars. https://github.com/SWE-bench/SWE-bench
- **SWE-agent**: `sweagent run-batch --instances.type swe_bench --instances.subset lite --instances.split dev --instances.slice :3 --num_workers 3 --agent.model.per_instance_cost_limit 2.00`; `total_cost_limit`; outputs `preds.json` and `.traj` trajectories with an inspector; `--evaluate=True` submits to sb-cli; docs recommend mini-swe-agent for new projects; MIT, 20,210 stars. https://swe-agent.com/latest/usage/batch_mode/ ; https://github.com/SWE-agent/SWE-agent

## 11. OpenHands evaluation harness

- `OpenHands/benchmarks` ("Evaluation harness for OpenHands V1"): SWE-Bench, SWE-Bench Pro, GAIA, Commit0, OpenAgentSafety, ProgramBench; `make build`; JSON LLM config; Docker workspace default or remote workspace ("32+ concurrent workers"); `logs/instance_<id>.log`; MIT, 120 stars. https://github.com/OpenHands/benchmarks Main repo MIT, 86,077 stars. https://github.com/OpenHands/OpenHands No paired comparison, no statistics documented.

## 12. Google ADK eval

- `adk eval <AGENT_MODULE_FILE_PATH> <EVAL_SET_FILE_PATH_OR_ID>... [--config_file_path] [--print_detailed_results]`; `.test.json` / `.evalset.json` (Pydantic `EvalSet`/`EvalCase`); metrics `tool_trajectory_avg_score` (default threshold 1.0), `response_match_score` (ROUGE-1, default 0.8), `final_response_match_v2`, `rubric_based_final_response_quality_v1`, `rubric_based_tool_use_quality_v1`, `rubric_based_multi_turn_trajectory_quality_v1`, `hallucinations_v1`, `safety_v1`, `multi_turn_*`; web UI shows "side-by-side comparison of Actual vs. Expected Output". https://adk.dev/evaluate/
- Repeats: `AgentEvaluator.evaluate(..., num_runs: int = NUM_RUNS)` with `NUM_RUNS = 2`; aggregation `overall_score = statistics.mean(scores)`, pass when `overall_score >= threshold`. https://github.com/google/adk-python/blob/main/src/google/adk/evaluation/agent_evaluator.py
- No config-vs-config comparison, no cost accounting documented. Apache-2.0, 21,396 stars. https://github.com/google/adk-python

## 13. Microsoft Foundry (Azure AI) agent evaluation

- **Graders**: Task Completion, Customer Satisfaction (1–5), Task Adherence, Task Navigation Efficiency (`exact_match|in_order_match|any_order_match`, returns precision/recall/F1), Intent Resolution, Tool Call Accuracy, Tool Selection, Tool Input Accuracy, Tool Output Utilization, Tool Call Success, Quality Grader; binary pass/fail (1–5 scale thresholded at 3 where applicable). https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/evaluation-evaluators/agent-evaluators Safety: `builtin.indirect_attack` (XPIA, "Model only"), `builtin.prohibited_actions` and `builtin.sensitive_data_leakage` (agents only, preview), code vulnerability, etc. https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/evaluation-evaluators/risk-safety-evaluators
- **Paired + stats**: portal Compare of 2+ runs uses "statistical t-testing", baseline selection, cells coded ImprovedStrong (p≤0.001), ImprovedWeak (0.001<p≤0.05), Degraded*, Changed*, Inconclusive; hover shows sample size and p-value; "The comparison view isn't saved." https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/evaluate-results GitHub Action `microsoft/ai-agent-evals@v3-beta`: `agent-ids` "comma-separated and compared with statistical test results", `baseline-agent-id`, report with "confidence intervals, and … a pairwise statistical comparison". https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/evaluation-github-action Action repo MIT, 99 stars; no repeat/trial flag documented. https://github.com/microsoft/ai-agent-evals
- **Cost**: run list shows "Evaluation tokens" and "Target tokens". https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/evaluate-results
- **Sandbox**: cloud-hosted agents; no task container. **License**: proprietary service; SDK MIT.

## 14. W&B Weave evaluations

- `Evaluation(dataset, scorers, trials, evaluation_name, preprocess_model_input)`; `Model` with `@weave.op predict`; `EvaluationLogger` alternative. https://docs.wandb.ai/weave/guides/core-types/evaluations/
- Comparison view: up to six objects; baseline = leftmost ("all objects are compared to the leftmost object"); "Diff only" toggle; Summary view shows "tokens, cost, and latency"; side-by-side and (for two) Unified view. https://docs.wandb.ai/weave/guides/tools/comparison/ Leaderboards: columns defined by evaluation + scorer + metric (`mean`, `true_fraction`), shared with the team. https://docs.wandb.ai/weave/guides/core-types/leaderboards
- No CI/bootstrap statistics documented; no cache split documented. Apache-2.0, 1,124 stars. https://github.com/wandb/weave

## 15. Arize Phoenix experiments

- `client.experiments.run(name, dataset, task, evaluators, concurrency, dry_run, dry_run_count)`; code evaluators (`EvaluationResult` score/label/explanation) and LLM judges; `client.experiments.create()` to upload externally computed results. https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments
- Repeats: "Use repetitions to run experiments multiple times for statistical confidence"; tutorial `running_experiments_with_repetitions.ipynb`. https://github.com/Arize-ai/phoenix/blob/main/docs/phoenix/skill.md ; https://github.com/Arize-ai/phoenix/blob/main/tutorials/experiments/running_experiments_with_repetitions.ipynb
- UI: "side-by-side experiment comparison showing performance differences, score distributions, and individual example results"; cost "automatic calculation based on token usage and model pricing". https://github.com/Arize-ai/phoenix/blob/main/docs/phoenix/skill.md No significance testing documented.
- License: Elastic License 2.0 (https://github.com/Arize-ai/phoenix/blob/main/LICENSE); 11,309 stars. https://github.com/Arize-ai/phoenix

## 16. Langfuse experiments / datasets

- `run_experiment(name, task, data, evaluators, run_evaluators, max_concurrency, metadata, description, run_name)`; item-level `Evaluation(name, value, comment)`; run-level evaluators for aggregates; `result.format()`; dataset versions ("Every add, update, delete, or archive … produces a new dataset version") and JSON-schema validation. https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk ; https://langfuse.com/docs/evaluation/experiments/overview
- Paired (post-hoc): compare view with baseline: "Each row shows baseline and candidate outputs for the same dataset item, using stable identifiers", "Green/red deltas for scores, cost, and latency", Charts tab, filters such as "Cost Delta > 10%", click-through to traces. https://langfuse.com/changelog/2025-11-06-compare-view-baseline-support ; https://langfuse.com/changelog/2024-11-18-dataset-runs-comparison-view
- Repeats and significance: not documented. CI/CD page exists. https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk
- License: "MIT licensed, except for the ee folders"; 34,156 stars. https://github.com/langfuse/langfuse

## 17. 2026 "agent A/B" and harness-comparison tools

- **skillcheck** (sx4im): A/B of a `SKILL.md` "with skill injected as a system prompt" vs without, on freshly generated tasks; blind grader at temperature 0; "1,000 iterations" paired bootstrap, 95% CI; verdict HELPS / HARMS / PLACEBO; `skillcheck check <path> [--tasks N] [--trials K] [--json]`; reports token overhead of the skill; MIT, 26 stars. https://github.com/sx4im/skillcheck
- **SkillTester** (arXiv 2603.28815, 2026-03-28): "paired baseline and with-skill execution conditions with a separate security probe suite"; utility score + security score + 3-level label; code at github.com/skilltester-ai/skilltester. https://arxiv.org/abs/2603.28815
- **PluginEval** (in wshobson/agents): `plugin-eval score|certify|compare <skill-a> <skill-b>|init`; static analysis + LLM judge + Monte Carlo simulation; JSON/Markdown/HTML output; repo MIT, 39,386 stars (marketplace repo, not the tool alone). https://github.com/wshobson/agents/blob/main/docs/plugin-eval.md
- **TribeAI/claude-evals**: `claude-evals compare --baseline <path> --candidate <path>` classifies regressions by severity and reports % tasks regressed; `--runs <k>`; `max_budget_usd` default $0.50 per task; deterministic + LLM-judge graders, human queue on roadmap; Apache-2.0, 21 stars. https://github.com/TribeAI/claude-evals
- **AgentV** (najeed/ai-agent-eval-harness): pass@k, mutation testing (typos, injections), HTML reports with trajectory diagrams, `ci generate`; Apache-2.0 core, 43 stars. https://github.com/najeed/ai-agent-eval-harness
- **linny006/agent-eval-harness**: despite the name, a cron-updated tracker of eval repos, not a harness; 7 stars. https://github.com/linny006/agent-eval-harness
- **HAL harness** (Princeton): `hal-eval --benchmark … --agent_dir … --docker|--vm`, Weave cost tracking, accuracy-vs-cost leaderboard; archived 2026-07-01, "no longer being updated"; 311 stars. https://github.com/princeton-pli/hal-harness
- **Research establishing the need**: "The Scaffold Effect in Coding Agents" (arXiv 2607.22585): 3 harnesses × 2 models × 50 Terminal-Bench Pro tasks, paired same-task comparison with 95% bootstrap CIs (B=10,000); "40× difference in tokens per solved task" across harnesses vs 1.0–1.3× from model upgrade; pass-rate spread 0–8 pp with CIs including zero; "the unit of comparison … should be the harness–model pair". https://arxiv.org/html/2607.22585 "Stochasticity in Agentic Evaluations" (arXiv 2512.06710): "ICC converges by n=8-16 trials for structured tasks and n>=32 for complex reasoning"; report "accuracy alongside ICC and within-query variance". https://arxiv.org/abs/2512.06710 LangChain moved Deep Agents from 52.8% to 66.5% on TB 2.0 by harness-only changes with the model fixed (gpt-5.2-codex), measured via Harbor + Daytona with traces in LangSmith; no CIs reported. https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering
- **Safety / memory scenario sources**: AgentDojo (utility + targeted attack success; `--defense`, `--attack` flags; MIT, 797 stars; last push 2026-06-02) https://github.com/ethz-spylab/agentdojo ; Inspect port https://github.com/UKGovernmentBEIS/inspect_evals/tree/main/src/inspect_evals/agentdojo ; multi-session memory datasets LoCoMo (1,540 Qs), LongMemEval (500 Qs, 6 categories), MemoryAgentBench (2,071 Qs, 103k–1.44M tokens) — summarized by a vendor blog, not verified against primary papers. https://mem0.ai/blog/ai-memory-benchmarks-in-2026

---

## Feature matrix

Abbreviations: PH = post-hoc comparison of separately run experiments; ✗ = not offered; ND = not documented; CR/CW = cache read/write split.

| Tool | Unit | Paired same-task compare | Repeats | Stats | Cost / tokens (CR/CW) | Graders | Sandbox | CI / exit codes | Storage / sharing | UI compare view | License · stars |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Harbor | agent×model | ✗ (separate jobs) | `--n-attempts` | mean, reward distribution | tokens+cost on leaderboard; CR/CW ND | verifier script (code/LLM), oracle & nop agents | Docker + 6 cloud envs | ND | job dirs; `harbor upload` (private default / `--public`) | trajectory, trials table, artifacts; no job diff | Apache-2.0 · 4.9k |
| Terminal-Bench 2.0 | agent×model | ✗ (leaderboard) | ≥5 trials required | resolution rate + 95% CI whiskers | COST, TOKENS columns | task tests | via Harbor | n/a | HF dataset of submissions | leaderboard only | Apache-2.0 · 2.6k (TB1) |
| promptfoo | prompt×provider×test | partial: same eval matrix; eval-vs-eval diff; no paired stats | `--repeat` | pass rate, weighted thresholds | per-result cost; CR/CW yes | deterministic, code, LLM, trajectory/trace, human | ✗ | exit 100 / threshold env; GH Action PR comment | sqlite + share URL | matrix, filters, diff | MIT · 24.8k |
| Braintrust | task fn | PH: baseline, per-row delta, regressions filter, diff mode | `trial_count` | means (unweighted aggregates) | tokens + est. cost; CR/CW ND | code, LLM, human | ✗ | ND | hosted | yes (traces view) | SDK Apache-2.0; SaaS |
| LangSmith | target fn | PH: pairwise evaluators + compare view (regressions/improvements counts) | `num_repetitions` | mean, std | cost, tokens, latency per row; CR/CW ND | code, LLM, pairwise LLM, human | ✗ | ND | hosted | yes, side-by-side traces | SDK MIT · 1.0k; SaaS |
| Inspect AI | task/solver/scorer | ✗ (per-log) | `epochs` + reducers (pass_at, pass_k…) | stderr (clustered), bootstrap_stderr, ci, ci_wilson | ModelUsage incl. CR/CW | text, model-graded, custom | Docker, k8s, Modal, Proxmox, Vagrant | ND | .eval logs; `inspect view bundle` | per-log viewer; epoch consistency sort | MIT · 2.7k |
| OpenAI Evals (repo) | model | ✗ | ✗ | accuracy | ND | match, model-graded | ✗ | ND | JSONL/Snowflake | ✗ | MIT · 19.4k (API sunset 2026-11-30) |
| DeepEval | test cases / spans | ✗ (platform) | `-r` | score vs threshold | ND | LLM agent metrics, hybrid tool metric | ✗ | pytest | local cache / Confident AI | platform | Apache-2.0 · 18.1k |
| `claude plugin eval` | plugin (+ablation with/without) | ablation arms per case | `runs` (default 3 per built-in ref.) | threshold pass (ref.) | `--max-cost-usd` (ref.) | regex, tool_used, tool_order, file_exists, llm, baseline | throwaway workspace, not OS sandbox (ref.) | exit 0/1/2 (ref.) | results JSON + HTML | HTML report | early access; no public docs |
| SWE-bench / SWE-agent | patches / agent config | ✗ | ✗ | resolved rate | cost limits (SWE-agent) | tests | Docker / Modal / sb-cli | ND | results.json, .traj | trajectory inspector | MIT · 5.8k / 20.2k |
| OpenHands benchmarks | agent SDK version | ✗ | ✗ | ND | ND | benchmark tests | Docker / remote | ND | logs | ✗ | MIT · 120 |
| ADK eval | agent | ✗ | `num_runs`=2, mean | mean vs threshold | ND | trajectory match, ROUGE, LLM rubric, safety | ✗ | pytest | local | actual vs expected | Apache-2.0 · 21.4k |
| Azure Foundry | agent version | PH: t-test, baseline, p-values; GH Action pairwise | ND | CI + t-test | evaluation/target tokens | 11 agent evaluators, safety incl. XPIA (model only), custom | cloud | GH Action summary | hosted | compare (not saved) | proprietary; action MIT · 99 |
| Weave | Model/fn | PH: ≤6 objects, baseline, diff-only | `trials` | means | tokens, cost, latency | scorers (code/LLM) | ✗ | ND | hosted; leaderboards | yes | Apache-2.0 · 1.1k |
| Phoenix | task fn | PH: side-by-side | `repetitions` | distributions | cost from pricing | code, LLM | ✗ | ND | hosted/self-host | yes | ELv2 · 11.3k |
| Langfuse | task fn | PH: baseline vs candidate per item, deltas | ND | means | cost, latency deltas | code, LLM-judge | ✗ | CI page exists | hosted/self-host | yes + charts | MIT(+ee) · 34.2k |
| skillcheck | SKILL.md | yes: with/without, paired bootstrap | `--trials` | 95% CI, verdict | token overhead | blind LLM grader | ✗ | `--json` | none persisted | ✗ | MIT · 26 |
| TribeAI/claude-evals | model/config runs | PH: baseline vs candidate, severity | `--runs` | % regressed | budget cap | deterministic, LLM | ✗ | JSON/MD | files | ✗ | Apache-2.0 · 21 |

---

## Gaps nobody fills

1. **Paired / interleaved same-window runs.** Every general tool compares experiments post hoc (Braintrust, LangSmith, Langfuse, Weave, Phoenix, Azure) or runs arms sequentially. Only skillcheck runs both arms in one invocation with paired bootstrap (https://github.com/sx4im/skillcheck), `claude plugin eval --ablation with-without` runs each case twice (https://bopen.ai/blog/plugin-context-reduction), and Anthropic's skill-creator instructs launching with/without subagents "in the same turn" (https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md). None schedules arms interleaved per task in a bounded time window, records provider-side conditions (model version, rate-limit state, time of day) per trial, or computes task-clustered paired CIs; Inspect's `stderr(cluster=…)` and `bootstrap_stderr` are per-log, not per-pair (https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html). The variance literature says n≥8–16 trials for structured tasks and n≥32 for complex reasoning (https://arxiv.org/abs/2512.06710); no tool sizes trials from ICC.

2. **One-variable enforcement between arms.** No tool checks that two arms differ in exactly one component. Harbor requires duplicating whole tasks to vary a prompt (https://rmoff.net/2026/04/09/kicking-the-tyres-on-harbor-for-agent-evals/); Braintrust auto-picks a comparison by git branch (https://www.braintrust.dev/docs/evaluate/compare-experiments); LangSmith/Braintrust rely on free-form `metadata`. Nothing hashes and diffs the full effective config (model id, temperature, tool set, system prompt, plugin set) and refuses a comparison with >1 changed variable.

3. **Oracle / null verifier self-checks.** Harbor's `oracle` and `nop` agents validate a task at authoring time (https://deepwiki.com/harbor-framework/harbor/4.4-oracle-agent) and Anthropic recommends reference solutions (https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents); skill-creator flags "non-discriminating assertions" (https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md). No comparison tool runs oracle-must-pass / null-must-fail arms as part of every A/B job and invalidates cases whose grader cannot discriminate.

4. **Never-worse gating.** Existing gates are absolute thresholds (promptfoo `PROMPTFOO_PASS_RATE_THRESHOLD`, exit 100 https://www.promptfoo.dev/docs/usage/command-line/ ; plugin-eval `--threshold`) or informational significance (Azure t-test legend https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/evaluate-results ; GH Action CIs https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/evaluation-github-action). TribeAI classifies regression severity (https://github.com/TribeAI/claude-evals). No tool implements a non-inferiority test (candidate ≥ baseline − margin with a stated confidence) as a CI exit code, nor per-task "no task regressed from pass to fail in all trials" gating.

5. **Cache-aware cost with time-of-day pricing.** Cache read/write splits exist in promptfoo's `TokenUsage.completionDetails` (https://www.promptfoo.dev/docs/configuration/reference/) and Inspect's `ModelUsage` (https://inspect.aisi.org.uk/eval-logs.html); Braintrust/LangSmith/Weave/Phoenix/Langfuse report cost without a documented cache split. None prices by wall-clock: DeepSeek charges half price off-peak, with peak hours "01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday" and cache-hit input at 1/30th of cache-miss (V4-flash: $0.007 vs $0.22 per 1M off-peak) (https://api-docs.deepseek.com/quick_start/pricing), so an arm run at a different hour or with a warmer cache gets a different bill for identical behavior. No tool normalizes cost to a fixed tariff or reports both "billed" and "tariff-normalized" cost.

6. **Public comparable ledgers.** Public artifacts are leaderboards of agent×model (Terminal-Bench with cost/tokens/CI whiskers https://www.tbench.ai/leaderboard/terminal-bench/2.0 ; Harbor Hub jobs https://hub.harborframework.com/jobs ; HAL, now archived https://github.com/princeton-pli/hal-harness) or private share links (promptfoo, Braintrust, Weave leaderboards for a team https://docs.wandb.ai/weave/guides/core-types/leaderboards). No public ledger records component-level paired results (arm configs, per-task outcomes, CIs, cost) in a schema others can reproduce or append to.

7. **Component-level (not model-level) evaluation.** Harbor/TB/SWE-bench/OpenHands treat the whole agent as the unit; Braintrust/LangSmith/Langfuse/Weave/Phoenix evaluate an opaque task function; ADK and Azure evaluate an agent version. Component-level A/B exists only for skills/plugins (skillcheck, SkillTester https://arxiv.org/abs/2603.28815, PluginEval https://github.com/wshobson/agents/blob/main/docs/plugin-eval.md, `claude plugin eval` ablation, skill-creator). Nothing targets loop/context-management designs, memory backends, or tool implementations as swappable arms with the rest held fixed — precisely the variable the Scaffold Effect paper found dominates (40× token gap across harnesses vs ≤1.3× across models, https://arxiv.org/html/2607.22585).

8. **Multi-session memory scenarios.** Datasets exist (LoCoMo, LongMemEval, MemoryAgentBench https://mem0.ai/blog/ai-memory-benchmarks-in-2026), but no surveyed harness expresses a case as "session 1 writes, process restarts, session 2 must recall", with the memory component as the A/B variable and graders on both recall and cross-session leakage. Inspect and ADK support multi-turn within one session; the plugin-eval reference mentions transcripts/scaffolds per case but not cross-session state.

9. **Prompt-injection safety scenarios.** AgentDojo measures utility and targeted attack success with `--defense`/`--attack` flags (https://github.com/ethz-spylab/agentdojo), promptfoo has indirect-injection plugins/strategies (https://www.promptfoo.dev/docs/red-team/plugins/indirect-prompt-injection/), Azure's `builtin.indirect_attack` is "Model only" (https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/evaluation-evaluators/risk-safety-evaluators), OpenHands ships OpenAgentSafety (https://github.com/OpenHands/benchmarks). None runs a guard component with/without as paired arms over the same injected tasks and reports the utility-vs-attack-success trade-off with CIs and cost, which is what a "safety guard plugin" A/B needs.

Net: the nearest existing pieces to build on are Harbor (containers, oracle/nop, trials), Inspect (epoch reducers, clustered stderr/bootstrap, cache-split usage, static log publishing) and skillcheck (paired bootstrap verdicts); none combines them into component-level, interleaved, one-variable, never-worse-gated A/B with tariff-normalized cost and a public ledger.
