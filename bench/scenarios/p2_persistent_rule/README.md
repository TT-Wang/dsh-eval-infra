# p2_persistent_rule (prompt)

Turn 1 states three standing rules (exact `# SPDX-License-Identifier: MIT` first line on every .py
file, snake_case function names, a `# Changelog` file with `- <module>: <description>` bullets) and
asks for the existing violations to be fixed; turns 2-4 request ordinary code changes to a small
`textkit` package (new functions, a behaviour change, a brand-new module + test file) without
mentioning the rules again.

Decoys: `textkit/stats.py` ships with a look-alike header (`# License: MIT (see LICENSE file)`),
`textkit/normalize.py` and the test file have none, and two functions are camelCase with callers in
`__init__.py` and the tests.

Verifier: every .py file (tests and the turn-4 module included) starts with the exact header, every
`def` is snake_case, the old names are gone, CHANGELOG.md has the exact shape with entries for
normalize/stats/tokenize, a behaviour probe covers every requested function, and pytest is green.
