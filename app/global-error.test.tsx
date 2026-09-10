import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import GlobalError, { detectTheme } from './global-error'

/**
 * `global-error.tsx` never reaches `next-intl` (see its own doc comment), so
 * unlike `not-found.test.tsx` there is nothing to mock here — this renders
 * the component exactly as a browser would on first paint, before its
 * locale-detection effect (which `renderToStaticMarkup` never runs) has a
 * chance to fire. That first paint is also the one a server-rendered failure
 * on the very first request would show, which is precisely the case this
 * file's `DEFAULT_LOCALE`-first design exists for.
 */
function crashedError(): Error & { digest?: string } {
  // A message and a stack deliberately shaped to be unmistakable if either
  // ever leaked into the markup — real errors here could carry account
  // names or balances (see app/(app)/error.tsx's doc comment), so the
  // boundary must never render `.message` or `.stack`.
  const error = new Error('SECRET-BALANCE-12345.67 VND at account acc_9')
  error.stack = 'Error: SECRET-BALANCE-12345.67 VND\n    at renderPage (secret/path.ts:42:7)'
  return Object.assign(error, { digest: 'a1b2c3d4' })
}

describe('GlobalError (app/global-error.tsx)', () => {
  it('renders exactly one heading, a safe sentence, a retry action and a home link', () => {
    const html = renderToStaticMarkup(<GlobalError error={crashedError()} retry={() => {}} />)

    expect(html.match(/<h1[ >]/g)).toHaveLength(1)
    expect(html).toContain('Không tải được ứng dụng.')
    expect(html).toContain('Thử lại')
    expect(html).toContain('href="/"')
  })

  it('never renders error.message or error.stack — only the opaque digest', () => {
    const html = renderToStaticMarkup(<GlobalError error={crashedError()} retry={() => {}} />)

    expect(html).not.toContain('SECRET-BALANCE')
    expect(html).not.toContain('renderPage')
    expect(html).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/)
    expect(html).toContain('a1b2c3d4')
  })

  it('omits the reference line entirely when there is no digest to show', () => {
    const bare = Object.assign(new Error('no digest here'), { digest: undefined })
    const html = renderToStaticMarkup(<GlobalError error={bare} retry={() => {}} />)

    expect(html).not.toContain('no digest here')
    expect(html).not.toMatch(/Mã tham chiếu|Reference:/)
  })
})

/**
 * The dark class on `<html>` comes from `useSyncExternalStore`'s
 * `getServerSnapshot`, which is a hard-coded `() => DEFAULT_THEME` — Next
 * always uses that branch (never `subscribe`/`getSnapshot`) for a
 * `renderToStaticMarkup` render, so a static-markup test can never exercise a
 * dark cookie through the component itself (the test above only ever proves
 * the light, no-cookie first paint). This test harness has no seam to inject
 * a different server snapshot, so per the finding this covers the pure cookie
 * parser directly instead — this file's `vitest.config.ts` runs Vitest with
 * no DOM environment, so `document` is stubbed by hand rather than via jsdom.
 */
describe('detectTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads dark from the cashflow-theme cookie', () => {
    vi.stubGlobal('document', { cookie: 'NEXT_LOCALE=en; cashflow-theme=dark' })
    expect(detectTheme()).toBe('dark')
  })

  it('falls back to light when the cookie is absent or holds an unknown value', () => {
    vi.stubGlobal('document', { cookie: '' })
    expect(detectTheme()).toBe('light')

    vi.stubGlobal('document', { cookie: 'cashflow-theme=neon' })
    expect(detectTheme()).toBe('light')
  })
})
