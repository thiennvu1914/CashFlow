'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { mapCommonActionError } from './map-action-error'
import * as accountService from '@/lib/server/services/financial-account'
import { AccountNotFoundError } from '@/lib/server/services/balance'
import { ArchivedAccountError } from '@/lib/server/services/transaction'
import type {
  CreateFinancialAccountInput,
  UpdateFinancialAccountInput,
} from '@/lib/validation/financial-account'

/**
 * Server actions never throw a domain error to the client: every mapped
 * failure comes back as `{ ok: false, error: <code> }` so the form can render
 * a fixed, translatable message instead of an English `Error#message`.
 * Anything unmapped rethrows — a genuine bug should surface, not vanish into
 * a silent `ok: false` the UI shrugs off.
 *
 * `input`/`accountId` always come from the client; `userId` never does —
 * every call into the service below is `(user.id, ...)` from `requireUser()`.
 */
export type FinancialAccountActionError =
  | 'NON_ZERO_BALANCE'
  | 'ACCOUNT_LOCKED'
  | 'ARCHIVED_ACCOUNT'
  | 'INVALID_ACCOUNT_TYPE'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'

export type FinancialAccountActionResult =
  { ok: true } | { ok: false; error: FinancialAccountActionError }

function mapError(e: unknown): FinancialAccountActionResult {
  if (e instanceof accountService.AccountHasNonZeroBalanceError) {
    return { ok: false, error: 'NON_ZERO_BALANCE' }
  }
  if (e instanceof accountService.AccountLockedError) {
    return { ok: false, error: 'ACCOUNT_LOCKED' }
  }
  if (e instanceof ArchivedAccountError) return { ok: false, error: 'ARCHIVED_ACCOUNT' }
  if (e instanceof accountService.InvalidAccountTypeError) {
    return { ok: false, error: 'INVALID_ACCOUNT_TYPE' }
  }
  // Hoisted above the shared tail (which is where the `ZodError` branch used
  // to sit): `AccountNotFoundError` and `ZodError` are disjoint classes, so
  // the order of the two `instanceof` checks cannot change any outcome.
  if (e instanceof AccountNotFoundError) return { ok: false, error: 'NOT_FOUND' }
  return mapCommonActionError(e)
}

export async function createFinancialAccountAction(
  input: CreateFinancialAccountInput,
): Promise<FinancialAccountActionResult> {
  const user = await requireUser()
  try {
    await accountService.createFinancialAccount(user.id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/accounts')
  return { ok: true }
}

export async function updateFinancialAccountAction(
  accountId: string,
  input: UpdateFinancialAccountInput,
): Promise<FinancialAccountActionResult> {
  const user = await requireUser()
  try {
    await accountService.updateFinancialAccount(user.id, accountId, input)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/accounts')
  return { ok: true }
}

export async function archiveFinancialAccountAction(
  accountId: string,
): Promise<FinancialAccountActionResult> {
  const user = await requireUser()
  try {
    await accountService.archiveFinancialAccount(user.id, accountId)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/accounts')
  return { ok: true }
}
