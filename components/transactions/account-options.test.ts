import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { toAccountOptions } from './account-options'

const accounts = [
  { id: 'a1', name: 'Cash', currency: 'VND' as const },
  { id: 'a2', name: 'Fresh', currency: 'USD' as const },
]

describe('toAccountOptions', () => {
  it('joins balances by account id as fixed-2-decimal strings', () => {
    const result = toAccountOptions(
      accounts,
      new Map([
        ['a1', new Prisma.Decimal('1500000')],
        ['a2', new Prisma.Decimal('12.5')],
      ]),
    )
    expect(result.map((o) => o.balance)).toEqual(['1500000.00', '12.50'])
  })

  it('treats an account with no balance yet (created mid-request) as zero instead of throwing', () => {
    const result = toAccountOptions(accounts, new Map([['a1', new Prisma.Decimal('10')]]))
    expect(result).toEqual([
      { id: 'a1', name: 'Cash', currency: 'VND', balance: '10.00' },
      { id: 'a2', name: 'Fresh', currency: 'USD', balance: '0.00' },
    ])
  })
})
