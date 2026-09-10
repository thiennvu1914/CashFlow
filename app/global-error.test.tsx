import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import GlobalError from './global-error'

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
    const html = renderToStaticMarkup(<GlobalError error={crashedError()} reset={() => {}} />)

    expect(html.match(/<h1[ >]/g)).toHaveLength(1)
    expect(html).toContain('Không tải được ứng dụng.')
    expect(html).toContain('Thử lại')
    expect(html).toContain('href="/"')
  })

  it('never renders error.message or error.stack — only the opaque digest', () => {
    const html = renderToStaticMarkup(<GlobalError error={crashedError()} reset={() => {}} />)

    expect(html).not.toContain('SECRET-BALANCE')
    expect(html).not.toContain('renderPage')
    expect(html).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/)
    expect(html).toContain('a1b2c3d4')
  })

  it('omits the reference line entirely when there is no digest to show', () => {
    const bare = Object.assign(new Error('no digest here'), { digest: undefined })
    const html = renderToStaticMarkup(<GlobalError error={bare} reset={() => {}} />)

    expect(html).not.toContain('no digest here')
    expect(html).not.toMatch(/Mã tham chiếu|Reference:/)
  })
})
