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
console.log(`ui → ${out}`)
