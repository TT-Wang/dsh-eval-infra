# Methodology sweep 2 — paired A/B evaluation of agent components (dsh)

Date: 2026-09-04. Scope: material NOT covered in sweep 1 (2411.00640, 2512.21326, 2512.06710, 2603.29231, 2512.07795, 2608.22331, 2607.22585, 2606.08529, 2507.02825, 2407.01502, 2510.20270, 2406.13352, TOST, τ-bench pass^k, MT-Bench, 2406.07791, 2404.13076, 2502.01534, 2503.13657, 2510.11977, 2508.21433). Those are referenced only where a new source builds on them.

Verification notes: every entry below was fetched (arXiv abstract/HTML, official docs, or the full PDF text extracted locally). Three pages could not be read directly: openai.com's SWE-bench Verified post (HTTP 403; facts taken from a mirror that quotes it), the Wiley page for Agresti & Min 2005 (403), and harborframework.com/docs/jobs (404). Those are flagged inline.

Notation used throughout: n scenarios, k repeats per scenario per arm, per-trial outcome Y ∈ {0,1} (pass) or cost C (tokens/USD/seconds); paired difference per trial d = Y_A − Y_B (or C_A − C_B); 2×2 paired-binary table with concordant counts a (both pass), dd (both fail) and discordant counts b (A pass, B fail), c (A fail, B pass).

---

## A. Newest work (June–Sept 2026 first, then 2025–2026)

### A1. Evaluating harnesses / scaffolds / components (not models)

**Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents — A Source-Code Study of Eleven Systems** (Barbaste et al., arXiv:2609.00006, submitted 2026-07-15). https://arxiv.org/abs/2609.00006
Source-code study (~4M LOC; Claude Code, Codex CLI, Gemini CLI, and eight others) that defines an agent as "a model plus a harness" and maps seven canonical harness subsystems (loop, tools, context management, safety controls, orchestration, extension surfaces, plus a meta-harness contrast), 29 recurring design patterns, 13 cross-cutting observations, 18 design recommendations and a 90-line minimum-viable-harness template. It documents migration from prompt-based to configuration-based policies and hand-rolled async loops rather than frameworks. No statistics; it is a taxonomy of the *independent variable* a component A/B tool manipulates.
Apply to dsh: use the seven subsystems as the canonical "component under test" vocabulary in run metadata, so A/B results can be grouped by which subsystem was varied.

**Don't Blame the Large Language Model: How Agent Harness Evolution Shapes Coding Agent Quality** (Ben Sghaier, Li, Adams, Hassan, arXiv:2607.03691, July 2026). https://arxiv.org/abs/2607.03691
Fixes the model and varies only the harness: 35 sequential releases of Qwen Code CLI on 50 stratified SWE-bench Verified tasks, measuring effectiveness and efficiency, and links specific PRs to quality fluctuations. Motivation: practitioners "report quality regressions after agent harness updates" and blame the model. Documents harness release velocities above two releases per day.
Apply to dsh: the natural CI use case — every harness release is arm B against the previous release as arm A on a fixed task set with the model pinned.

**Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses** (Lin et al., arXiv:2604.25850, Apr–May 2026). https://arxiv.org/abs/2604.25850
Closed-loop harness evolution with three observability pillars (component = file-level, reversible edits; experience = distilled trajectory evidence; decision = each edit paired with a prediction verified against outcome). Terminal-Bench 2 pass@1 69.7% → 77.0% over 10 iterations; SWE-bench Verified top success at 12% fewer tokens than seed; +5.1 to +10.1 pp transfer across three model families. Ablations localize gains to tools, middleware and long-term memory rather than the system prompt.
Apply to dsh: their "decision observability" (predict the effect of an edit, then verify) is exactly a pre-registered A/B with a directional hypothesis; the tool should record the prediction with the run.

**SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks** (Li et al., arXiv:2602.12670, Feb–June 2026). https://arxiv.org/abs/2602.12670
87 tasks / 8 domains with deterministic verifiers, run under matched no-Skills vs curated-Skills conditions for 18 model–harness configurations. Pass rate 33.9% → 50.5% (+16.6 pp), per-configuration gains +4.1 to +25.7 pp; focused skills (≤3 modules) beat bundles; small models + skills reach parity with larger unaugmented models. The paper frames "paired evaluation as the foundation" for measuring skill efficacy.
Apply to dsh: a skill/plugin is a harness component; SkillsBench's with/without paired design on the same tasks is the template, and the +4 to +26 pp spread across harnesses is the effect-size range the tool must resolve.

**Specialize Roles, Mix Deployments (AgentCARD)** (Jiang et al., arXiv:2606.20629, May 2026). https://arxiv.org/abs/2606.20629
Role-aware benchmark suite for multi-role agent teams with a role-decomposed harness, a unified API/self-hosted cost model, Pareto-frontier analysis and a Shapley-based diagnostic that attributes team accuracy to roles (planner- vs executor-bottlenecked domains). Heterogeneous teams +44% accuracy at equal cost; hybrid deployments up to 12× cheaper at matched accuracy.
Apply to dsh: Shapley attribution over component subsets is the principled way to report "which component carried the gain" when more than one component differs between arms.

### A2. A/B or paired comparison of agent configurations

**AV-AIVAT: 74× Cheaper Agent Evaluation with Certified Anytime-Valid Stopping in Imperfect-Information Games** (arXiv:2608.06362, Aug 2026). https://arxiv.org/html/2608.06362
Combines AIVAT variance reduction with confidence sequences for early stopping; 71,439 paired HUNL hands across 15 LLM agent configurations. Correction Y_t = X_t + C_t with mean-zero control-variate term C_t = Σ_{h∈H_c} S_{t,h} I_{t,h} (Σ_a p_{t,h}(a) v_t(h·a) − v_t(h·A_{t,h})) built from the *evaluated agent's own* action distribution and a value function. Two CSs run in parallel: an asymptotic CS (primary; width w_t = σ̂_t sqrt(2(tρ²+1)/(t²ρ²) · log(sqrt(tρ²+1)/α))) and an empirical-Bernstein CS (exact certificate, needs an a-priori bound B_Y). Results: median 54.4× variance reduction, median 74.17× reduction in stopping time at a ±1 BB target; value functions may be learned online provided they are predictable (fixed before hand t). Uses paired replay of identical hand sequences.
Apply to dsh: the closest existing precedent for "paired trials + variance reduction + anytime-valid stopping" in agent evaluation; the AsympCS formula is the one to implement for continuous paired outcomes (cost).

**A More Accurate Algorithm Comparison through A/B Testing using Offline Evaluation Methods** (Konishi, Ushiku, Saito, arXiv:2607.01958, July 2026). https://arxiv.org/abs/2607.01958
Shows that independent-arm sample-mean A/B estimators lack the positive correlation that offline estimators enjoy, so selection errors are higher; introduces a hypothetical "middle algorithm" M and estimates A→M and M→B on shared data to induce positive correlation, deriving the variance-optimal M. Matches selection accuracy with ~50% of the A/B data.
Apply to dsh: formalizes why the paired (shared-scenario, shared-seed) design beats independent arms — Var(Â−B̂) = Var(Â)+Var(B̂)−2Cov; the tool should always report the realized Cov/correlation between arms.

**Resolution Diagnostics for Paired LLM Evaluation** (Kotawala, arXiv:2605.30315, May 2026; ICML 2026 HT workshop). https://arxiv.org/abs/2605.30315
Defines the per-pair resolution ratio q = N/N*, where N* is the minimum benchmark size at which a paired test attains (α, 1−β) = (0.05, 0.8) for the observed gap and discordance; gives a small-effect expansion showing the common *unpaired* Cohen-h formula misstates N* by ≈2× for small gaps. Open LLM Leaderboard v1: 11/40 displayed pairwise rankings unresolved; MMLU-Pro top-10: 4/9 adjacent pairs unresolved (6/9 with subject-level clustering); persists under multiplicity correction and sequential testing.
Apply to dsh: print q = n/N* next to every A/B verdict so an "inconclusive" is distinguished from "no effect".

**Quantifying Ranking Uncertainty in LLM Benchmarks** (Neuhof & Benjamini, arXiv:2607.16259, June 2026). https://arxiv.org/html/2607.16259v1
Rank confidence intervals from directional paired t-tests on identical units, with Holm's step-down over all pairwise comparisons; rank bounds L_j = 1 + #{models significantly worse than j}, U_j = M − #{models significantly better than j}. Requires the analyst to fix (i) unit of analysis (question/subject/prompt), (ii) population of inference, (iii) marginal vs simultaneous coverage. Adds indifference margins δ (e.g., 2 pp) and alpha-splitting to drop non-informative units. On PromptEval-MMLU (15 models × 57 subjects × 100 prompts) subject heterogeneity dominates prompt-variant variance.
Apply to dsh: the multi-arm reporting rule (rank intervals + Holm) when more than two configs are compared, and the "declare the unit" checklist.

**Rank Intervals for Leaderboards: A Hierarchical Framework for Model Evaluation** (Neuhof & Benjamini, arXiv:2606.08679, June 2026). https://arxiv.org/abs/2606.08679
Two-level framework: task-level rank CIs from pairwise comparisons, leaderboard-level conformal prediction intervals for unseen tasks. Validated on TabArena and PromptEval/MMLU.
Apply to dsh: when reporting across scenario categories, the leaderboard-level (conformal) interval is the honest "what to expect on a new category" statement.

### A3. Reliability / consistency metrics

**ReliabilityBench** (Gupta, arXiv:2601.06112, Jan 2026). https://arxiv.org/abs/2601.06112
Unified reliability surface R(k, ε, λ): k = repetition count (pass^k), ε = perturbation intensity of semantically equivalent task variants, λ = fault-injection intensity (timeouts, rate limits, partial responses, schema drift). 1,280 episodes, 4 domains, ReAct vs Reflexion × Gemini 2.0 Flash vs GPT-4o; success 96.9% (ε=0) → 88.1% (ε=0.2); rate limiting most damaging; ReAct more robust than Reflexion.
Apply to dsh: a component A/B should optionally sweep ε and λ (paraphrase and fault injection) so the reported difference is a surface, not a point.

**How Consistent Are LLM Agents? Measuring Behavioral Reproducibility in Multi-Step Tool-Calling Pipelines** (Yagubyan, arXiv:2605.28840, Apr 2026). https://arxiv.org/html/2605.28840
Correctness-free consistency metrics over N runs of the same task: Tool Sequence Similarity TSS = (1/C(N,2)) Σ_{j<j'} [1 − EditDist(s^(j), s^(j'))/max(|s^(j)|,|s^(j')|)] and Argument Consistency AC = mean Jaccard of tool-argument key–value sets; also unique sequences, divergence point, output agreement. 1,140 traces (19 tasks × 6 models × 10 runs, T=1.0): TSS 0.87 [0.84,0.90] vs AC 0.69 [0.64,0.74]; TSS≥0.90 → 90.2% correct vs 61.2% for low TSS; ~60% of divergence occurs in the first 1–2 steps; ambiguous specs reduce AC by 28%.
Apply to dsh: TSS per scenario is a cheap secondary metric that detects harness changes that alter *behavior* even when pass rate is unchanged.

**Inspect `pass_k` reducer** (UK AISI docs). https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html
Documented estimators for repeated epochs: `pass_at` uses the Chen et al. 2021 unbiased pass@k estimator; `pass_k` = C(correct, k)/C(total, k) ("dual to pass_at"); `at_least(k)`; `mean/median/mode/max`.
Apply to dsh: adopt the same draw-without-replacement pass^k estimator so numbers are comparable with Inspect-based reports.

**Bootstrap Confidence Intervals for LLM Evaluation** (Indeed Engineering, July 2026). https://engineering.indeedblog.com/blog/2026/07/bootstrap-confidence-intervals-for-llm-evaluation/
See B4 and B7 — gives the design-effect formula and coverage simulations for N inputs × k runs.

### A4. Cost-controlled / Pareto evaluation

**EarlyEval: Cheaper Agent Evaluation via Early Outcome Prediction** (Shi et al., arXiv:2609.02783, 2026-09-02). https://arxiv.org/html/2609.02783
Two LightGBM classifiers (success / failure) over behavioral, TF-IDF/SVD and reference-overlap features, Platt-calibrated, with a dual-threshold "unconfident region"; halts a run once either classifier crosses its threshold. SWE-bench Verified (16 agents, 7,805 trajectories), TerminalBench (37 agents, 6,757), Toolathlon (22 agents, 7,116): 13–26% fewer steps, up to 44.1% fewer input tokens, resolve-rate deviation 1–2 pp, ranking Spearman ρ ≥ 0.959.
Apply to dsh: an optional truncation mode for cost-limited A/Bs, but note it introduces a classifier-dependent bias of 1–2 pp that must be disclosed and is not acceptable for the confirmatory arm of a paired test.

**Knowing When to Stop: Bayesian Optimal Stopping for LLM Evaluations** (Pilditch, UK AISI, arXiv:2608.14425, Aug 2026). https://arxiv.org/html/2608.14425
`optstop`: hierarchical models per score type (binary: logit-normal group level with adaptive Beta item priors; ordinal: cumulative-link with Dirichlet-multinomial fallback; continuous bounded: logit-normal on item summaries), stop when posterior credible-interval width W < δ (default 0.05, i.e., ±2.5 pp) or when width plateaus; asymmetric conservatism multiplies effective width by c (default 5) when estimated performance < 1%. Eliminated 57–97% of planned trials with mean |Δscore| 0.006; provides width guarantees, not frequentist coverage.
Apply to dsh: a precision-targeted (rather than significance-targeted) stopping rule for the *cost* arm and for per-scenario pass-rate estimation; pair with an anytime-valid test for the decision.

**Efficient Evaluation of LLM Performance with Statistical Guarantees** (Wu, Nair, Candès, arXiv:2601.20251, Jan–May 2026). https://arxiv.org/abs/2601.20251
Factorized Active Querying: Bayesian factor model on historical benchmark data + hybrid variance-reduction/active-learning sampling + "proactive active inference" (finite-population active inference) with frequentist coverage; up to 5× effective-sample-size gain vs uniform sampling.
Apply to dsh: when the scenario pool is large and history exists, sample scenarios adaptively instead of uniformly; the coverage guarantee survives.

**AgentCARD** (above) and **Harbor-Index** (A7) both report pass rate against cost explicitly. https://arxiv.org/abs/2606.20629 ; https://www.tbench.ai/news/harbor-index

### A5. Evaluation infrastructure ("evaluation as code")

**UniACE: A Unified Framework for Evaluating LLM Agentic Capabilities** (Zhu et al., arXiv:2605.27898, May–Sept 2026). https://arxiv.org/abs/2605.27898
Represents benchmarks as instruction–tool–environment triplets, runs every model through a shared task-agnostic harness in isolated per-task runtimes, standardizes efficiency measurement, execution records and failure attribution, and offers an offline mode with fixed snapshots replacing live resources. Migrating 7 benchmarks / 24 domains / 15 models (400K rollouts, 5B tokens) produced "large bidirectional score changes and model-ranking reversals" relative to source implementations; results are reported as properties of an explicit evaluation configuration.
Apply to dsh: the config-as-first-class-object principle — every result must be keyed by a hashed evaluation configuration (harness, tools, snapshot, seeds).

**Agent-Diff: State-Diff-Based Evaluation** (Pysklo, Zhuravel, Watson, arXiv:2602.11224, Feb–Apr 2026). https://arxiv.org/abs/2602.11224
"State-diff contract": success = the expected change in environment state was achieved, independent of trace or parameter matching; containerized replicas of enterprise APIs; 224 tasks, 9 models.
Apply to dsh: prefer state-diff verifiers over trajectory matching so component changes that alter the *path* are not penalized.

**Demystifying evals for AI agents** (Anthropic Engineering, Jan 2026). https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
Defines task, trial, grader (with assertions), agent harness, eval harness, suite; distinguishes pass@k ("at least one correct solution in k attempts") from pass^k ("all k trials succeed", e.g., 0.75³ ≈ 42%); grader taxonomy (code-based / model-based / human) with trade-offs; "grade what the agent produced, not the path it took"; "failures should seem fair"; a zero pass rate across many trials "often signals a broken task"; "we do not take eval scores at face value until someone ... reads some transcripts"; graders must resist bypasses.
Apply to dsh: adopt these six nouns verbatim in the schema and surface both pass@k and pass^k per arm.

**Developing and Maintaining an Open-Source Repository of AI Evaluations: Challenges and Insights** (Abbas, Waggoner, Olive, arXiv:2507.06893, July 2025; inspect_evals). https://arxiv.org/abs/2507.06893
Eight months maintaining 70+ community evals: needs "specialized infrastructure, statistical rigor, and community coordination"; proposes cohort management, statistical methodology for cross-model comparison with uncertainty, and reproducibility QC.
Apply to dsh: an eval-verification step (reproduce a reference result before an eval is admitted to the pool) belongs in the tool.

**Evaluation-Driven Development and Operations of LLM Agents (EDDOps)** (Xia et al., CSIRO, arXiv:2411.13768, rev. Nov 2025). https://arxiv.org/abs/2411.13768
Process model + reference architecture placing offline and online evaluation in a closed loop that drives runtime adaptation and controlled redevelopment, with traceability.
Apply to dsh: the A/B tool is the "offline" node of this loop; export results in a form the online monitor can consume.

**Towards More Standardized AI Evaluation: From Models to Agents** (El Filali & Bedar, arXiv:2602.18029, Feb 2026). https://arxiv.org/abs/2602.18029
Position paper: evaluation as "a core control function" and a measurement discipline for non-deterministic systems; argues aggregate scores obscure behavior. No checklist beyond principles.

**Harbor / ATIF** — see D.

### A6. Trajectory analysis and failure taxonomies with automatic labeling

**Model or Harness? An Interaction-Centric Taxonomy for Localizing Agent Failures** (Raj, Gupta, Mahmoud et al., Scale AI, arXiv:2607.28802, 2026-07-30). https://arxiv.org/html/2607.28802
Nine components in three families (User: owner, grader, third party; Harness: context, memory, tool, peer model; Environment: external, local); each failure is an interaction edge plus a "fault side"; 41 failure modes (over/under-initiative, satisficing, reasoning failure, specification gaming, state-tracking failure, tool hallucination, memory failures, recovery failures, …). Labeling rule: trace backward from the system-level failure to "the earliest failure from which execution does not recover"; later errors are consequences. Attribution principle: model-side "when a more capable model could have prevented it or recovered from it" — 36 of 41 modes are model-side, 5 harness/environment-side. Automatic labeling: four frontier judges on 40 worked examples, category κ = 0.76 (GPT-5.5) vs humans, inter-judge κ up to 0.84.
Apply to dsh: the labeling rule and fault-side field are what a component A/B needs to say whether a regression is *caused by the component*; report the labeler's κ alongside the counts.

**AgentRx: Diagnosing AI Agent Failures from Execution Trajectories** (Barke et al., Microsoft, arXiv:2602.02475, Feb–Aug 2026; EMNLP Findings 2026). https://arxiv.org/abs/2602.02475
Constraint synthesis from failed executions → step-wise constraint evaluation → LLM judge localizes the critical failure step and category (grounded-theory taxonomy); 170 trajectories / 11 settings; +75% average step-localization vs prior approaches.
Apply to dsh: constraint-violation logs are a structured, diffable intermediate that makes per-step blame comparable across arms.

**Who&When Pro: Can LLMs Really Attribute Failures in AI Agents?** (Liu et al., arXiv:2607.09996, July 2026). https://arxiv.org/abs/2607.09996
12,326 failed trajectories with ground truth built by "inject[ing] a failure only after exactly replaying a successful prefix"; 3 modalities, 26 benchmarks; finds systematic attribution patterns by modality/protocol/model family.
Apply to dsh: the replay-then-inject construction is a way to *calibrate* the tool's own failure labeler with known ground truth.

**TRAIL: Trace Reasoning and Agentic Issue Localization** (Deshpande et al., arXiv:2505.08638, 2025). https://arxiv.org/abs/2505.08638
148 human-annotated traces, 841 labeled errors under a formal taxonomy; best model (Gemini-2.5-pro) scored 11%.
Apply to dsh: automatic trace labeling is not yet reliable for open-ended error *discovery*; restrict LLM labeling to a closed taxonomy with reported κ.

**Strained Coherence: A Pre-Failure Signal in Coding Agent Execution Trajectories** (Pandya, Zhang, Lyu, arXiv:2606.07889, June 2026). https://arxiv.org/abs/2606.07889
Span-level detector for "acknowledge a problem, then proceed anyway"; flagged trajectories failed 94% vs 46% unflagged (Qwen3.5), 94% precision at matched selectivity.
Apply to dsh: a cheap per-trajectory risk flag that can be counted per arm.

**Automata from Agent Traces: Failure and Next-Step Prediction** (Cho et al., arXiv:2608.23670, Aug 2026). https://arxiv.org/abs/2608.23670
Collapses a trace corpus into a 7–43-state FSM (fitness ≥0.997 on held-out data); failure prediction AUROC up to 0.94; "behavioral topology ... appears shaped more by the deployment harness than by the LLM".
Apply to dsh: an FSM diff between arms is a compact visualization of *how* a harness change altered behavior.

**AgentAtlas: Beyond Outcome Leaderboards for LLM Agents** (Mazaheri & Mazaheri, arXiv:2605.20530, May 2026). https://arxiv.org/abs/2605.20530
Six-state control-decision taxonomy (Act, Ask, Refuse, Stop, Confirm, Recover), a trajectory-failure vocabulary, and a 0/1/2 coverage audit of 15 benchmarks; demonstrates that label agreement changes substantially when the explicit label menu is removed and that axis choice changes rankings.
Apply to dsh: always give the labeler a fixed menu; do not let taxonomy-blind prompts define categories.

### A7. Contamination and task validation (Harbor-Index-style continuous validation; verifier overreach)

**Harbor-Index 1.0** (Terminal-Bench team, 2026). https://www.tbench.ai/news/harbor-index
82 tasks distilled from 6,627 candidates across 54 Harbor-adapted benchmarks. Pipeline: (1) difficulty filter — keep tasks where Claude Opus 4.6 / GPT-5.4 / Gemini 3.1 Pro succeed ≤33% over 18 trials (6,627 → 1,311); (2) automated broken-task detection with a Gemini-3-Flash auditor scoring test–instruction alignment and "essential difficulty", flagging verifier overreach, undisclosed constraints and broken mechanics (→ 307); (3) 14 domain experts with identical rubrics, senior panel for diversity (→ 100 → 82 after hardening). Validation uses free-form *agentic judges* (production coding agents run as Harbor tasks inside each task's container with the trajectory, verifier output, gold solution and the ability to re-run the verifier on the agent's own submission), classifying verdicts as TP/TN/FP/FN to separate broken tasks from agent limitations; only 9 of 1,414 rollouts flagged as verifier gaming. Continuous "audit-and-fix loop" (run frontier models → audit verifier behaviour → repair or drop). Reporting: pass rate vs cost, failure modes (timeouts, near-misses, wrong answers), dashboards where every cited rollout opens the full trajectory with judge reasoning.
Apply to dsh: implement the TP/TN/FP/FN verdict audit as a standing job on the scenario pool and drop/repair scenarios whose FP/FN rate is non-zero before they enter an A/B.

**Terminal-Bench** (arXiv:2601.11868, Jan 2026). https://arxiv.org/html/2601.11868
Task QC: tests must fail on the initial state and pass with the oracle solution; contributor checklist, automated check and debug tools, an adversarial exploit agent to find unintended shortcuts, and a predicted-vs-empirical difficulty calibration; reports cost, episode counts and output tokens alongside success.
Apply to dsh: the two mechanical gates (oracle passes; untouched state fails) are the minimum grader-validity check per scenario.

**OpenAI: "Why SWE-bench Verified no longer measures frontier coding capabilities"** (Feb 2026). https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ (403 at fetch time; figures below from the mirror https://blog.pebblous.ai/blog/swe-bench-verified-retired/en/ which attributes them to OpenAI's post)
Audit of 138 hard tasks: 59.4% had flaws in the test design, 35.5% of those excessively restrictive (rejecting functionally correct solutions); contamination evidence — GPT-5.2 solved 31 "nearly impossible" tasks and in one Django case its reasoning cited release-note details absent from the prompt; top score moved only 74.9% → 80.9% in six months; recommends SWE-bench Pro (1,865 tasks, multilingual), on which the same models score much lower.
Apply to dsh: a fixed public task pool contaminates; the tool should record task provenance/dates and prefer private or post-cutoff scenarios for confirmatory A/Bs.

**SWE-Bench+** (Aleithan et al., arXiv:2410.06992). https://arxiv.org/abs/2410.06992
32.67% of successful patches had the solution in the issue text/comments; 31.08% passed on weak tests; SWE-Agent+GPT-4 resolution 12.47% → 3.97% after filtering; >94% of issues predate knowledge cutoffs.

**Cross-Context Verification** (Song, arXiv:2603.21454, Mar–Apr 2026). https://arxiv.org/abs/2603.21454
Solve the same problem in N isolated sessions and measure solution diversity: memorized solutions are reproduced verbatim across sessions, genuine reasoning varies; "contamination is binary". On 9 SWE-bench Verified problems: perfect separation (Mann–Whitney U=0, p≈0.012); 33% of previously flagged cases were false positives.
Apply to dsh: an optional contamination probe per scenario (k isolated runs → diversity score) that is a by-product of the repeats the tool already runs.

**Building to the Test: Coding Agents Deliver What You Check, Not What You Requested** (Ma, Kereopa-Yorke, Schultz, arXiv:2606.28430, June 2026). https://arxiv.org/abs/2606.28430
18 runs of a React→Angular component port under three oracle-availability conditions with a 222-test Playwright oracle; agents that see the tests reach near-perfect scores while shipping dead or absent functionality; mechanical audits and no-op ablations expose it.
Apply to dsh: keep the verifier hidden from the agent arm and run a no-op ablation (agent does nothing) as a grader sanity check.

**The Art of Building Verifiers for Computer Use Agents** (Rosset et al., Microsoft/Browserbase, arXiv:2604.06240, Apr 2026). https://arxiv.org/html/2604.06240
Verifier failure modes: phantom criteria (requirements never stated), cascading errors from non-independent rubric items, confirmation bias when rubric generation and scoring co-occur, hallucination opacity, unaccounted side effects. Principles: specific non-overlapping criteria; separate process and outcome rewards; distinguish controllable vs uncontrollable failures; systematic screenshot evidence management. Universal Verifier κ = 0.64 / 0.58 vs WebJudge 0.44 / 0.26; false-positive rate 1–8% vs 20–45%; humans changed 16.6% of labels after reading its reasoning.
Apply to dsh: rubric-judge graders must be generated *before* seeing agent output, with independent criteria, and audited for phantom criteria.

**Overeager Coding Agents** (Qu et al., arXiv:2605.18583, May 2026). https://arxiv.org/abs/2605.18583
Paired prompt variants byte-identical except for a consent declaration; every scenario passed a behavioral-gradient validator certifying discriminative power before inclusion; 500 scenarios, ~7,500 runs, four products; removing consent text raised overeager rates 0.0% → 17.1% on Claude Code.
Apply to dsh: certify each scenario's discriminative power (it must separate at least two known-different arms) before it counts toward an A/B.

**Who Drifted: the System or the Judge? Anytime-Valid Attribution in LLM Evaluation Pipelines** (Li, arXiv:2606.15474, June 2026). https://arxiv.org/abs/2606.15474
Fixed human-labeled anchor set re-scored by the judge at intervals + betting e-process on the judge–human gap + guard-window rule → verdict ∈ {none, system, judge}; silent judge version bumps detected 60/60 with zero false system attributions; contaminated prompt changes 110/120; monitoring cost ~21–64% of standard evaluation.
Apply to dsh: an A/B that uses an LLM judge needs the anchor-set monitor so a judge update is not mistaken for a component effect.

---

## B. Statistical methods a small-sample paired tool should implement

### B1. Prediction-powered inference (PPI / PPI++)

**PPI** (Angelopoulos, Bates, Fannjiang, Jordan, Zrnic, arXiv:2301.09633; Science 2023). https://arxiv.org/abs/2301.09633 (formulas read from the PDF)
Setup: n gold-labeled pairs (X_i, Y_i) with judge predictions f(X_i), and N ≫ n unlabeled items with predictions f(X̃_i). Rectifier for the mean: Δ = E[f(X_i) − Y_i]. Estimator
  θ̂^PP = (1/N) Σ_{i=1}^{N} f(X̃_i) − (1/n) Σ_{i=1}^{n} (f(X_i) − Y_i),
unbiased for θ* = E[Y]; CI θ̂^PP ± z_{1−α/2} · sqrt(σ̂²_{f−Y}/n + σ̂²_f/N) where σ̂²_{f−Y} is the variance of the residuals on the labeled set and σ̂²_f the variance of predictions on the unlabeled set; Proposition 1: liminf P(θ* ∈ C^PP_α) ≥ 1−α with no assumption on f.

**PPI++** (Angelopoulos, Duchi, Zrnic, arXiv:2311.01453). https://arxiv.org/abs/2311.01453 (formulas read from the PDF, Example 6.1)
Power-tuned mean estimator
  θ̂^PP_λ = (1/n) Σ Y_i + λ · ( (1/N) Σ f(X̃_i) − (1/n) Σ f(X_i) ),
λ = 0 is the classical estimator, λ = 1 the original PPI; optimal λ* = Cov(Y, f(X)) / ((1 + r) Var(f(X))) with r = n/N, plug-in λ̂ = Cov_n(Y_i, f(X_i)) / ((1 + n/N) Var_{N+n}(f)). Asymptotic variance at λ* is the classical variance minus a non-negative term, so PPI++ "(asymptotically) dominates classical inference". Reference implementation: `ppi_mean_ci(Y, Yhat, Yhat_unlabeled, alpha)` in https://github.com/aangelopoulos/ppi_py.

Related 2026 applications and limits:
- *Efficient Inference for Noisy LLM-as-a-Judge Evaluation* (Chen et al., arXiv:2601.05420): unifies Rogan–Gladen measurement-error correction and PPI via efficient influence functions; characterizes when PPI-style estimators have strictly smaller asymptotic variance. https://arxiv.org/abs/2601.05420
- *Power Analysis for PPI* (Chen, Guo, Li, arXiv:2603.16041): closed-form power via Wald inversion; required labeled n shrinks roughly with the R² between predictions and truth; covers two-sample comparisons and 2×2 tables; R package + calculators. https://arxiv.org/abs/2603.16041
- *Statistically Reliable LLM-Based Ranking Evaluation via PPI* (Divekar, arXiv:2606.05308, ACL 2026 GEM): 30 human labels + Claude judgments cut SE of Precision@4 from 4.45 to 3.50; 100 human labels correctly ranked three system variants later confirmed by A/B. https://arxiv.org/abs/2606.05308
- *Bias and Uncertainty in LLM-as-a-Judge Estimation* (Fiedler, arXiv:2605.06939): sharing one calibration across systems can flip the sign of a comparison "with high apparent confidence"; proposes judge-quality J and cross-system calibration instability ΔJ as diagnostics. https://arxiv.org/abs/2605.06939
- *Best Arm Identification with LLM Judges and Limited Human* (Ao et al., arXiv:2601.21471): proxy score + inverse-propensity-weighted residuals, anytime-valid confidence sequences, adaptive human audits concentrated on "unreliable contexts and close arms"; without bias correction mis-selection probability need not vanish even with unlimited proxy data. https://arxiv.org/abs/2601.21471
- *AutoEval Done Right* (Boyeau et al., arXiv:2403.07008): PPI for accuracy, pairwise win rates and rankings; effective human sample size +50% with GPT-4 labels. https://arxiv.org/abs/2403.07008
- *LLM as Judge won't beat twice the data* (Dorner, Nastl, Hardt, arXiv:2410.13341, ICLR 2025): a debiased judge no better than the evaluated systems cannot cut required gold labels by more than 50%. https://arxiv.org/abs/2410.13341
Apply to dsh: for judge-graded metrics, estimate each arm (and the paired difference: apply PPI++ to d_i = judge_A − judge_B with residuals against human-labeled paired differences) with λ̂ reported; calibrate *per arm* (Fiedler) and budget with the R² rule; expect ≤2× label savings.

### B2. Anytime-valid / sequential testing

**mSPRT and always-valid p-values** (Johari, Pekelis, Walsh, arXiv:1512.04922; Operations Research 2022). https://arxiv.org/abs/1512.04922 (definitions read from the PDF)
For a one-parameter exponential family with sample mean S_n, the mixture likelihood ratio Λ^H_n(S_n) = ∫_Θ (f_θ(S_n)/f_θ0(S_n))^n dH(θ); the test stops at T^H(α) = inf{n : Λ^H_n ≥ 1/α} and controls type-I error at α by the martingale property. Always-valid p-value: p_n = inf{α : T(α) ≤ n}, i.e., p_n = min(p_{n−1}, 1/Λ_n) capped at 1; always-valid CI = the set of θ0 not rejected at time n. The paper's A/B model explicitly treats visitors as arriving in pairs (X_n, Y_n), one per arm, testing θ = p_1 − p_0 for Bernoulli or μ_1 − μ_0 for normal data. With H = N(0, τ²) and normal data the mixture has the standard closed form Λ_n = sqrt(σ²/(σ²+nτ²)) · exp( n²τ²(S̄_n − θ0)² / (2σ²(σ²+nτ²)) ) (closed form as given in the KDD'17 companion "Peeking at A/B Tests", https://doi.org/10.1145/3097983.3097992; not re-verified from that PDF here).

**Asymptotic confidence sequences** (Waudby-Smith, Arbour, Sinha, Kennedy, Ramdas, arXiv:2103.06476). https://arxiv.org/abs/2103.06476 (Theorem 2.2 read from the PDF)
For i.i.d. (or martingale-difference) data with finite variance, C_t = μ̂_t ± σ̂_t · sqrt( (2(tρ²+1)/(t²ρ²)) · log( sqrt(tρ²+1)/α ) ) is a (1−α)-AsympCS: asymptotically P(∀t: μ ∈ C_t) ≥ 1−α, with no MGF/boundedness assumption. ρ is "a user-chosen tuning parameter which dictates the time at which (8) is tightest" (Appendix B.2); for a first-peek time m the paper uses ρ_m = sqrt( (−2 log α + log(−2 log α) + 1) / (σ̂²_m · m · log(m ∨ e)) ). Deployed in Adobe's experimentation platform (Maharaj et al., arXiv:2302.10108, https://arxiv.org/abs/2302.10108) and in AV-AIVAT (A2).

**Betting confidence sequences for bounded means** (Waudby-Smith & Ramdas, arXiv:2010.09686; JRSS-B). https://arxiv.org/abs/2010.09686
For X_t ∈ [0,1], capital process K_t(m) = ∏_{i≤t} (1 + λ_i(m)(X_i − m)) with predictable bets λ_i(m); C_t = {m : K_t(m) < 1/α} is a time-uniform (1−α)-CS, variance-adaptive, valid at any stopping time. General framework and Ville's inequality P(sup_t E_t ≥ 1/α) ≤ α: Ramdas, Grünwald, Vovk, Shafer, arXiv:2210.01948, https://arxiv.org/abs/2210.01948. E-variables for sequential k×2 contingency tables with optional stopping (independent streams): Turner, Ly, Grünwald, arXiv:2106.02693, https://arxiv.org/abs/2106.02693.

How to apply to per-trial paired outcomes:
- Paired binary: per trial d_t = Y_A − Y_B ∈ {−1,0,1}; set X_t = (d_t+1)/2 ∈ [0,1] and run the betting CS for E[X]; H0 "no difference" ⇔ E[X] = 1/2; stop when 1/2 leaves C_t. Equivalent conditional form: among discordant trials, b ~ Bernoulli(1/2) under H0 — a Beta-mixture (Robbins/Kelly) test martingale on the discordant stream is the sequential McNemar.
- Paired continuous (cost): d_t = C_A − C_B, use the AsympCS on the running mean of d_t with ρ tuned at the planned n·k; the 0-crossing of the CS is the decision.
- Ordering: trials must be interleaved/randomized across scenarios (AV-AIVAT and optstop both require exchangeable arrival); the AsympCS σ̂_t should be the cluster-robust estimate when k > 1 per scenario, or the sequence should be indexed by scenario with the scenario mean of d as X_t.

### B3. Variance reduction with covariates (CUPED / regression adjustment)

**CUPED** (Deng, Xu, Kohavi, Walker, WSDM 2013). https://exp-platform.com/Documents/2013-02-CUPED-ImprovingSensitivityOfControlledExperiments.pdf (formulas read from the PDF)
For pairs (Y_i, X_i) with known E[X], Ŷ_cv = Ȳ − θ X̄ + θ E[X] is unbiased; Var is minimized at θ = cov(Y, X)/var(X), giving var(Ŷ_cv) = var(Ȳ)(1 − ρ²) with ρ = cor(Y, X). The covariate must be pre-experiment (unaffected by treatment); the same metric measured pre-period is the usual best covariate; Bing saw ≈50% variance reduction (equivalent to half the users or half the duration).

**Regression adjustment with interactions** (Lin, Annals of Applied Statistics 2013, arXiv:1208.2301). https://arxiv.org/abs/1208.2301
OLS with a full set of treatment×covariate interactions "cannot hurt asymptotic precision", and Huber–White sandwich SEs give asymptotically valid CIs.

Apply to dsh: in the paired design, adjust the paired difference: d̃_i = d_i − θ (x_i − x̄) with x_i = the scenario's baseline cost (or baseline pass rate) from a pre-registered baseline run, θ = cov(d, x)/var(x); report ρ² as "variance removed". Because x_i is a property of the scenario measured before either arm runs, it is a valid pre-experiment covariate. AIVAT (A2) is the agent-specific generalization when a value function is available.

### B4. Clustered / hierarchical bootstrap

**Bootstrap Confidence Intervals for LLM Evaluation** (Indeed Engineering, July 2026). https://engineering.indeedblog.com/blog/2026/07/bootstrap-confidence-intervals-for-llm-evaluation/
Design: N inputs × k runs. Simulation (2,000 trials, 5,000 resamples, nominal 95%): IID bootstrap on one run per input 96.0% coverage (width 0.127); cluster bootstrap (resample inputs with replacement, carry all k runs) 94.8% (width 0.075); hierarchical two-stage (resample inputs, then runs within input) 98.7% (conservative; "double-counts" within-input variance); single-draw-per-cluster 100% (over-conservative); mode-aggregate 0% at k=5. Formulas: Var(Ȳ) = (σ_B² + σ_W²/k)/N; SD ∝ (σ/√N)·sqrt((1+(k−1)ρ)/k), ρ = ICC; recommended k = 3–5.
Procedure: "resampling inputs with replacement (carrying all k runs for each chosen input), and recompute your metric on each resample; the 2.5th and 97.5th percentiles give a 95% interval."

**Bootstrap-Based Improvements for Inference with Clustered Errors** (Cameron, Gelbach, Miller, REStat 2008; NBER TWP 0344). https://www.nber.org/papers/t0344
With few clusters (5–30) cluster-robust asymptotics over-reject (≈10% at nominal 5%); cluster bootstrap-t (incl. wild cluster) restores nominal size.

**Hierarchical cluster bootstrap in practice** (Ding, arXiv:2607.08065, July 2026): B = 2,000; resample the dominant dependence factor (runners) then cases within, explicitly *not* a two-way crossed resample. https://arxiv.org/html/2607.08065
**Inspect** ships `stderr(cluster=...)`, `ci(method="bootstrap", cluster=...)`, `ci_wilson` for binary scores. https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html

Apply to dsh: default CI = cluster (scenario) bootstrap of the paired-difference statistic carrying all k repeats; report ρ̂ and the design effect 1+(k−1)ρ̂; when the number of scenarios is small (<30) use a bootstrap-t variant rather than percentile.

### B5. Multiple-comparison control

**Holm (1979)** — Scand. J. Statist. 6:65–70, https://www.jstor.org/stable/4615733 (procedure as stated at https://en.wikipedia.org/wiki/Holm%E2%80%93Bonferroni_method): order p_(1) ≤ … ≤ p_(m); reject sequentially while p_(k) ≤ α/(m−k+1); stop at the first failure; adjusted p̃_(i) = max_{j≤i} min(1, (m−j+1) p_(j)). Controls FWER strongly under any dependence.
**Benjamini–Hochberg (1995)** — JRSS-B 57:289–300, https://doi.org/10.1111/j.2517-6161.1995.tb02031.x (procedure at https://en.wikipedia.org/wiki/False_discovery_rate): find the largest k with p_(k) ≤ (k/m)·α and reject H_(1..k); controls FDR under independence/PRDS. **Benjamini–Yekutieli (2001)**, Ann. Statist. 29:1165–1188, https://doi.org/10.1214/aos/1013699998: divide by c(m) = Σ_{i=1}^{m} 1/i for arbitrary dependence.
Used in 2026 LLM-ranking work: 2607.16259 applies Holm across all pairwise model tests to build rank intervals (A2).
When to prefer which (for dsh): Holm for the *confirmatory* family (each candidate vs baseline on the primary metric; a single false "ship" decision is costly; few hypotheses); BH for the *exploratory* per-category screen (many scenario categories; goal is a list to inspect; some false leads acceptable); BY when category tests share trials/judges so dependence is arbitrary. Report both raw and adjusted p, and per 2605.30315 remember that unresolved pairs persist after correction — correction does not manufacture power.

### B6. Bayesian estimation of a paired pass-rate difference (alternative to TOST)

**HDI + ROPE rule** (Kruschke & Liddell 2018, Psychon. Bull. Rev. 25:178–206; Kruschke 2018 AMPPS). https://easystats.github.io/bayestestR/articles/region_of_practical_equivalence.html ; https://journals.sagepub.com/doi/10.1177/2515245918771304
Reject the null value if the HDI lies entirely outside the ROPE; accept practical equivalence if the HDI lies entirely inside; otherwise undecided. bayestestR's default ROPE is ±0.1 of a standardized effect (Cohen 1988) and it recommends reporting the % of the full posterior inside the ROPE.
**Closed form for independent Beta posteriors** (Evan Miller): Pr(p_B > p_A) = Σ_{i=0}^{α_B−1} B(α_A+i, β_A+β_B) / ((β_B+i) · B(1+i, β_B) · B(α_A, β_A)), with Beta(S+1, F+1) posteriors; compute in log-space. https://www.evanmiller.org/bayesian-ab-testing.html — applies to *independent* arms only.
Paired version (derived; for the Bayesian literature on matched-pair intervals see the Communications in Statistics 2008 paper "Bayesian Confidence Interval for the Difference of Two Proportions in the Matched-Paired Design", https://www.tandfonline.com/doi/full/10.1080/03610920801931879, abstract not retrievable here):
- Full table: (a, b, c, dd) ~ Multinomial(p); prior Dirichlet(1,1,1,1) ⇒ posterior Dirichlet(a+1, b+1, c+1, dd+1); the paired difference δ = p_A − p_B = p_b − p_c; sample δ, compute HDI, apply ROPE (e.g., ±0.02 or ±0.05 absolute pass rate, chosen a priori).
- Conditional (discordant-only) version: b | (b+c) ~ Binomial(b+c, π), π ~ Beta(1,1) ⇒ π | data ~ Beta(b+1, c+1); H0 ⇔ π = 1/2; Pr(π > 1/2) = 1 − I_{1/2}(b+1, c+1) (regularized incomplete beta); ROPE on π or on δ = π·(b+c)/n − (1−π)·(b+c)/n.
A precision-based Bayesian *stopping* rule with Beta priors and asymmetric conservatism for rare successes is in optstop (arXiv:2608.14425, A4).
Apply to dsh: report P(δ > 0), P(|δ| < ROPE) and the 95% HDI beside the frequentist test; TOST and HDI+ROPE agree asymptotically but the Bayesian output is interpretable at n·k in the tens.

### B7. Minimum detectable effect / power for n scenarios × k repeats

Variance components (law of total variance, Indeed 2026; same decomposition as the clustered SE in sweep-1's 2411.00640): Var(d̄) = (σ²_B + σ²_W/k)/n where σ²_B is between-scenario variance of the scenario-mean paired difference and σ²_W the within-scenario (repeat) variance; equivalently Var(d̄) = σ²·(1+(k−1)ρ)/(n·k). https://engineering.indeedblog.com/blog/2026/07/bootstrap-confidence-intervals-for-llm-evaluation/
MDE for a two-sided paired z-test: MDE = (z_{1−α/2} + z_{1−β}) · sqrt((σ̂²_B + σ̂²_W/k)/n); the k-limit is (z_{1−α/2}+z_{1−β})·σ̂_B/√n (adding repeats cannot beat √ρ), so once ρ̂ is known the planner decides n vs k by cost.
Paired binary (McNemar) sample size, Connor 1987, Biometrics 43:207–211, as implemented in pwrss `proportions.mcnemar`: n = [ z_{1−α/2}·√p_d + z_{1−β}·√(p_d − p_d²·(1 − (OR−1)²/(OR+1)²) ) ]² / ( p_d·|OR−1|/(OR+1) )², with p_d = p_10 + p_01 the discordance probability and OR = p_21/p_12; only the n·p_d discordant pairs carry information. https://rdrr.io/cran/pwrss/man/proportions.mcnemar.html ; exact power via exact2x2 `powerPaired2x2(pb, pc, npairs)` https://rdrr.io/cran/exact2x2/man/powerPaired2x2.html
Judge-labeled metrics: PPI power formulas (2603.16041) — labeled-sample savings scale with R²(prediction, truth).
Reporting: the resolution ratio q = n/N* (2605.30315); note its finding that the unpaired Cohen-h formula misstates N* by ≈2× for small gaps — never plan a paired eval with an unpaired formula.
Apply to dsh: after any run, fit σ̂²_B, σ̂²_W, ρ̂ and p̂_d from the data and print (i) MDE at the current n,k, (ii) the n or k needed for a target MDE, (iii) q.

### B8. McNemar exact / mid-p test for paired binary outcomes

**Fagerland, Lydersen, Laake, BMC Med Res Methodol 2013;13:91.** https://pmc.ncbi.nlm.nih.gov/articles/PMC3716987/
Asymptotic: χ² = (b−c)²/(b+c) ~ χ²_1. Exact conditional: under H0, b | (b+c) ~ Binomial(b+c, 1/2); two-sided p = 2·P(Bin(b+c,1/2) ≤ min(b,c)) capped at 1. Mid-p: exact two-sided p minus the point probability f(b | b+c). Findings across 9,595 scenarios: the mid-p test never violated the nominal level and had power close to the asymptotic test; "We do not recommend use of the McNemar exact conditional test in any situation" (too conservative). Exact CIs for the paired difference: exact2x2 `mcnemarExactDP` https://rdrr.io/cran/exact2x2/man/mcnemarExactDP.html.
Apply to dsh: primary paired-binary test = McNemar mid-p on the discordant counts, with the difference δ̂ = (b−c)/(n·k) and an exact/bootstrap CI; when k > 1 either aggregate to scenario level or use the cluster bootstrap (B4) for the CI, since repeats within a scenario are not independent pairs.

### B9. Bradley–Terry with bootstrap CIs (Chatbot-Arena style) — and whether it fits config comparisons

**Chatbot Arena** (Chiang et al., arXiv:2403.04132). https://arxiv.org/html/2403.04132v1
P(m beats m') = 1/(1+e^{ξ_{m'}−ξ_m}) (Eq. 2); ξ fit by minimizing binary cross-entropy (logistic regression, Eq. 3); MLE remains asymptotically normal under misspecification with the sandwich covariance; CIs from the sandwich estimate (chi-square confidence set {ξ : T‖V̂^{−1/2}(ξ̂−ξ)‖ ≤ χ²_{1−α,M−1}}); rank rule R_m = 1 + Σ_{m'} 1{inf C_{m'} > sup C_m}; active pair sampling P_t(a) ∝ sqrt(Σ̂_{t,a,a}/n_a) − sqrt(Σ̂_{t,a,a}/(n_a+1)); non-binary feedback (ties, both-bad) handled by a nonparametric extension. The leaderboard implementation (LMSYS blog, Dec 2023, https://lmsys.org/blog/2023-12-07-leaderboard/) fits BT by MLE, counts a tie as half a win and half a loss, and bootstraps the battles for CIs ("bootstrap the MLE Bradley-Terry scores"); it moved off Elo because "the BT coefficients are better for the purpose of statistical estimation".
**Elo Uncovered** (Boubdir et al., GEM@EMNLP 2023, arXiv:2311.17295): Elo violates reliability and transitivity axioms under realistic hyperparameters. https://arxiv.org/abs/2311.17295
Appropriateness for config comparisons: BT is appropriate only when (i) ≥3 arms, (ii) the primary signal is a pairwise *preference* (judge or human) rather than a per-trial outcome, and (iii) one wants a single latent scale. For 2–4 harness configs graded by pass/fail or cost on the *same* scenarios, direct paired estimation (B4/B8) is more efficient and needs no transitivity or one-dimensionality assumption; if BT is used, battles that share a scenario are dependent, so the bootstrap must resample scenarios (clusters), not battles, and the rank rule from 2607.16259 (Holm-corrected pairwise tests) is the more conservative alternative.

---

## C. LLM-judge protocols in 2026

**Reliability without Validity** (Norman, Rivera, Hughes, UC Berkeley, arXiv:2606.19544, June 2026). https://arxiv.org/html/2606.19544v1
21 judges / 9 providers / MT-Bench, JudgeBench, RewardBench / 118 runs / ~541K judgments. Metrics: Cohen's κ vs exact match; test-retest (Krippendorff's α) and self-consistency over ≥3 runs; position bias |P(A wins)−0.5|; verbosity bias (length–verdict correlation). "Kappa deflation": exact-match minus κ gaps of 33.8–41.2 pp on MT-Bench (85% agreement ≈ κ 0.48); "consistency–bias paradox": judges with test-retest >0.95 and position bias >0.10 (reliable but invalid). Minimum viable validation protocol: (1) chance-corrected metrics as headline; (2) position bias via paired AB+BA; (3) consistency over ≥3 runs at T=0; (4) ≥2 benchmarks with different label structures; (5) if test-retest >0.95, verify position bias <0.10.

**SCOPE: Selective Conformal Optimized Pairwise LLM Judging** (Badshah, Emami, Sajjad, arXiv:2602.13110, ICML 2026). https://arxiv.org/abs/2602.13110
Bidirectional Preference Entropy: query both orderings, convert the preference probabilities into an entropy uncertainty; conformal threshold so that under exchangeability the error rate among non-abstained judgments ≤ α (observed FDR 0.097–0.099 at α = 0.10); accepts up to 2.4× more judgments than baselines.
**Localize-Then-Decide** (Li et al., arXiv:2608.25824, Aug 2026): conformal shortlist that contains the human-preferred response w.h.p., then a calibrated confidence rule selects or abstains; fixes the breakdown of confidence thresholding when many candidates split probability mass. https://arxiv.org/abs/2608.25824
**Trust or Escalate** (Jung, Brahman, Choi, arXiv:2407.18370): selective evaluation with provable human-agreement guarantee, "simulated annotators" for confidence, cascaded judges (Mistral-7B → GPT-4); >80% agreement at ~80% coverage on Chatbot Arena. https://arxiv.org/abs/2407.18370

**Panels**: *A Finite-Calibration Regime Map for LLM Judge Panels* (Zhu, Xie, Rao, arXiv:2606.01034, May–Aug 2026): with a seven-judge pool on RewardBench/LLMBar/SummEval/Arena100K, simple low-dimensional stackers or reliability models beat unrestricted joint-table calibration in 16/20 dataset–budget cells; decide by whether "the next judge's information is estimable under the available human labels". https://arxiv.org/abs/2606.01034 · *PoLL* (Verga et al., arXiv:2404.18796): panel of smaller judges from disjoint families beats a single large judge, >7× cheaper, less intra-model bias. https://arxiv.org/abs/2404.18796 · *Vibe Coding on Trial* (Ullah & Serwadda, arXiv:2602.18492): unanimous juries (1–6 of the strongest 6 of 15 models) on 82 execution-grounded text-to-SQL tasks; reports TPR/FPR/Youden J; small unanimous committees "cut false accepts while still passing many good queries". https://arxiv.org/abs/2602.18492

**Calibration against human labels**:
- *How to Correctly Report LLM-as-a-Judge Evaluations* (Lee et al., arXiv:2511.21140, rev. May 2026): with judge positive rate p̂ and calibration-set specificity q̂_0 and sensitivity q̂_1, θ̂ = (p̂ + q̂_0 − 1)/(q̂_0 + q̂_1 − 1) (from E[p̂] = (q_0+q_1−1)θ + (1−q_0)); Var(θ̂) = [ p̂(1−p̂)/n + (1−θ̂)²·q̂_0(1−q̂_0)/m_0 + θ̂²·q̂_1(1−q̂_1)/m_1 ] / (q̂_0+q̂_1−1)²; adjusted-Wald CIs; unbiased under test/calibration distribution shift; judge-based evaluation beats human-only only in a θ-band around 0.5 that widens with judge accuracy (Prop. 6.1); ≈200 calibration examples for CI length <0.1 at (q̂_0, q̂_1) = (0.7, 0.9). https://arxiv.org/abs/2511.21140
- *Noisy but Valid* (Feng et al., ICLR 2026, arXiv:2601.20913): estimate TPR/FPR on a small human set, apply a variance-corrected critical threshold to the judge-labeled set; finite-sample type-I control despite calibration uncertainty; quantifies the "oracle gap". https://arxiv.org/abs/2601.20913
- *Judge's Verdict* (Han et al., arXiv:2510.09738): step 1 correlation filter, step 2 "human-likeness" z-test (|z|<1 human-like; z>1 super-consistent); 27/54 judges Tier 1. https://arxiv.org/abs/2510.09738
- Hamel Husain's field guide: binary pass/fail with critique, ~100 human-labeled gold examples, track agreement (TPR/TNR) and iterate the judge prompt ("three iterations to achieve >90% agreement"), error analysis by open coding then an LLM-built taxonomy. https://hamel.dev/blog/posts/field-guide/ ; TPR/TNR framing at https://hamel.dev/blog/posts/evals-faq/can-i-use-the-same-model-for-both-the-main-task-and-evaluation.html
- *Judge drift*: Who Drifted (2606.15474, A7) — anchor set + betting e-process.

**Grader-validity checks beyond sweep 1** (non-discriminating assertions, oracle/null agents):
- Terminal-Bench: tests must fail on the initial state and pass with the oracle; adversarial exploit agent hunts shortcuts (A7).
- Harbor-Index: TP/TN/FP/FN verdict audit of every rollout with re-runnable verifiers; verifier-overreach flag; 9/1,414 gaming cases (A7).
- Building to the Test: no-op ablations and a hidden oracle test suite (A7).
- Overeager Coding Agents: discriminative-power certification of each scenario against a behavioral gradient before inclusion (A7).
- Universal Verifier: phantom-criteria / cascading-error / confirmation-bias audit of rubric graders; separate process vs outcome rewards (A7).
- Anthropic: zero pass rate over many trials ⇒ suspect the task; "grade what the agent produced, not the path"; read transcripts before trusting a score (A5).
Apply to dsh (judge protocol): AB+BA with BPE-style uncertainty and abstention; κ (not raw agreement) vs a ≥100-item human set per arm; publish (q̂_0, q̂_1, m) and the bias-corrected θ̂; anchor-set monitoring for judge drift; per-scenario grader gates (oracle passes, null agent fails, discriminative-power certified).

---

## D. UI / reporting conventions in academic eval tooling

**Inspect (UK AISI)** — log viewer https://inspect.aisi.org.uk/log-viewer.html ; metrics https://inspect.aisi.org.uk/metrics.html ; reference https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html
Eval-level header with task metrics, model and config; Info panel with dataset, solver, scorer, git revision and token usage; per-sample tabs Messages (full conversation incl. tool calls), Scoring (input, target, extracted answer, explanation), Metadata; filter by score (e.g., only incorrect), sort by epoch or grouped by sample across epochs "helpful for identifying inconsistencies"; `inspect view` serves logs (port 7575, S3/shared logs). Metrics: accuracy, mean, std, var, stderr (CLT, `cluster=` metadata key), bootstrap_stderr (1000 resamples), ci ("t" or "bootstrap", with cluster), ci_wilson for binary; grouped(metric, key) with an "all" aggregate; reducers mean/median/mode/max/at_least/pass_at/pass_k operate per sample across epochs.

**HELM** (Liang et al., arXiv:2211.09110; https://crfm-helm.readthedocs.io/en/latest/). https://arxiv.org/abs/2211.09110
Scenario × metric matrix (16 core scenarios, 7 metric categories: accuracy, calibration, robustness, fairness, bias, toxicity, efficiency) so trade-offs are exposed rather than collapsed; web UI for inspecting individual prompts/responses; all raw prompts and completions released; leaderboards per domain.

**OpenCompass** — summarizer docs https://opencompass.readthedocs.io/en/latest/user_guides/summarizer.html
Result tables with columns dataset, version (a hash of evaluation method, prompt and output-length limit, used to check comparability), metric, mode (ppl/gen/mixed), one column per model; `summary_groups` with subsets and weights, emitted only if all subsets exist; missing = "-". No stderr/uncertainty column is documented.

**lm-evaluation-harness** — https://github.com/EleutherAI/lm-evaluation-harness ; https://raw.githubusercontent.com/EleutherAI/lm-evaluation-harness/main/lm_eval/api/metrics.py
Results table columns task, version, filter, n-shot, metric, value, stderr; mean_stderr = sample SD/√n; bootstrap_stderr resamples with replacement (chunks of ≤1000 iterations, parallel); pooled_sample_stderr combines subtasks; `--log_samples` writes per-sample JSON (also W&B/Zeno); task versioning and prompt YAMLs for reproducibility.

**Harbor / Terminal-Bench** — core concepts https://www.harborframework.com/docs/core-concepts ; ATIF https://www.harborframework.com/docs/agents/trajectory-format ; RFC https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md ; dashboards https://www.tbench.ai/news/harbor-index
Task = instruction + container + tests (task.toml); Trial = one agent attempt producing a reward; Job = many trials over datasets/agents configured in job.yaml. ATIF v1.8 trajectory JSON: schema_version, session_id, agent{name, version, model}, steps[{source, message, reasoning_content, tool_calls, observation, metrics{prompt/completion/cached tokens, USD cost}}], final_metrics; designed for debugging, visualization, SFT and RL. Harbor-Index dashboards: pass rate vs cost, failure-mode breakdown, click any cited rollout to open the full trajectory with judge reasoning. (The /docs/jobs page returned 404; per-trial directory layout not verified.)

What a report is expected to contain (union of the above): a header with the exact configuration hash (harness, model, tools, snapshot, git revision, seeds, k); a metric table with CI/stderr columns (Inspect, lm-eval) — clustered by the declared unit; multi-metric rather than single-score presentation with cost alongside accuracy (HELM, Harbor-Index); per-sample drill-down to the full transcript with grading rationale and metadata, filterable by outcome and sortable by sample across repeats (Inspect); a version/hash column that says whether two results are comparable (OpenCompass, lm-eval); machine-readable per-sample logs in a standard trajectory format (ATIF); failure-mode breakdown with clickable evidence (Harbor-Index).
Apply to dsh: the A/B report card should add, on top of these, the paired-specific fields — discordant counts (b, c), per-scenario paired differences with sign, ICC/design effect, adjusted p, q = n/N*, and the stopping-time trace of the confidence sequence.

---

## Prioritized: 10 most valuable additions for a paired dsh A/B tool

1. **Scenario-level cluster bootstrap CIs carrying all k repeats, with ICC/design effect reported** — nominal coverage (94.8%) where hierarchical and mode-aggregate variants fail; few-cluster bootstrap-t when n < 30. Indeed 2026 https://engineering.indeedblog.com/blog/2026/07/bootstrap-confidence-intervals-for-llm-evaluation/ ; Cameron–Gelbach–Miller https://www.nber.org/papers/t0344 ; Inspect `ci(cluster=)` https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html
2. **McNemar mid-p on discordant pairs as the primary paired-binary test, plus a Beta(b+1, c+1)/Dirichlet HDI+ROPE readout** — mid-p never exceeded nominal level in 9,595 scenarios; exact conditional is dominated. Fagerland et al. 2013 https://pmc.ncbi.nlm.nih.gov/articles/PMC3716987/ ; Kruschke ROPE https://easystats.github.io/bayestestR/articles/region_of_practical_equivalence.html
3. **Anytime-valid early stopping**: betting CS on X_t = (d_t+1)/2 for paired pass/fail and the asymptotic CS (ρ tuned at the planned n·k) for paired cost — AV-AIVAT shows 74× median stopping-time reduction in paired agent evaluation. Waudby-Smith & Ramdas https://arxiv.org/abs/2010.09686 ; Waudby-Smith et al. https://arxiv.org/abs/2103.06476 ; AV-AIVAT https://arxiv.org/html/2608.06362
4. **CUPED-style adjustment of paired differences with per-scenario baseline cost/pass-rate as covariate** (θ = cov/var, variance × (1−ρ²)), reported as "variance removed"; Lin-style interaction OLS with sandwich SEs for multi-covariate cases. Deng et al. 2013 https://exp-platform.com/Documents/2013-02-CUPED-ImprovingSensitivityOfControlledExperiments.pdf ; Lin 2013 https://arxiv.org/abs/1208.2301
5. **Grader-validity gates per scenario**: oracle solution must pass, null/no-op agent must fail, discriminative-power certification, verifier-overreach/phantom-criteria audit with TP/TN/FP/FN verdicts. Terminal-Bench https://arxiv.org/html/2601.11868 ; Harbor-Index https://www.tbench.ai/news/harbor-index ; Building to the Test https://arxiv.org/abs/2606.28430 ; Overeager https://arxiv.org/abs/2605.18583 ; Universal Verifier https://arxiv.org/html/2604.06240
6. **PPI++ for judge-graded metrics with per-arm calibration and λ̂ reported; TPR/TNR bias-corrected estimator as the cross-check; ≤2× label-savings expectation.** PPI++ https://arxiv.org/abs/2311.01453 ; Lee et al. https://arxiv.org/abs/2511.21140 ; Fiedler (per-arm calibration) https://arxiv.org/abs/2605.06939 ; Dorner et al. https://arxiv.org/abs/2410.13341
7. **Judge protocol: AB+BA with bidirectional-entropy uncertainty and conformal abstention; κ not raw agreement; position bias <0.10; ≥3 test-retest runs; anchor-set drift monitor.** Norman et al. https://arxiv.org/html/2606.19544v1 ; SCOPE https://arxiv.org/abs/2602.13110 ; Who Drifted https://arxiv.org/abs/2606.15474
8. **Power/MDE planner from fitted variance components and discordance** (Var(d̄) = (σ²_B+σ²_W/k)/n; Connor's McNemar n; PPI R² rule) printing q = n/N* with every verdict. Indeed 2026 (formula) ; Connor 1987 via https://rdrr.io/cran/pwrss/man/proportions.mcnemar.html ; PPI power https://arxiv.org/abs/2603.16041 ; Resolution diagnostics https://arxiv.org/abs/2605.30315
9. **Multiplicity layer**: Holm for candidate-vs-baseline confirmatory decisions, BH (BY under shared-trial dependence) for per-category screens, Holm-based rank intervals when >2 arms. Holm https://www.jstor.org/stable/4615733 ; BH https://doi.org/10.1111/j.2517-6161.1995.tb02031.x ; BY https://doi.org/10.1214/aos/1013699998 ; Neuhof & Benjamini https://arxiv.org/html/2607.16259v1
10. **Failure labeling with the earliest-unrecovered-failure rule and a model-vs-harness fault side, using a closed label menu and a reported labeler κ; TSS as a correctness-free behavior-change metric per scenario.** Scale AI taxonomy https://arxiv.org/html/2607.28802 ; AgentRx https://arxiv.org/abs/2602.02475 ; AgentAtlas (menu effect) https://arxiv.org/abs/2605.20530 ; TSS https://arxiv.org/html/2605.28840

Runners-up: Shapley attribution over component subsets (AgentCARD https://arxiv.org/abs/2606.20629); cross-context contamination probe from existing repeats (https://arxiv.org/abs/2603.21454); ATIF as the trajectory storage format (https://www.harborframework.com/docs/agents/trajectory-format).
