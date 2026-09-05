'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import * as transactionService from '@/lib/server/services/transaction'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { calendarDateToInstant } from '@/lib/datetime/calendar-date'
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
 * This layer also owns the calendar-date → instant conversion (ruling R-21b):
 * the form submits the plain `yyyy-MM-dd` the user picked, and only here is
 * the session user's IANA timezone known, so only here can that day be pinned
 * to the right instant. See `lib/datetime/calendar-date.ts`.
 */
export type TransactionActionError =
  | 'FX_UNAVAILABLE'
  | 'ARCHIVED_ACCOUNT'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_CATEGORY'
  | 'CONFLICT'
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
  if (e instanceof ZodError) return { ok: false, error: 'INVALID_INPUT' }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return { ok: false, error: 'NOT_FOUND' }
  }
  throw e
}

/**
 * Re-validates the form shape server-side (a malformed `date` is a ZodError,
 * i.e. INVALID_INPUT, never an unmapped throw out of `calendarDateToInstant`)
 * and resolves the calendar day against the caller's own timezone.
 */
function toServiceInput(
  input: CreateTransactionFormInput,
  timezone: string,
): CreateTransactionInput {
  const parsed = createTransactionFormSchema.parse(input)
  return { ...parsed, date: calendarDateToInstant(parsed.date, timezone) }
}

export async function createTransactionAction(
  input: CreateTransactionFormInput,
): Promise<TransactionActionResult> {
  const user = await requireUser()
  const { timezone } = resolveProfileDefaults(user)
  try {
    await transactionService.createTransaction(user.id, toServiceInput(input, timezone))
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/transactions')
  revalidatePath('/accounts')
  return { ok: true }
}

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
