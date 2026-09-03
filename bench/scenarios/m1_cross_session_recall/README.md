# m1_cross_session_recall (memory)

Turn 1 gives six project facts and asks for `notes/kickoff.md` in a fixed `- key: value` format;
turn 2 is a tiny unrelated task that also drops a chat-only fact ("the release codename is
ORCHID-7 — don't write it down yet"); before turn 3 the runner starts a fresh runtime session
(`new_session_before_turns: [3]`) and asks for `handoff.md` with all seven facts.

A plain agent can recover the six facts from `notes/kickoff.md`; the codename exists only in the
previous session's conversation, so recalling it requires memory that survives a restart.
Decoy: `notes/old_kickoff_2025.md` carries the same keys with stale values.

Verifier: all seven `key: value` pairs in handoff.md (the detail names the missing ones, so partial
recall is visible), plus the turn-1 file and the turn-2 script.
