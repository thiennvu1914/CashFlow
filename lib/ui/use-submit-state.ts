import { useCallback, useState } from 'react'

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

export function useSubmitState(): SubmitState {
  const [pending, setPending] = useState(false)

  const run = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      // A guard, not just an optimisation: `run` can be reached from a
      // keyboard Enter and a click in the same tick before React has
      // re-rendered the disabled fieldset.
      if (pending) return undefined
      setPending(true)
      try {
        return await work()
      } finally {
        setPending(false)
      }
    },
    [pending],
  )

  return { pending, locked: pending, busy: pending ? true : undefined, run }
}
