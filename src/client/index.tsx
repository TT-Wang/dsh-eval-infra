/**
 * Browser half of dsh-eval: a seat in the dsh sidebar showing the last paired
 * comparison and the actions that follow from it. The node half serves the API
 * and the full UI under /eval; this bundle only reads that API, so the two
 * surfaces cannot drift apart.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { EvalPanel } from './Panel.js'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Register the panel into the sidebar's footer-action list.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // The slot registry's own types live in the host's client packages, which a
  // third-party bundle does not compile against; the two calls used here are
  // narrow enough to spell out.
  const slots = (ctx as unknown as { slots: SlotRegistry }).slots
  slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'dsh-eval' }, EvalPanel))
}

interface SlotRegistry {
  inject: (name: string, run: () => unknown) => unknown
  register: (options: { name: string; id?: string }, component: unknown) => () => void
}
