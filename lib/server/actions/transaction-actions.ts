'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import * as transactionService from '@/lib/server/services/transaction'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import type { CreateTransactionInput } from '@/lib/validation/transaction'

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
 */
export type TransactionActionError =
  'FX_UNAVAILABLE' | 'ARCHIVED_ACCOUNT' | 'INVALID_CATEGORY' | 'INVALID_INPUT' | 'NOT_FOUND'

export type TransactionActionResult = { ok: true } | { ok: false; error: TransactionActionError }

function mapError(e: unknown): TransactionActionResult {
  if (isFxUnavailableError(e)) return { ok: false, error: 'FX_UNAVAILABLE' }
  if (e instanceof transactionService.ArchivedAccountError) {
    return { ok: false, error: 'ARCHIVED_ACCOUNT' }
  }
  if (e instanceof transactionService.InvalidCategoryError) {
    return { ok: false, error: 'INVALID_CATEGORY' }
  }
  if (e instanceof ZodError) return { ok: false, error: 'INVALID_INPUT' }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return { ok: false, error: 'NOT_FOUND' }
  }
  throw e
}

export async function createTransactionAction(
  input: CreateTransactionInput,
): Promise<TransactionActionResult> {
  const user = await requireUser()
  try {
    await transactionService.createTransaction(user.id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/transactions')
  revalidatePath('/accounts')
  return { ok: true }
}

export async function updateTransactionAction(
  id: string,
  input: CreateTransactionInput,
): Promise<TransactionActionResult> {
  const user = await requireUser()
  try {
    await transactionService.updateTransaction(user.id, id, input)
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
