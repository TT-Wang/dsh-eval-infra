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
| served-model verification | AgentProv (2609.00052) | the meter records the model id and system fingerprint of every provider response; a report reads nothing when a response reports a different model than requested or the arms were served different models. This checks what the provider *declares*; behavioural fingerprinting of a substituted model (AgentProv) is not done | *partial* (declared-model check met; behavioural fingerprint missing) | 20260903-210317-otgh |
| sequential / adaptive stopping, valid at every look | AV-AIVAT (2608.06362), betting CS (2010.09686), asymptotic CS (2103.06476) | `--sequential`: the deciding cost sequence is a **hedged betting confidence sequence** (non-asymptotic) on the paired cost ratio winsorized at 2×; the asymptotic sequence is reported for screening only; betting sequence on the pass difference; stop once decided; the final report reads the sequence, not the bootstrap | **met** | 20260903-191646-jz48 (undecided after 6 scenarios: betting ratio interval 0.64–1.48 while the asymptotic Δ% interval was −5.5% to +24.8%; see results.md) |
| active / surrogate-guided scenario selection | CELEUS (2606.20820), 2607.17409 | `--order signal`: sequential order by archive signal-to-noise, strongest first, fixed before the run's data exists (a predictable ordering, not an adaptive surrogate) | *partial* (informed ordering met; adaptive selection missing) | 20260903-210317-otgh |
| holdout / sealed pools with a dev–sealed gap | AI Agents That Matter; Selection-Aware Stress Testing (2608.30916) | `meta.holdout` scenarios excluded unless `--include-holdout`; dev vs sealed Δpass and gap warning in the report | **met** | 20260903-204909-fczz |
| discovery / confirmation split | 2608.30916 | confirmation rule: a dev-pool pass direction of ≥10 pp that reverses on ≥3 sealed scenarios is declined (grade inconclusive, verdict says why); no joint bounds across planned claims | **met** (rule) / *partial* (joint bounds) | 20260903-210653-2m6a (armed, not triggered; trigger covered by test) |
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
| failure attribution with rerun validation | AgentDebugX, ClawBench regimes | first-divergence attribution: for a pair where one arm failed, the report names the first tool call where the sequences part and which arm failed; no automatic rerun validation of a hypothesised cause | *partial* | 20260903-203845-40b3 (`fold diverges at call 1 (bash vs todo_write)`) |
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
| tamper-evident evidence and an independent report check | ClaimReceipt (2609.01992), muou000 content-addressed artifacts, Harbor lockfiles | every finished run is **sealed**: `manifest.json` hashes every evidence file into one evidence sha; `dsh-eval verify <run>` recomputes the hashes and re-derives the report from the sealed ledgers, failing on any changed, missing or non-reproducing item; regrades are recorded in the seal | **met** | 20260903-204909-fczz, 20260903-205119-9xup (tamper detection covered by test) |

## E. Graders beyond deterministic verifiers

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| blinded pairwise judge with swap-and-tie and a panel | MT-Bench, PoLL, Inspect 0.3.262 panel | no arm/model names, seeded first position, both orders, disagreement → tie; `--model` repeated forms a strict-majority panel with a unanimity rate and inter-judge κ | **met** | 20260903-191944-k7ig |
| judge from a different model family than the arms | preference leakage (2502.01534), self-recognition (2404.13076) | a judge sharing a family with the arms is **refused** unless `--allow-same-family`; the override is stamped into the judge file and the report | **met** (rule) / *partial* (a cross-family endpoint has not been run here: no second-family key available) | tests |
| verbosity / length control | AlpacaEval LC | share of decided pairs won by the longer submission reported next to the verdict | *partial* (diagnostic, not a correction) | tests |
| judge calibration against humans | BiBoyang TPR/TNR; κ | κ vs annotations (pairwise); TPR and TNR separately (absolute mode) | **met** | tests (no human labels on real runs yet) |
| prediction-powered inference | PPI++ (2311.01453), PRECISE | `judge --mode absolute`: per-arm pass rate rectified with the run's annotations (λ̂, SE) | **met** | 20260903-191944-k7ig (uncalibrated: no labels) |
| conformal abstention | SCOPE (2602.13110) | not implemented (order disagreement is the only abstention) | missing | — |
| human review / override with audit trail | promptfoo, Braintrust, Langfuse | per-trial annotations applied to the report | **met** | tests |
| blind human review | Braintrust blind reviews | the annotation form hides the arm name, verdict and cost until the reviewer submits (`blind` toggle) | **met** | UI |

## F. Execution and safety

| capability | best reference | dsh-eval-infra | status | exercised |
|---|---|---|---|---|
| workspace confinement of the agent shell | Harbor Kata microVM, dsh-plugin-evaluation Docker-only | host mode: dsh workspace-write sandbox, escape-probed (dsh's SAFETY.md says this is not a security boundary for untrusted workloads); `--sandbox docker`: one container per trial, checkout and plugins ro, eval home and workspace rw, plain bash inside (dsh's in-process sandbox needs Landlock/bwrap the stock Docker kernel lacks); no microVM | *partial* (container yes, microVM no; the container path is the recommendation for third-party plugins) | 20260903-19… docker-check-3 |
| network off by default, opt-in per scenario | ABC T.5 | implemented | **met** | every run |
| budget cap and cancel with usable partial results | claude plugin eval `--max-cost-usd` | `--max-usd` stops scheduling, finished ledgers kept, `--resume` completes the plan | **met** | 20260903-205056-mo91 (cancelled at $0.012 after 3 of 6 trials, resumed) |
| within-trial early termination | EarlyEval (2609.02783) | not implemented | missing | — |
| record / replay / fork | OrcaReplay, dsh-llm-replay | not implemented; events are stored, not replayable | missing | — |
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
| paired trace diff with first divergence | OrcaReplay | side-by-side with mirrored selection and divergence marker (no fork-from-step) | **met** (diff) / missing (fork) |
| history across runs, chronic failures, cost trend, scenario signal | Braintrust trends, ClawBench SNR | per-scenario history, sparklines, signal/noise chip | **met** |
| provenance and evidence on the run page | — | usage provenance line, seal status with evidence sha and verify result | **met** |
| static single-file export | Inspect `view bundle` | `export --html` | **met** |
| ATIF interchange | Harbor | per-trial ATIF with observations | **met** |
| side-by-side final outputs with text diff | LangSmith, Braintrust | implemented | **met** |
| virtualized tables for very large runs | Braintrust | windowed rendering above 150 rows and 200 steps | **met** |
| dark mode, density | — | implemented | **met** |
| automated pattern discovery across traces | Braintrust Patterns | not implemented | missing |

## dsh-native tools, row by row

The first sweep missed the tools built on dsh itself; the second sweep and the adversarial review cover them. What each does that this tool also does, and what differs:

| tool | overlap | where it is ahead | where this tool is ahead |
|---|---|---|---|
| muou000/dsh-eval | paired per case × repetition, seeded AB/BA, serialized pairs, pre-registered thresholds, Wilson intervals, content-addressed artifacts, fail-closed manifests, `trust: self-reported` usage labels | stricter contracts (versioned schemas that fail closed on unknown fields; every artifact content-addressed) | composed-configuration diff with refusal; verifier self-check and mutation; A/A floor veto; cluster/ICC/MDE/CUPED/sequential statistics; independent wire meter with reconciliation (muou000 labels self-reported usage, it does not meter); regrade; judge panel with family rule; container mode; UI |
| hccccc01333/dsh-eval | paired A/B, subagent trace merging | keyless replay of recorded chunks in CI; trace import from other agents | everything statistical above; verifier validity; meter; seal/verify |
| BiBoyang/dsh-eval-harness | PASS/WARN/FAIL gate, retries off when trials > 1, judge validation with TPR/TNR | judge TPR/TNR was the reference for our absolute-mode calibration | paired interleaving, one-variable, meter, sequences, seal |
| dsheval.ai / dsheval/dsh-eval | public ledger of plugin evaluations, LoCoMo memory protocol | a public cross-plugin ledger (we have none; landscape gap #6 stands) | the pairing and statistics machinery; the ledger publishes point estimates without paired intervals |
| dsh-plugin-evaluation/* | Docker-only runner, exit codes, security dataset | Docker is the only path (stronger default isolation); a pinned injection dataset | paired design, statistics, meter, judge, UI; container mode exists here but is opt-in |

## Verdict (2026-09-04, after the adversarial review)

Method: two landscape sweeps (about 110 repositories and products including the dsh-native tools), two literature sweeps (about 70 papers through arXiv 2609.02783), an independent adversarial review of the previous verdict with 19 GitHub queries and 30 page reads, then implementation of the objections that could be answered in the tool (finite-sample sequence, wire meter with provenance gating, fault injection, sealed evidence with `verify`, regrade, judge family rule, TPR/TNR, length share, inter-judge κ, scenario signal, blind review, three-repeat and holdout and budget/resume runs), each exercised on a real run.

**What can be claimed.** For paired evaluation of a dsh component change, this tool's *combination* is not offered by any surveyed tool: paired interleaved runs of two live configurations, a one-variable check on the composed configuration, verifier self-checks with mutation, a regression-first gate that prices only matched passes, cache- and calendar-aware cost, rerun and perturbation A/A floors that can veto a directional call, a non-asymptotic sequential stop with signal-informed order, usage that is metered on the wire and reconciled before any cost call, a served-model check, sealed evidence with an independent report check, regrade without agent re-runs, a confirmation rule on sealed pools, a blinded swap-and-tie panel that refuses same-family judges, human overrides with blind review, a paired trace diff with divergence attribution, CI exit codes and a self-contained export. On the rows marked **met** above, no surveyed tool or method is ahead.

**What cannot be claimed, stated plainly.** "Ahead on every row" was the previous verdict and the review showed it false; it is withdrawn. The rows where the field is ahead today, and that this tool does not close:

1. Isolation: Harbor's microVM path and dsh-plugin-evaluation's Docker-only default are stronger than our opt-in container mode, and dsh's in-process sandbox is off inside our containers.
2. Judge machinery: no conformal abstention, no anchor-set drift attribution, length share is a diagnostic not a correction, and the cross-family rule has only been exercised structurally (no second-family key here).
3. Scenario science: served-model verification reads what the provider declares, not behavioural fingerprints; scenario ordering is informed, not adaptive; the confirmation rule has no joint bounds across planned claims; failure attribution names the divergence point without rerun validation; no simulated user (scripted prompts are the design choice that keeps the arms' inputs identical).
4. Replay and within-trial economy: no record/replay/fork, no early termination inside a trial (predicting an outcome instead of observing it would bias a paired verdict, so the budget cap and per-turn timeouts bound spend instead).
5. Breadth: no bundled non-DeepSeek prices (configurable); a 35-scenario library, not a benchmark; no public ledger.

The judgment this file supports is therefore narrow: **state of the art as a paired A/B evaluation infrastructure for dsh components on the rows it covers, with the five gaps above open.** It is not a claim of leading the agent-evaluation field as a whole. The verdict will be revised when any row changes.
