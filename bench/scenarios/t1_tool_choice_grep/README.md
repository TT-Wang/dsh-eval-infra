# t1_tool_choice_grep (tools)

300 generated Python modules under `src/` define handler functions; the task is the sorted list of
files that define `handle_retry` (turn 1) and `handle_flush` (turn 2), written to `matches.txt` /
`matches_flush.txt`. The natural solution is one anchored grep; reading files individually is slow.

Decoys: `src/router/router_legacy.py` mentions `def handle_retry(` only in a comment,
`src/queue/queue_client.py` only calls the functions, `src/cache/cache_async.py` defines
`handle_retry_async`, `src/auth/auth_private.py` defines `_handle_retry` and quotes the name in a
docstring, and `src/docs/handlers.md` quotes a definition but is not a Python file.

Verifier: each list must equal the exact sorted set of matching paths.
