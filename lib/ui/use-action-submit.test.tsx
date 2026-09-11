import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSubmitRunner } from './use-submit-state'
import { digestOf, runActionSubmit, useActionSubmit, type ActionFailure } from './use-action-submit'

/**
 * Same constraint, and therefore the same shape, as `use-submit-state.test.tsx`:
 * no jsdom and no Testing Library in this repo, so the HOOK is exercised only
 * for its initial (server-render) state, and the whole in-flight policy —
 * clear, refuse, throw, settle, guard — is exercised against
 * `runActionSubmit`, the pure async function the hook wraps, with a plain
 * boolean lock (`createSubmitRunner`) and spies standing in for React state.
 *
 * `t` is the identity function in every test below, so the assertions read as
 * the i18n KEY each path resolves to. That is exactly what the real callers
 * pass to `t`, and it keeps these tests independent of the copy in
 * `messages/{vi,en}`.
 */

const t = (key: string) => key

/** A minimal `useState`-alike lock, as in `use-submit-state.test.tsx`. */
function pendingBox() {
  let pending = false
  return {
    isPending: () => pending,
    setPending: (next: boolean) => {
      pending = next
    },
  }
}

function harness() {
  const box = pendingBox()
  const run = createSubmitRunner(box.isPending, box.setPending)
  return { ...box, run }
}

afterEach(() => {
  vi.restoreAllMocks()
})

function Probe() {
  const { pending, locked, busy } = useActionSubmit(t)
  return (
    <fieldset data-pending={String(pending)} disabled={locked} aria-busy={busy}>
      <button type="submit">go</button>
    </fieldset>
  )
}

describe('useActionSubmit', () => {
  it('starts unlocked, so the server HTML is never a disabled form', () => {
    const html = renderToStaticMarkup(<Probe />)
    expect(html).toContain('data-pending="false"')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('aria-busy')
  })
})

describe('digestOf', () => {
  it('reads the digest Next attaches to a server-action error', () => {
    expect(digestOf(Object.assign(new Error('x'), { digest: '2851135023' }))).toBe('2851135023')
  })

  it('is undefined for anything without a string digest', () => {
    expect(digestOf(new Error('plain'))).toBeUndefined()
    expect(digestOf({ digest: 42 })).toBeUndefined()
    expect(digestOf(null)).toBeUndefined()
    expect(digestOf('boom')).toBeUndefined()
  })
})

describe('runActionSubmit', () => {
  const ERROR_KEYS = { ARCHIVED: 'errors.goal.ARCHIVED' } as const

  it('clears the error sink before the attempt, and locks while in flight', async () => {
    const { run, isPending } = harness()
    const onError = vi.fn<(failure: ActionFailure | null) => void>()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))

    const pending = runActionSubmit(run, t, {
      tag: 'Probe: failed',
      action: async () => {
        await gate
        return { ok: true } as const
      },
      onError,
    })

    // Cleared synchronously, BEFORE the lock and therefore before the
    // duplicate-submit guard can refuse anything — the same order the
    // hand-written handlers had (`setError(null)` above `submit.run`).
    expect(onError).toHaveBeenCalledExactlyOnceWith(null)
    expect(isPending()).toBe(true)

    release()
    await pending
    expect(isPending()).toBe(false)
  })

  it('calls onSettled then onSuccess when the action succeeds', async () => {
    const { run, isPending } = harness()
    const order: string[] = []
    const onError = vi.fn<(failure: ActionFailure | null) => void>()

    await runActionSubmit(run, t, {
      tag: 'Probe: failed',
      action: async () => ({ ok: true }) as const,
      onError,
      onSettled: () => order.push('settled'),
      onSuccess: () => order.push('success'),
    })

    expect(order).toEqual(['settled', 'success'])
    expect(onError.mock.calls).toEqual([[null]])
    expect(isPending()).toBe(false)
  })

  it('maps a refused code to its localized key and never calls onSuccess', async () => {
    const { run } = harness()
    const onError = vi.fn<(failure: ActionFailure | null) => void>()
    const onSuccess = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runActionSubmit(run, t, {
      tag: 'Probe: failed',
      action: async () => ({ ok: false, error: 'ARCHIVED' }) as const,
      errorKeys: ERROR_KEYS,
      onError,
      onSuccess,
    })

    expect(onError.mock.calls).toEqual([
      [null],
      [{ message: 'errors.goal.ARCHIVED', code: 'ARCHIVED' }],
    ])
    expect(onSuccess).not.toHaveBeenCalled()
    // A refusal is an answer, not a defect: it is not logged (unchanged from
    // the hand-written handlers).
    expect(log).not.toHaveBeenCalled()
  })

  it('settles the caller (closing its dialog) before reporting a refusal', async () => {
    const { run } = harness()
    const order: string[] = []

    await runActionSubmit(run, t, {
      tag: 'Probe: failed',
      action: async () => ({ ok: false, error: 'ARCHIVED' }) as const,
      errorKeys: ERROR_KEYS,
      onError: (failure) => order.push(failure === null ? 'cleared' : 'reported'),
      onSettled: () => order.push('settled'),
    })

    expect(order).toEqual(['cleared', 'settled', 'reported'])
  })

  it('falls back to the generic key rather than rendering undefined for an unmapped code', async () => {
    const { run } = harness()
    const onError = vi.fn<(failure: ActionFailure | null) => void>()

    await runActionSubmit(run, t, {
      tag: 'Probe: failed',
      action: async () => ({ ok: false, error: 'SOMETHING_NEW' }) as const,
      errorKeys: ERROR_KEYS as Record<string, string>,
      onError,
    })

    expect(onError).toHaveBeenLastCalledWith({
      message: 'errors.generic',
      code: 'SOMETHING_NEW',
    })
  })

  it("retains a thrown error's digest on the failure and logs it under the fixed tag", async () => {
    const { run, isPending } = harness()
    const onError = vi.fn<(failure: ActionFailure | null) => void>()
    const onSuccess = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const thrown = Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest: '3948213570',
    })

    await runActionSubmit(run, t, {
      tag: 'GoalForm: create failed',
      action: async () => {
        throw thrown
      },
      errorKeys: ERROR_KEYS,
      onError,
      onSuccess,
    })

    expect(onError).toHaveBeenLastCalledWith({
      message: 'errors.generic',
      digest: '3948213570',
    })
    // The digest is the only correlation handle between this browser and the
    // server stack trace, and it must reach the console — the message must not
    // (pre-flight A-4).
    expect(log).toHaveBeenCalledExactlyOnceWith('GoalForm: create failed', {
      digest: '3948213570',
    })
    expect(log.mock.calls[0]?.join(' ')).not.toContain('Server Components render')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(isPending()).toBe(false)
  })

  it('logs the bare tag when the thrown error carries no digest', async () => {
    const { run } = harness()
    const onError = vi.fn<(failure: ActionFailure | null) => void>()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runActionSubmit(run, t, {
      tag: 'GoalForm: create failed',
      action: async () => {
        throw new Error('network')
      },
      onError,
    })

    expect(log).toHaveBeenCalledExactlyOnceWith('GoalForm: create failed')
    expect(onError).toHaveBeenLastCalledWith({ message: 'errors.generic' })
  })

  it('never rejects, so a caller needs no try/catch of its own', async () => {
    const { run } = harness()
    await expect(
      runActionSubmit(run, t, {
        tag: 'Probe: failed',
        action: async () => {
          throw new Error('boom')
        },
        onError: () => {},
      }),
    ).resolves.toBeUndefined()
  })

  it('treats a void action (no discriminated result) as success', async () => {
    const { run } = harness()
    const onSuccess = vi.fn()
    const onError = vi.fn<(failure: ActionFailure | null) => void>()

    await runActionSubmit(run, t, {
      tag: 'CategoryChipList: create failed',
      action: async () => {},
      onError,
      onSuccess,
    })

    expect(onSuccess).toHaveBeenCalledOnce()
    expect(onError.mock.calls).toEqual([[null]])
  })

  it('refuses a second submit while the first is still in flight', async () => {
    const { run } = harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const first = vi.fn(async () => {
      await gate
      return { ok: true } as const
    })
    const second = vi.fn(async () => ({ ok: true }) as const)

    const inFlight = runActionSubmit(run, t, {
      tag: 'Probe: failed',
      action: first,
      onError: () => {},
    })
    await runActionSubmit(run, t, {
      tag: 'Probe: failed',
      action: second,
      onError: () => {},
    })

    expect(second).not.toHaveBeenCalled()

    release()
    await inFlight
    expect(first).toHaveBeenCalledOnce()
  })

  it('allows a new submit once the previous one has settled', async () => {
    const { run } = harness()
    const action = vi.fn(async () => ({ ok: true }) as const)

    await runActionSubmit(run, t, { tag: 'Probe: failed', action, onError: () => {} })
    await runActionSubmit(run, t, { tag: 'Probe: failed', action, onError: () => {} })

    expect(action).toHaveBeenCalledTimes(2)
  })
})
