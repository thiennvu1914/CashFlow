'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { mapCommonActionError } from './map-action-error'
import {
  acknowledgeOccurrence,
  createReminder,
  dismissOccurrence,
  payOccurrence,
  setReminderActive,
  InvalidReminderAccountError,
  InvalidReminderCategoryError,
  OccurrenceNotPendingError,
  type PayOccurrenceResult,
} from '@/lib/server/services/reminder'
import { createReminderSchema, type CreateReminderInput } from '@/lib/validation/reminder'
import { resolveProfileDefaults } from '@/lib/validation/profile'

/**
 * Server actions never throw a domain error to the client: every mapped
 * failure comes back as `{ ok: false, error: <code> }` so the form can render
 * a fixed, translatable message instead of an English `Error#message`.
 * Anything unmapped rethrows — a genuine bug should surface, not vanish into
 * a silent `ok: false` the UI shrugs off.
 *
 * `input`/`id` always come from the client; `userId` never does — every call
 * into the service below is `(user.id, ...)` from `requireUser()`. Neither does
 * the **timezone**, and that is this layer's own concern: `createReminder`
 * turns `startDate` into the instant of *local* midnight in the zone it is
 * handed, so a client-supplied zone would move the day a reminder starts on,
 * and the server's would move it for every user who does not live in UTC. It
 * comes from `resolveProfileDefaults(user)` — which also means a stored value
 * that is not a real IANA zone falls back to CashFlow's default instead of
 * reaching `date-fns-tz` and raising a `RangeError` a page render cannot
 * answer.
 *
 * `createReminderAction` parses the input itself before calling the service,
 * the same shape (and for the same two reasons) as `loan-actions.ts`: a
 * rejected input costs no database work, and `startDate` is a calendar string
 * the service turns into a UTC carrier with `calendarDateToUtcCarrier`, which
 * raises a bare `RangeError` (not a `ZodError`) for a value that never passed
 * the schema — an unmapped error rather than "check the highlighted fields".
 * The service re-parses, exactly as it does for every other caller.
 *
 * **Only Paid moves money.** "Chỉ đánh dấu / Mark only" and "Bỏ qua / Dismiss"
 * record the user's answer and write no Transaction, no Transfer and no account
 * balance, so they revalidate `/reminders` (the page that changed) and
 * `/dashboard` (whose widget reads the same occurrences) and no ledger page.
 * "Đã trả / Paid" (`payOccurrenceAction`, money-source linking spec 2026-10-12
 * §6.6) is the exception: when it records the transaction, `/transactions` and
 * `/accounts` change too.
 *
 * `OCCURRENCE_NOT_PENDING` is Paid's answer to an occurrence already answered
 * (a stale tab, a double tap): recording it again would count the bill twice.
 * `FX_UNAVAILABLE` is Paid's too — the transaction it records snapshots the
 * live rate, and an outage writes nothing.
 */
export type ReminderActionError =
  | 'INVALID_CATEGORY'
  | 'INVALID_ACCOUNT'
  | 'OCCURRENCE_NOT_PENDING'
  | 'FX_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'

export type ReminderActionResult = { ok: true } | { ok: false; error: ReminderActionError }

/** Paid's answer: what happened, for the button to act on — the recorded
 *  transaction to offer an edit link to, or the occurrence whose pre-filled
 *  form to open. */
export type PayOccurrenceActionResult =
  { ok: true; data: PayOccurrenceResult } | { ok: false; error: ReminderActionError }

function mapError(e: unknown): { ok: false; error: ReminderActionError } {
  // The *class* is what is mapped, never the error's `reason`: "no such
  // category", "not your category", "wrong type of category" and "archived
  // category" are one code on purpose, or the message becomes an oracle for
  // which ids exist.
  if (e instanceof InvalidReminderCategoryError) return { ok: false, error: 'INVALID_CATEGORY' }
  if (e instanceof InvalidReminderAccountError) return { ok: false, error: 'INVALID_ACCOUNT' }
  if (e instanceof OccurrenceNotPendingError) return { ok: false, error: 'OCCURRENCE_NOT_PENDING' }
  if (isFxUnavailableError(e)) return { ok: false, error: 'FX_UNAVAILABLE' }
  return mapCommonActionError(e)
}

/** Both pages a reminder appears on. Called only after a write actually
 *  happened, so a rejected action leaves the caches alone. */
function revalidateReminderPages(): void {
  revalidatePath('/reminders')
  revalidatePath('/dashboard')
}

export async function createReminderAction(
  input: CreateReminderInput,
): Promise<ReminderActionResult> {
  const user = await requireUser()
  // Resolved before the `try`: `resolveProfileDefaults` cannot throw (it
  // `safeParse`s every field and falls back), so there is nothing here for
  // `mapError` to answer for.
  const { timezone } = resolveProfileDefaults(user)
  try {
    // Inside the `try`, so a `ZodError` from the parse is mapped by the same
    // clause as one raised by the service.
    await createReminder(user.id, timezone, createReminderSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateReminderPages()
  return { ok: true }
}

/**
 * Pauses or resumes a reminder. `active` is a boolean the caller sends, and the
 * only thing about a reminder a client may change after creation — the
 * schedule itself is fixed at creation, so there is no update schema here.
 */
export async function setReminderActiveAction(
  id: string,
  active: boolean,
): Promise<ReminderActionResult> {
  const user = await requireUser()
  try {
    await setReminderActive(user.id, id, active)
  } catch (e) {
    return mapError(e)
  }
  revalidateReminderPages()
  return { ok: true }
}

/**
 * "Chỉ đánh dấu / Mark only" — the user has dealt with it and records no
 * transaction for it here.
 *
 * No `now` is passed: `actionedAt` records when the *server* took the answer,
 * and a client-supplied clock would let a stale tab backdate a decision. The
 * service is idempotent, so a double-clicked button or a re-submitted stale
 * page comes back `ok` rather than as a failure about a state the user already
 * has — and it never flips one answer into the other.
 */
export async function acknowledgeOccurrenceAction(id: string): Promise<ReminderActionResult> {
  const user = await requireUser()
  try {
    await acknowledgeOccurrence(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidateReminderPages()
  return { ok: true }
}

/** "This one does not apply" — the subscription was cancelled, the month was
 *  skipped. A distinct state from acknowledged because the two mean different
 *  things about the same due date. */
export async function dismissOccurrenceAction(id: string): Promise<ReminderActionResult> {
  const user = await requireUser()
  try {
    await dismissOccurrence(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidateReminderPages()
  return { ok: true }
}

/**
 * "Đã trả / Paid" — records the occurrence's transaction in one tap, or says
 * which pre-filled form to open instead (spec 2026-10-12 §2 Q6, §6.6).
 *
 * The zone is the session user's, like `createReminderAction`'s: the
 * transaction is dated on the due day the user's list shows, in that zone. No
 * `now` and no provider override — the server's clock and the real FX policy.
 *
 * Only a recorded transaction revalidates anything, and then every page it
 * changes: the occurrence leaves the due list (`/reminders`, `/dashboard`), and
 * the ledger and the balances move (`/transactions`, `/accounts`). A
 * `needs-form` answer wrote nothing.
 */
export async function payOccurrenceAction(
  occurrenceId: string,
): Promise<PayOccurrenceActionResult> {
  const user = await requireUser()
  const { timezone } = resolveProfileDefaults(user)
  let result: PayOccurrenceResult
  try {
    result = await payOccurrence(user.id, occurrenceId, timezone)
  } catch (e) {
    return mapError(e)
  }
  if (result.status === 'created') {
    revalidateReminderPages()
    revalidatePath('/transactions')
    revalidatePath('/accounts')
  }
  return { ok: true, data: result }
}
