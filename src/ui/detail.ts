/**
 * Detail level. The default view answers "did this change help, and what should
 * I do next"; everything that only a careful reader needs — intervals, design
 * diagnostics, notes, environment, logs — is behind this switch, so the page
 * that greets a first-time user is not a statistics dashboard.
 */
import { useEffect, useState } from 'preact/hooks'

const KEY = 'dsh-eval-detail'
const EVENT = 'dsh-eval-detail-change'

export function getDetail(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function setDetail(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode */ }
  window.dispatchEvent(new Event(EVENT))
}

export function useDetail(): [boolean, () => void] {
  const [on, setOn] = useState(getDetail)
  useEffect(() => {
    const handler = (): void => setOn(getDetail())
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [])
  return [on, () => setDetail(!getDetail())]
}
