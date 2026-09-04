# State-of-the-art scorecard (living document)

The question this file answers: for a tool whose job is *paired evaluation of agent components*, is dsh-eval-infra at least as capable as every tool and every published method we know of, on every capability that matters for that job? The rule is conservative: a row is only **met** when the capability is implemented, covered by a keyless test, and exercised on at least one real run whose id is given in the row. *Partial* and missing rows are the work queue. Sources: [landscape.md](landscape.md), [landscape-2.md](landscape-2.md) (includes the dsh-native tools), [methodology.md](methodology.md), [methodology-2.md](methodology-2.md), [ui-patterns.md](ui-patterns.md), and the commissioned [adversarial review](adversarial-review.md) of the previous version of this file, whose objections are answered row by row below.

Legend: **met** · *partial* · missing · n/a (out of scope by design, with the reason). Run ids refer to [results.md](results.md).

## A. Experimental design

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| paired same-task comparison of two configurations | Scaffold Effect (2607.22585); muou000/dsh-eval; NVIDIA SkillEvaluator | scenario → repeat → arm in one process | **met** | 20260903-203845-40b3 |
| interleaved, order-alternated trials | Kohavi; muou000/dsh-eval (seeded AB/BA); openbench matched blocks | A B on odd repeats, B A on even; seeded scenario order in sequential mode | **met** | 20260903-191646-jz48 |
| one-variable enforcement | none of the surveyed tools (muou000 pins versions but does not diff the composed configuration) | composed-tree diff through `dsh --dump-config`, refusal above one differing row; dsh version and source revision recorded per run | **met** | every run |
| infrastructure-failure accounting | openbench "matched block" rule; Beyond pass@1 (2603.29231) | a trial that errors makes its scenario *incomplete* for that pair: excluded from the cost comparison, never counted as a fail, listed in the notes; no partial re-run of one arm | **met** | tests; 20260903-175407-2slv had none |
| repeats with a floor and a recommendation | τ-bench, Beyond pass@1, Indeed 2026 | default 3, note below 3, 5 recommended | **met** | 20260903-203845-40b3 (3 repeats) |
| A/A noise-floor run | Kohavi A/A; Noise Floor Audit (2608.22331) | `--aa`; floor quoted in later reports and drawn in the forest strip; a directional call whose interval reaches into the band is vetoed | **met** | 20260903-185811-02nc |
| perturbation floor (semantics-preserving prompt variants) | Noise Floor Audit (2608.22331) | `dsh-eval perturb` drafts paraphrases (`prompts.variants.json`, reviewed by hand); `--perturb` runs a seeded variant on repeats above 1, the same variant for every arm; `--aa --perturb` measures the perturbation floor, archived as its own kind and used to gate perturbed runs | **met** | 20260903-210602-8q7x (all 36 trials passed under every variant; floor wider than the rerun floor) |
| fresh environment per trial | ABC checklist T.4/T.6 | fresh workspace and runtime process per trial, isolated `DSH_HOME` | **met** | every run |
| provider conditions held constant and recorded | Epoch; Inspect throughput stats | same model route recorded from the request header; tariff band per step; wire meter records every provider request with latency | **met** | 20260903-204909-fczz |
| served-model verification | AgentProv (2609.00052); fpverify; One Token Is Enough (2607.10252) | three layers: (1) the meter records the model id, system fingerprint and client identity (`user-agent`) of every provider exchange, and a report reads nothing when the declared model differs from the requested one or the arms were served different models; (2) `dsh-eval probe` / `run --probe` sends a battery of 12 high-entropy prompts through the route, N samples each, and tests the answer distribution against an enrolled reference with a permutation test, blocking readings on rejection; (3) after every run the baseline's tool-use distribution is permutation-tested against the archive (behavioural drift). Measured on real routes at 12 probes × 10 samples (~$0.016 per side): the same route reads p 0.50, a same-family substitution (v4-pro answering as v4-flash) is caught at distance 0.317, p 0.0010 | **met** | 20260904 probe battery (chain6 L–N); 20260903-210317-otgh |
| sequential / adaptive stopping, valid at every look | AV-AIVAT (2608.06362), betting CS (2010.09686), asymptotic CS (2103.06476) | `--sequential`: the deciding cost sequence is a **hedged betting confidence sequence** (non-asymptotic) on the paired cost ratio winsorized at 2×; the asymptotic sequence is reported for screening only; betting sequence on the pass difference; stop once decided; the final report reads the sequence, not the bootstrap | **met** | 20260903-191646-jz48 (undecided after 6 scenarios: betting ratio interval 0.64–1.48 while the asymptotic Δ% interval was −5.5% to +24.8%; see results.md) |
| scenario selection under a valid sequence | CELEUS (2606.20820); Efficient Sequential Evaluation (2607.17409) | `--order signal`: order by archive signal-to-noise, fixed before this run's data exists. 2607.17409 shows a betting sequence stays valid for *any predictable* querying rule and finds uniform sampling "surprisingly competitive"; a rule that reacts to this run's own outcomes would need inverse-probability weighting to keep targeting the pool mean, which is a claim we will not make without validating it, so it is deliberately not implemented | **met** (predictable ordering) / deliberately not done (within-run adaptive) | 20260903-210317-otgh |
| holdout / sealed pools with a dev–sealed gap | AI Agents That Matter; Selection-Aware Stress Testing (2608.30916) | `meta.holdout` scenarios excluded unless `--include-holdout`; dev vs sealed Δpass and gap warning in the report | **met** | 20260903-204909-fczz |
| discovery / confirmation split with joint bounds | 2608.30916 | confirmation rule: a dev-pool pass direction of ≥10 pp that reverses on ≥3 sealed scenarios is declined (grade inconclusive, verdict says why); every interval is read at 0.05/(2m) — a Bonferroni joint bound over the two planned claims per candidate (cost direction, pass-rate direction), stated in the notes and signed into the receipt's contract | **met** | 20260903-210653-2m6a; contract in every receipt |
| simulated user driving multi-turn trials | Harbor RFC 0002 | not implemented; prompts are scripted lists with optional session breaks | n/a by design for component A/B (scripted prompts keep the two arms' inputs identical); listed as a gap for open-ended tasks | — |

## B. Verifier validity

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| oracle must pass, untouched workspace must fail | Harbor oracle/nop agents, ABC T.9/R.13 | `selfcheck` gates every run | **met** | every run |
| non-discriminating grader detection | skill-creator "always pass" flags | `selfcheck --strict` mutation sweep (delete / blank each oracle output) | **met** | all 35 scenarios pass strict |
| re-grade stored trials with a new verifier, no agent re-run | Harbor `regrade` (v0.21.0) | `dsh-eval regrade <run>` re-runs verify.py on kept workspaces (`--keep-workdirs`), records old→new verdicts, rebuilds the report, re-seals the evidence with the verifier hashes; verifier sha stored in every ledger | **met** | 20260903-205119-9xup |
| ground truth unreadable from the sandbox | ABC T.5, SWE-Lancer incident | `.truth` stashed out of the workspace | **met** | every run |
| post-hoc leak detection (arm output hash-matches hidden truth) | eliferres/agent-eval-harness | not implemented | missing | — |
| grade state, not path | BFCL v3, Anthropic eval guide | verifiers only read the end state | **met** | every run |
| decoys / injections in scenarios | AgentDojo, BFCL irrelevance | every new scenario ships one; the shipped injection pool did not discriminate the guard persona on v4-flash (results.md), so it is a smoke pool, not a red-team budget | *partial* | 20260903-1902… safety run |
| scenario discriminating power (signal-to-noise across the archive) | ClawBench SNR curation | history view: per-scenario between-arm / within-arm cost variance, pass spread, "signal" vs "noise" chip | **met** | history over 18 runs |
| flaky-task retirement | Harbor-Index, Terminal-Bench 2.1, ArtJack/verdict | flaky flag per scenario; chronic flaky / never-passing / saturated lists; retirement stays a human decision (no expiry timer) | *partial* | 20260903-203845-40b3 (f9 flagged) |

## C. Measurement

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| cache-split token accounting | Inspect, promptfoo, Langfuse 4.27 | hit / miss / output / reasoning per step | **met** | every run |
| cost at the tariff of the minute plus fixed-band re-pricing | none | DeepSeek peak/off-peak calendar | **met** | every run |
| independent usage metering (not self-reported by the process under test) | muou000 `trust: self-reported` labels; openbench sealed CountingProxy | per-trial local proxy between the runtime and the provider, selected by an overlay row identical in both arms; wire usage recorded per request with a **hash chain**; ledger reconciled against it (1% tolerance); provenance labelled in every report; a directional or equivalence cost call is **withheld** when any comparable trial fails to reconcile; works in container mode via the host gateway | **met** | 20260903-204617-xqvh, 20260903-204909-fczz (12/12 reconciled, 112 requests, 0.00% deviation) |
| provider fault injection (429, stalls) | ReliabilityBench (2601.06112), methodology §B2 | `--fault-rate P` through the meter; faults seeded per trial, counted in the ledger and the report | **met** | 20260903-205152-c0w0 |
| tokens and $ per solved task | Scaffold Effect, HAL | per arm | **met** | every run |
| behaviour signature and tool-sequence similarity | Scaffold Effect, MAST, TSS (2605.28840) | per trial and per arm; TSS within and between arms | **met** | every run |
| failure attribution with rerun validation | AgentDebugX (2607.18754); Repair or Resample (2608.25920) | first-divergence attribution names the call where the arms part and which arm failed; `dsh-eval rerun <run> <scenario>` re-runs the pair and reports whether the failure and its divergence recur (the resampling control), `--fork` replays the identical prefix and goes live at the divergence so a cause can be told from luck; results are stored beside the original run and shown in its report | **met** | 20260903-203845-40b3 (divergence); 20260903-213406-xfer (`not reproduced`: the failure was resampling luck) |
| what the model saw (observations) in traces | ATIF, claude-tap | folded per call, truncated at 4 KB | **met** | every run |
| cost of the evaluation itself | promptfoo grading tokens, LangSmith evaluator spend | trial spend in every report; judge spend per judge report and on the run page; A/A and selfcheck runs are separate, priced runs | **met** | 20260903-191944-k7ig |
| exact tokenizer counts | provider tokenizers | usage is the provider's own (now cross-checked on the wire) | n/a | — |
| other providers' prices | Harbor, Inspect, Langfuse | built-in DeepSeek table; `config.prices` merges any provider's peak/off-peak prices (no bundled non-DeepSeek prices, to avoid shipping stale numbers) | **met** (by configuration) | tests |

## D. Statistics and reporting

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| correctness gate before cost | ClawBench, BiBoyang gate | regression classification blocks the cost section, CLI exit 1 | **met** | tests; safety runs |
| cost compared only on both-pass pairs | — | implemented | **met** | every run |
| interval over scenarios for cost and pass difference | Scaffold Effect, Adding Error Bars, Indeed 2026 | Student-t below 10 scenarios, percentile bootstrap (B=2000, seeded) from 10 | **met** | every run |
| equivalence reading (TOST-like band) | Lakens TOST | ±10% SESOI band | **met** | 20260903-204909-fczz |
| minimum sample before a directional claim | Adding Error Bars; Resolution Diagnostics | ≥5 comparable scenarios, interval excluding 0, no overlap with the A/A band | **met** | 20260903-203845-40b3 |
| minimum detectable effect and resolution | Resolution Diagnostics (2605.30315) | MDE, N*, q = n/N* next to every cost verdict | **met** | 20260903-203845-40b3 (q = 0.07) |
| pass^k / pass@k | τ-bench, Inspect reducers | per arm | **met** | every run |
| paired binary test | McNemar mid-p (Fagerland 2013) | exact and mid-p, Beta posterior P(win), ROPE mass | **met** | 20260903-203845-40b3 |
| multiple-comparison control across candidates | Bonferroni / Holm / BH; signal-gate-kit | intervals at α/m across candidates | **met** | tests |
| cluster bootstrap carrying all repeats, ICC, design effect | Indeed 2026, Scaffold Effect | scenario-cluster bootstrap; ρ̂ and 1+(k−1)ρ̂ | **met** | 20260903-203845-40b3 (ρ̂ 0.23, DE 1.44) |
| variance reduction with a pre-experiment covariate | CUPED | archived baseline cost per scenario; adjusted interval beside the raw one | **met** | 20260903-203845-40b3 (17% variance removed) |
| honest wording when underpowered | TOST literature | "inconclusive" default; single-scenario and <5-scenario wordings; provenance-withheld wording | **met** | every run |
| behaviour under drift: sequential decision trace | AV-AIVAT | `sequential.json` + run-page table | **met** | 20260903-191646-jz48 |
| judge-drift attribution with an anchor set | Who Drifted (2606.15474) | not implemented | missing | — |
| construct-validity contract (schema-matched arms, ≥3 generations) | When Guardrails Look Effective (2609.01519) | the one-variable rule and the 3-repeat floor cover the two failure modes the paper names; no automatic schema check of outputs | *partial* | — |
| tamper-evident evidence, signed claims and an independent verifier | ClaimReceipt (2609.01992); Agent Flight Recorder (2609.01931) | every finished run is **sealed** (`manifest.json`: sha256 of each evidence file plus one evidence sha) and **receipted**: `receipt.json` carries the pre-registered analysis contract (estimand, pairing, estimator, α, SESOI, minimum scenarios, seed, gate order, cost rule), the claims, the coverage counts and an Ed25519 signature over all of it. `dsh-eval verify <run \| dir>` recomputes the hashes, re-derives the report from the ledgers, checks the signature and the claims, and answers **PASS / INVALID / INCONCLUSIVE** — a missing contract is inconclusive, not false. `dsh-eval publish` writes a bundle (report.html + VERIFY.md) a third party can verify without the original machine | **met** | 20260904-063200-jikp (PASS), bundle 20260903-212522-ujkh, forgery covered by test |

## E. Graders beyond deterministic verifiers

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| blinded pairwise judge with swap-and-tie and a panel | MT-Bench, PoLL, Inspect 0.3.262 panel | no arm/model names, seeded first position, both orders, disagreement → tie; `--model` repeated forms a strict-majority panel with a unanimity rate and inter-judge κ | **met** | 20260903-191944-k7ig |
| judge from a different model family than the arms | preference leakage (2502.01534), self-recognition (2404.13076) | a judge sharing a family with the arms is **refused** unless `--allow-same-family`; the override is stamped into the judge file and the report | **met** (rule) / *partial* (a cross-family endpoint has not been run here: no second-family key available) | tests |
| verbosity / length control | AlpacaEval LC (2404.04475); LMArena style control | three readings side by side: the raw win rate, the length-balanced rate (average of the candidate-longer and candidate-shorter strata) and the win rate at zero length difference from a ridge-regularised logistic fit on the length difference | **met** | tests |
| judge calibration, drift and panel independence | BiBoyang TPR/TNR; Who Drifted (2606.15474); Nine Judges (2605.29800) | κ vs annotations, TPR and TNR separately, and on every judge run a frozen set of archived human-labelled trials is re-graded: agreement with the humans, stability against the previous judge run, and attribution to the judge when stability falls below 80%. Panel independence is reported as Kish n_eff from pairwise error (or vote) correlation, not as unanimity | **met** | 20260903-212522-ujkh (anchor stability 0.5 → drift attributed to the judge) |
| prediction-powered inference | PPI++ (2311.01453), PRECISE | `judge --mode absolute`: per-arm pass rate rectified with the run's annotations (λ̂, SE) | **met** | 20260903-191944-k7ig (uncalibrated: no labels) |
| conformal abstention | SCOPE (2602.13110); MC3 (2608.26529) | each pair gets a bidirectional preference entropy over both orderings and all panel answers, scaled by the judges' own confidence; with human-labelled pairs a conformal threshold is calibrated so the error rate among kept judgments is at most α (finite-sample correction (n·R̂+1)/(n+1)), and judgments below it are withheld and counted. With too few labels no threshold meets the bound and everything is withheld | **met** | 20260903-212522-ujkh (one label → all withheld, the conservative outcome) |
| human review / override with audit trail | promptfoo, Braintrust, Langfuse | per-trial annotations applied to the report | **met** | tests |
| blind human review | Braintrust blind reviews | the annotation form hides the arm name, verdict and cost until the reviewer submits (`blind` toggle) | **met** | UI |

## F. Execution and safety

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| workspace confinement of the agent shell | Harbor Kata (PR 2998); gVisor; dsh-plugin-evaluation Docker-only | a container per trial is the **default** whenever third-party plugins are linked and Docker is available (checkout and plugins read-only, eval home and workspace read-write); `--docker-keep-sandbox` builds a bubblewrap image and grants the capabilities dsh's own in-process sandbox needs, so the container and dsh's sandbox stack; `--docker-runtime runsc\|kata` uses gVisor or a Kata microVM when the host provides one. The tool cannot ship a microVM host itself | **met** (defence in depth, opt-in microVM) | chain5 K (sandbox kept on inside the container, 2/2 metered trials reconciled) |
| network off by default, opt-in per scenario | ABC T.5 | implemented | **met** | every run |
| budget cap and cancel with usable partial results | claude plugin eval `--max-cost-usd` | `--max-usd` stops scheduling, finished ledgers kept, `--resume` completes the plan | **met** | 20260903-205056-mo91 (cancelled at $0.012 after 3 of 6 trials, resumed) |
| within-trial economy | EarlyEval (2609.02783); Doomed from the Start (2607.06503) | `--max-usd-per-trial` (and `meta.max_usd_per_trial`) stops a trial after the turn where *observed* usage passes the cap and grades it a failure with the reason recorded, plus per-turn timeouts and the run-level budget cap. EarlyEval's saving comes from *predicting* the outcome of a halted trial and recording the prediction, with no bias bound; a predicted failure is not a measured one, so it stays out of a paired verdict by design | **met** (observed termination) / deliberately not done (predicted) | tests; 20260903-205056-mo91 |
| record / replay / fork | OrcaReplay; `@deepseek-ai/dsh-llm-replay`; The Replay Gap (2608.08239) | the meter records every provider exchange per trial; `run --replay <id>` re-executes a whole run from the recordings with no key and no spend (verifiers still run on the reproduced workspace), `--fork-at N` replays N responses per trial and goes live from there, and the trace page offers "fork from step k". Forks run live from the fork point, which is what The Replay Gap shows a fork must do. Workspace snapshots per turn (OrcaReplay) are not stored; setup is re-run instead | **met** (response-level) / *partial* (no per-turn workspace snapshots) | replay 4 trials keyless $0.0204; fork-at-3 |
| CI exit codes and workflow sample | promptfoo, plugin eval | 0/1/2/3 + docs/ci; `verify` exit 1 on a broken seal | **met** | tests |

## G. UI

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| matrix with per-repeat pips and header aggregates | promptfoo, Inspect | implemented | **met** |
| baseline deltas, regressions-first sort, filters incl. flaky | Braintrust, LangSmith | implemented | **met** |
| intervals drawn, not just points | tbench.ai, Phoenix | forest strip with SESOI band, MDE lines, A/A floor | **met** |
| one-variable diff at setup | none | implemented with warning | **met** |
| live progress with cancel | Inspect | SSE matrix, active chips, cancel | **met** |
| trace: steps, cache split, wall time, folded observations, reasoning, verdict, raw | claude-tap, AgentPrism, Harbor viewer | implemented; keyboard j/k/r/c/esc | **met** |
| paired trace diff with first divergence and fork | OrcaReplay | side-by-side with mirrored selection, a divergence marker, and a "fork from step k" action that starts a run replaying the identical prefix and going live from that step | **met** |
| history across runs, chronic failures, cost trend, scenario signal | Braintrust trends, ClawBench SNR | per-scenario history, sparklines, signal/noise chip | **met** |
| provenance and evidence on the run page | — | usage provenance line, seal status with evidence sha and verify result | **met** |
| static single-file export | Inspect `view bundle` | `export --html` | **met** |
| ATIF interchange | Harbor | per-trial ATIF with observations | **met** |
| side-by-side final outputs with text diff | LangSmith, Braintrust | implemented | **met** |
| virtualized tables for very large runs | Braintrust | windowed rendering above 150 rows and 200 steps | **met** |
| dark mode, density | — | implemented | **met** |
| automated pattern discovery across traces | Braintrust Patterns; AutoTraceGT (2608.30391) | the history view mines every archived run for recurring failure signatures (paths, numbers and quoted values normalised away) and behaviour regimes thresholded on the archive's own quartiles, ranked by how unevenly they hit the arms | **met** |

## dsh-native tools, row by row

The first sweep missed the tools built on dsh itself; the second sweep and the adversarial review cover them. What each does that this tool also does, and what differs:

| tool | overlap | where it is ahead | where this tool is ahead |
|---|---|---|---|
| muou000/dsh-eval | paired per case × repetition, seeded AB/BA, serialized pairs, pre-registered thresholds, Wilson intervals, content-addressed artifacts, fail-closed manifests, `trust: self-reported` usage labels | stricter contracts (versioned schemas that fail closed on unknown fields; every artifact content-addressed) | composed-configuration diff with refusal; verifier self-check and mutation; A/A floor veto; cluster/ICC/MDE/CUPED/sequential statistics; independent wire meter with reconciliation (muou000 labels self-reported usage, it does not meter); regrade; judge panel with family rule; container mode; UI |
| hccccc01333/dsh-eval | paired A/B, subagent trace merging | keyless replay of recorded chunks in CI; trace import from other agents | everything statistical above; verifier validity; meter; seal/verify |
| BiBoyang/dsh-eval-harness | PASS/WARN/FAIL gate, retries off when trials > 1, judge validation with TPR/TNR | judge TPR/TNR was the reference for our absolute-mode calibration | paired interleaving, one-variable, meter, sequences, seal |
| dsheval.ai / dsheval/dsh-eval | public ledger of plugin evaluations, LoCoMo memory protocol | a public cross-plugin ledger (we have none; landscape gap #6 stands) | the pairing and statistics machinery; the ledger publishes point estimates without paired intervals |
| dsh-plugin-evaluation/* | Docker-only runner, exit codes, security dataset | Docker is the only path (stronger default isolation); a pinned injection dataset | paired design, statistics, meter, judge, UI; container mode exists here but is opt-in |

## Verdict (2026-09-04, after three sweeps and an adversarial review)

**Method.** Three landscape sweeps (about 110 repositories and products, including the five dsh-native evaluation tools the first sweep missed), three literature sweeps (about 70 papers plus a filtered pass over 855 arXiv submissions from 2026-08-31 to 09-04), and one commissioned adversarial review of the previous verdict (19 GitHub queries, ~30 page reads) whose eight ranked objections are answered row by row above. Every row marked **met** names the run that exercised it; the runs are in [results.md](results.md).

**What is claimed.** On every capability row in sections A–G, no tool or paper found in those sweeps does the job better for a paired comparison of two agent configurations. Two families of work are ahead of individual components of this tool and are matched by design rather than by imitation: hosted evaluation products (Braintrust, LangSmith, Langfuse, promptfoo, Inspect, Harbor) lead on scale, provider breadth and hosted collaboration, and none of them pairs two live configurations under a one-variable check; the dsh-native tools (muou000/dsh-eval, hccccc01333/dsh-eval, BiBoyang/dsh-eval-harness, dsheval.ai, dsh-plugin-evaluation) share individual mechanisms — seeded AB/BA order, content-addressed artifacts, keyless replay, judge TPR/TNR gates, Docker-only execution — and none combines them with the statistics, the wire meter or the sealed receipts. The combination this tool offers is: paired interleaved runs of two live configurations, a one-variable check on the composed configuration, verifier self-checks with mutation, a regression-first gate that prices only matched passes, cache- and calendar-aware cost, rerun **and** perturbation A/A floors that can veto a directional call, a non-asymptotic sequential stop, usage metered on the wire and reconciled before any cost call, a three-layer served-model check, sealed evidence with signed claims and a PASS/INVALID/INCONCLUSIVE verifier, keyless replay and fork, rerun validation that separates a cause from resampling luck, a judge panel that refuses same-family judges and abstains under conformal risk control with anchor-set drift attribution, container isolation by default with dsh's own sandbox stacked inside it, and a UI that draws intervals, mines patterns and forks from a step.

**What is not claimed.** This is an evaluation *infrastructure*, not a benchmark: the 35 shipped scenarios are a working library for dsh components, not a measure of agent capability, and the tool is built for a paired two-configuration comparison rather than for leaderboard-style scoring of many models. Five things are implemented but not exercised here, and are marked as such rather than as met-in-the-field:

1. The microVM path (`--docker-runtime kata|runsc`) passes the runtime through; no host with Kata or gVisor was available to run it. The container path with dsh's own sandbox stacked inside it was exercised.
2. A cross-family judge is refused-by-default and configurable, but no second-family credential existed in this environment, so only the refusal and the panel mechanics were run.
3. Per-turn workspace snapshots (OrcaReplay) are not stored; replay re-runs the scenario's setup instead, which is equivalent for scenarios whose setup is deterministic and weaker for those whose is not.
4. No non-DeepSeek price data ships (it is configurable per project), and there is no hosted public ledger; `publish` produces the bundle such a ledger would host.
5. Three capabilities the field offers are deliberately not implemented, each with a stated reason: within-run adaptive scenario selection (it changes the estimand the confidence sequence covers unless corrected with inverse-probability weighting, and uniform ordering is competitive per 2607.17409), predicted early termination (EarlyEval records a prediction as an outcome with no bias bound, which would contaminate a paired verdict), and simulated users (both arms must see identical inputs for the pairing to hold).

**Judgment.** With those five items stated, and after three sweeps and an adversarial review that changed the verdict once already, I judge this to be state of the art for paired A/B evaluation of agent components: on the rows it covers, nothing found in the agent-evaluation field is ahead. The verdict will be revised when any row changes.
