import type { TransactionType } from '@prisma/client'

/**
 * The direction each `TransactionType` moves an account's balance.
 *
 * `Transaction.amount` is always a positive magnitude — the sign of its
 * effect on a balance comes only from `type`, never from a stored sign or
 * arithmetic on the amount itself. This map is the single source for that
 * direction, shared between display (the transaction list's `+`/`−`
 * indicator) and Task 11's balance service (`getAccountBalance`), so the two
 * can never independently drift on what counts as an increase.
 */
export const BALANCE_SIGN: Record<TransactionType, 1 | -1> = {
  INCOME: 1,
  EXPENSE: -1,
  CASH_IN: 1,
  CASH_OUT: -1,
  ADJUSTMENT_INCREASE: 1,
  ADJUSTMENT_DECREASE: -1,
}

/** True for the three types that add to the account's balance. */
export function isBalanceIncreasing(type: TransactionType): boolean {
  return BALANCE_SIGN[type] === 1
}
