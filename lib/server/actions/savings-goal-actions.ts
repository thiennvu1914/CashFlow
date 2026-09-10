'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { mapCommonActionError } from './map-action-error'
import {
  archiveSavingsGoal,
  createSavingsGoal,
  updateSavingsGoal,
  updateSavingsGoalProgress,
  SavingsGoalArchivedError,
} from '@/lib/server/services/savings-goal'
import type {
  CreateSavingsGoalInput,
  UpdateSavingsGoalInput,
  UpdateSavingsGoalProgressInput,
} from '@/lib/validation/savings-goal'

/**
 * Server actions never throw a domain error to the client: every mapped
 * failure comes back as `{ ok: false, error: <code> }` so the form can render
 * a fixed, translatable message instead of an English `Error#message`.
 * Anything unmapped rethrows — a genuine bug should surface, not vanish into
 * a silent `ok: false` the UI shrugs off.
 *
 * `input`/`id` always come from the client; `userId` never does — every call
 * into the service below is `(user.id, ...)` from `requireUser()`. The service
 * itself `parse`s the input again (`createSavingsGoalSchema` and friends), so
 * this layer passes it straight through rather than re-validating a second
 * time.
 *
 * Nothing here moves money, so nothing here revalidates a ledger page:
 * `/goals` is the page that changed, and `/dashboard` because Group 8's widget
 * reads the same goals. `/accounts` and `/transactions` are deliberately absent
 * — a savings goal cannot alter either.
 */
export type SavingsGoalActionError = 'ARCHIVED' | 'INVALID_INPUT' | 'NOT_FOUND'

export type SavingsGoalActionResult = { ok: true } | { ok: false; error: SavingsGoalActionError }

function mapError(e: unknown): SavingsGoalActionResult {
  if (e instanceof SavingsGoalArchivedError) return { ok: false, error: 'ARCHIVED' }
  return mapCommonActionError(e)
}

/** Both pages a goal appears on. Called only after a write actually happened,
 *  so a rejected action leaves the caches alone. */
function revalidateGoalPages(): void {
  revalidatePath('/goals')
  revalidatePath('/dashboard')
}

export async function createSavingsGoalAction(
  input: CreateSavingsGoalInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await createSavingsGoal(user.id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

export async function updateSavingsGoalAction(
  id: string,
  input: UpdateSavingsGoalInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await updateSavingsGoal(user.id, id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

export async function updateSavingsGoalProgressAction(
  id: string,
  input: UpdateSavingsGoalProgressInput,
): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await updateSavingsGoalProgress(user.id, id, input)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}

export async function archiveSavingsGoalAction(id: string): Promise<SavingsGoalActionResult> {
  const user = await requireUser()
  try {
    await archiveSavingsGoal(user.id, id)
  } catch (e) {
    return mapError(e)
  }
  revalidateGoalPages()
  return { ok: true }
}
