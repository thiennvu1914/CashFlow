import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSubmitRunner, useSubmitState } from './use-submit-state'

/**
 * No jsdom and no Testing Library in this repo, so the hook itself is
 * exercised the one way a server render allows: its INITIAL state, which is
 * the state the server HTML is built from and therefore the one a hydration
 * bug would expose. The in-flight transition — the re-entry guard, and
 * unlocking on both resolve and throw — is covered below against
 * `createSubmitRunner`, the pure state machine `useSubmitState` wraps, with a
 * plain boolean and a spy standing in for `useState`.
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

/** A minimal `useState`-alike: a mutable box plus a setter, for `createSubmitRunner`. */
function pendingBox() {
  let pending = false
  return {
    isPending: () => pending,
    setPending: (next: boolean) => {
      pending = next
    },
  }
}

describe('createSubmitRunner', () => {
  it('does not invoke work and returns undefined while a run is already pending', async () => {
    const { isPending, setPending } = pendingBox()
    const run = createSubmitRunner(isPending, setPending)

    let resolveFirst!: (value: string) => void
    const firstWork = vi.fn(() => new Promise<string>((resolve) => (resolveFirst = resolve)))
    const first = run(firstWork)

    // `run` sets the lock synchronously before its first `await`, so by the
    // time control returns here (still before `first` has settled) a second
    // call must already see the lock and refuse to invoke its own work.
    expect(isPending()).toBe(true)
    const secondWork = vi.fn(async () => 'should never run')
    const second = await run(secondWork)

    expect(second).toBeUndefined()
    expect(secondWork).not.toHaveBeenCalled()

    resolveFirst('first result')
    await expect(first).resolves.toBe('first result')
  })

  it('unlocks after work resolves, and passes the resolved value through', async () => {
    const { isPending, setPending } = pendingBox()
    const run = createSubmitRunner(isPending, setPending)

    await expect(run(async () => 42)).resolves.toBe(42)
    expect(isPending()).toBe(false)
  })

  it('unlocks and rethrows when work throws, rather than swallowing the error', async () => {
    const { isPending, setPending } = pendingBox()
    const run = createSubmitRunner(isPending, setPending)
    const error = new Error('boom')

    await expect(
      run(async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(isPending()).toBe(false)
  })

  it('allows a new run once the previous one has settled', async () => {
    const { isPending, setPending } = pendingBox()
    const run = createSubmitRunner(isPending, setPending)

    await run(async () => 'one')
    const secondWork = vi.fn(async () => 'two')
    await expect(run(secondWork)).resolves.toBe('two')
    expect(secondWork).toHaveBeenCalledOnce()
  })
})
