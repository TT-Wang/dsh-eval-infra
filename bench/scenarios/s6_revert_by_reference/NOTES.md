# Notes

* `oracle.py` added (delegates to `reference_fix.apply`, the reference implementation that already shipped with the scenario).
* `verify.py` fix (minimal): the probes write `verify_a.jsonl` .. `verify_f.jsonl` into the workdir and never removed them.
  The selfcheck runs verify twice on the same workdir (untouched, then after the oracle); the seed CLI accepts plain
  `add`, so the first run left seed-era records (no `tags` field, lower ids) in those files and the second run's
  `rec()` lookups returned the stale records (`t1_tags_default_empty`, `t4_archived_hidden_from_*` failed for a
  correct implementation). verify now deletes its probe files before and after probing. No check was changed.
