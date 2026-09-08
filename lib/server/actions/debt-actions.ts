'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import {
  createDebt,
  recordDebtPayment,
  updateDebt,
  writeOffDebt,
  DebtNotActiveError,
  DebtOverpaymentError,
} from '@/lib/server/services/debt'
import {
  createDebtSchema,
  recordDebtPaymentSchema,
  updateDebtSchema,
  type CreateDebtInput,
  type RecordDebtPaymentInput,
  type UpdateDebtInput,
} from '@/lib/validation/debt'

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
 * Unlike `savings-goal-actions.ts`, each action here `parse`s the input itself
 * before calling the service (the same shape as `transaction-actions.ts`'
 * `toServiceInput`). Two reasons, both about `recordDebtPayment`: its write
 * happens inside an interactive transaction that takes an exclusive row lock,
 * so an input the schema was always going to reject would otherwise open a
 * transaction and hold that lock only to throw — and its date field is a
 * *calendar string* the service turns into a UTC carrier with
 * `calendarDateToUtcCarrier`, which raises a bare `RangeError` (not a
 * `ZodError`) for a value that never passed the schema, and a `RangeError`
 * would rethrow as an unmapped bug rather than reading as "check the
 * highlighted fields". Parsing at the edge keeps both failures cheap and
 * correctly mapped. The service re-parses, exactly as it does for every other
 * caller — it never trusts an action to have done it.
 *
 * Nothing here moves money — a debt is tracking only, and recording a
 * repayment writes a `DebtPayment` and nothing else — so nothing here
 * revalidates a ledger page: `/debts` is the page that changed, and
 * `/dashboard` because a later group's widget reads the same debts.
 * `/accounts` and `/transactions` are deliberately absent.
 */
export type DebtActionError = 'OVERPAYMENT' | 'NOT_ACTIVE' | 'INVALID_INPUT' | 'NOT_FOUND'

export type DebtActionResult = { ok: true } | { ok: false; error: DebtActionError }

function mapError(e: unknown): DebtActionResult {
  if (e instanceof DebtOverpaymentError) return { ok: false, error: 'OVERPAYMENT' }
  if (e instanceof DebtNotActiveError) return { ok: false, error: 'NOT_ACTIVE' }
  if (e instanceof ZodError) return { ok: false, error: 'INVALID_INPUT' }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return { ok: false, error: 'NOT_FOUND' }
  }
  throw e
}

/** Both pages a debt appears on. Called only after a write actually happened,
 *  so a rejected action leaves the caches alone. */
function revalidateDebtPages(): void {
  revalidatePath('/debts')
  revalidatePath('/dashboard')
}

export async function createDebtAction(input: CreateDebtInput): Promise<DebtActionResult> {
  const user = await requireUser()
  try {
    // Inside the `try`, so a `ZodError` from the parse is mapped by the same
    // clause as one raised by the service.
    await createDebt(user.id, createDebtSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateDebtPages()
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
    await recordDebtPayment(user.id, debtId, recordDebtPaymentSchema.parse(input))
  } catch (e) {
    return mapError(e)
  }
  revalidateDebtPages()
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
