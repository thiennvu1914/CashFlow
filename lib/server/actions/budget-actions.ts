'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { mapCommonActionError } from './map-action-error'
import {
  createBudget,
  updateBudget,
  deleteBudget,
  DuplicateBudgetError,
  InvalidBudgetCategoryError,
} from '@/lib/server/services/budget'
import type { CreateBudgetInput, UpdateBudgetInput } from '@/lib/validation/budget'

/**
 * Server actions never throw a domain error to the client: every mapped
 * failure comes back as `{ ok: false, error: <code> }` so the form can render
 * a fixed, translatable message instead of an English `Error#message`.
 * Anything unmapped rethrows — a genuine bug should surface, not vanish into
 * a silent `ok: false` the UI shrugs off.
 *
 * `input`/`id` always come from the client; `userId` never does — every call
 * into the service below is `(user.id, ...)` from `requireUser()`. The
 * service itself `parse`s the input again (`createBudgetSchema` /
 * `updateBudgetSchema`), so this layer passes it straight through rather than
 * re-validating a second time.
 */
export type BudgetActionError =
  'DUPLICATE_BUDGET' | 'INVALID_CATEGORY' | 'INVALID_INPUT' | 'NOT_FOUND'

export type BudgetActionResult = { ok: true } | { ok: false; error: BudgetActionError }

function mapError(e: unknown): BudgetActionResult {
  if (e instanceof DuplicateBudgetError) return { ok: false, error: 'DUPLICATE_BUDGET' }
  if (e instanceof InvalidBudgetCategoryError) return { ok: false, error: 'INVALID_CATEGORY' }
  return mapCommonActionError(e)
}

export async function createBudgetAction(input: CreateBudgetInput): Promise<BudgetActionResult> {
  const user = await requireUser()
  try {
    await createBudget(user.id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/budgets')
  revalidatePath('/dashboard')
  return { ok: true }
}

export async function updateBudgetAction(
  id: string,
  input: UpdateBudgetInput,
): Promise<BudgetActionResult> {
  const user = await requireUser()
  try {
    await updateBudget(user.id, id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/budgets')
  revalidatePath('/dashboard')
  return { ok: true }
}

export async function deleteBudgetAction(id: string): Promise<BudgetActionResult> {
  const user = await requireUser()
  try {
    await deleteBudget(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidatePath('/budgets')
  revalidatePath('/dashboard')
  return { ok: true }
}
