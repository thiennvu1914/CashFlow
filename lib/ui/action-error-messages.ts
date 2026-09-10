import type { BudgetActionError } from '@/lib/server/actions/budget-actions'
import type { DebtActionError } from '@/lib/server/actions/debt-actions'
import type { FinancialAccountActionError } from '@/lib/server/actions/financial-account-actions'
import type { LoanActionError } from '@/lib/server/actions/loan-actions'
import type { ReminderActionError } from '@/lib/server/actions/reminder-actions'
import type { SavingsGoalActionError } from '@/lib/server/actions/savings-goal-actions'
import type { TransactionActionError } from '@/lib/server/actions/transaction-actions'
import type { TransferActionError } from '@/lib/server/actions/transfer-actions'

/**
 * The user-facing message KEY for every server-action error code, in one place.
 *
 * A server action never returns an `Error#message`: it returns a code, and the
 * component renders a fixed string for it. Those strings used to be copied
 * into each component that could receive the code (seven copies across
 * accounts, transactions and transfers), so the same failure could read
 * differently depending on which form the user happened to be looking at.
 *
 * Typing each map as `Record<…ActionError, string>` also makes a new error
 * code a compile error until it has a key, rather than a silent `undefined`
 * rendered as an empty paragraph.
 *
 * Phase 7 replaced the literals below with i18n keys (Vietnamese default,
 * English via the locale cookie): a caller does `t(ACCOUNT_ERROR_KEYS[code])`
 * against the root translator, and `messages/{vi,en}/errors.json` (Task 2b)
 * holds the copy each key resolves to.
 */

export const GENERIC_ERROR_KEY = 'errors.generic'

export const ACCOUNT_ERROR_KEYS: Record<FinancialAccountActionError, string> = {
  NON_ZERO_BALANCE: 'errors.account.NON_ZERO_BALANCE',
  ACCOUNT_LOCKED: 'errors.account.ACCOUNT_LOCKED',
  ARCHIVED_ACCOUNT: 'errors.account.ARCHIVED_ACCOUNT',
  INVALID_ACCOUNT_TYPE: 'errors.account.INVALID_ACCOUNT_TYPE',
  INVALID_INPUT: 'errors.account.INVALID_INPUT',
  NOT_FOUND: 'errors.account.NOT_FOUND',
}

export const TRANSACTION_ERROR_KEYS: Record<TransactionActionError, string> = {
  FX_UNAVAILABLE: 'errors.transaction.FX_UNAVAILABLE',
  ARCHIVED_ACCOUNT: 'errors.transaction.ARCHIVED_ACCOUNT',
  CURRENCY_MISMATCH: 'errors.transaction.CURRENCY_MISMATCH',
  INVALID_CATEGORY: 'errors.transaction.INVALID_CATEGORY',
  CONFLICT: 'errors.transaction.CONFLICT',
  INVALID_INPUT: 'errors.transaction.INVALID_INPUT',
  NOT_FOUND: 'errors.transaction.NOT_FOUND',
}

export const TRANSFER_ERROR_KEYS: Record<TransferActionError, string> = {
  SAME_ACCOUNT: 'errors.transfer.SAME_ACCOUNT',
  ARCHIVED_ACCOUNT: 'errors.transfer.ARCHIVED_ACCOUNT',
  INVALID_INPUT: 'errors.transfer.INVALID_INPUT',
  NOT_FOUND: 'errors.transfer.NOT_FOUND',
}

export const BUDGET_ERROR_KEYS: Record<BudgetActionError, string> = {
  DUPLICATE_BUDGET: 'errors.budget.DUPLICATE_BUDGET',
  INVALID_CATEGORY: 'errors.budget.INVALID_CATEGORY',
  INVALID_INPUT: 'errors.budget.INVALID_INPUT',
  NOT_FOUND: 'errors.budget.NOT_FOUND',
}

export const SAVINGS_GOAL_ERROR_KEYS: Record<SavingsGoalActionError, string> = {
  ARCHIVED: 'errors.goal.ARCHIVED',
  INVALID_INPUT: 'errors.goal.INVALID_INPUT',
  NOT_FOUND: 'errors.goal.NOT_FOUND',
}

export const DEBT_ERROR_KEYS: Record<DebtActionError, string> = {
  OVERPAYMENT: 'errors.debt.OVERPAYMENT',
  NOT_ACTIVE: 'errors.debt.NOT_ACTIVE',
  INVALID_INPUT: 'errors.debt.INVALID_INPUT',
  NOT_FOUND: 'errors.debt.NOT_FOUND',
}

export const LOAN_ERROR_KEYS: Record<LoanActionError, string> = {
  OVERPAYMENT: 'errors.loan.OVERPAYMENT',
  NOT_ACTIVE: 'errors.loan.NOT_ACTIVE',
  SPLIT_MISMATCH: 'errors.loan.SPLIT_MISMATCH',
  INVALID_INPUT: 'errors.loan.INVALID_INPUT',
  NOT_FOUND: 'errors.loan.NOT_FOUND',
}

export const REMINDER_ERROR_KEYS: Record<ReminderActionError, string> = {
  INVALID_CATEGORY: 'errors.reminder.INVALID_CATEGORY',
  INVALID_ACCOUNT: 'errors.reminder.INVALID_ACCOUNT',
  INVALID_INPUT: 'errors.reminder.INVALID_INPUT',
  NOT_FOUND: 'errors.reminder.NOT_FOUND',
}

