import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structural guard, not a behaviour test: this repo's component tests are
 * `renderToStaticMarkup` tests with no jsdom, so a submit path cannot be driven
 * here. What can be pinned is the rule itself — a component that awaits a
 * server action must not follow it with `router.refresh()`.
 *
 * Why: when an action calls `revalidatePath`/`updateTag`/`refresh`, mutates
 * cookies, or redirects, Next re-renders the current route inside the action's
 * own response ("A single response carries data and UI", Next docs,
 * `01-app/02-guides/server-actions.md`). A client `router.refresh()` afterwards
 * renders the whole page a second time — several extra DB round trips per
 * click, which is seconds on the slow free host.
 *
 * `components/auth/*` is exempt: login/register/reset/logout go through the
 * Better Auth client over HTTP, not server actions, so nothing re-renders for
 * them and their refresh is the only one. (The error-boundary retry buttons
 * live under `app/`, outside this scan.)
 */
const COMPONENTS_DIR = join(process.cwd(), 'components')
const EXEMPT_DIR = join(COMPONENTS_DIR, 'auth')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return path === EXEMPT_DIR ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('server-action call sites', () => {
  it('never follow an action with router.refresh()', () => {
    const offenders = sourceFiles(COMPONENTS_DIR)
      .filter((file) => /\brouter\.refresh\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file).split(sep).join('/'))
    expect(offenders).toEqual([])
  })
})
