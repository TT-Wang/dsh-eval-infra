# c1_big_read_budget (cost)

A single-turn cost probe. `data/catalog.json` is ~400 KB (1800 items); the answer needs only
`meta.schema_version`, the item count, one item's price and one category count. An agent can read the
whole file into context or query it — the verifier does not care, the ledger does.

Decoy: `data/catalog.sample.json` has the same shape, an older schema version and a different price
for the target SKU; the prompt names the full file explicitly.

Verifier: `answer.json` must carry exactly the four keys with the exact values.
