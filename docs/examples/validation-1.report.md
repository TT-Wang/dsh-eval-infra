# dsh-eval report 20260903-175407-2slv

Baseline **baseline** · 4 scenarios × 2 repeats · 16 runs · $0.1893 total

## fold vs baseline

**Cost difference inconclusive: the interval covers zero and is wider than ±10% (+3.3%, 95% CI −11.4% to +16.5%, 4 scenarios); more repeats or scenarios needed.**

Pass: baseline 8/8, candidate 8/8 · pass^k 100% → 100% · discordant pairs: 0 won / 0 lost (sign test p=1.00)

Per solved task: baseline 379K tokens / $0.0123, candidate 412K tokens / $0.0114 · cache-hit share 94% → 96%

| scenario | baseline pass | candidate pass | class | cost pairs | Δ cost | Δ % | Δ steps | baseline spread |
|---|---|---|---|---|---|---|---|---|
| f1_log_triage | 2/2 | 2/2 | same | 2 | $0.0018 | +20.9% | +2.0 | 31% |
| f10_db_investigation | 2/2 | 2/2 | same | 2 | $0.0003 | +3.3% | +1.5 | 28% |
| f6_csv_reconcile | 2/2 | 2/2 | same | 2 | $0.0000 | +5.9% | +0.0 | 47% |
| f9_docs_research | 2/2 | 2/2 | same | 2 | −$0.0056 | −17.1% | +10.5 | 25% |

Cost over comparable scenarios: baseline $0.0982 → candidate $0.0911; per-scenario mean Δ −$0.0009 (95% bootstrap CI −$0.0042 to $0.0013); Δ% +3.3% (CI −11.4% to +16.5%); fixed-band Δ peak −$0.0018, off-peak −$0.0009.

## Notes

- repeats=2: below the 3-repeat floor the literature recommends; single-run noise is around ±30% on cost, so treat every difference as indicative only.
