'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { mapCommonActionError } from './map-action-error'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { ArchivedAccountError } from '@/lib/server/services/account-lock'
import { LinkedAccountCurrencyMismatchError } from '@/lib/server/services/linked-transaction'
import {
  closeLoan,
  createLoan,
  deleteLoanPayment,
  recordLoanPayment,
  updateLoan,
  updateLoanPayment,
  LoanNotActiveError,
  LoanOverpaymentError,
  LoanSplitMismatchError,
  type LoanLinkContext,
} from '@/lib/server/services/loan'
import { ConcurrentModificationError } from '@/lib/server/services/transaction'
import {
  createLoanSchema,
  recordLoanPaymentSchema,
  updateLoanSchema,
  type CreateLoanInput,
  type RecordLoanPaymentInput,
  type UpdateLoanInput,
} from '@/lib/validation/loan'
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
 * Each action `parse`s the input itself before calling the service, the same
 * shape (and for the same two reasons) as `debt-actions.ts`, and both reasons
 * bite harder here. The payment writes happen inside an interactive
 * transaction that takes exclusive row locks, so an input the schema was
 * always going to reject would otherwise open a transaction and hold those
 * locks only to throw — and *three* fields across these schemas are calendar
 * strings the service turns into UTC carriers with `calendarDateToUtcCarrier`,
 * which raises a bare `RangeError` (not a `ZodError`) for a value that never
 * passed the schema. A `RangeError` would rethrow as an unmapped bug rather
 * than reading as "check the highlighted fields". Parsing at the edge keeps
 * both failures cheap and correctly mapped. The service re-parses, exactly as
 * it does for every other caller — it never trusts an action to have done it.
 *
 * Money-source linking (spec 2026-10-12 §6.3): a loan received into an account
 * and an instalment paid from one write Transactions too, so the writes that
 * can do that take the session user's timezone and locale (`LoanLinkContext`,
 * resolved here because only this layer has the session) and revalidate the
 * ledger pages as well. Editing a loan's terms and closing one still move no
 * money, so those two leave `/accounts` and `/transactions` alone.
 *
 * The four linked-write failures get their own codes rather than one generic
 * "couldn't record it", exactly as on debts: `ACCOUNT_CURRENCY_MISMATCH` (the
 * account is not in the loan's currency — deliberately not
 * `transaction-actions`' `CURRENCY_MISMATCH`, whose copy tells the user to
 * delete and re-enter a transaction), `ARCHIVED_ACCOUNT`, `FX_UNAVAILABLE`, and
 * `CONFLICT` for an instalment or linked transaction that changed while the
 * user was editing it.
 */
export type LoanActionError =
  | 'OVERPAYMENT'
  | 'NOT_ACTIVE'
  | 'SPLIT_MISMATCH'
  | 'FX_UNAVAILABLE'
  | 'ARCHIVED_ACCOUNT'
  | 'ACCOUNT_CURRENCY_MISMATCH'
  | 'CONFLICT'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'

export type LoanActionResult = { ok: true } | { ok: false; error: LoanActionError }

function mapError(e: unknown): LoanActionResult {
  if (e instanceof LoanOverpaymentError) return { ok: false, error: 'OVERPAYMENT' }
  if (e instanceof LoanNotActiveError) return { ok: false, error: 'NOT_ACTIVE' }
  // Layer two of the split invariant reaching the UI. The schema's refine
  // rejects the same input first, so this is unreachable through a form today —
  // it is mapped rather than left to rethrow because a future caller that does
  // reach it must be answered with a sentence about the split.
  if (e instanceof LoanSplitMismatchError) return { ok: false, error: 'SPLIT_MISMATCH' }
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
function linkContext(user: Parameters<typeof resolveProfileDefaults>[0]): LoanLinkContext {
  const { timezone, locale } = resolveProfileDefaults(user)
  return { timezone, locale }
}

/** The two pages a loan's own terms appear on. Called only after a write
 *  actually happened, so a rejected action leaves the caches alone. */
function revalidateLoanPages(): void {
  revalidatePath('/loans')
  revalidatePath('/dashboard')
}

/** Every page a write that may have moved money re-renders: the loan, the
 *  account balances, the ledger and the dashboard. */
function revalidateMoneyPages(): void {
  revalidatePath('/loans')
  revalidatePath('/accounts')
  revalidatePath('/transactions')
  revalidatePath('/dashboard')
}

export async function createLoanAction(input: CreateLoanInput): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    // Inside the `try`, so a `ZodError` from the parse is mapped by the same
    // clause as one raised by the service.
    await createLoan(user.id, createLoanSchema.parse(input), linkContext(user))
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

export async function updateLoanAction(
  id: string,
  input: UpdateLoanInput,
): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    // `updateLoanSchema` holds only the three editable fields, so a crafted
    // request carrying `principal`, `currency`, `interestRate`, `startDate`,
    // `termMonths`, `paymentFrequency` or `nextDueDate` has them stripped here
    // rather than reaching the service at all.
    await updateLoan(user.id, id, updateLoanSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateLoanPages()
  return { ok: true }
}

export async function recordLoanPaymentAction(
  loanId: string,
  input: RecordLoanPaymentInput,
): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    await recordLoanPayment(
      user.id,
      loanId,
      recordLoanPaymentSchema.parse(input),
      linkContext(user),
    )
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

/** Corrects a recorded instalment — split, date, note, account — and its two
 *  linked transactions with it. Same input shape as recording one. */
export async function updateLoanPaymentAction(
  paymentId: string,
  input: RecordLoanPaymentInput,
): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    await updateLoanPayment(
      user.id,
      paymentId,
      recordLoanPaymentSchema.parse(input),
      linkContext(user),
    )
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

/** Removes a recorded instalment and, when it moved money, its transactions,
 *  and steps the due date back one period. */
export async function deleteLoanPaymentAction(paymentId: string): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    await deleteLoanPayment(user.id, paymentId)
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

export async function closeLoanAction(id: string): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    await closeLoan(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidateLoanPages()
  return { ok: true }
}
