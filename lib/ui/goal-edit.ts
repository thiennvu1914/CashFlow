import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import type { UpdateSavingsGoalInput } from '@/lib/validation/savings-goal'

/**
 * The account choices a goal edit offers: the active accounts, plus the goal's
 * current account even when it was archived since (kept selected and labelled,
 * so saving does not silently unlink), and — for a goal that already has
 * entries — only accounts in the goal's own currency, because its entries are
 * amounts in that currency and the service refuses to re-denominate them
 * (CURRENCY_LOCKED).
 */
export function editAccountOptions(
  goal: Pick<SavingsGoalDto, 'entries' | 'currency' | 'linkedAccount'>,
  accounts: ReadonlyArray<DebtAccountOption>,
): DebtAccountOption[] {
  const options =
    goal.entries.length > 0 ? accounts.filter((a) => a.currency === goal.currency) : [...accounts]
  const linked = goal.linkedAccount
  if (linked && !options.some((option) => option.id === linked.id)) {
    options.push({ id: linked.id, name: linked.name, currency: goal.currency, archived: true })
  }
  return options
}

/**
 * What the edit form posts. `linkedAccountId` is whatever the picker holds
 * (`undefined` only for "Not linked" — the service reads that as unlink). The
 * currency: a chosen account's own; else, for a goal with entries, the goal's
 * unchanged (its select is not registered); else what the user picked.
 */
export function buildGoalEditPayload(
  values: UpdateSavingsGoalInput,
  linkedAccount: DebtAccountOption | undefined,
  goal: Pick<SavingsGoalDto, 'entries' | 'editable'>,
): UpdateSavingsGoalInput {
  if (linkedAccount) return { ...values, currency: linkedAccount.currency }
  if (goal.entries.length > 0) return { ...values, currency: goal.editable.currency }
  return values
}
