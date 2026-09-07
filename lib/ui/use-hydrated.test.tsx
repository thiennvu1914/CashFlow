import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { useHydrated } from './use-hydrated'

/**
 * The one thing about `useHydrated` a non-browser test can prove, and the one
 * thing the money forms depend on: the SERVER snapshot is `false`.
 *
 * That is what puts `disabled` on the `<fieldset>` in the HTML the browser
 * paints first, and it is also what makes the client's hydration render agree
 * with that HTML (React uses `getServerSnapshot` while hydrating too —
 * `react-dom-client.development.js:8112-8117`), so the gate costs no hydration
 * mismatch. The `true` half is React's own post-commit re-render and is
 * asserted where it matters, in `e2e/transaction-form-hydration.spec.ts`.
 */
function Probe() {
  return <span>{String(useHydrated())}</span>
}

describe('useHydrated', () => {
  it('renders false on the server', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>false</span>')
  })
})
