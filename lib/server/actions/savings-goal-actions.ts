'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { mapCommonActionError } from './map-action-error'
import { ArchivedAccountError } from '@/lib/server/services/account-lock'
import {
  addSavingsGoalEntry,
  archiveSavingsGoal,
  createSavingsGoal,
  deleteSavingsGoalEntry,
  updateSavingsGoal,
  updateSavingsGoalEntry,
  updateSavingsGoalProgress,
  SavingsGoalArchivedError,
  SavingsGoalCurrencyLockedError,
  SavingsGoalLinkedError,
  SavingsGoalWithdrawalExceedsProgressError,
  type SavingsGoalContext,
} from '@/lib/server/services/savings-goal'
import {
  createSavingsGoalSchema,
  savingsGoalEntrySchema,
  updateSavingsGoalProgressSchema,
  updateSavingsGoalSchema,
  type CreateSavingsGoalInput,
  type SavingsGoalEntryInput,
  type UpdateSavingsGoalInput,
  type UpdateSavingsGoalProgressInput,
} from '@/lib/validation/savings-goal'
import { resolveProfileDefaults } from '@/lib/validation/profile'

/**
 * Server actions never throw a domain error to the client: every mapped
 * failure comes back as `{ ok: false, error: <code> }` so the form can render
 * a fixed, translatable message instead of an English `Error#message`.
 * Anything unmapped rethrows — a genuine bug should surface, not vanish into
 * a silent `ok: false` the UI shrugs off.
 *
 * `input`/`id` always come from the client; `userId` never does — every call
 * into the service below is `(user.id, ...)` from `requireUser()`. Each action
 * `parse`s its input at the edge, as `debt-actions.ts` does: an entry write
 * takes the goal's row lock inside a transaction, and its date is a calendar
 * string the service turns into a carrier — parsing first keeps a doomed
 * request from opening a transaction and maps it to INVALID_INPUT rather than a
 * bare `RangeError`. The service re-parses regardless; it trusts no caller.
 *
 * Nothing here moves money (a linked goal *reads* its account's balance), so
 * nothing here revalidates a ledger page: `/goals` is the page that changed,
 * and `/dashboard` because its widget reads the same goals. `/accounts` and
 * `/transactions` are deliberately absent — a savings goal cannot alter either.
 *
 * Codes beyond the shared tail: `ARCHIVED` (the goal), `ARCHIVED_ACCOUNT` (a
 * new link to an archived account), `CURRENCY_LOCKED` (an edit that would
 * re-denominate a goal's entries), `LINKED` (an entry on a goal whose progress
 * is its account's balance) and `WITHDRAWAL_EXCEEDS_PROGRESS` (an entry write
 * that would take progress below zero). An entry dated after the user's today
 * (ruling P11) is a field error of the entry schema, so it is INVALID_INPUT.
 */
export type SavingsGoalActionError =
  | 'ARCHIVED'
  | 'ARCHIVED_ACCOUNT'
  | 'CURRENCY_LOCKED'
  | 'LINKED'
  | 'WITHDRAWAL_EXCEEDS_PROGRESS'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'

export type SavingsGoalActionResult = { ok: true } | { ok: false; error: SavingsGoalActionError }

function mapError(e: unknown): SavingsGoalActionResult {
  if (e instanceof SavingsGoalArchivedError) return { ok: false, error: 'ARCHIVED' }
  if (e instanceof ArchivedAccountError) return { ok: false, error: 'ARCHIVED_ACCOUNT' }
  if (e instanceof SavingsGoalCurrencyLockedError) return { ok: false, error: 'CURRENCY_LOCKED' }
  if (e instanceof SavingsGoalLinkedError) return { ok: false, error: 'LINKED' }
  if (e instanceof SavingsGoalWithdrawalExceedsProgressError) {
    return { ok: false, error: 'WITHDRAWAL_EXCEEDS_PROGRESS' }
  }
  return mapCommonActionError(e)
}

/** The session user's zone — "today" is decided there: the date of an
 *  opening contribution, and the latest date an entry may carry.
 *  `resolveProfileDefaults` cannot throw: it falls back to CashFlow's defaults
 *  for an out-of-enum stored value. */
function goalContext(user: Parameters<typeof resolveProfileDefaults>[0]): SavingsGoalContext {
  return { timezone: resolveProfileDefaults(user).timezone }
}

/** An entry, parsed against the session user's today (ruling P11). */
function parseEntry(input: SavingsGoalEntryInput, context: SavingsGoalContext) {
  return savingsGoalEntrySchema(todayCalendarDateInZone(context.timezone)).parse(input)
}

/** Both pages a goal appears on. Called only after a write actually happened,
 *  so a rejected action leaves the caches alone. */
function revalidateGoalPages(): void {
  revalidatePath('/goals')
  revalidatePath('/dashboard')
}

export async function createSavingsGoalAction(
  input: CreateSavingsGoalInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await createSavingsGoal(user.id, createSavingsGoalSchema.parse(input), goalContext(user))
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

export async function updateSavingsGoalAction(
  id: string,
  input: UpdateSavingsGoalInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await updateSavingsGoal(user.id, id, updateSavingsGoalSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

/** "+ Góp / Contribute" or "− Rút / Withdraw" on an unlinked goal. */
export async function addSavingsGoalEntryAction(
  goalId: string,
  input: SavingsGoalEntryInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    const context = goalContext(user)
    await addSavingsGoalEntry(user.id, goalId, parseEntry(input, context), context)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

/** Corrects one entry of a goal's history. Same input shape as adding one. */
export async function updateSavingsGoalEntryAction(
  entryId: string,
  input: SavingsGoalEntryInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    const context = goalContext(user)
    await updateSavingsGoalEntry(user.id, entryId, parseEntry(input, context), context)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

export async function deleteSavingsGoalEntryAction(
  entryId: string,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await deleteSavingsGoalEntry(user.id, entryId)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

/**
 * @deprecated Transitional (money-source linking Task 9 → Task 10): the action
 * behind the Savings page's existing "Cập nhật tiến độ / Update progress"
 * dialog. The absolute figure it posts is recorded as the difference — one
 * contribution or withdrawal dated today — never stored. Task 10 replaces the
 * dialog with contribute/withdraw and removes this action and its service.
 */
export async function updateSavingsGoalProgressAction(
  id: string,
  input: UpdateSavingsGoalProgressInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await updateSavingsGoalProgress(
      user.id,
      id,
      updateSavingsGoalProgressSchema.parse(input),
      goalContext(user),
    )
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

export async function archiveSavingsGoalAction(id: string): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await archiveSavingsGoal(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}
