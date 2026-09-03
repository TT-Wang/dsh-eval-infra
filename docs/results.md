# Results log

Every entry is a real run through the dsh SDK runtime (deepseek-v4-flash, effort high, isolated eval home, network tools off). Ledgers for the runs below live in the project that produced them; the self-contained HTML of the last one is checked in under [examples/](examples/).

## 2026-09-04 · validation-1 · baseline vs `dsh-tool-result-fold`

Purpose: prove the whole pipeline on a known plugin. The fold plugin condenses large tool results in-turn; on shell-driven scenarios a capable agent already filters its own output, so the expected reading is "neutral, maybe cheaper on whole-file reads".

Setup: 4 scenarios (f1 log triage, f6 csv reconcile, f9 docs research, f10 db investigation) × 2 repeats × 2 arms = 16 trials, concurrency 2, 9.0 min, $0.19. One variable: `+ row tool-result-fold`.

| scenario | baseline pass | fold pass | class | cost pairs | Δ cost | Δ % | Δ steps | baseline spread |
|---|---|---|---|---|---|---|---|---|
| f1_log_triage | 2/2 | 2/2 | same | 2 | $0.0018 | +20.9% | +2.0 | 31% |
| f10_db_investigation | 2/2 | 2/2 | same | 2 | $0.0003 | +3.3% | +1.5 | 28% |
| f6_csv_reconcile | 2/2 | 2/2 | same | 2 | $0.0000 | +5.9% | +0.0 | 47% |
| f9_docs_research | 2/2 | 2/2 | same | 2 | −$0.0056 | −17.1% | +10.5 | 25% |

Verdict as printed: *Cost difference inconclusive: the interval covers zero and is wider than ±10% (+3.3%, 95% CI −11.4% to +16.5%, 4 scenarios); more repeats or scenarios needed.* Pass 8/8 → 8/8, pass^k 100% → 100%, cache-hit share 94% → 96%.

What the run demonstrates:

- The gate ran first: no regressions, so the cost section was allowed.
- The baseline's own spread between two repeats of the same scenario is 25–47% of its mean. Any tool that reports a single-run cost delta as a result is reporting noise; the interval is what carries the information.
- f9 (whole-document fetches) is the one scenario where folding pays, which matches the plugin's own A/B history; the others are shell-driven and neutral to slightly worse. Two repeats cannot separate this from noise, and the report says so instead of picking a side.
- Both arms saw identical composed trees except the inserted row (`arms/*.composed.yml`, SHAs in `env.json`), identical model and effort (`request/header`), and the same off-peak band.

Full report: [examples/validation-1.report.md](examples/validation-1.report.md) · interactive: [examples/validation-1.html](examples/validation-1.html) (open in a browser).

## 2026-09-04 · smoke-f6

1 scenario × 1 repeat, 21 s, $0.008: the first end-to-end run; used to check ledgers, verdicts, and the single-scenario wording ("no interval possible").
