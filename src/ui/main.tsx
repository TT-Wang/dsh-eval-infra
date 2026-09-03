import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { RunsView } from './views/runs.js'
import { NewRunView } from './views/new-run.js'
import { RunView } from './views/run.js'
import { TraceView } from './views/trace.js'

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
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  let view
  if (parts[0] === 'new') view = <NewRunView />
  else if (parts[0] === 'run' && parts[1] !== undefined && parts[2] === 'trace' && parts[3] !== undefined && parts[4] !== undefined && parts[5] !== undefined) {
    view = <TraceView runId={parts[1]} scenario={parts[3]} arm={parts[4]} rep={Number(parts[5])} />
  } else if (parts[0] === 'run' && parts[1] !== undefined) view = <RunView id={parts[1]} />
  else view = <RunsView />
  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/"><span class="logo" aria-hidden="true"><i /><i /></span>dsh-eval</a>
        <nav>
          <a href="#/" class={parts.length === 0 ? 'active' : ''}>Runs</a>
          <a href="#/new" class={parts[0] === 'new' ? 'active' : ''}>New run</a>
        </nav>
      </header>
      <main>{view}</main>
    </div>
  )
}

render(<App />, document.getElementById('app')!)
