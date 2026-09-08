'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import {
  acknowledgeOccurrence,
  createReminder,
  dismissOccurrence,
  setReminderActive,
  InvalidReminderAccountError,
  InvalidReminderCategoryError,
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
 * **Nothing here moves money.** A reminder is not a Transaction (spec §4.7,
 * directive M): acknowledging a bill records that the user dealt with it and
 * writes no Transaction, no Transfer and no account balance. So nothing here
 * revalidates a ledger page: `/reminders` is the page that changed, and
 * `/dashboard` because a later group's widget reads the same occurrences.
 * `/accounts` and `/transactions` are deliberately absent.
 */
export type ReminderActionError =
  'INVALID_CATEGORY' | 'INVALID_ACCOUNT' | 'INVALID_INPUT' | 'NOT_FOUND'

export type ReminderActionResult = { ok: true } | { ok: false; error: ReminderActionError }

function mapError(e: unknown): ReminderActionResult {
  // The *class* is what is mapped, never the error's `reason`: "no such
  // category", "not your category", "wrong type of category" and "archived
  // category" are one code on purpose, or the message becomes an oracle for
  // which ids exist.
  if (e instanceof InvalidReminderCategoryError) return { ok: false, error: 'INVALID_CATEGORY' }
  if (e instanceof InvalidReminderAccountError) return { ok: false, error: 'INVALID_ACCOUNT' }
  if (e instanceof ZodError) return { ok: false, error: 'INVALID_INPUT' }
  // What a foreign (or deleted) occurrence or reminder id resolves to: every
  // service read goes through the composite `userId_id` key, so another user's
  // id is a P2025 rather than a usable reference.
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return { ok: false, error: 'NOT_FOUND' }
  }
  throw e
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
 * "I have dealt with this" — the bill is paid, the salary arrived.
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
