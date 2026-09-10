import { useCallback, useRef, useState } from 'react'

/**
 * The in-flight lock every mutating form uses (spec §9).
 *
 * `useHydrated()` answers "may the user touch this form yet?"; this answers
 * "is a submission already on its way?". They are independent reasons to
 * disable the same `<fieldset>`, and both are expressed there:
 *
 *   <fieldset disabled={!hydrated || locked} aria-busy={busy}>
 *
 * A `<fieldset disabled>` is the one native mechanism that disables everything
 * inside it, submit button included, so a second submit is impossible while the
 * first is running — without any per-control `disabled` prop, and without
 * introducing controlled state (which would trip the Base UI warning the spec
 * forbids silencing that way).
 *
 * `run` always unlocks, success or failure: a form that stayed locked after a
 * rejected submit would strand the user with their own typing.
 */
export interface SubmitState {
  pending: boolean
  /** `disabled` for the `<fieldset>` — true while pending. */
  locked: boolean
  /** `aria-busy` for the `<fieldset>` — `true` while pending, else `undefined`. */
  busy: true | undefined
  /** Wraps a submit handler: locks, awaits, always unlocks. */
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>
}

/**
 * The lock's state machine, with no React import: `isPending`/`setPending` are
 * handed in rather than closed over a `useState` pair, so the re-entry guard
 * and the unlock-on-resolve/unlock-on-throw paths can be unit-tested with a
 * plain boolean and a spy — no DOM, no jsdom, no Testing Library (none of
 * which this repo has) — while `useSubmitState` stays a thin wrapper over it.
 *
 * `run` does not catch: if `work` rejects, `run`'s own promise rejects with
 * the same error (the `finally` still unlocks first) rather than swallowing
 * it and returning `undefined` — a caller that needs to show an inline error
 * for a failed submit has to see the rejection to do it.
 */
export function createSubmitRunner(
  isPending: () => boolean,
  setPending: (pending: boolean) => void,
): <T>(work: () => Promise<T>) => Promise<T | undefined> {
  return async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    // A guard, not just an optimisation: `run` can be reached from a
    // keyboard Enter and a click in the same tick before React has
    // re-rendered the disabled fieldset.
    if (isPending()) return undefined
    setPending(true)
    try {
      return await work()
    } finally {
      setPending(false)
    }
  }
}

export function useSubmitState(): SubmitState {
  const [pending, setPendingState] = useState(false)
  /**
   * The re-entry guard's REAL source of truth. `pending` (the `useState`
   * pair above) exists to trigger a re-render — for the fieldset's `disabled`/
   * `aria-busy` — but a re-render is not instantaneous: React defers it to the
   * next flush, so a SECOND `run()` invoked before that flush (two clicks
   * dispatched back to back with no task boundary between them — verified
   * against a real browser, not merely a theoretical race) would still read
   * the STALE closed-over `pending` from the render the first call started
   * in, and the guard would not fire. A ref has no such delay: writing
   * `pendingRef.current` is visible to every reader immediately, synchronously,
   * regardless of whether React has re-rendered yet — which is what makes two
   * clicks landing in the same tick create exactly one submission rather than
   * two.
   */
  const pendingRef = useRef(false)

  const setPending = useCallback((next: boolean) => {
    pendingRef.current = next
    setPendingState(next)
  }, [])

  const run = useCallback(
    <T>(work: () => Promise<T>) => createSubmitRunner(() => pendingRef.current, setPending)(work),
    [setPending],
  )

  return { pending, locked: pending, busy: pending ? true : undefined, run }
}
