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
| sequential / adaptive repeats (stop when decided) | anytime-valid A/B literature | not implemented | missing |
| holdout / sealed scenario pools with a dev–sealed gap | AI Agents That Matter, ARC | not implemented (pools exist, no sealed flag) | missing |

## B. Verifier validity

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| oracle must pass, untouched workspace must fail | Harbor oracle/nop agents, ABC T.9/R.13 | `selfcheck` gates every run | **met** |
| non-discriminating grader detection | skill-creator "always pass" flags | `selfcheck --strict` mutation sweep (delete / blank each oracle output) | **met** |
| ground truth unreadable from the sandbox | ABC T.5, SWE-Lancer incident | `.truth` stashed out of the workspace | **met** |
| grade state, not path | BFCL v3, Anthropic eval guide | verifiers only read the end state | **met** |
| decoys / injections in scenarios | AgentDojo, BFCL irrelevance | every new scenario ships one | **met** |
| task validation across trials (flaky-task retirement) | Harbor-Index, Terminal-Bench 2.1 | flaky flag per scenario and history view; no automatic retirement | *partial* |

## C. Measurement

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| cache-split token accounting | Inspect ModelUsage, promptfoo TokenUsage | hit / miss / output / reasoning per step | **met** |
| cost at the tariff of the minute plus fixed-band re-pricing | none | DeepSeek peak/off-peak calendar | **met** |
| tokens and $ per solved task | Scaffold Effect, HAL | per arm | **met** |
| behaviour signature (tool errors, repeats, no-action, observation volume, compactions) | Scaffold Effect failure fingerprints, MAST | per trial and per arm | **met** |
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
| minimum sample before a directional claim | Adding Error Bars power analysis | ≥3 comparable scenarios | **met** |
| minimum detectable effect reported | Adding Error Bars | MDE from observed spread, in notes and forest strip | **met** |
| pass^k / pass@k | τ-bench, Inspect reducers | per arm | **met** |
| paired binary test | McNemar / sign test | exact sign test on discordant pairs | **met** |
| multiple-comparison control across candidates and categories | Holm / BH | not implemented | missing |
| hierarchical bootstrap (scenarios and repeats) | Scaffold Effects on GAIA | scenarios only | *partial* |
| Bayesian pass-rate difference with ROPE | — | not implemented | missing |
| one-word grade (improvement / regression / tradeoff / tie) | Braintrust comparison grade | implemented | **met** |
| honest wording when underpowered | TOST literature | "inconclusive" default; single-scenario and <3-scenario wordings | **met** |

## E. Graders beyond deterministic verifiers

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| blinded LLM judge with swap-and-tie, panel, calibration | MT-Bench, position-bias study, PoLL | not implemented | missing |
| prediction-powered inference (judge + human labels) | PPI / PPI++ | not implemented | missing |
| human review / override with audit trail | promptfoo, Braintrust, Langfuse annotation | per-trial annotations, applied to the report | **met** |

## F. Execution and safety

| capability | best reference | dsh-eval-infra | status |
|---|---|---|---|
| workspace confinement of agent shell | Harbor / Inspect containers | dsh workspace-write sandbox (Seatbelt / bwrap / Landlock), escape-probed | *partial* (same-world, not a container) |
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
| trace: steps, tokens with cache split, folded observations, reasoning, verdict, raw | claude-tap, AgentPrism, Harbor viewer | implemented, keyboard j/k/r/c/esc | **met** |
| paired trace diff with first divergence | OrcaReplay | side-by-side with mirrored selection and divergence marker | **met** |
| history across runs, chronic failures, cost trend | Braintrust trends | per-scenario history with pass/fail and cost sparklines | **met** |
| static single-file export | Inspect `view bundle`, claude-tap | `export --html` | **met** |
| ATIF interchange | Harbor | per-trial ATIF with observations | **met** |
| side-by-side final outputs with text diff | LangSmith Diff, Braintrust | not implemented (final assistant text is in the trace, no diff view) | missing |
| virtualized tables for very large runs | Braintrust "10x faster" | plain tables | *partial* |
| dark mode, density | — | dark via prefers-color-scheme; no density toggle | *partial* |

## Verdict (to be revised after each iteration)

Not yet claimed. Open rows that block the claim: sequential repeats, sealed pools, multiple-comparison control, hierarchical bootstrap, blinded judge, output diff view. Rows marked n/a or same-world sandbox are documented limitations, not blockers, as long as they are stated plainly in the README.
