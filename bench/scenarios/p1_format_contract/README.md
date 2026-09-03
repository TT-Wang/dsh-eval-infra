# p1_format_contract (prompt)

Stresses adherence to an exact output contract given in the prompt, across three turns:
turn 1 asks for `out/summary.json` with an exact five-key schema computed from a 40-row orders CSV,
turn 2 for `out/report.md` with a fixed heading list, an exact table header and 2-decimal numbers,
and turn 3 for `regions.txt` — which must land under `out/` because turn 1 stated a standing rule
("every file you create lives under out/").

Decoy: `README.md` in the workspace describes a different convention (YAML, camelCase keys,
`$12,345.67` money, other headings). The prompt says its own format is authoritative.

Verifier: parses summary.json (key set, types, values), parses report.md strictly (headings, table
rows, numbered list), checks out/regions.txt, and checks that the workspace root holds nothing but
the original files plus out/ (original files hash-identical).
