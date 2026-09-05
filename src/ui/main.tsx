import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { RunsView } from './views/runs.js'
import { NewRunView } from './views/new-run.js'
import { RunView } from './views/run.js'
import { TraceView } from './views/trace.js'
import { HistoryView } from './views/history.js'
import { STATIC } from './api.js'

function useHash(): string {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = (): void => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export function navigate(to: string): void {
  location.hash = to
}

function App() {
  const hash = useHash()
  const [pathPart, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const parts = (pathPart ?? '').split('/').filter(Boolean).map(decodeURIComponent)
  const preset = Object.fromEntries(new URLSearchParams(query).entries())
  let view
  if (parts[0] === 'new') view = <NewRunView preset={preset} />
  else if (parts[0] === 'history') view = <HistoryView />
  else if (parts[0] === 'run' && parts[1] !== undefined && parts[2] === 'trace' && parts[3] !== undefined && parts[4] !== undefined && parts[5] !== undefined) {
    view = <TraceView runId={parts[1]} scenario={parts[3]} arm={parts[4]} rep={Number(parts[5])} />
  } else if (parts[0] === 'run' && parts[1] !== undefined) view = <RunView id={parts[1]} />
  else view = <RunsView />
  const tab = (href: string, label: string, active: boolean) => (
    <a href={href} class={`px-3 py-1.5 rounded-md text-sm ${active ? 'bg-secondary text-secondary-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}>{label}</a>
  )
  return (
    <div class="min-h-screen bg-background text-foreground">
      <header class="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-card px-5 py-2">
        <a class="flex items-center gap-2 font-semibold" href="#/">
          <span aria-hidden="true" class="inline-flex items-end gap-0.5">
            <i class="block w-1.5 h-3.5 rounded-sm" style="background: hsl(var(--primary))" />
            <i class="block w-1.5 h-2.5 rounded-sm" style="background: #10a37f" />
          </span>
          dsh-eval
        </a>
        <nav class="flex items-center gap-1">
          {tab('#/', 'Runs', parts.length === 0)}
          {tab('#/new', 'New run', parts[0] === 'new')}
          {tab('#/history', 'Scenarios', parts[0] === 'history')}
        </nav>
        <div class="flex-1" />
      </header>
      <main>{view}</main>
    </div>
  )
}

if (STATIC !== undefined && location.hash === '') location.hash = `#/run/${STATIC.run.plan.id}`
render(<App />, document.getElementById('app')!)
