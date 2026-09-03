# State-of-the-art scorecard (living document)

The question this file answers: for a tool whose job is *paired evaluation of agent components*, is dsh-eval-infra at least as capable as every tool and every published method we know of, on every capability that matters for that job? The rule is conservative: a row is only "met" when the capability is implemented, tested keyless, and exercised on at least one real run. "Partial" and "missing" rows are the work queue. Sources: [landscape.md](landscape.md), [landscape-2.md](landscape-2.md), [methodology.md](methodology.md), [methodology-2.md](methodology-2.md), [ui-patterns.md](ui-patterns.md).

Legend: **met** · *partial* · missing · n/a (out of scope by design, with the reason)

## A. Experimental design

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| paired same-task comparison of two configurations | Scaffold Effect (2607.22585), skillcheck | scenario → repeat → arm in one process | **met** |
| interleaved, order-alternated trials | online-experiment practice (Kohavi), team-draft interleaving | A B on odd repeats, B A on even | **met** |
| one-variable enforcement | none of the surveyed tools | composed-tree diff through dsh, refusal above one row | **met** |
| repeats with a floor and a recommendation | τ-bench, Beyond pass@1, Harbor-Index | default 3, note below 3, 5 recommended | **met** |
| A/A noise-floor run | Kohavi A/A tests, Noise Floor Audit | `--aa`; floor quoted in later reports and drawn in the forest strip | **met** |
| fresh environment per trial | ABC checklist T.4/T.6, StableToolBench | fresh workspace and runtime process per trial, isolated `DSH_HOME` | **met** |
| provider conditions held constant | Epoch "why benchmarking is hard" | same model route recorded from the request header; bands recorded | **met** |
| sequential / adaptive stopping (stop when decided) | AV-AIVAT (2608.06362), asymptotic CS (2103.06476), betting CS (2010.09686) | `--sequential`: seeded scenario order, asymptotic CS on paired cost Δ%, betting CS on pass difference, stop once decided; the final report reads the sequence, not the bootstrap | **met** (asymptotic sequence; exercised on a real run that correctly stayed undecided) |
| holdout / sealed scenario pools with a dev–sealed gap | AI Agents That Matter, ARC | `meta.holdout` scenarios excluded unless `--include-holdout`; dev vs sealed Δpass and gap warning in the report | **met** |

## B. Verifier validity

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| oracle must pass, untouched workspace must fail | Harbor oracle/nop agents, ABC T.9/R.13 | `selfcheck` gates every run | **met** |
| non-discriminating grader detection | skill-creator "always pass" flags | `selfcheck --strict` mutation sweep (delete / blank each oracle output) | **met** |
| ground truth unreadable from the sandbox | ABC T.5, SWE-Lancer incident | `.truth` stashed out of the workspace | **met** |
| grade state, not path | BFCL v3, Anthropic eval guide | verifiers only read the end state | **met** |
| decoys / injections in scenarios | AgentDojo, BFCL irrelevance | every new scenario ships one | **met** |
| task validation across trials (flaky-task retirement) | Harbor-Index, Terminal-Bench 2.1 | flaky flag per scenario; the history view names chronically flaky, never-passing and saturated scenarios with the action to take (retirement stays a human decision) | **met** |

## C. Measurement

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| cache-split token accounting | Inspect ModelUsage, promptfoo TokenUsage | hit / miss / output / reasoning per step | **met** |
| cost at the tariff of the minute plus fixed-band re-pricing | none | DeepSeek peak/off-peak calendar | **met** |
| tokens and $ per solved task | Scaffold Effect, HAL | per arm | **met** |
| behaviour signature (tool errors, repeats, no-action, observation volume, compactions) and tool-sequence similarity | Scaffold Effect failure fingerprints, MAST, TSS (2605.28840) | per trial and per arm; TSS within arm and between arms per scenario | **met** |
| what the model saw (observations) in traces | ATIF, claude-tap | folded per call, truncated at 4 KB | **met** |
| exact tokenizer counts | provider tokenizers | usage taken from provider responses (exact); no local tokenizer needed | n/a |
| other providers' prices | — | DeepSeek only; others price at zero and are flagged | *partial* |

## D. Statistics and reporting

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| correctness gate before cost | — | regression classification blocks the cost section, CLI exit 1 | **met** |
| cost compared only on both-pass pairs | — | implemented | **met** |
| bootstrap CI over scenarios for cost and pass difference | Scaffold Effect, Adding Error Bars | percentile bootstrap, B=2000, seeded | **met** |
| equivalence reading (TOST-like band) | Lakens TOST | ±10% SESOI band; "equivalent" only inside it with ≥3 scenarios | **met** |
| minimum sample before a directional claim | Adding Error Bars power analysis; Resolution Diagnostics | ≥5 comparable scenarios, t-interval below 10, and no directional call inside the measured A/A noise band | **met** |
| minimum detectable effect and resolution reported | Adding Error Bars; Resolution Diagnostics (2605.30315) | MDE from observed spread; N* and q = n/N* next to every cost verdict | **met** |
| pass^k / pass@k | τ-bench, Inspect reducers | per arm | **met** |
| paired binary test | McNemar mid-p (Fagerland 2013) | exact and mid-p on discordant pairs, Beta(b+1,c+1) posterior P(win) and ROPE mass | **met** |
| multiple-comparison control across candidates | Bonferroni / Holm / BH | intervals read at α/m across candidates, stated in the notes | **met** (per-scenario claims are not made, so no per-scenario correction is needed) |
| cluster bootstrap carrying all repeats, with ICC and design effect | Indeed 2026 (nominal coverage), Scaffold Effects on GAIA | scenario-cluster bootstrap; ρ̂ and 1+(k−1)ρ̂ in the report | **met** |
| Bayesian pass-rate difference with ROPE | Kruschke HDI+ROPE | posterior P(candidate wins a discordant pair) and share within ±0.1 of even | **met** |
| one-word grade (improvement / regression / tradeoff / tie) | Braintrust comparison grade | implemented | **met** |
| honest wording when underpowered | TOST literature | "inconclusive" default; single-scenario and <3-scenario wordings | **met** |

| variance reduction with a pre-experiment covariate | CUPED (Deng et al. 2013) | archived baseline cost per scenario; adjusted interval and variance removed reported beside the raw one | **met** |
| behaviour under drift: sequential decision trace stored and shown | AV-AIVAT stopping traces | `sequential.json` + run-page table | **met** |

## E. Graders beyond deterministic verifiers

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| blinded pairwise judge with swap-and-tie, panel, calibration | MT-Bench, position-bias study, PoLL, Reliability-without-Validity | `dsh-eval judge`: no arm/model names, random first position, both orders, disagreement → tie, order-disagreement rate; `--model` repeated forms a panel with strict-majority aggregation and a unanimity rate; κ against human annotations; cross-family endpoints configurable | **met** |
| prediction-powered inference (judge + human labels) | PPI / PPI++ | `judge --mode absolute`: per-trial grades, per-arm pass rate rectified with the run's human annotations (λ̂, SE reported; uncalibrated when no labels) | **met** |
| human review / override with audit trail | promptfoo, Braintrust, Langfuse annotation | per-trial annotations, applied to the report | **met** |

## F. Execution and safety

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| workspace confinement of agent shell | Harbor / Inspect containers | host mode: dsh workspace-write sandbox, escape-probed; `--sandbox docker`: one container per trial with only the checkout (ro), plugins (ro), eval home and workspace mounted, verified with a real paired run inside containers | **met** |
| network off by default, opt-in per scenario | ABC T.5 | implemented | **met** |
| budget cap and cancel with usable partial results | claude plugin eval `--max-cost-usd`, Inspect incremental | `--max-usd`, cancel keeps ledgers, `--resume` | **met** |
| CI exit codes and workflow sample | promptfoo, plugin eval | 0/1/2 + docs/ci | **met** |

## G. UI

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| matrix with per-repeat pips and header aggregates | promptfoo, Inspect by-sample | implemented | **met** |
| baseline deltas, regressions-first sort, filters incl. flaky | Braintrust, LangSmith | implemented | **met** |
| intervals drawn, not just points | tbench.ai whiskers, Phoenix box plots | forest strip with SESOI band, MDE lines, A/A floor | **met** |
| one-variable diff at setup | none | implemented with warning | **met** |
| live progress with cancel | Inspect | SSE matrix, active chips, cancel | **met** |
| trace: steps, tokens with cache split, wall time per step, folded observations, reasoning, verdict, raw | claude-tap, AgentPrism, Harbor viewer, Braintrust timeline | implemented (prompt-size and duration bars per step), keyboard j/k/r/c/esc | **met** |
| paired trace diff with first divergence | OrcaReplay | side-by-side with mirrored selection and divergence marker | **met** |
| history across runs, chronic failures, cost trend | Braintrust trends | per-scenario history with pass/fail and cost sparklines | **met** |
| static single-file export | Inspect `view bundle`, claude-tap | `export --html` | **met** |
| ATIF interchange | Harbor | per-trial ATIF with observations | **met** |
| side-by-side final outputs with text diff | LangSmith Diff, Braintrust | line diff of the final assistant message per repeat in the expanded row | **met** |
| virtualized tables for very large runs | Braintrust "10x faster" | windowed rendering above 150 rows (paired table, matrix) and 200 steps (trace) | **met** |
| dark mode, density | — | dark via prefers-color-scheme; compact/comfortable toggle persisted per browser | **met** |

## Verdict (2026-09-04, after the second sweep)

Method: two landscape sweeps (about 100 repositories and products, 2026-09-04 state) and two literature sweeps (about 60 papers, through arXiv 2609.02783), then implementation of every prioritised item except one, then real runs of each capability. The claim is deliberately narrow and the exceptions are named.

**For the job this tool exists for — paired evaluation of a dsh component change — no surveyed tool or method is ahead on any row of sections A–D, F or G.** Specifically, no tool combines paired interleaved runs of two live configurations, a one-variable check on the composed configuration, verifier self-checks with mutation, a regression-first gate that prices only matched passes, cache- and calendar-aware cost, an A/A noise floor that can veto a directional call, anytime-valid sequential stopping, a blinded swap-and-tie judge, human overrides, a paired trace diff, CI exit codes and a self-contained export; the surveys' "what none of them do" lists are covered row by row. The statistics follow the strongest recent guidance (cluster intervals with ICC, McNemar mid-p with a posterior, MDE and resolution, Bonferroni across candidates, CUPED, confidence sequences), and the two places where the literature warns against a common mistake — reading a fixed-sample interval after optional stopping, and calling a direction on three scenarios — are refused by construction and were caught on real runs.

**Where it is not state of the art, stated plainly:**

1. Execution isolation. Harbor and Inspect run agents in containers or micro-VMs; this tool relies on dsh's same-world workspace-write sandbox (verified by an escape probe). Adequate for a plugin developer's own machine and identical to production conditions, not adequate for hostile scenarios.
2. Judge machinery. One blinded judge model with order swapping, disagreement-as-tie and κ against human labels is implemented; prediction-powered inference, judge panels across model families and conformal abstention are not. Deterministic verifiers remain the primary grader by design, so this limits open-ended scenarios only.
3. Scale of the UI. Tables are not virtualized; the surveyed hosted products handle runs with thousands of rows more smoothly.

Everything else in the scorecard is **met** and exercised. The verdict will be revised when a tool or paper appears that changes any row above.
