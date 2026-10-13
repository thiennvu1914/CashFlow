'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { requireUser } from '@/lib/auth/require-user'
import { mapCommonActionError } from './map-action-error'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { ArchivedAccountError } from '@/lib/server/services/account-lock'
import {
  FutureLinkedPaymentError,
  LinkedAccountCurrencyMismatchError,
} from '@/lib/server/services/linked-transaction'
import {
  closeLoan,
  createLoan,
  deleteLoanPayment,
  linkLoanToAccount,
  recordLoanPayment,
  unlinkLoanFromAccount,
  updateLoan,
  updateLoanPayment,
  LoanAlreadyLinkedError,
  LoanNotActiveError,
  LoanNotLinkedError,
  LoanOverpaymentError,
  LoanSplitMismatchError,
  type LoanLinkContext,
} from '@/lib/server/services/loan'
import { ConcurrentModificationError } from '@/lib/server/services/transaction'
import {
  createLoanSchemaAsOf,
  linkLoanToAccountSchemaAsOf,
  recordLoanPaymentSchemaAsOf,
  updateLoanSchema,
  type CreateLoanInput,
  type LinkLoanToAccountInput,
  type RecordLoanPaymentInput,
  type UpdateLoanInput,
} from '@/lib/validation/loan'
import {
  unlinkFromAccountSchema,
  type UnlinkFromAccountInput,
} from '@/lib/validation/link-to-account'
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
 * user was editing it. "Record in an account" (spec §6.4) adds
 * `ALREADY_LINKED`, for a loan whose disbursement another tab or a
 * double-click recorded first, and `TIMEOUT` for Prisma's P2028 — an
 * interactive transaction (a link writes up to two rows per instalment in one)
 * that expired and rolled back. "Remove from account" (its undo) adds
 * `NOT_LINKED`, for a loan whose disbursement another tab already removed from
 * its account.
 *
 * Ruling P12 (final review F8): money recorded in an account cannot have moved
 * later than the session user's today, so the writes that can record it parse
 * against that day (`…SchemaAsOf`) — a later date is `INVALID_INPUT` on its
 * field — and "Record in an account" answers `FUTURE_PAYMENT` when an existing
 * instalment it would record is dated later.
 */
export type LoanActionError =
  | 'OVERPAYMENT'
  | 'NOT_ACTIVE'
  | 'SPLIT_MISMATCH'
  | 'FX_UNAVAILABLE'
  | 'ARCHIVED_ACCOUNT'
  | 'ACCOUNT_CURRENCY_MISMATCH'
  | 'CONFLICT'
  | 'ALREADY_LINKED'
  | 'NOT_LINKED'
  | 'FUTURE_PAYMENT'
  | 'TIMEOUT'
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
  if (e instanceof LoanAlreadyLinkedError) return { ok: false, error: 'ALREADY_LINKED' }
  if (e instanceof LoanNotLinkedError) return { ok: false, error: 'NOT_LINKED' }
  if (e instanceof FutureLinkedPaymentError) return { ok: false, error: 'FUTURE_PAYMENT' }
  // P2028: the interactive transaction expired (or could not start in time).
  // Everything in it rolled back, so the user can be told nothing was written.
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2028') {
    return { ok: false, error: 'TIMEOUT' }
  }
  return mapCommonActionError(e)
}

/** The session user's zone and language, as every money-capable write needs
 *  them. `resolveProfileDefaults` cannot throw: it falls back to CashFlow's
 *  defaults for an out-of-enum stored value. */
function linkContext(user: Parameters<typeof resolveProfileDefaults>[0]): LoanLinkContext {
  const { timezone, locale } = resolveProfileDefaults(user)
  return { timezone, locale }
}

/** The session user's calendar day in their zone — the latest day money
 *  recorded in an account may have moved (Ruling P12). */
function todayOf(context: LoanLinkContext): string {
  return todayCalendarDateInZone(context.timezone)
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
  const context = linkContext(user)
  try {
    // Inside the `try`, so a `ZodError` from the parse is mapped by the same
    // clause as one raised by the service.
    await createLoan(user.id, createLoanSchemaAsOf(todayOf(context)).parse(input), context)
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
  const context = linkContext(user)
  try {
    await recordLoanPayment(
      user.id,
      loanId,
      recordLoanPaymentSchemaAsOf(todayOf(context)).parse(input),
      context,
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
  const context = linkContext(user)
  try {
    await updateLoanPayment(
      user.id,
      paymentId,
      recordLoanPaymentSchemaAsOf(todayOf(context)).parse(input),
      context,
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

/** "Record in an account" (spec §6.4): records a loan that moved no money yet
 *  — its disbursement and, when asked, its existing instalments — in an
 *  account. */
export async function linkLoanToAccountAction(
  loanId: string,
  input: LinkLoanToAccountInput,
): Promise<LoanActionResult> {
  const user = await requireUser()
  const context = linkContext(user)
  try {
    await linkLoanToAccount(
      user.id,
      loanId,
      linkLoanToAccountSchemaAsOf(todayOf(context)).parse(input),
      context,
    )
  } catch (e) {
    return mapError(e)
  }
  revalidateMoneyPages()
  return { ok: true }
}

/** "Remove from account": the undo of recording a loan in an account — deletes
 *  its disbursement and, when asked, both legs of every instalment paid from
 *  an account, so the loan can be recorded again in the right account. */
export async function unlinkLoanFromAccountAction(
  loanId: string,
  input: UnlinkFromAccountInput,
): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    await unlinkLoanFromAccount(user.id, loanId, unlinkFromAccountSchema.parse(input))
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
