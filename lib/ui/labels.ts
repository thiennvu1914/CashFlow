import type {
  BudgetScope,
  CategoryType,
  Currency,
  DebtDirection,
  OccurrenceStatus,
  PaymentFrequency,
  RecordStatus,
  RecurrenceFrequency,
  ReminderType,
  SavingsGoalStatus,
  TransactionType,
} from '@prisma/client'
import type { BudgetStatus } from '@/lib/server/services/budget'
import type { DebtDisplayStatus } from '@/lib/server/services/debt'
import type { LoanDisplayStatus } from '@/lib/server/services/loan'

/**
 * Every enum family's message KEY, in one place (spec §4).
 *
 * Not the text — the key. A view model returns keys and enum values; the
 * component that renders them calls `t(key)`. That split is what lets a view
 * model stay a pure function with a unit test, and it is why no raw enum
 * (`CASH_OUT`, `ADJUSTMENT_DECREASE`, `WRITTEN_OFF`, `PARTIALLY_PAID`) can
 * reach the DOM: there is no path from an enum to a screen that does not pass
 * through one of these functions.
 *
 * Keys are FULL dotted paths from the message root, so a caller uses the root
 * translator (`useTranslations()` / `getTranslations()` with no namespace) and
 * `t(transactionTypeLabelKey(tx.type))` just works.
 *
 * `Record<Enum, string>` for each map rather than a template literal: a new
 * enum member is then a compile error until it has a key, instead of a silent
 * `undefined` that next-intl renders as the key path itself.
 */
const TRANSACTION_TYPE_KEYS: Record<TransactionType, string> = {
  INCOME: 'labels.transactionType.INCOME',
  EXPENSE: 'labels.transactionType.EXPENSE',
  CASH_IN: 'labels.transactionType.CASH_IN',
  CASH_OUT: 'labels.transactionType.CASH_OUT',
  ADJUSTMENT_INCREASE: 'labels.transactionType.ADJUSTMENT_INCREASE',
  ADJUSTMENT_DECREASE: 'labels.transactionType.ADJUSTMENT_DECREASE',
}
export function transactionTypeLabelKey(type: TransactionType): string {
  return TRANSACTION_TYPE_KEYS[type]
}

const CATEGORY_TYPE_KEYS: Record<CategoryType, string> = {
  INCOME: 'labels.categoryType.INCOME',
  EXPENSE: 'labels.categoryType.EXPENSE',
}
export function categoryTypeLabelKey(type: CategoryType): string {
  return CATEGORY_TYPE_KEYS[type]
}

const RECORD_STATUS_KEYS: Record<RecordStatus, string> = {
  ACTIVE: 'labels.recordStatus.ACTIVE',
  ARCHIVED: 'labels.recordStatus.ARCHIVED',
}
export function recordStatusLabelKey(status: RecordStatus): string {
  return RECORD_STATUS_KEYS[status]
}

const BUDGET_SCOPE_KEYS: Record<BudgetScope, string> = {
  OVERALL: 'labels.budgetScope.OVERALL',
  CATEGORY: 'labels.budgetScope.CATEGORY',
}
export function budgetScopeLabelKey(scope: BudgetScope): string {
  return BUDGET_SCOPE_KEYS[scope]
}

const BUDGET_STATUS_KEYS: Record<BudgetStatus, string> = {
  ok: 'labels.budgetStatus.ok',
  warning_50: 'labels.budgetStatus.warning_50',
  warning_80: 'labels.budgetStatus.warning_80',
  at_100: 'labels.budgetStatus.at_100',
  exceeded: 'labels.budgetStatus.exceeded',
}
export function budgetStatusLabelKey(status: BudgetStatus): string {
  return BUDGET_STATUS_KEYS[status]
}

const GOAL_STATUS_KEYS: Record<SavingsGoalStatus, string> = {
  ACTIVE: 'labels.goalStatus.ACTIVE',
  ACHIEVED: 'labels.goalStatus.ACHIEVED',
  ARCHIVED: 'labels.goalStatus.ARCHIVED',
}
export function goalStatusLabelKey(status: SavingsGoalStatus): string {
  return GOAL_STATUS_KEYS[status]
}

const DEBT_DIRECTION_KEYS: Record<DebtDirection, string> = {
  RECEIVABLE: 'labels.debtDirection.RECEIVABLE',
  PAYABLE: 'labels.debtDirection.PAYABLE',
}
export function debtDirectionLabelKey(direction: DebtDirection): string {
  return DEBT_DIRECTION_KEYS[direction]
}

const DEBT_STATUS_KEYS: Record<DebtDisplayStatus, string> = {
  OPEN: 'labels.debtStatus.OPEN',
  PARTIALLY_PAID: 'labels.debtStatus.PARTIALLY_PAID',
  PAID: 'labels.debtStatus.PAID',
  OVERDUE: 'labels.debtStatus.OVERDUE',
  WRITTEN_OFF: 'labels.debtStatus.WRITTEN_OFF',
}
export function debtStatusLabelKey(status: DebtDisplayStatus): string {
  return DEBT_STATUS_KEYS[status]
}

const LOAN_STATUS_KEYS: Record<LoanDisplayStatus, string> = {
  ACTIVE: 'labels.loanStatus.ACTIVE',
  OVERDUE: 'labels.loanStatus.OVERDUE',
  PAID_OFF: 'labels.loanStatus.PAID_OFF',
  CLOSED: 'labels.loanStatus.CLOSED',
}
export function loanStatusLabelKey(status: LoanDisplayStatus): string {
  return LOAN_STATUS_KEYS[status]
}

const PAYMENT_FREQUENCY_KEYS: Record<PaymentFrequency, string> = {
  WEEKLY: 'labels.paymentFrequency.WEEKLY',
  MONTHLY: 'labels.paymentFrequency.MONTHLY',
  YEARLY: 'labels.paymentFrequency.YEARLY',
}
export function paymentFrequencyLabelKey(frequency: PaymentFrequency): string {
  return PAYMENT_FREQUENCY_KEYS[frequency]
}

const REMINDER_TYPE_KEYS: Record<ReminderType, string> = {
  INCOME: 'labels.reminderType.INCOME',
  EXPENSE: 'labels.reminderType.EXPENSE',
}
export function reminderTypeLabelKey(type: ReminderType): string {
  return REMINDER_TYPE_KEYS[type]
}

/**
 * Recurrence needs the interval as well as the frequency, because "hàng tuần"
 * and "mỗi 3 tuần" are different sentences and only the second takes a count —
 * exactly the distinction `recurrenceLabel` already makes
 * (`lib/ui/reminder-view-model.ts:74-87`), preserved here as two keys instead
 * of two hard-coded English strings. The caller passes `{ count: interval }` to
 * `t`; at interval 1 the key takes no argument and an extra one is harmless.
 *
 * ONE_TIME ignores the interval entirely — `createReminderSchema` refuses
 * anything but 1 on it, and describing a one-off as happening "every 3" of
 * anything would be a schedule it does not have.
 */
const RECURRENCE_KEYS: Record<RecurrenceFrequency, { one: string; many: string }> = {
  ONE_TIME: { one: 'labels.recurrence.ONE_TIME', many: 'labels.recurrence.ONE_TIME' },
  WEEKLY: { one: 'labels.recurrence.WEEKLY', many: 'labels.recurrence.WEEKLY_N' },
  MONTHLY: { one: 'labels.recurrence.MONTHLY', many: 'labels.recurrence.MONTHLY_N' },
  YEARLY: { one: 'labels.recurrence.YEARLY', many: 'labels.recurrence.YEARLY_N' },
}
export function recurrenceLabelKey(frequency: RecurrenceFrequency, interval: number): string {
  const keys = RECURRENCE_KEYS[frequency]
  return interval === 1 ? keys.one : keys.many
}

const OCCURRENCE_STATUS_KEYS: Record<OccurrenceStatus, string> = {
  PENDING: 'labels.occurrenceStatus.PENDING',
  ACKNOWLEDGED: 'labels.occurrenceStatus.ACKNOWLEDGED',
  DISMISSED: 'labels.occurrenceStatus.DISMISSED',
}
export function occurrenceStatusLabelKey(status: OccurrenceStatus): string {
  return OCCURRENCE_STATUS_KEYS[status]
}

const CURRENCY_KEYS: Record<Currency, string> = {
  VND: 'labels.currency.VND',
  USD: 'labels.currency.USD',
}
export function currencyLabelKey(currency: Currency): string {
  return CURRENCY_KEYS[currency]
}
