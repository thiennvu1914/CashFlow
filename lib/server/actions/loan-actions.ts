'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import {
  closeLoan,
  createLoan,
  recordLoanPayment,
  updateLoan,
  LoanNotActiveError,
  LoanOverpaymentError,
  LoanSplitMismatchError,
} from '@/lib/server/services/loan'
import {
  createLoanSchema,
  recordLoanPaymentSchema,
  updateLoanSchema,
  type CreateLoanInput,
  type RecordLoanPaymentInput,
  type UpdateLoanInput,
} from '@/lib/validation/loan'

/**
 * Server actions never throw a domain error to the client: every mapped
 * failure comes back as `{ ok: false, error: <code> }` so the form can render
 * a fixed, translatable message instead of an English `Error#message`.
 * Anything unmapped rethrows — a genuine bug should surface, not vanish into
 * a silent `ok: false` the UI shrugs off.
 *
 * `input`/`id` always come from the client; `userId` never does — every call
 * into the service below is `(user.id, ...)` from `requireUser()`.
 *
 * Each action `parse`s the input itself before calling the service, the same
 * shape (and for the same two reasons) as `debt-actions.ts`, and both reasons
 * bite harder here. `recordLoanPayment`'s write happens inside an interactive
 * transaction that takes an exclusive row lock, so an input the schema was
 * always going to reject would otherwise open a transaction and hold that lock
 * only to throw — and *three* fields across these schemas are calendar strings
 * the service turns into UTC carriers with `calendarDateToUtcCarrier`, which
 * raises a bare `RangeError` (not a `ZodError`) for a value that never passed
 * the schema. A `RangeError` would rethrow as an unmapped bug rather than
 * reading as "check the highlighted fields". Parsing at the edge keeps both
 * failures cheap and correctly mapped. The service re-parses, exactly as it
 * does for every other caller — it never trusts an action to have done it.
 *
 * Nothing here moves money — a loan is tracking only, and recording an
 * instalment writes a `LoanPayment` and advances `nextDueDate` and nothing else
 * — so nothing here revalidates a ledger page: `/loans` is the page that
 * changed, and `/dashboard` because a later group's widget reads the same
 * loans. `/accounts` and `/transactions` are deliberately absent.
 */
export type LoanActionError =
  'OVERPAYMENT' | 'NOT_ACTIVE' | 'SPLIT_MISMATCH' | 'INVALID_INPUT' | 'NOT_FOUND'

export type LoanActionResult = { ok: true } | { ok: false; error: LoanActionError }

function mapError(e: unknown): LoanActionResult {
  if (e instanceof LoanOverpaymentError) return { ok: false, error: 'OVERPAYMENT' }
  if (e instanceof LoanNotActiveError) return { ok: false, error: 'NOT_ACTIVE' }
  // Layer two of the split invariant reaching the UI. The schema's refine
  // rejects the same input first, so this is unreachable through a form today —
  // it is mapped rather than left to rethrow because a future caller that does
  // reach it must be answered with a sentence about the split.
  if (e instanceof LoanSplitMismatchError) return { ok: false, error: 'SPLIT_MISMATCH' }
  if (e instanceof ZodError) return { ok: false, error: 'INVALID_INPUT' }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return { ok: false, error: 'NOT_FOUND' }
  }
  throw e
}

/** Both pages a loan appears on. Called only after a write actually happened,
 *  so a rejected action leaves the caches alone. */
function revalidateLoanPages(): void {
  revalidatePath('/loans')
  revalidatePath('/dashboard')
}

export async function createLoanAction(input: CreateLoanInput): Promise<LoanActionResult> {
  const user = await requireUser()
  try {
    // Inside the `try`, so a `ZodError` from the parse is mapped by the same
    // clause as one raised by the service.
    await createLoan(user.id, createLoanSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateLoanPages()
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
    await recordLoanPayment(user.id, loanId, recordLoanPaymentSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateLoanPages()
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
