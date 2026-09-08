import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { useSubmitState } from './use-submit-state'

/**
 * No jsdom and no Testing Library in this repo, so the hook is exercised the
 * one way a server render allows: its INITIAL state, which is the state the
 * server HTML is built from and therefore the one a hydration bug would
 * expose. The in-flight transition itself is covered end-to-end by
 * `e2e/phase7-a11y-forms.spec.ts`'s double-submit test, which is where a lock
 * can actually be observed.
 */
function Probe() {
  const { pending, locked, busy } = useSubmitState()
  return (
    <fieldset data-pending={String(pending)} disabled={locked} aria-busy={busy}>
      <button type="submit">go</button>
    </fieldset>
  )
}

describe('useSubmitState', () => {
  it('starts unlocked, so the server HTML is never a disabled form', () => {
    const html = renderToStaticMarkup(<Probe />)
    expect(html).toContain('data-pending="false"')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('aria-busy')
  })
})
