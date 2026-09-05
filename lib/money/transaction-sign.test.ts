import { describe, it, expect } from 'vitest'
import type { TransactionType } from '@prisma/client'
import { BALANCE_SIGN, isBalanceIncreasing } from './transaction-sign'

describe('BALANCE_SIGN', () => {
  it('assigns +1 to every balance-increasing type', () => {
    expect(BALANCE_SIGN.INCOME).toBe(1)
    expect(BALANCE_SIGN.CASH_IN).toBe(1)
    expect(BALANCE_SIGN.ADJUSTMENT_INCREASE).toBe(1)
  })

  it('assigns -1 to every balance-decreasing type', () => {
    expect(BALANCE_SIGN.EXPENSE).toBe(-1)
    expect(BALANCE_SIGN.CASH_OUT).toBe(-1)
    expect(BALANCE_SIGN.ADJUSTMENT_DECREASE).toBe(-1)
  })

  it('covers exactly the six TransactionType members', () => {
    const expected: TransactionType[] = [
      'INCOME',
      'EXPENSE',
      'CASH_IN',
      'CASH_OUT',
      'ADJUSTMENT_INCREASE',
      'ADJUSTMENT_DECREASE',
    ]
    expect(Object.keys(BALANCE_SIGN).sort()).toEqual([...expected].sort())
  })
})

describe('isBalanceIncreasing', () => {
  it('is true for INCOME, CASH_IN and ADJUSTMENT_INCREASE', () => {
    expect(isBalanceIncreasing('INCOME')).toBe(true)
    expect(isBalanceIncreasing('CASH_IN')).toBe(true)
    expect(isBalanceIncreasing('ADJUSTMENT_INCREASE')).toBe(true)
  })

  it('is false for EXPENSE, CASH_OUT and ADJUSTMENT_DECREASE', () => {
    expect(isBalanceIncreasing('EXPENSE')).toBe(false)
    expect(isBalanceIncreasing('CASH_OUT')).toBe(false)
    expect(isBalanceIncreasing('ADJUSTMENT_DECREASE')).toBe(false)
  })
})
