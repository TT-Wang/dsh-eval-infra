#!/usr/bin/env node
/**
 * Build the dsh client bundle (the sidebar seat).
 *
 * dsh loads a browser plugin as a closure factory: the artifact calls
 * `window.__ModuleLoader__.load({ id, factory })` and the factory resolves
 * every external through the `require` the loader injects, so React and the
 * slot registry come from the shell's module table rather than from a second
 * copy on the page. esbuild's CommonJS output is exactly that shape once the
 * `module`/`exports` locals and the wrapper are supplied.
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

/** Specifiers the shell shares into its module table; a bundle must not carry its own copy. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
]

const out = join(root, 'lib', 'client.js')
await build({
  entryPoints: [join(root, 'src', 'client', 'index.tsx')],
  outfile: out,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // esbuild reads the nearest tsconfig for JSX settings, and this repo's root
  // config targets Preact for the standalone UI. Point it at the client config
  // so JSX compiles to the shell's own React: a bundled second renderer makes
  // elements the host rejects as plain objects (React error #31).
  tsconfig: join(root, 'tsconfig.client.json'),
  jsx: 'transform',
  jsxFactory: 'createElement',
  jsxFragment: 'Fragment',
  external: PLATFORM_MODULES,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(id)},\n\tfactory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
  },
  footer: { js: 'return module.exports;\n\t}\n});' },
})

// Verify the contract by running the artifact the way the shell does: a fake
// loader hands the factory a `require` over the platform table and must get a
// module exporting `apply` and `inject` back. A shape check on the text would
// pass on bundles the loader cannot actually use.
const text = readFileSync(out, 'utf8')
const { runInNewContext } = await import('node:vm')
let loaded
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
  console,
}
runInNewContext(text, sandbox, { filename: 'client.js' })
if (loaded === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load')
if (loaded.id !== id) throw new Error(`the bundle registered as ${String(loaded.id)}, not ${id}`)
const stub = new Proxy({}, { get: () => () => undefined })
const exported = loaded.factory((specifier) => {
  if (!PLATFORM_MODULES.includes(specifier)) throw new Error(`the bundle asks the loader for ${specifier}, which the shell does not share`)
  return stub
})
if (/node_modules\/preact/.test(text)) throw new Error('the client bundle contains Preact; JSX must compile to the shell\'s React or the renderer rejects every element')
for (const specifier of ['react', 'react/jsx-runtime']) {
  if (text.includes(`require("${specifier}")`)) break
}
for (const name of ['apply', 'inject']) {
  if (typeof exported[name] === 'undefined') throw new Error(`the bundle does not export ${name}; the loader would reject it`)
}
if (!Array.isArray(exported.inject)) throw new Error('inject must be the list of required services')
console.log(`client → ${out} (${(text.length / 1024).toFixed(1)} KB) · exports ${Object.keys(exported).join(', ')} · inject ${exported.inject.join(', ')}`)
