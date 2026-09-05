'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import {
  createTransfer,
  deleteTransfer,
  SameAccountTransferError,
} from '@/lib/server/services/transfer'
import { ArchivedAccountError } from '@/lib/server/services/transaction'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { calendarDateToInstant } from '@/lib/datetime/calendar-date'
import { createTransferFormSchema, type CreateTransferFormInput } from '@/lib/validation/transfer'

/**
 * Same shape as `transaction-actions.ts`: a server action never throws a
 * domain error to the client, so the form can render a fixed, translatable
 * message instead of an English `Error#message`. Anything unmapped rethrows.
 *
 * `input` always comes from the client; `userId` never does — the only call
 * into the service below is `(user.id, input)` from `requireUser()`.
 *
 * As in `transaction-actions.ts`, this layer owns the calendar-date → instant
 * conversion (ruling R-21b): the form submits the plain `yyyy-MM-dd` the user
 * picked, and only here is the session user's IANA timezone known.
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
  input: CreateTransferFormInput,
): Promise<TransferActionResult> {
  const user = await requireUser()
  const { timezone } = resolveProfileDefaults(user)
  try {
    // Re-validated server-side so a malformed `date` is a ZodError
    // (INVALID_INPUT) rather than an unmapped throw out of the conversion.
    const parsed = createTransferFormSchema.parse(input)
    await createTransfer(user.id, {
      ...parsed,
      date: calendarDateToInstant(parsed.date, timezone),
    })
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/transfers')
  revalidatePath('/accounts')
  return { ok: true }
}

export async function deleteTransferAction(id: string): Promise<TransferActionResult> {
  const user = await requireUser()
  try {
    await deleteTransfer(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  // Both pages change: the transfer disappears, and both accounts' derived
  // balances move back.
  revalidatePath('/transfers')
  revalidatePath('/accounts')
  return { ok: true }
}
