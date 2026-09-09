# m1_cross_session_recall (memory)

Turn 1 gives six project facts and asks for `notes/kickoff.md` in a fixed `- key: value` format;
turn 2 is a tiny unrelated task that also drops a chat-only fact ("the release codename is
ORCHID-7 — don't write it down yet"); before turn 3 the runner starts a fresh runtime session
(`new_session_before_turns: [3]`) and asks for `handoff.md` with all seven facts.

A plain agent can recover the six facts from `notes/kickoff.md`; the codename exists only in the
previous session's conversation, so recalling it requires memory that survives a restart.

That holds because the runner moves the ended session out of reach: dsh writes every session's full
transcript to `<eval home>/sessions/<workspace slug>/<id>/session.jsonl.zstd` (and its first prompt
verbatim to `storages/session_projcache/sessions/<id>.json`), which sits beside the workspace on the
host and is mounted into the container, so before turn 3's session starts both are moved to a private
temporary directory and restored when the trial ends. Without that, `zstd -d` on the old transcript
would answer the question with no memory at all.
Decoy: `notes/old_kickoff_2025.md` carries the same keys with stale values.

Verifier: all seven `key: value` pairs in handoff.md (the detail names the missing ones, so partial
recall is visible), plus the turn-1 file and the turn-2 script.
