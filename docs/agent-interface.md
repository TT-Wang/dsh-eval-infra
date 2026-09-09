# The agent interface

dsh-eval is a dsh host plugin. Its first-class caller is the agent in the user's
main conversation, not a person clicking through the web UI: the agent drives the
evaluation, the person reads the result and decides whether to believe it. This
document defines the contract that makes that possible — the state machine an
agent asks about, and the shape every tool answers in.

The web UI is not deprecated by this. It changes role: from the surface where a
run is *built* to the surface where a result is *read*. Forest strips, decision
traces and per-trial traces are for human eyes, and the reading order (gates →
reliability → north star → diagnostics) exists so a person can decide. An agent
can drive and summarise; it cannot decide for them.

## Two agents, different rights

The word "agent" means two different things here and the interface keeps them apart.

| | may do |
|---|---|
| **The driver** — the agent in the user's conversation | call every tool below; read and write scenarios, including `verify.py`; start runs; read reports and evidence |
| **The subject** — the agent inside a trial, running under the arm being measured | do the task. Opening the evaluation's own files (the scenario directory, the run directory) is recorded on its ledger as `evalFileReads` and named in the report |

Nothing the driver does is a violation; everything the subject does inside its
workspace is the task. The two never share a process.

## Three invariants

**1. A gate is an answer, not a failure.** The tool's value is what it refuses to
say. `status` reporting "no direction is attainable, because this baseline has no
A/A floor" is a successful call, and so is a report whose cost reading is withheld.
Both return `next`, so refusal always comes with the way forward.

**2. There is no escape hatch.** No tool takes `force`, `skip_gate`,
`ignore_floor` or an equivalent. If such a parameter existed an agent would use
it, and would then tell the user it had "skipped a check" in a sentence the user
never reads. The gates are the product.

**3. The agent narrates `licensed`, never `withheld`.** Every reading tool
returns what the evidence licenses and what it does not, as codes with
parameters. The agent renders `licensed` in the user's own language; for anything
in `withheld` it says only that no conclusion is available and why. Turning
`{reading: "inconclusive"}` into "成本差不多" is the exact overclaim this project
exists to prevent, and the interface is where it must be stopped, because the
model now sits between the number and the person.

## Output shape

Tool results are data for an agent to reason over and then retell, not text for a
person to read. Therefore:

- **Codes and parameters, never sentences.** `{code: "floor.thin", baseline: "base", have: 4, need: 5}`, not "the A/A floor on file covers only 4 scenarios". The user may be working in any language; a fixed English sentence either gets echoed untranslated or gets paraphrased into something weaker.
- **No formatting.** No tables, no alignment, no emoji. Those are for the UI.
- **Errors are causes.** `{code: "scenario.missing_file", file: "verify.py"}`, not a thrown string.
- **Reasons travel with readings.** The user will ask "为什么没结论", "还要跑多久", "值得再跑吗". Those map to no single tool, so every answer carries the facts an agent needs to compose one: what is missing, how much evidence exists, what the design can currently detect, what has been spent.

An optional `gloss` (short English) may accompany a code for logs and debugging.
It is never authoritative and agents must not relay it verbatim.

## `status`

The entry point. An agent arriving in a fresh session with no context calls this
first and learns three things: where the project is, what it may claim, and what
to do next.

```jsonc
{
  "schema": "dsh-eval-status/1",
  "project": { "root": "~/code/my-plugin", "profile": "eval", "sandbox": "docker" },

  // The linear setup phases, in order. `blocked` names the first unmet one.
  "phases": [
    { "code": "profile",      "state": "ok" },
    { "code": "arms",         "state": "ok", "baseline": "baseline", "candidates": ["fold"] },
    { "code": "one_variable", "state": "ok", "variables": 1 },
    { "code": "scenarios",    "state": "ok", "matched": 12 },
    { "code": "selfcheck",    "state": "stale", "checked": 9, "changed": ["f6_csv_reconcile"], "never": 2 },
    { "code": "floor",        "state": "thin", "baseline": "baseline", "have": 4, "need": 5, "runId": "20260909-043013-w7i1" },
    { "code": "run",          "state": "none" }
  ],
  "blocked": "selfcheck",

  // What each reading would need before it could be made at all. Answers
  // "can you tell me whether my plugin is cheaper?" before anything is run.
  "readings": {
    "reliability":       { "attainable": true },
    "northStar.cost":    { "attainable": false, "missing": [{ "code": "floor.thin", "have": 4, "need": 5 }] },
    "northStar.efficiency": { "attainable": false, "missing": [{ "code": "floor.no_step_band", "runId": "…w7i1" }] },
    "northStar.quality": { "attainable": false, "missing": [{ "code": "judge.unconfigured" }, { "code": "scenario.no_judge_rubric" }] }
  },

  "runs": [
    { "id": "20260909-044603-a9fm", "state": "done", "arms": ["baseline", "candidate"],
      "scenarios": 1, "repeats": 1, "completed": 2, "total": 2, "usd": 0.0166,
      "gate": "pass", "sealed": true }
  ],

  "next": {
    "reason": { "code": "selfcheck.stale", "changed": ["f6_csv_reconcile"], "never": 2 },
    "tool": "scenarios.selfcheck",
    "args": { "scenarios": ["f6_csv_reconcile", "…"] }
  }
}
```

### Phase states, and what determines each

Every state is read off the project on disk. Nothing here runs a model or spends money.

| phase | states | determined by | `next` when not `ok` |
|---|---|---|---|
| `profile` | `ok` / `missing` | `evalProfileManifest(home, profile).exists` | `init` |
| `arms` | `ok` / `no_baseline` / `no_candidate` | arm files under the project's arms directory | `arms.write` |
| `one_variable` | `ok` / `multi_variable` / `unchecked` | `armsDiff(baseline, candidate).variables`, composed through `dsh --dump-config` | `arms.diff`, then `arms.write` |
| `scenarios` | `ok` / `none` | scenarios matching the project's filter | `scenarios.add` |
| `selfcheck` | `ok` / `stale` / `never` / `failing` | the selfcheck cache (below) against each scenario's content hash | `scenarios.selfcheck` |
| `floor` | `ok` / `missing` / `thin` | `archiveNoiseFloors(project)[baseline]`: present, and `scenarios >= minScenarios` | `run.start {aa: true}` |
| `run` | `none` / `running` / `done` | the run index, and the progress file's age | `run.start`, or `run.status` while one is live |

A run that claims to be running but whose progress file has not been written for
`ABANDONED_AFTER_MS` (30 minutes) belongs to a process that is gone: it is listed
under `abandoned` with its idle time and does not make the phase `running`.
Without that, one crashed run tells every later caller to keep polling it forever.
A live run outranks every setup blocker in `next` — "how is it going" is actionable,
"go measure a floor" is not, until it ends.

Container scenarios are named apart under `needsDocker` and kept out of `next`:
checking one opens its own image, which means Docker and a pull of some gigabytes.
The caller decides when to pay for that.

Two deliberate omissions:

- **`floor.stale` is not a status state.** A floor goes stale when the baseline's
  behaviour has drifted since it was measured, and drift is computed against a
  *run's* observed tool distribution. Status has no run to compare, so it reports
  `ok` / `missing` / `thin` only; `stale` appears in `report.read`, where the
  comparison exists. Status must not guess it.
- **`one_variable: unchecked` is a real state**, not an error. The diff composes
  both arms through dsh and costs a second or two, so status never runs it and
  never caches it: it reports `unchecked` and names `arms.diff`, the tool that
  answers. Status stays free to call.

### The selfcheck cache (new)

Selfcheck currently runs on demand and persists nothing, so status cannot know
whether the scenarios were ever checked. The state machine needs one small
addition: `.dsh-eval/selfcheck.json`, an entry per scenario —

```jsonc
{ "f6_csv_reconcile": { "sha": "<sha256 of the scenario directory>", "ok": true,
                        "blankPasses": false, "oraclePasses": true,
                        "strict": { "mutated": 6, "nonDiscriminating": [] },
                        "checkedAt": "2026-09-09T…" } }
```

`sha` is what makes `stale` meaningful: a scenario whose files changed since the
check is `stale`, not `ok`. Writing this cache is the only persistence this
interface adds, and `run` already re-runs selfcheck itself before every run, so
the cache is an index of what has been checked, never a substitute for checking.

## Reading tools

`report.read` is the one that carries claims, and it is where invariant 3 lives.

```jsonc
{
  "schema": "dsh-eval-report/1",
  "run": "20260909-043013-w7i1",
  "gate": { "state": "pass" },

  "readings": {
    "reliability": { "reading": "same", "k": 3, "scenarios": 5,
                     "baseline": 0.80, "candidate": 0.80, "midP": 1.0 },
    "northStar":   { "metric": "cost", "reading": "inconclusive",
                     "interval": [-55.3, 71.5], "mean": 8.1, "scenarios": 4 }
  },

  "licensed": [
    { "code": "reliability.same", "k": 3, "scenarios": 5 },
    { "code": "gate.no_regression", "scenarios": 5 }
  ],

  "withheld": [
    { "claim": "northStar.direction",
      "reason": { "code": "floor.thin", "baseline": "baseline", "have": 4, "need": 5 },
      "observed": { "interval": [-55.3, 71.5], "mean": 8.1 },
      "next": { "tool": "run.start", "args": { "aa": true, "repeats": 3 } } }
  ],

  // For "是不是还要多跑" / "这个设计能看出多小的差别"
  "design": { "comparableScenarios": 4, "repeats": 3, "mdePct": 76.0,
              "resolution": { "nStar": 31, "q": 0.13 }, "alpha": 0.025,
              "usd": 0.1845, "wallMs": 630000 }
}
```

`observed` inside a `withheld` entry is deliberate: the number exists and hiding
it would be its own dishonesty. What is withheld is the *claim*, not the
measurement, and the agent must relay it as a measurement that does not support a
direction — never as a direction.

**A closed gate withholds both readings**, whatever they computed to. The contract
says "gates first: any safety-gate violation, then any consistent regression, then
any suspected regression, blocks every reading", so `gate.unsafe`,
`gate.regressions`, `gate.suspect` and `gate.incomplete` appear as the `reason` on
both `reliability.direction` and `northStar.direction`, and the reading each would
have been is kept in `observed`. A gate that is *open* is itself a licensed claim —
`gate.nothing_broke` — because "nothing broke" is a finding, not an absence.

### Blocker codes

Every reason a direction is not read, recorded where the rule applies rather than
parsed back out of a sentence:

| code | carries |
|---|---|
| `gate.unsafe` / `gate.regressions` / `gate.suspect` / `gate.incomplete` | `scenarios` |
| `scenarios.below_minimum` | `have`, `need` |
| `floor.missing` / `floor.thin` / `floor.stale` | `baseline`, `have`, `need`, `runId` |
| `floor.no_step_band` | `runId` — the A/A run had no pair to measure steps on |
| `reading.inside_noise_band` | `interval`, `band`, `floorRun` |
| `reading.interval_covers_zero` | `interval`, `sesoiPct` |
| `provenance.unreconciled` | `trials`, `of` — the runtime's usage disagreed with the wire meter |
| `served_model.mismatch` / `probe.route_differs` | `findings` |
| `cost.unpriced` | `trials`, `models` |
| `cost.no_comparable_pairs` / `steps.no_comparable_pairs` | — |
| `judge.not_run` | `runId` |

Provenance and served-model failures are unshifted to the front: figures that
cannot be trusted are withheld before any question of floors or intervals.

## Tool surface, first cut

Each maps to a CLI form today and to an MCP tool of the same name once the server
is in place; the shapes are the same either way.

| tool | CLI | returns |
|---|---|---|
| `status` | `dsh-eval status --json` | above |
| `scenarios.list` | `scenarios --json` | name, category, turns, tags, oracle, setup, judge, holdout, runtime, and each one's selfcheck state |
| `scenarios.add` | — (server `POST /api/scenarios`) | writes a scenario, runs selfcheck, returns structured failures |
| `scenarios.selfcheck` | `selfcheck --json` | per scenario: `blankPasses`, `oraclePasses`, and `findings` — the loop an agent uses to iterate on a `verify.py` |
| `arms.diff` | `diff a b --json` | rows, variables, route, patch sources; `state` is `ok` / `identical` / `multi_variable` |
| `run.start` | — (server `POST /api/runs`) | run id, at once. A run takes minutes to hours, so it is never held open in a tool call: the server owns it and the caller polls. Takes `aa`, `repeats`, `scenarios`, `northStar`, `maxUsd` — and no gate override |
| `run.status` | `progress <id> --json` | status, trials done, spend, active trials, early-stop decision, and `abandoned` when the process behind a "running" run is gone |
| `report.read` | `report <id> --claims` | above |
| `verify` | `verify <id> --json` | sealed hashes, report re-derivation, receipt status, trusted-key state |
| `runs.list` | `runs --json` | the run index, each with `sealed` and its gate |

### Selfcheck findings

Four ways a scenario fails its check, each a code with the parameters needed to fix it:

| code | means | carries |
|---|---|---|
| `blank.accepted` | the verifier passed a workspace the agent never touched, so it would pass every trial | `detail`: what the verifier said while accepting it |
| `oracle.rejected` | the verifier refused the reference answer: it asks for something the oracle does not produce | `detail`: the verifier's own reason |
| `strict.blind_to_output` | under `--strict`, oracle outputs whose deletion or blanking the verifier does not notice | `files`, `mutated` |
| `scenario.threw` | the scenario's own code raised | `phase` (`setup` / `verify` / `oracle` / `environment`), `message` |

`detail` inside a finding is always the verifier's own words, never a sentence
this tool composed: it belongs to whoever wrote the scenario. The findings are
kept in the checks record too, so a caller can read why a scenario last failed
without paying to run the check again.

`scenarios.selfcheck` is the one that makes importing a user's existing eval
practical: the target is machine-checkable (an untouched workspace must fail, the
reference answer must pass, and under `strict` every mutation of the oracle's
output must be caught), so an agent can write a `verify.py`, run the check, read
the structured failure and iterate until it passes. That loop — expensive to
write, cheap to verify — is the whole reason the driver is an agent.

## What this does not decide

- Whether an in-house assistant should generate scenarios inside dsh-eval. The
  driver agent already has the model, the context and the user's intent; the
  plumbing exists (`ChatCall`, `config.judges`) if that changes.
- Whether a trial that read the evaluation's own files should be invalidated
  rather than flagged. Currently flagged.
