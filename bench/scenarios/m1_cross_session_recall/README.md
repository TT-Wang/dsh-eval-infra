# m1_cross_session_recall (memory)

Turn 1 gives six project facts and asks for `notes/kickoff.md` in a fixed `- key: value` format;
turn 2 is a tiny unrelated task that also drops a chat-only fact ("the release codename is
ORCHID-7 — don't write it down yet"); before turn 3 the runner starts a fresh runtime session
(`new_session_before_turns: [3]`) and asks for `handoff.md` with all seven facts.

A plain agent can recover the six facts from `notes/kickoff.md`; the codename was never written to the
workspace, so it has to come from somewhere else.

**What this scenario does not separate.** dsh keeps every session's transcript under its own home
(`sessions/<workspace slug>/<id>/session.jsonl.zstd`, plus the first prompt verbatim in
`storages/session_projcache/`), and that home is beside the workspace on the host and mounted into the
container. So the seventh fact can be produced two ways: remembered across the restart, or decompressed
out of the previous session's transcript. A real run has done the second — `npm install fzstd`, a
throwaway decompress script, and the verifier said "all 7 facts recalled" (docs/results.md, run
20260909-043013-w7i1).

dsh-eval does not hide that store: it belongs to the harness under test, and a memory component may
legitimately be implemented by reading it — a scale does not hide the thing it is weighing. So read the
trace before crediting a difference here to memory. The paired design still holds (both arms get the
same opportunity), and `--sandbox docker` does not change it either, since the eval home is mounted
there too.

Verifier: all seven `key: value` pairs in handoff.md (the detail names the missing ones, so partial
recall is visible), plus the turn-1 file and the turn-2 script.
