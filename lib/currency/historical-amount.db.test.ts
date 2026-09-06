import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { historicalAmountIn } from './historical-amount'
import type { HistoricalAmountInput } from './historical-amount'

/**
 * The same guarantees as `historical-amount.test.ts`, but against a real
 * persisted `Transaction`: a Prisma row satisfies `HistoricalAmountInput`
 * structurally (no mapping layer between the table and the conversion), the
 * conversion is read-only, and `User.baseCurrency` — a display preference — has
 * no influence on the numbers.
 *
 * Hits the real database: `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 */

describe('historicalAmountIn against a persisted Transaction', () => {
  let fetchSpy: MockInstance

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('converts a stored row both ways, changes nothing, and ignores User.baseCurrency', async () => {
    const userId = randomUUID()
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `test-${userId}@example.com`,
          name: 'Test',
          emailVerified: false,
        },
      })
      const accountType = await prisma.accountType.create({
        data: { userId, name: 'Cash' },
      })
      // `Transaction.currency` is always a copy of the owning account's
      // currency, so a USD-currency row belongs to a USD account.
      const account = await prisma.financialAccount.create({
        data: {
          userId,
          name: 'Test USD',
          accountTypeId: accountType.id,
          initialBalance: 0,
          currency: 'USD',
        },
      })
      const fxRateFetchedAt = new Date('2026-01-15T03:04:05.000Z')
      const fxRateEffectiveAt = new Date(Date.UTC(2026, 0, 15))
      const created = await prisma.transaction.create({
        data: {
          userId,
          accountId: account.id,
          type: 'EXPENSE',
          amount: new Prisma.Decimal('100.00'),
          currency: 'USD',
          date: new Date('2026-01-15T10:00:00.000Z'),
          vndPerUsdAtEntry: new Prisma.Decimal('26025.122751'),
          fxRateFetchedAt,
          fxRateEffectiveAt,
          fxRateSource: 'fixture',
        },
      })

      // Compile-time proof that no adapter is needed: the row itself is the
      // input type.
      const asInput: HistoricalAmountInput = created
      expect(asInput.currency).toBe('USD')

      const inVnd = historicalAmountIn('VND', created)
      const inUsd = historicalAmountIn('USD', created)

      expect(inVnd.toString()).toBe('2602512.2751')
      expect(inUsd.toString()).toBe('100')
      expect(fetchSpy).not.toHaveBeenCalled()

      // Read-only: every column of the row is exactly as it was written.
      const reread = await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })
      expect(reread).toEqual(created)

      // `User.baseCurrency` is display-only and is never an input to historical
      // conversion — flipping it must not move a single digit.
      await prisma.user.update({ where: { id: userId }, data: { baseCurrency: 'USD' } })

      expect(historicalAmountIn('VND', created).toString()).toBe(inVnd.toString())
      expect(historicalAmountIn('USD', created).toString()).toBe(inUsd.toString())

      const afterFlip = await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })
      expect(afterFlip).toEqual(created)
      expect(historicalAmountIn('VND', afterFlip).toString()).toBe('2602512.2751')
    } finally {
      await prisma.transaction.deleteMany({ where: { userId } })
      await prisma.financialAccount.deleteMany({ where: { userId } })
      await prisma.accountType.deleteMany({ where: { userId } })
      await prisma.user.deleteMany({ where: { id: userId } })
    }
  })
})
