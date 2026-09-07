import type { BudgetActionError } from '@/lib/server/actions/budget-actions'
import type { DebtActionError } from '@/lib/server/actions/debt-actions'
import type { FinancialAccountActionError } from '@/lib/server/actions/financial-account-actions'
import type { LoanActionError } from '@/lib/server/actions/loan-actions'
import type { ReminderActionError } from '@/lib/server/actions/reminder-actions'
import type { SavingsGoalActionError } from '@/lib/server/actions/savings-goal-actions'
import type { TransactionActionError } from '@/lib/server/actions/transaction-actions'
import type { TransferActionError } from '@/lib/server/actions/transfer-actions'

/**
 * The user-facing text for every server-action error code, in one place.
 *
 * A server action never returns an `Error#message`: it returns a code, and the
 * component renders a fixed string for it. Those strings used to be copied
 * into each component that could receive the code (seven copies across
 * accounts, transactions and transfers), so the same failure could read
 * differently depending on which form the user happened to be looking at.
 *
 * Typing each map as `Record<…ActionError, string>` also makes a new error
 * code a compile error until it has a message, rather than a silent
 * `undefined` rendered as an empty paragraph.
 *
 * Phase 7 replaces these literals with i18n keys (Vietnamese default, English
 * via the locale cookie); this module is the single hook point for that
 * change — nothing else in the UI will need touching.
 */

/** Shown when something failed in a way no action code covers. */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'

export const ACCOUNT_ERROR_MESSAGES: Record<FinancialAccountActionError, string> = {
  NON_ZERO_BALANCE:
    'This account must have a zero balance before it can be archived. Transfer or adjust the balance first.',
  ACCOUNT_LOCKED: 'Currency and opening balance cannot be changed once the account has activity.',
  ARCHIVED_ACCOUNT: 'This account is archived and can no longer be edited.',
  INVALID_ACCOUNT_TYPE: 'Choose a valid account type.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That account no longer exists.',
}

export const TRANSACTION_ERROR_MESSAGES: Record<TransactionActionError, string> = {
  FX_UNAVAILABLE: 'Exchange rate is temporarily unavailable. Please try again in a moment.',
  ARCHIVED_ACCOUNT: 'This account is archived.',
  CURRENCY_MISMATCH:
    'Move the transaction to an account in the same currency, or delete and re-enter it.',
  INVALID_CATEGORY: 'Choose a valid category for this type.',
  CONFLICT: 'This record changed while you were editing it. Reload and try again.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That record no longer exists.',
}

export const TRANSFER_ERROR_MESSAGES: Record<TransferActionError, string> = {
  SAME_ACCOUNT: 'Choose two different accounts.',
  ARCHIVED_ACCOUNT: 'One of these accounts is archived.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That record no longer exists.',
}

export const BUDGET_ERROR_MESSAGES: Record<BudgetActionError, string> = {
  DUPLICATE_BUDGET: 'A budget for this month already exists for that scope or category.',
  INVALID_CATEGORY: 'Choose an active expense category.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That budget no longer exists.',
}

export const SAVINGS_GOAL_ERROR_MESSAGES: Record<SavingsGoalActionError, string> = {
  // Not "no longer exists": the goal is still on the page, under "Archived
  // goals", so the message has to name the state the user can actually see.
  ARCHIVED: 'This goal is archived and can no longer be changed.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That goal no longer exists.',
}

export const DEBT_ERROR_MESSAGES: Record<DebtActionError, string> = {
  // Says what is wrong with the figure the user typed, not what the service
  // compared it against: the outstanding amount is already on the row above
  // the form, and `DebtOverpaymentError` carries a `Prisma.Decimal` that
  // cannot cross into a client component anyway.
  OVERPAYMENT: 'That payment is more than what is still owed.',
  // Like an archived goal, a written-off debt is still visible on the page —
  // under "Written-off debts" — so the message names the state the user can
  // see rather than claiming the row has gone.
  NOT_ACTIVE: 'This debt has been written off and can no longer be changed.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That debt no longer exists.',
}

export const LOAN_ERROR_MESSAGES: Record<LoanActionError, string> = {
  // Names the *principal*, because that is the only part of an instalment the
  // check compares: a loan can be repaid in principal and still owe a final
  // interest charge, so "that payment is too large" would be wrong advice. The
  // outstanding figure itself is already on the row above the form, and
  // `LoanOverpaymentError` carries a `Prisma.Decimal` that cannot cross into a
  // client component anyway.
  OVERPAYMENT: 'That principal payment is more than the principal still outstanding.',
  // Like a written-off debt, a closed loan is still visible on the page — under
  // "Closed loans" — so the message names the state the user can see rather
  // than claiming the row has gone.
  NOT_ACTIVE: 'This loan is closed and can no longer be changed.',
  // The same sentence the schema's refine puts under the total field, so the
  // split invariant reads identically whichever of its three layers refused
  // the instalment.
  SPLIT_MISMATCH: 'Total must equal principal plus interest.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That loan no longer exists.',
}

export const REMINDER_ERROR_MESSAGES: Record<ReminderActionError, string> = {
  // Names the rule the category broke — the *type* has to match — because that
  // is the one the user can act on from the form: the other three cases the
  // service refuses (not yours, no such id, archived) all read as "pick another
  // one" too, and spelling them out would tell a crafted request which ids
  // exist.
  INVALID_CATEGORY: 'Choose a category that matches the reminder type.',
  // "Active", because an archived account is still in the user's vocabulary —
  // it just cannot be named on a new reminder.
  INVALID_ACCOUNT: 'Choose one of your active accounts.',
  INVALID_INPUT: 'Check the highlighted fields.',
  // Covers a foreign or deleted *occurrence* id as well as a reminder one: an
  // occurrence only exists as an instance of a reminder, so "that reminder" is
  // what the user can see has gone from the page.
  NOT_FOUND: 'That reminder no longer exists.',
}
