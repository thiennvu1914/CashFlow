import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import { createTransfer } from './transfer'

/**
 * R-19: `Transfer.exchangeRateUsed` was widened from `Decimal(18,6)` to
 * `Decimal(24,12)` so a cross-currency rate keeps its full precision instead
 * of being silently rounded to 6 fractional digits by Postgres. A separate,
 * small file rather than an addition to `transfer.test.ts` — that file is
 * being read by a concurrent reviewer and must not change underneath them.
 *
 * Hits the real database, same pattern as `transfer.test.ts`: every user
 * created here is removed again in `afterEach`.
 */
describe('Transfer.exchangeRateUsed precision (R-19)', () => {
  const createdUserIds: string[] = []

  async function setupTwoAccounts(currencyA: 'VND' | 'USD', currencyB: 'VND' | 'USD') {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `test-${randomUUID()}@example.com`,
        name: 'Test',
        emailVerified: false,
      },
    })
    createdUserIds.push(user.id)
    const accountType = await prisma.accountType.create({
      data: { userId: user.id, name: 'Cash' },
    })
    const a = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'A',
        accountTypeId: accountType.id,
        initialBalance: 1_000_000,
        currency: currencyA,
      },
    })
    const b = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'B',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: currencyB,
      },
    })
    return { userId: user.id, accountAId: a.id, accountBId: b.id }
  }

  afterEach(async () => {
    const userIds = createdUserIds.splice(0)
    if (userIds.length === 0) return
    try {
      await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
  })

  it('stores the exact effective rate for a VND→USD transfer of 250000 → 10', async () => {
    const s = await setupTwoAccounts('VND', 'USD')

    const transfer = await createTransfer(s.userId, {
      fromAccountId: s.accountAId,
      toAccountId: s.accountBId,
      fromAmount: 250_000,
      toAmount: 10,
      date: new Date(),
    })

    expect(transfer.exchangeRateUsed?.toString()).toBe('0.00004')
  })

  it('stores the exact effective rate for a 1 → 3 cross-currency transfer', async () => {
    const s = await setupTwoAccounts('VND', 'USD')

    const transfer = await createTransfer(s.userId, {
      fromAccountId: s.accountAId,
      toAccountId: s.accountBId,
      fromAmount: 1,
      toAmount: 3,
      date: new Date(),
    })

    expect(transfer.exchangeRateUsed?.toString()).toBe('3')
  })
})
