'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createTransfer, SameAccountTransferError } from '@/lib/server/services/transfer'
import { ArchivedAccountError } from '@/lib/server/services/transaction'
import type { CreateTransferInput } from '@/lib/validation/transfer'

/**
 * Same shape as `transaction-actions.ts`: a server action never throws a
 * domain error to the client, so the form can render a fixed, translatable
 * message instead of an English `Error#message`. Anything unmapped rethrows.
 *
 * `input` always comes from the client; `userId` never does — the only call
 * into the service below is `(user.id, input)` from `requireUser()`.
 */
export type TransferActionError =
  'ARCHIVED_ACCOUNT' | 'SAME_ACCOUNT' | 'INVALID_INPUT' | 'NOT_FOUND'

export type TransferActionResult = { ok: true } | { ok: false; error: TransferActionError }

function mapError(e: unknown): TransferActionResult {
  if (e instanceof ArchivedAccountError) return { ok: false, error: 'ARCHIVED_ACCOUNT' }
  if (e instanceof SameAccountTransferError) return { ok: false, error: 'SAME_ACCOUNT' }
  if (e instanceof ZodError) return { ok: false, error: 'INVALID_INPUT' }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return { ok: false, error: 'NOT_FOUND' }
  }
  throw e
}

export async function createTransferAction(
  input: CreateTransferInput,
): Promise<TransferActionResult> {
  const user = await requireUser()
  try {
    await createTransfer(user.id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/transfers')
  revalidatePath('/accounts')
  return { ok: true }
}
