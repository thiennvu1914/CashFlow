import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createTransferSchema } from '@/lib/validation/transfer'
import { createTransfer, deleteTransfer, listTransfers, SameAccountTransferError } from './transfer'
import { ArchivedAccountError } from './transaction'
import { getAccountBalance } from './balance'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every user is created with a fresh id and
 * removed again in `afterEach`, so repeated runs are identical.
 *
 * A transfer carries no FX snapshot, so unlike the transaction tests nothing
 * here needs an exchange-rate provider: the only rate a transfer knows is the
 * one implied by its own two amounts.
 */
describe('transfer service', () => {
  const createdUserIds: string[] = []

  /** Account A opens with 1,000,000 and account B with 0, so the two together
   *  hold exactly 1,000,000 before any transfer moves money between them. */
  async function setupTwoAccounts(
    currencyA: 'VND' | 'USD' = 'VND',
    currencyB: 'VND' | 'USD' = 'VND',
  ) {
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

  /** Reads the row back independently of whatever `createTransfer` returned, so
   *  an assertion is about what the database actually holds. */
  async function readTransfer(userId: string, id: string) {
    return prisma.transfer.findUniqueOrThrow({ where: { userId_id: { userId, id } } })
  }

  /**
   * Asserts the rejection is specifically Prisma's not-found. Ownership here
   * comes from the composite `(userId, id)` lookup missing the row, so a bare
   * `rejects.toThrow()` would also pass if the call had failed for an unrelated
   * reason — this pins down *why* another user's account is unusable.
   */
  async function expectNotFound(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2025')
  }

  async function archiveAccount(userId: string, accountId: string) {
    // Task 15 adds the archive service; setting the status directly here proves
    // the transfer service itself refuses an archived account at either end.
    await prisma.financialAccount.update({
      where: { userId_id: { userId, id: accountId } },
      data: { status: 'ARCHIVED' },
    })
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

  describe('createTransfer', () => {
    it('rejects transferring an account to itself', async () => {
      const s = await setupTwoAccounts()

      await expect(
        createTransfer(s.userId, {
          fromAccountId: s.accountAId,
          toAccountId: s.accountAId,
          fromAmount: 100,
          toAmount: 100,
          date: new Date(),
        }),
      ).rejects.toThrow()

      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('records no exchangeRateUsed for a same-currency transfer', async () => {
      const s = await setupTwoAccounts('VND', 'VND')

      const transfer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 500_000,
        toAmount: 500_000,
        date: new Date(),
      })

      expect(transfer.exchangeRateUsed).toBeNull()
      const stored = await readTransfer(s.userId, transfer.id)
      expect(stored.exchangeRateUsed).toBeNull()
      expect(stored.fromAmount.toString()).toBe('500000')
      expect(stored.toAmount.toString()).toBe('500000')
    })

    it('records the effective exchangeRateUsed for a cross-currency transfer', async () => {
      const s = await setupTwoAccounts('VND', 'USD')

      const transfer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 250_000,
        toAmount: 10,
        date: new Date(),
      })

      // Exact, not approximate: `toBeCloseTo` at its default precision of 2
      // would also accept 0, which is exactly the failure mode that matters for
      // a rate this small. `Decimal.toString()` normalises the trailing zeros
      // the `Decimal(24, 12)` column pads it with, so this is the whole value.
      expect(transfer.exchangeRateUsed?.toString()).toBe('0.00004')
      // Cross-currency keeps both client amounts: they are genuinely different
      // quantities of two different currencies, not a conservation violation.
      expect(transfer.fromAmount.toNumber()).toBe(250_000)
      expect(transfer.toAmount.toNumber()).toBe(10)

      const stored = await readTransfer(s.userId, transfer.id)
      expect(stored.exchangeRateUsed?.toString()).toBe('0.00004')
      expect(stored.fromAmount.toString()).toBe('250000')
      expect(stored.toAmount.toString()).toBe('10')
    })

    it('conserves money on a same-currency transfer: a crafted mismatched toAmount is overridden server-side', async () => {
      const s = await setupTwoAccounts('VND', 'VND')

      // Crafted request: 100 out, 500 in. The server must store toAmount = fromAmount = 100.
      const transfer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 100,
        toAmount: 500,
        date: new Date(),
      })

      expect(transfer.toAmount.toNumber()).toBe(100)
      expect(transfer.fromAmount.toNumber()).toBe(100)
      // Re-read: what the service returned and what the database holds are two
      // different claims, and it is the stored row that later balances read.
      const stored = await readTransfer(s.userId, transfer.id)
      expect(stored.toAmount.toString()).toBe('100')
      expect(stored.fromAmount.toString()).toBe('100')
      expect(stored.exchangeRateUsed).toBeNull()
      // Total money across both accounts is unchanged: 1,000,000 + 0 before,
      // 999,900 + 100 after. `getAccountBalance` includes the transfer legs
      // since Task 13, so this is a live conservation check.
      const a = await getAccountBalance(s.userId, s.accountAId)
      const b = await getAccountBalance(s.userId, s.accountBId)
      expect(a.toString()).toBe('999900')
      expect(b.toString()).toBe('100')
      expect(a.add(b).toNumber()).toBe(1_000_000)
    })

    it('rejects a transfer whose source account is archived', async () => {
      const s = await setupTwoAccounts()
      await archiveAccount(s.userId, s.accountAId)

      await expect(
        createTransfer(s.userId, {
          fromAccountId: s.accountAId,
          toAccountId: s.accountBId,
          fromAmount: 100,
          toAmount: 100,
          date: new Date(),
        }),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('rejects a transfer whose destination account is archived', async () => {
      const s = await setupTwoAccounts()
      await archiveAccount(s.userId, s.accountBId)

      await expect(
        createTransfer(s.userId, {
          fromAccountId: s.accountAId,
          toAccountId: s.accountBId,
          fromAmount: 100,
          toAmount: 100,
          date: new Date(),
        }),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
    })

    it("rejects another user's toAccountId and writes nothing", async () => {
      const s = await setupTwoAccounts()
      const other = await setupTwoAccounts()

      await expectNotFound(
        createTransfer(s.userId, {
          fromAccountId: s.accountAId,
          toAccountId: other.accountBId,
          fromAmount: 100,
          toAmount: 100,
          date: new Date(),
        }),
      )

      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
      expect(await prisma.transfer.count({ where: { userId: other.userId } })).toBe(0)
    })

    it("rejects another user's fromAccountId and writes nothing", async () => {
      const s = await setupTwoAccounts()
      const other = await setupTwoAccounts()

      await expectNotFound(
        createTransfer(s.userId, {
          fromAccountId: other.accountAId,
          toAccountId: s.accountBId,
          fromAmount: 100,
          toAmount: 100,
          date: new Date(),
        }),
      )

      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
      expect(await prisma.transfer.count({ where: { userId: other.userId } })).toBe(0)
    })

    it('stores the note and the given date', async () => {
      const s = await setupTwoAccounts()

      const transfer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 250,
        toAmount: 250,
        date: new Date('2026-02-01'),
        note: 'Moving cash to the bank',
      })

      expect(transfer.userId).toBe(s.userId)
      expect(transfer.note).toBe('Moving cash to the bank')
      expect(transfer.date.toISOString()).toBe(new Date('2026-02-01').toISOString())
      // A transfer is its own entity: it is never income or expense, so there
      // is no transaction row hiding behind it.
      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })
  })

  describe('listTransfers', () => {
    it('returns only the calling user rows, newest first, with both accounts included', async () => {
      const s = await setupTwoAccounts()
      const other = await setupTwoAccounts()
      const older = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 100,
        toAmount: 100,
        date: new Date('2026-01-01'),
      })
      const newer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 200,
        toAmount: 200,
        date: new Date('2026-02-01'),
      })
      await createTransfer(other.userId, {
        fromAccountId: other.accountAId,
        toAccountId: other.accountBId,
        fromAmount: 999,
        toAmount: 999,
        date: new Date('2026-03-01'),
      })

      const rows = await listTransfers(s.userId)

      expect(rows.map((r) => r.id)).toEqual([newer.id, older.id])
      expect(rows[0].fromAccount.name).toBe('A')
      expect(rows[0].toAccount.name).toBe('B')
    })

    it('orders same-date rows by entry order, newest first, and returns the same order every call', async () => {
      const s = await setupTwoAccounts()
      const sameDate = new Date('2026-02-01')
      const created = []
      for (const amount of [100, 200, 300]) {
        created.push(
          await createTransfer(s.userId, {
            fromAccountId: s.accountAId,
            toAccountId: s.accountBId,
            fromAmount: amount,
            toAmount: amount,
            date: sameDate,
          }),
        )
      }
      // `createdAt` is TIMESTAMP(3): three inserts can land in the same
      // millisecond and leave the tie-break to chance. Pinning three distinct
      // values makes the assertion about the ordering rule rather than about
      // how fast the database happened to be.
      for (const [index, transfer] of created.entries()) {
        await prisma.transfer.update({
          where: { userId_id: { userId: s.userId, id: transfer.id } },
          data: { createdAt: new Date(Date.UTC(2026, 1, 1, 12, 0, index)) },
        })
      }

      const first = await listTransfers(s.userId)
      const second = await listTransfers(s.userId)

      const newestFirst = created.map((t) => t.id).reverse()
      expect(first.map((r) => r.id)).toEqual(newestFirst)
      expect(second.map((r) => r.id)).toEqual(newestFirst)
    })

    it('falls back to a deterministic id order when date and createdAt both tie', async () => {
      const s = await setupTwoAccounts()
      const sameDate = new Date('2026-02-01')
      for (const amount of [100, 200, 300]) {
        await createTransfer(s.userId, {
          fromAccountId: s.accountAId,
          toAccountId: s.accountBId,
          fromAmount: amount,
          toAmount: amount,
          date: sameDate,
        })
      }
      await prisma.transfer.updateMany({
        where: { userId: s.userId },
        data: { createdAt: new Date(Date.UTC(2026, 1, 1, 12, 0, 0)) },
      })

      const rows = await listTransfers(s.userId)

      // The expected order comes from the database's own `id DESC` (its
      // collation, not JavaScript's), so this asserts the tie-break clause is
      // applied rather than re-implementing string comparison here.
      const byIdDesc = await prisma.transfer.findMany({
        where: { userId: s.userId },
        orderBy: { id: 'desc' },
        select: { id: true },
      })
      expect(rows.map((r) => r.id)).toEqual(byIdDesc.map((r) => r.id))
      expect(rows).toHaveLength(3)
    })
  })

  describe('deleteTransfer', () => {
    it('restores both balances exactly', async () => {
      const s = await setupTwoAccounts()
      const transfer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 250_000,
        toAmount: 250_000,
        date: new Date('2026-02-01'),
      })
      expect((await getAccountBalance(s.userId, s.accountAId)).toString()).toBe('750000')
      expect((await getAccountBalance(s.userId, s.accountBId)).toString()).toBe('250000')

      await deleteTransfer(s.userId, transfer.id)

      // No stored balance anywhere: removing the row is the whole undo.
      expect((await getAccountBalance(s.userId, s.accountAId)).toString()).toBe('1000000')
      expect((await getAccountBalance(s.userId, s.accountBId)).toString()).toBe('0')
      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('refuses to delete a transfer whose source account is archived, leaving the row in place', async () => {
      const s = await setupTwoAccounts()
      const transfer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 100,
        toAmount: 100,
        date: new Date('2026-02-01'),
      })
      await archiveAccount(s.userId, s.accountAId)

      await expect(deleteTransfer(s.userId, transfer.id)).rejects.toThrow(ArchivedAccountError)

      expect(await readTransfer(s.userId, transfer.id)).toBeTruthy()
    })

    it('refuses to delete a transfer whose destination account is archived', async () => {
      const s = await setupTwoAccounts()
      const transfer = await createTransfer(s.userId, {
        fromAccountId: s.accountAId,
        toAccountId: s.accountBId,
        fromAmount: 100,
        toAmount: 100,
        date: new Date('2026-02-01'),
      })
      // B holds the 100 that arrived, so archiving it needs the balance back
      // at zero first — a second transfer returning the money does that
      // without touching the row under test.
      await createTransfer(s.userId, {
        fromAccountId: s.accountBId,
        toAccountId: s.accountAId,
        fromAmount: 100,
        toAmount: 100,
        date: new Date('2026-02-02'),
      })
      await archiveAccount(s.userId, s.accountBId)

      await expect(deleteTransfer(s.userId, transfer.id)).rejects.toThrow(ArchivedAccountError)

      expect(await readTransfer(s.userId, transfer.id)).toBeTruthy()
    })

    it("refuses to delete another user's transfer (P2025) and leaves the row in place", async () => {
      const s = await setupTwoAccounts()
      const other = await setupTwoAccounts()
      const transfer = await createTransfer(other.userId, {
        fromAccountId: other.accountAId,
        toAccountId: other.accountBId,
        fromAmount: 100,
        toAmount: 100,
        date: new Date('2026-02-01'),
      })

      await expectNotFound(deleteTransfer(s.userId, transfer.id))

      expect(await readTransfer(other.userId, transfer.id)).toBeTruthy()
    })
  })

  describe('createTransferSchema', () => {
    function parseWithAmounts(fromAmount: number, toAmount = 100) {
      return createTransferSchema.safeParse({
        fromAccountId: 'a',
        toAccountId: 'b',
        fromAmount,
        toAmount,
        date: new Date(),
      }).success
    }

    it('rejects a fromAmount of zero', () => {
      expect(parseWithAmounts(0)).toBe(false)
    })

    it('rejects a negative fromAmount', () => {
      expect(parseWithAmounts(-1)).toBe(false)
    })

    it('rejects a fromAmount with more than 2 decimal places', () => {
      expect(parseWithAmounts(12.345)).toBe(false)
    })

    it('accepts a fromAmount with exactly 2 decimal places', () => {
      expect(parseWithAmounts(12.34)).toBe(true)
    })

    // `toAmount` gets the same treatment as `fromAmount`: it is only ignored
    // for a same-currency transfer, and on the cross-currency path it is the
    // amount actually received, so it has to satisfy the same money rule.
    it('rejects a toAmount of zero', () => {
      expect(parseWithAmounts(100, 0)).toBe(false)
    })

    it('rejects a negative toAmount', () => {
      expect(parseWithAmounts(100, -1)).toBe(false)
    })

    it('rejects a toAmount with more than 2 decimal places', () => {
      expect(parseWithAmounts(100, 12.345)).toBe(false)
    })

    it('accepts a toAmount with exactly 2 decimal places', () => {
      expect(parseWithAmounts(100, 12.34)).toBe(true)
    })

    it('rejects an unparseable date', () => {
      expect(
        createTransferSchema.safeParse({
          fromAccountId: 'a',
          toAccountId: 'b',
          fromAmount: 100,
          toAmount: 100,
          date: 'not-a-date',
        }).success,
      ).toBe(false)
    })

    it('rejects identical account ids', () => {
      const result = createTransferSchema.safeParse({
        fromAccountId: 'same',
        toAccountId: 'same',
        fromAmount: 100,
        toAmount: 100,
        date: new Date(),
      })
      expect(result.success).toBe(false)
      expect(result.error?.issues.some((i) => i.path.includes('toAccountId'))).toBe(true)
    })

    it('exports the service-level same-account guard as its own error type', () => {
      // Defence in depth: the schema refine above is the first line, and the
      // service re-checks the resolved accounts after lookup. Only the schema
      // can be reached through `createTransfer`, so the second line is asserted
      // here as a distinguishable error type rather than through a crafted call.
      expect(new SameAccountTransferError()).toBeInstanceOf(Error)
      expect(new SameAccountTransferError().name).toBe('SameAccountTransferError')
    })
  })

  describe('database CHECK constraints (R-17)', () => {
    it('refuses a negative Transaction.amount at the database level', async () => {
      const s = await setupTwoAccounts()

      await expect(
        prisma.transaction.create({
          data: {
            userId: s.userId,
            accountId: s.accountAId,
            type: 'CASH_OUT',
            amount: -1,
            currency: 'VND',
            date: new Date(),
            vndPerUsdAtEntry: 25000,
            fxRateTimestamp: new Date(),
            fxRateSource: 'fixture',
          },
        }),
      ).rejects.toThrow(/Transaction_amount_nonnegative/)

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('refuses a zero Transfer.fromAmount at the database level', async () => {
      const s = await setupTwoAccounts()

      await expect(
        prisma.transfer.create({
          data: {
            userId: s.userId,
            fromAccountId: s.accountAId,
            toAccountId: s.accountBId,
            fromAmount: 0,
            toAmount: 100,
            date: new Date(),
          },
        }),
      ).rejects.toThrow(/Transfer_fromAmount_positive/)

      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('refuses a zero Transfer.toAmount at the database level', async () => {
      const s = await setupTwoAccounts()

      await expect(
        prisma.transfer.create({
          data: {
            userId: s.userId,
            fromAccountId: s.accountAId,
            toAccountId: s.accountBId,
            fromAmount: 100,
            toAmount: 0,
            date: new Date(),
          },
        }),
      ).rejects.toThrow(/Transfer_toAmount_positive/)

      expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
    })
  })
})
