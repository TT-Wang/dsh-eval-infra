/**
 * The evaluation as it happens.
 *
 * A paired run is a race between two configurations over the same work, so the
 * page is built around that: how far along it is and what it has cost, the two
 * arms side by side on the work finished so far, the grid of trials filling in,
 * and a stream of what the agents are doing right now. Nothing here is a
 * verdict — the numbers move and are labelled as provisional — because a
 * conclusion drawn from a half-finished run is exactly the mistake this tool
 * exists to prevent.
 */
import { useEffect, useState } from 'preact/hooks'
import { fmt, type LedgerLite } from '../api.js'
import type { Progress } from '../../core/store.js'
import type { RunPlan } from '../../core/types.js'

export interface StreamEvent { at: number; kind: 'start' | 'turn' | 'done' | 'log'; text: string; tone?: 'good' | 'bad' | 'warn' }

/** Per-arm totals over the trials finished so far. */
function tally(ledgers: LedgerLite[], arm: string): { trials: number; passes: number; usd: number; steps: number; wallMs: number } {
  const rows = ledgers.filter(l => l.arm === arm)
  return {
    trials: rows.length,
    passes: rows.filter(l => l.verdict?.ok === true && l.error === undefined).length,
    usd: rows.reduce((a, l) => a + l.totals.usd, 0),
    steps: rows.reduce((a, l) => a + l.totals.steps, 0),
    wallMs: rows.reduce((a, l) => a + l.wallMs, 0),
  }
}

/** Scenarios where both arms have finished the same repeat: the only ones that could ever be compared. */
function settledPairs(ledgers: LedgerLite[], baseline: string, candidate: string): Array<{ scenario: string; rep: number; a: LedgerLite; b: LedgerLite }> {
  const out: Array<{ scenario: string; rep: number; a: LedgerLite; b: LedgerLite }> = []
  for (const a of ledgers.filter(l => l.arm === baseline)) {
    const b = ledgers.find(l => l.arm === candidate && l.scenario === a.scenario && l.rep === a.rep)
    if (b) out.push({ scenario: a.scenario, rep: a.rep, a, b })
  }
  return out
}

export function LiveRun({ plan, progress, ledgers, events, onCancel }: {
  plan: RunPlan
  progress: Progress
  ledgers: LedgerLite[]
  events: StreamEvent[]
  onCancel: () => void
}) {
  const baseline = plan.baseline.name
  const candidate = plan.candidates[0]?.name ?? ''
  const arms = [baseline, ...plan.candidates.map(c => c.name)]
  const done = progress.completed
  const pct = progress.total ? Math.round((done / progress.total) * 100) : 0
  // The page only re-renders when the stream delivers something, and a turn can take a
  // minute; the clocks below need their own tick or "elapsed" freezes at its first value.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsedMs = Math.max(0, now - new Date(progress.startedAt).getTime())
  const perTrial = done > 0 ? elapsedMs / done : null
  const remaining = perTrial === null ? null : perTrial * (progress.total - done)
  const spendPerTrial = done > 0 ? progress.usd / done : null
  const projected = spendPerTrial === null ? null : spendPerTrial * progress.total

  const A = tally(ledgers, baseline)
  const B = candidate === '' ? null : tally(ledgers, candidate)
  const pairs = candidate === '' ? [] : settledPairs(ledgers, baseline, candidate)
  const bothPassed = pairs.filter(p => p.a.verdict?.ok === true && p.b.verdict?.ok === true && p.a.error === undefined && p.b.error === undefined)
  const cheaper = bothPassed.filter(p => p.b.totals.usd < p.a.totals.usd).length
  const costA = bothPassed.reduce((a, p) => a + p.a.totals.usd, 0)
  const costB = bothPassed.reduce((a, p) => a + p.b.totals.usd, 0)
  const provisionalPct = costA > 0 ? ((costB - costA) / costA) * 100 : null
  const scenarios = [...new Set(plan.scenarios)]
  const maxUsd = Math.max(A.usd, B?.usd ?? 0, 1e-9)

  return (
    <div class="flex flex-col gap-4">
      {/* progress and spend */}
      <section class="uk-card">
        <div class="uk-card-body py-3 flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <span class="pip live" aria-hidden="true" />
              <b>{done}</b><span class="text-muted-foreground">of {progress.total} trials</span>
              {progress.failed > 0 && <span class="text-destructive">{progress.failed} errored</span>}
            </div>
            <div class="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span>spent <b class="text-foreground">{fmt.usd(progress.usd, 3)}</b>{projected !== null && <span> of about {fmt.usd(projected, 2)}</span>}</span>
              <span>elapsed <b class="text-foreground">{fmt.secs(elapsedMs)}</b>{remaining !== null && done < progress.total && <span>, about {fmt.secs(remaining)} left</span>}</span>
              <button class="uk-btn uk-btn-destructive uk-btn-sm" onClick={onCancel}>Stop</button>
            </div>
          </div>
          <div class="race-bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      </section>

      <div class="grid gap-4 lg:grid-cols-3">
        {/* the race */}
        <section class="uk-card lg:col-span-2">
          <div class="uk-card-header py-3">
            <h2 class="uk-card-title text-sm">Where the two arms stand <span class="font-normal text-muted-foreground">on the {bothPassed.length} pair{bothPassed.length === 1 ? '' : 's'} where both have finished and passed</span></h2>
          </div>
          <div class="uk-card-body py-3 flex flex-col gap-4">
            {[{ name: baseline, t: A, cls: '' }, ...(B ? [{ name: candidate, t: B, cls: 'b' }] : [])].map(({ name, t, cls }) => (
              <div key={name} class="flex flex-col gap-1">
                <div class="flex items-center justify-between text-sm">
                  <span class="font-medium">{name}</span>
                  <span class="text-muted-foreground">{t.passes}/{t.trials} passed · {fmt.usd(t.usd, 3)} · {t.steps} steps</span>
                </div>
                <div class={`race-bar ${cls}`}><i style={{ width: `${(t.usd / maxUsd) * 100}%` }} /></div>
              </div>
            ))}
            {B !== null && (
              <div class="text-sm">
                {bothPassed.length === 0 && <span class="text-muted-foreground">No pair has finished on both arms yet.</span>}
                {bothPassed.length > 0 && (
                  <span class="text-muted-foreground">
                    Running difference <b class="text-foreground">{fmt.pct(provisionalPct)}</b> on cost, candidate cheaper on {cheaper} of {bothPassed.length}.
                    {' '}Provisional — the verdict is computed when the run finishes.
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        {/* the stream */}
        <section class="uk-card">
          <div class="uk-card-header py-3"><h2 class="uk-card-title text-sm">Activity</h2></div>
          <div class="uk-card-body py-2">
            <div class="stream">
              {events.length === 0 && <p class="text-sm text-muted-foreground">waiting for the first turn…</p>}
              {events.map((e, i) => (
                <div key={`${e.at}-${i}`} class="stream-row">
                  <span class="when">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
                  <span class={e.tone === 'good' ? 'text-foreground' : e.tone === 'bad' ? 'text-destructive' : 'text-muted-foreground'}>{e.text}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* the grid filling in */}
      <section class="uk-card">
        <div class="uk-card-header py-3"><h2 class="uk-card-title text-sm">Trials <span class="font-normal text-muted-foreground">● passed ● failed ● errored ○ waiting</span></h2></div>
        <div class="uk-card-body py-0 table-scroll">
          <table class="uk-table uk-table-divider uk-table-sm text-sm">
            <thead><tr><th>scenario</th>{arms.map(a => <th key={a}>{a}</th>)}</tr></thead>
            <tbody>
              {scenarios.map(s => (
                <tr key={s}>
                  <td><code class="text-xs">{s}</code></td>
                  {arms.map(arm => (
                    <td key={arm}>
                      {Array.from({ length: plan.repeats }, (_, i) => i + 1).map((rep) => {
                        const l = ledgers.find(x => x.scenario === s && x.arm === arm && x.rep === rep)
                        const live = progress.active.find(a => a.scenario === s && a.arm === arm && a.rep === rep)
                        const cls = l ? (l.error ? 'err' : l.verdict?.ok ? 'pass' : 'fail') : live ? 'live' : 'queued'
                        const title = l ? `${l.verdict?.ok ? 'pass' : 'fail'} · ${fmt.usd(l.totals.usd)} · ${l.totals.steps} steps` : live ? `turn ${live.turn}/${live.turns}` : 'waiting'
                        return <span key={rep} class={`pip ${cls}`} title={title} />
                      })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
