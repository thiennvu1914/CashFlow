#!/usr/bin/env node
/**
 * `npm run start` — run the standalone production build locally the way the
 * Docker `runner` stage runs it, without a Docker image.
 *
 * `output: 'standalone'` (`next.config.ts`) traces `.next/standalone/server.js`
 * but deliberately does not copy `.next/static` or `public` into the bundle —
 * Next expects whoever serves the standalone output to place those two
 * directories next to `server.js` itself. The Dockerfile's `runner` stage does
 * that with two `COPY` instructions (see `Dockerfile`); this script does the
 * same two copies for a local `npm run build && npm run start`, then runs the
 * same `server.js` the Docker image runs.
 *
 * Plain ESM, Node >= 20, no dependencies — this must run before `npm ci` has
 * necessarily produced anything beyond the base install.
 */

import { existsSync, cpSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const serverEntry = path.join(root, '.next', 'standalone', 'server.js')

if (!existsSync(serverEntry)) {
  console.error(
    `Cannot find ${path.relative(root, serverEntry)}. Run \`npm run build\` first — ` +
      '`npm run start` serves the standalone build, not source.',
  )
  process.exit(1)
}

const staticSrc = path.join(root, '.next', 'static')
const staticDest = path.join(root, '.next', 'standalone', '.next', 'static')
if (existsSync(staticSrc)) {
  cpSync(staticSrc, staticDest, { recursive: true })
}

const publicSrc = path.join(root, 'public')
const publicDest = path.join(root, '.next', 'standalone', 'public')
if (existsSync(publicSrc)) {
  cpSync(publicSrc, publicDest, { recursive: true })
}

const child = spawn(process.execPath, [serverEntry], { stdio: 'inherit', env: process.env })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
