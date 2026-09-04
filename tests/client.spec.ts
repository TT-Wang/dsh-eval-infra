import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * The browser half is loaded by dsh as a closure factory, not as a module: it
 * calls `window.__ModuleLoader__.load({id, factory})` and takes React and the
 * slot registry from the `require` the shell injects. Two mistakes are easy and
 * silent — bundling a second renderer (this repo's root tsconfig points JSX at
 * Preact, and elements from a foreign renderer are rejected as plain objects),
 * and registering into a list slot without an id. Both are checked here.
 */
const BUNDLE = join(__dirname, '..', 'lib', 'client.js')
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
]

describe('dsh client bundle', () => {
  it('registers a sidebar seat through the loader, using only the shell\'s own modules', () => {
    if (!existsSync(BUNDLE)) return   // `npm run build` has not run in this checkout
    const text = readFileSync(BUNDLE, 'utf8')
    expect(text).not.toMatch(/node_modules\/preact/)

    let loaded: { id: string; factory: (req: (s: string) => unknown) => Record<string, unknown> } | undefined
    runInNewContext(text, { window: { __ModuleLoader__: { load: (e: typeof loaded) => { loaded = e } } }, console }, { filename: 'client.js' })
    expect(loaded?.id).toBe('@dsh-external/dsh-eval-infra')

    const asked: string[] = []
    const stub = new Proxy({}, { get: () => () => undefined })
    const exported = loaded!.factory((specifier) => { asked.push(specifier); return stub })
    expect(asked.every(s => PLATFORM_MODULES.includes(s))).toBe(true)
    expect(asked).toContain('react')
    expect(exported['inject']).toEqual(['slots'])

    // apply must claim the footer-action list slot with an id; a list slot refuses a registration without one
    const registrations: Array<{ name: string; id?: string }> = []
    const slots = {
      inject: (_name: string, run: () => unknown) => run(),
      register: (options: { name: string; id?: string }) => { registrations.push(options); return () => undefined },
    }
    ;(exported['apply'] as (ctx: unknown) => void)({ slots })
    expect(registrations).toEqual([{ name: 'sidebar.footer.action', id: 'dsh-eval' }])
  })
})
