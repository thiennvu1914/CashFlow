'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { mapCommonActionError } from './map-action-error'
import * as transactionService from '@/lib/server/services/transaction'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { localDateTimeToInstant } from '@/lib/datetime/local-date-time'
import {
  createTransactionFormSchema,
  type CreateTransactionFormInput,
  type CreateTransactionInput,
} from '@/lib/validation/transaction'

/**
 * Server actions never throw a domain error to the client: every mapped
 * failure comes back as `{ ok: false, error: <code> }` so the form can render
 * a fixed, translatable message instead of an English `Error#message`.
 * Anything unmapped rethrows — a genuine bug should surface, not vanish into
 * a silent `ok: false` the UI shrugs off.
 *
 * `input`/`id` always come from the client; `userId` never does — every call
 * into the service below is `(user.id, ...)` from `requireUser()`, and the
 * real FX policy runs (no `providerOverride` is ever passed here).
 *
 * This layer also owns the local-date-time → instant conversion: the form
 * submits the plain `yyyy-MM-ddTHH:mm` the user entered, and only here is the
 * session user's IANA timezone known, so only here can that wall-clock moment
 * be pinned to the right instant. See `lib/datetime/local-date-time.ts`.
 *
 * `LINKED_TRANSACTION` (money-source linking spec 2026-10-12 §6.5): the row
 * belongs to a debt or loan and is changed from there. The UI never offers
 * edit or delete on such a row, so this is the answer to a stale page or a
 * crafted request, and its copy sends the user to the debt or loan.
 *
 * `OCCURRENCE_NOT_PENDING` (§6.6): the create form was opened from a
 * reminder's "Paid", and that occurrence was answered before the form was
 * saved (the form saved twice, or the bill paid from another tab). Nothing is
 * recorded — saving it would count the bill twice.
 */
export type TransactionActionError =
  | 'FX_UNAVAILABLE'
  | 'ARCHIVED_ACCOUNT'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_CATEGORY'
  | 'CONFLICT'
  | 'LINKED_TRANSACTION'
  | 'OCCURRENCE_NOT_PENDING'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'

export type TransactionActionResult = { ok: true } | { ok: false; error: TransactionActionError }

function mapError(e: unknown): TransactionActionResult {
  if (isFxUnavailableError(e)) return { ok: false, error: 'FX_UNAVAILABLE' }
  if (e instanceof transactionService.ArchivedAccountError) {
    return { ok: false, error: 'ARCHIVED_ACCOUNT' }
  }
  if (e instanceof transactionService.CurrencyMismatchError) {
    return { ok: false, error: 'CURRENCY_MISMATCH' }
  }
  if (e instanceof transactionService.InvalidCategoryError) {
    return { ok: false, error: 'INVALID_CATEGORY' }
  }
  if (e instanceof transactionService.ConcurrentModificationError) {
    return { ok: false, error: 'CONFLICT' }
  }
  if (e instanceof transactionService.LinkedTransactionError) {
    return { ok: false, error: 'LINKED_TRANSACTION' }
  }
  if (e instanceof transactionService.OccurrenceNotPendingError) {
    return { ok: false, error: 'OCCURRENCE_NOT_PENDING' }
  }
  return mapCommonActionError(e)
}

/**
 * Re-validates the form shape server-side (a malformed `date` is a ZodError,
 * i.e. INVALID_INPUT, never an unmapped throw out of `localDateTimeToInstant`)
 * and resolves the entered date and time against the caller's own timezone.
 */
function toServiceInput(
  input: CreateTransactionFormInput,
  timezone: string,
): CreateTransactionInput {
  const parsed = createTransactionFormSchema.parse(input)
  return { ...parsed, date: localDateTimeToInstant(parsed.date, timezone) }
}

/**
 * The create form's submit. Saved with an `occurrenceId` (the form opened from
 * a reminder's "Paid", spec 2026-10-12 §6.6), the same write marks that
 * occurrence paid — so the reminder pages change too: it leaves the due list
 * and the dashboard's widget.
 */
export async function createTransactionAction(
  input: CreateTransactionFormInput,
): Promise<TransactionActionResult> {
  const user = await requireUser()
  const { timezone } = resolveProfileDefaults(user)
  let serviceInput: CreateTransactionInput
  try {
    serviceInput = toServiceInput(input, timezone)
    await transactionService.createTransaction(user.id, serviceInput)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/transactions')
  revalidatePath('/accounts')
  if (serviceInput.occurrenceId !== undefined) {
    revalidatePath('/reminders')
    revalidatePath('/dashboard')
  }
  return { ok: true }
}

/**
 * The edit sheet's submit (spec 2026-10-12 §6.5): the same form shape and the
 * same zone conversion as create, applied to an existing row. The service
 * re-snapshots FX only for an economic change (ruling R-6) and refuses a row a
 * debt or loan owns. An edit can move the amount, the account or the date, so
 * the balances and the dashboard re-render with the ledger.
 */
export async function updateTransactionAction(
  id: string,
  input: CreateTransactionFormInput,
): Promise<TransactionActionResult> {
  const user = await requireUser()
  const { timezone } = resolveProfileDefaults(user)
  try {
    await transactionService.updateTransaction(user.id, id, toServiceInput(input, timezone))
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/transactions')
  revalidatePath('/accounts')
  revalidatePath('/dashboard')
  return { ok: true }
}

export async function deleteTransactionAction(id: string): Promise<TransactionActionResult> {
  const user = await requireUser()
  try {
    await transactionService.deleteTransaction(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/transactions')
  revalidatePath('/accounts')
  return { ok: true }
}
