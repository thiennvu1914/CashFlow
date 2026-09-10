import { useCallback } from 'react'
import { GENERIC_ERROR_KEY } from './action-error-messages'
import { useSubmitState, type SubmitState } from './use-submit-state'

/**
 * "How a failed mutation is reported", written once (pre-flight A-3/A-4).
 *
 * Every mutating client component used to repeat the same body: clear the
 * error, `submit.run`, call the action, branch on `result.ok`, map the refused
 * code through a `*_ERROR_KEYS` map, and a bare `} catch {` that logged a fixed
 * string and threw the error object away. Twenty-six copies of one policy, so
 * every change to that policy — such as A-4's "stop discarding the digest" —
 * was twenty-six edits with an invisible failure mode: a missed site keeps
 * compiling and keeps swallowing.
 *
 * This owns the policy and NOTHING else. In particular it does not own the
 * form (react-hook-form setup, `defaultValues`, what `reset()` is given), the
 * pre-hydration gate (`useHydrated`, and the `<fieldset disabled>` contract
 * `lib/ui/use-hydrated.ts` documents), where the message is displayed (a local
 * `useState`, a per-row record, `useRowError`, or react-hook-form's
 * `setError('root', …)` — all four are passed in as `onError`), which dialog
 * closes (`onSettled`), or where a success navigates (`onSuccess`). It is a
 * hook, deliberately not a framework: no store, no context, no request layer,
 * no Result monad.
 */

/**
 * The result shape every mutating server action in this app answers with
 * (`lib/server/actions/*-actions.ts`). A refusal carries a CODE, never an
 * `Error#message`; the code is what `errorKeys` translates.
 */
export type ActionResult<E extends string> = { ok: true } | { ok: false; error: E }

/** A localized, ready-to-render failure, plus the handles a report needs. */
export interface ActionFailure {
  /** Already through `t()` — the exact string to render. */
  message: string
  /** The refused code, when the action answered `{ ok: false }`. */
  code?: string
  /**
   * Next's opaque, PII-free server-error digest, when the action THREW and
   * Next attached one. The one token that ties this browser to the server
   * stack trace, and the reason `} catch {` had to become `} catch (e) {`
   * (pre-flight A-4). Retained here so a caller can surface it as a reference
   * code; never rendered by this module.
   */
  digest?: string
}

/**
 * The error sink. Called with `null` before every attempt (so a retry starts
 * clean) and with a failure on refusal or throw — the two cases the twenty-six
 * hand-written handlers spelled out as `setError(null)` / `setError(t(…))`.
 */
export type ActionErrorSink = (failure: ActionFailure | null) => void

/** Just enough of next-intl's translator: these callers only ever pass a key. */
export type Translate = (key: string) => string

export interface ActionSubmitOptions<E extends string> {
  /** The action call, already closed over its arguments. */
  action: () => Promise<ActionResult<E> | void>
  /**
   * Refused code → i18n key, i.e. one of `lib/ui/action-error-messages.ts`'s
   * `*_ERROR_KEYS` maps. Omit only for an action whose result this caller
   * cannot see (`CategoryChipList`'s `Promise<void>` props). A code with no
   * entry falls back to `GENERIC_ERROR_KEY` rather than rendering `undefined`.
   */
  errorKeys?: Record<E, string>
  /**
   * The fixed log string for a THROWN failure, e.g.
   * `'AccountForm: create failed'`. Fixed and PII-free by construction —
   * never interpolate user input or an error message into it.
   */
  tag: string
  onError: ActionErrorSink
  /** Success only: `reset()`, `router.refresh()`, `onCreated?.()`, a notice. */
  onSuccess?: () => void
  /**
   * Both outcomes, before `onSuccess`/`onError`. This is where a destructive
   * confirmation closes itself: `ConfirmDialog`'s house pattern is to close on
   * success AND failure, because the `InlineAlert` explaining a refusal renders
   * behind the dialog's own scrim (see `components/common/confirm-dialog.tsx`).
   */
  onSettled?: () => void
}

export interface ActionSubmit {
  pending: boolean
  /** `disabled` for the `<fieldset>` — true while a submit is in flight. */
  locked: boolean
  /** `aria-busy` for the `<fieldset>` — `true` while in flight, else `undefined`. */
  busy: true | undefined
  /**
   * NOTE the difference from `useSubmitState().run`, which this wraps: that
   * one takes a bare thunk, rethrows, and resolves to the thunk's value; this
   * one takes the mutation DESCRIPTION above, never rejects, and resolves to
   * nothing — the outcome is delivered through the callbacks.
   */
  run: <E extends string>(options: ActionSubmitOptions<E>) => Promise<void>
}

/**
 * Next replaces a thrown server error's `message` with a digest before it
 * reaches the browser. Read defensively: `catch` binds `unknown`, and a
 * network failure or an aborted fetch (which is how `e2e/phase7-confirm-dialogs`
 * forces this path) carries no digest at all.
 */
export function digestOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const digest = (e as { digest?: unknown }).digest
  return typeof digest === 'string' ? digest : undefined
}

/**
 * The policy itself, with no React import — same testability reasoning as
 * `createSubmitRunner`: `run` and `t` are handed in, so every branch (clear,
 * refuse, throw, settle, guard) is exercised with a plain boolean lock and
 * spies, in a repo with no jsdom and no Testing Library.
 *
 * The sink is cleared BEFORE `run`, not inside it, so the ordering matches the
 * hand-written handlers exactly: they put `setError(null)` above
 * `submit.run(…)`, which means a duplicate submit refused by the guard still
 * cleared the previous message.
 */
export async function runActionSubmit<E extends string>(
  run: SubmitState['run'],
  t: Translate,
  { action, errorKeys, tag, onError, onSuccess, onSettled }: ActionSubmitOptions<E>,
): Promise<void> {
  onError(null)
  await run(async () => {
    try {
      const result = await action()
      if (result && !result.ok) {
        onSettled?.()
        // A refusal is an answer the user asked for, not a defect: mapped to
        // copy and shown, never logged.
        onError({ message: t(errorKeys?.[result.error] ?? GENERIC_ERROR_KEY), code: result.error })
        return
      }
      onSettled?.()
      onSuccess?.()
    } catch (e) {
      const digest = digestOf(e)
      // The digest, and only the digest: `e.message` is either React's own
      // placeholder or (in dev) a server-internal string, and neither belongs
      // in a browser console. The two-branch call keeps the no-digest output
      // byte-identical to what these handlers logged before A-4, instead of
      // printing a `{ digest: undefined }` no reader can act on.
      if (digest) console.error(tag, { digest })
      else console.error(tag)
      onSettled?.()
      onError({ message: t(GENERIC_ERROR_KEY), ...(digest ? { digest } : {}) })
    }
  })
}

/**
 * `t` is passed in rather than read from `useTranslations()` here: every caller
 * already holds the root translator for its own labels, so taking it as an
 * argument avoids a second translator per component and keeps this module free
 * of an i18n dependency (which is also what lets the tests use the identity
 * function and assert on keys).
 */
export function useActionSubmit(t: Translate): ActionSubmit {
  const { pending, locked, busy, run } = useSubmitState()
  const submit = useCallback(
    <E extends string>(options: ActionSubmitOptions<E>) => runActionSubmit(run, t, options),
    [run, t],
  )
  return { pending, locked, busy, run: submit }
}
