'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { mapCommonActionError } from './map-action-error'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { ArchivedAccountError } from '@/lib/server/services/account-lock'
import {
  createDebt,
  deleteDebtPayment,
  recordDebtPayment,
  updateDebt,
  updateDebtPayment,
  writeOffDebt,
  DebtNotActiveError,
  DebtOverpaymentError,
  type DebtLinkContext,
} from '@/lib/server/services/debt'
import { LinkedAccountCurrencyMismatchError } from '@/lib/server/services/linked-transaction'
import { ConcurrentModificationError } from '@/lib/server/services/transaction'
import {
  createDebtSchema,
  recordDebtPaymentSchema,
  updateDebtSchema,
  type CreateDebtInput,
  type RecordDebtPaymentInput,
  type UpdateDebtInput,
} from '@/lib/validation/debt'
import { resolveProfileDefaults } from '@/lib/validation/profile'

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
 * Unlike `savings-goal-actions.ts`, each action here `parse`s the input itself
 * before calling the service (the same shape as `transaction-actions.ts`'
 * `toServiceInput`). Two reasons, both about the payment writes: they happen
 * inside an interactive transaction that takes exclusive row locks, so an
 * input the schema was always going to reject would otherwise open a
 * transaction and hold those locks only to throw — and their date field is a
 * *calendar string* the service turns into a UTC carrier with
 * `calendarDateToUtcCarrier`, which raises a bare `RangeError` (not a
 * `ZodError`) for a value that never passed the schema, and a `RangeError`
 * would rethrow as an unmapped bug rather than reading as "check the
 * highlighted fields". Parsing at the edge keeps both failures cheap and
 * correctly mapped. The service re-parses, exactly as it does for every other
 * caller — it never trusts an action to have done it.
 *
 * Money-source linking (spec 2026-10-12 §6.2): a debt or payment recorded in
 * an account writes a Transaction too, so the writes that can do that take the
 * session user's timezone and locale (`DebtLinkContext`, resolved here because
 * only this layer has the session) and revalidate the ledger pages as well.
 * Editing a debt's terms and writing one off still move no money, so those two
 * leave `/accounts` and `/transactions` alone.
 *
 * The four linked-write failures get their own codes rather than one generic
 * "couldn't record it": `ACCOUNT_CURRENCY_MISMATCH` (the account is not in the
 * debt's currency — deliberately not `transaction-actions`' `CURRENCY_MISMATCH`,
 * whose copy tells the user to delete and re-enter a transaction),
 * `ARCHIVED_ACCOUNT`, `FX_UNAVAILABLE`, and `CONFLICT` for a payment or linked
 * transaction that changed while the user was editing it.
 */
export type DebtActionError =
  | 'OVERPAYMENT'
  | 'NOT_ACTIVE'
  | 'FX_UNAVAILABLE'
  | 'ARCHIVED_ACCOUNT'
  | 'ACCOUNT_CURRENCY_MISMATCH'
  | 'CONFLICT'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'

export type DebtActionResult = { ok: true } | { ok: false; error: DebtActionError }

function mapError(e: unknown): DebtActionResult {
  if (e instanceof DebtOverpaymentError) return { ok: false, error: 'OVERPAYMENT' }
  if (e instanceof DebtNotActiveError) return { ok: false, error: 'NOT_ACTIVE' }
  if (isFxUnavailableError(e)) return { ok: false, error: 'FX_UNAVAILABLE' }
  if (e instanceof ArchivedAccountError) return { ok: false, error: 'ARCHIVED_ACCOUNT' }
  if (e instanceof LinkedAccountCurrencyMismatchError) {
    return { ok: false, error: 'ACCOUNT_CURRENCY_MISMATCH' }
  }
  if (e instanceof ConcurrentModificationError) return { ok: false, error: 'CONFLICT' }
  return mapCommonActionError(e)
}

/** The session user's zone and language, as every money-capable write needs
 *  them. `resolveProfileDefaults` cannot throw: it falls back to CashFlow's
 *  defaults for an out-of-enum stored value. */
function linkContext(user: Parameters<typeof resolveProfileDefaults>[0]): DebtLinkContext {
  const { timezone, locale } = resolveProfileDefaults(user)
  return { timezone, locale }
}

/** The two pages a debt's own terms appear on. Called only after a write
 *  actually happened, so a rejected action leaves the caches alone. */
function revalidateDebtPages(): void {
  revalidatePath('/debts')
  revalidatePath('/dashboard')
}

/** Every page a write that may have moved money re-renders: the debt, the
 *  account balances, the ledger and the dashboard. */
function revalidateMoneyPages(): void {
  revalidatePath('/debts')
  revalidatePath('/accounts')
  revalidatePath('/transactions')
  revalidatePath('/dashboard')
}

export async function createDebtAction(input: CreateDebtInput): Promise<DebtActionResult> {
  const user = await requireUser()
  try {
    // Inside the `try`, so a `ZodError` from the parse is mapped by the same
    // clause as one raised by the service.
    await createDebt(user.id, createDebtSchema.parse(input), linkContext(user))
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

export async function updateDebtAction(
  id: string,
  input: UpdateDebtInput,
): Promise<DebtActionResult> {
  const user = await requireUser()
  try {
    // `updateDebtSchema` holds only the four editable fields, so a crafted
    // request carrying `direction`, `originalAmount` or `currency` has them
    // stripped here rather than reaching the service at all.
    await updateDebt(user.id, id, updateDebtSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateDebtPages()
  return { ok: true }
}

export async function recordDebtPaymentAction(
  debtId: string,
  input: RecordDebtPaymentInput,
): Promise<DebtActionResult> {
  const user = await requireUser()
  try {
    await recordDebtPayment(
      user.id,
      debtId,
      recordDebtPaymentSchema.parse(input),
      linkContext(user),
    )
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

/** Corrects a recorded payment — amount, date, note, account — and its linked
 *  transaction with it. Same input shape as recording one. */
export async function updateDebtPaymentAction(
  paymentId: string,
  input: RecordDebtPaymentInput,
): Promise<DebtActionResult> {
  const user = await requireUser()
  try {
    await updateDebtPayment(
      user.id,
      paymentId,
      recordDebtPaymentSchema.parse(input),
      linkContext(user),
    )
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

/** Removes a recorded payment and, when it moved money, its transaction. */
export async function deleteDebtPaymentAction(paymentId: string): Promise<DebtActionResult> {
  const user = await requireUser()
  try {
    await deleteDebtPayment(user.id, paymentId)
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

export async function writeOffDebtAction(id: string): Promise<DebtActionResult> {
  const user = await requireUser()
  try {
    await writeOffDebt(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidateDebtPages()
  return { ok: true }
}
