import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

/**
 * Windowed rendering for long tables: only the rows near the viewport are
 * mounted; spacer rows keep the scrollbar honest. Below `threshold` rows the
 * table renders plainly, so small runs keep native table layout and
 * keyboard/focus behaviour.
 */
export function VirtualRows<T>({ items, rowHeight = 30, height = 560, threshold = 150, render }: { items: T[]; rowHeight?: number; height?: number; threshold?: number; render: (item: T, index: number) => ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = (): void => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [items.length])
  if (items.length <= threshold) return <>{items.map((it, i) => render(it, i))}</>
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 10)
  const count = Math.ceil(height / rowHeight) + 20
  const last = Math.min(items.length, first + count)
  return (
    <div class="virtual" ref={ref} style={{ maxHeight: `${height}px`, overflowY: 'auto' }}>
      <div style={{ height: `${first * rowHeight}px` }} />
      {items.slice(first, last).map((it, i) => render(it, first + i))}
      <div style={{ height: `${(items.length - last) * rowHeight}px` }} />
    </div>
  )
}
