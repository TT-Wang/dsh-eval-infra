#!/usr/bin/env node
// Bundle the Preact UI into lib/ui (app.js + app.css + index.html). No dev server: `dsh-eval ui` serves lib/ui.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'lib', 'ui')
mkdirSync(out, { recursive: true })
await build({
  entryPoints: [join(root, 'src', 'ui', 'main.tsx')],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outfile: join(out, 'app.js'),
  logLevel: 'warning',
})
copyFileSync(join(root, 'src', 'ui', 'index.html'), join(out, 'index.html'))
copyFileSync(join(root, 'src', 'ui', 'app.css'), join(out, 'app.css'))
// Franken UI (the design system this tool shares with dsh-assembler) ships as
// three static files; they are copied rather than bundled so the browser can
// cache them across rebuilds of the app itself.
const vendorOut = join(out, 'vendor')
mkdirSync(vendorOut, { recursive: true })
for (const file of ['core.min.css', 'utilities.min.css', 'core.iife.js', 'LICENSE-franken-ui.md']) {
  copyFileSync(join(root, 'src', 'ui', 'vendor', file), join(vendorOut, file))
}
console.log(`ui → ${out}`)
