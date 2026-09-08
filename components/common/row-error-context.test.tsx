import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { RowErrorAlert, RowErrorProvider } from './row-error-context'

/**
 * A markup test only — `renderToStaticMarkup` has no interactivity, so it can
 * pin the INITIAL render (no error yet) but not the set-error/read-error
 * round trip itself, which only a real browser exercises. That round trip is
 * covered by `e2e/phase7-budgets-goals.spec.ts`'s delete/archive-failure
 * flows, which land on a row still carrying a visible InlineAlert after the
 * ConfirmDialog closes.
 */
describe('RowErrorProvider / RowErrorAlert', () => {
  it('renders its children, with RowErrorAlert emitting nothing before any error is set', () => {
    const html = renderToStaticMarkup(
      <RowErrorProvider>
        <span>row content</span>
        <RowErrorAlert />
      </RowErrorProvider>,
    )
    expect(html).toContain('row content')
    // No InlineAlert markup at all when `error` is still null.
    expect(html).not.toContain('role="alert"')
  })

  it('throws a clear error if RowErrorAlert is used outside a RowErrorProvider', () => {
    expect(() => renderToStaticMarkup(<RowErrorAlert />)).toThrow(
      'useRowError must be called from inside a RowErrorProvider',
    )
  })
})
