import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { prisma } from '@/lib/prisma'
import { FxUnavailableError } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { createTransactionSchema } from '@/lib/validation/transaction'
import { instantToLocalDateTime, localDateTimeToInstant } from '@/lib/datetime/local-date-time'
import {
  ArchivedAccountError,
  CurrencyMismatchError,
  InvalidCategoryError,
  createTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction,
} from './transaction'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 *
 * Every call passes an injected fake provider, and `beforeEach` replaces
 * `fetch` with a throwing spy, so no test here can reach the network: an
 * accidental live lookup fails the test that caused it rather than passing
 * quietly. The USD/VND `ExchangeRate` rows are global (not user-scoped), so
 * `afterEach` clears them along with the user's own rows.
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

/** Every `source` string this file can write into the shared FX cache. */
const FAKE_SOURCES = ['fake', 'fake-2', 'fake-precise', 'seeded']

/**
 * A deterministic provider plus the exact timestamps it returns, so a test can
 * assert that the stored snapshot carries the provider's own `fetchedAt` rather
 * than a wall-clock "now" invented at write time.
 */
function fakeProvider(rate = 25000, source = 'fake') {
  // Deliberately in the past: a service that substituted `new Date()` for the
  // FX timestamp would still be "about now" and could slip past an equality
  // check made against a value captured in the same millisecond.
  const fetchedAt = new Date(Date.now() - 5 * 60 * 1000)
  const effectiveDate = new Date()
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => ({ rate, effectiveDate, fetchedAt, source }),
    getHistoricalRate: async () => null,
  }
  return { provider, fetchedAt, effectiveDate, rate, source }
}

/**
 * The UTC start of the day containing `date` — the `ExchangeRate` cache key,
 * and therefore the `fxRateEffectiveAt` a snapshot taken from a live lookup
 * must carry (the rate is published per day, not per instant).
 */
function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/** Stands in for a live provider outage — the only way into the fallback path. */
const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

/**
 * `getLatestRate` serves today's UTC day from the cache, so the first FX call
 * of a test pins the rate for every later call that day. Tests that need a
 * *second*, different snapshot clear the cache first — the same thing the
 * calendar does in production when the day rolls over.
 */
async function clearFxCache() {
  await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
}

describe('transaction service', () => {
  const createdUserIds: string[] = []
  let fetchSpy: MockInstance

  async function setup() {
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
    const account = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'Test',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      },
    })
    // A second account in the SAME currency: moving a row between two of
    // these is the legitimate account change, as opposed to a move across
    // currencies (which `updateTransaction` refuses).
    const secondAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'Test 2',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      },
    })
    const usdAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'Test USD',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'USD',
      },
    })
    const expenseCategory = await prisma.category.create({
      data: { userId: user.id, name: 'Food', type: 'EXPENSE' },
    })
    const incomeCategory = await prisma.category.create({
      data: { userId: user.id, name: 'Salary', type: 'INCOME' },
    })
    return {
      userId: user.id,
      accountId: account.id,
      secondAccountId: secondAccount.id,
      usdAccountId: usdAccount.id,
      accountTypeId: accountType.id,
      expenseCategoryId: expenseCategory.id,
      incomeCategoryId: incomeCategory.id,
    }
  }

  async function archiveAccount(userId: string, accountId: string) {
    // Task 15 adds the archive service; setting the status directly here proves
    // the transaction service itself refuses an archived account.
    await prisma.financialAccount.update({
      where: { userId_id: { userId, id: accountId } },
      data: { status: 'ARCHIVED' },
    })
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    // The fallback path warns by design; silenced to keep the output pristine.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    const userIds = createdUserIds.splice(0)
    try {
      await prisma.exchangeRate.deleteMany({ where: { source: { in: FAKE_SOURCES } } })
      await clearFxCache()
      if (userIds.length > 0) {
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    // Asserted after cleanup so a network leak fails the run without also
    // leaving rows behind for the next test.
    expect(fetchCalls).toBe(0)
  })

  describe('createTransaction', () => {
    it('rejects an EXPENSE transaction with no category', async () => {
      const s = await setup()
      await expect(
        createTransaction(
          s.userId,
          { accountId: s.accountId, type: 'EXPENSE', amount: 1000, date: new Date() },
          fakeProvider().provider,
        ),
      ).rejects.toThrow()
      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('allows a CASH_IN transaction with no category and snapshots the FX rate through getUsableCurrentRate', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 5000, date: new Date() },
        fakeProvider().provider,
      )
      expect(tx.categoryId).toBeNull()
      expect(tx.vndPerUsdAtEntry.toNumber()).toBe(25000)
      expect(tx.fxRateSource).toBe('fake')
    })

    it('rejects EXPENSE with an INCOME category', async () => {
      const s = await setup()
      await expect(
        createTransaction(
          s.userId,
          {
            accountId: s.accountId,
            categoryId: s.incomeCategoryId,
            type: 'EXPENSE',
            amount: 1000,
            date: new Date(),
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(InvalidCategoryError)
    })

    it('rejects INCOME with an EXPENSE category', async () => {
      const s = await setup()
      await expect(
        createTransaction(
          s.userId,
          {
            accountId: s.accountId,
            categoryId: s.expenseCategoryId,
            type: 'INCOME',
            amount: 1000,
            date: new Date(),
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(InvalidCategoryError)
    })

    it('rejects an archived category for a new transaction', async () => {
      const s = await setup()
      await prisma.category.update({
        where: { userId_id: { userId: s.userId, id: s.expenseCategoryId } },
        data: { status: 'ARCHIVED' },
      })
      await expect(
        createTransaction(
          s.userId,
          {
            accountId: s.accountId,
            categoryId: s.expenseCategoryId,
            type: 'EXPENSE',
            amount: 1000,
            date: new Date(),
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(InvalidCategoryError)
    })

    it('rejects any new activity on an archived account, even via a crafted request', async () => {
      const s = await setup()
      await archiveAccount(s.userId, s.accountId)
      await expect(
        createTransaction(
          s.userId,
          { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date() },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)
      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('deletes cleanly without affecting other rows', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 20000,
          date: new Date(),
        },
        fakeProvider().provider,
      )
      await deleteTransaction(s.userId, tx.id)
      expect(await prisma.transaction.findMany({ where: { userId: s.userId } })).toHaveLength(0)
    })

    it('creates every transaction type and always stores the account currency', async () => {
      const s = await setup()
      const cases = [
        { type: 'INCOME' as const, categoryId: s.incomeCategoryId },
        { type: 'EXPENSE' as const, categoryId: s.expenseCategoryId },
        { type: 'CASH_IN' as const, categoryId: undefined },
        { type: 'CASH_OUT' as const, categoryId: undefined },
        { type: 'ADJUSTMENT_INCREASE' as const, categoryId: undefined },
        { type: 'ADJUSTMENT_DECREASE' as const, categoryId: undefined },
      ]

      for (const c of cases) {
        const tx = await createTransaction(
          s.userId,
          {
            accountId: s.accountId,
            categoryId: c.categoryId,
            type: c.type,
            amount: 100,
            date: new Date(),
          },
          fakeProvider().provider,
        )
        expect(tx.type).toBe(c.type)
        expect(tx.currency).toBe('VND')
        // The amount column is a magnitude for every type; direction lives in `type`.
        expect(tx.amount.toString()).toBe('100')
        expect(tx.categoryId).toBe(c.categoryId ?? null)
      }

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(cases.length)
    })

    it('stores currency USD for a USD account and still snapshots the USD/VND rate', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.usdAccountId, type: 'CASH_IN', amount: 40, date: new Date() },
        fakeProvider().provider,
      )
      expect(tx.currency).toBe('USD')
      // The snapshot pair is always USD/VND — it does not follow the account.
      expect(tx.vndPerUsdAtEntry.toNumber()).toBe(25000)
      expect(tx.fxRateSource).toBe('fake')
    })

    it("rejects another user's accountId and writes nothing", async () => {
      const s = await setup()
      const other = await setup()
      await expect(
        createTransaction(
          s.userId,
          { accountId: other.accountId, type: 'CASH_IN', amount: 100, date: new Date() },
          fakeProvider().provider,
        ),
      ).rejects.toThrow()
      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
      expect(await prisma.transaction.count({ where: { userId: other.userId } })).toBe(0)
    })

    it("rejects another user's categoryId and writes nothing", async () => {
      const s = await setup()
      const other = await setup()
      await expect(
        createTransaction(
          s.userId,
          {
            accountId: s.accountId,
            categoryId: other.expenseCategoryId,
            type: 'EXPENSE',
            amount: 100,
            date: new Date(),
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow()
      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('stores the provider rate, source and real fetch instant as the snapshot', async () => {
      const s = await setup()
      const f = fakeProvider(26123.456789, 'fake-precise')

      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: new Date() },
        f.provider,
      )

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      // vndPerUsdAtEntry is Decimal(18, 6) — the same scale as
      // `ExchangeRate.rate` — so the provider's 6 decimal places survive
      // intact instead of being rounded to 4 on the way in.
      expect(stored.vndPerUsdAtEntry.toString()).toBe('26123.456789')
      expect(stored.fxRateSource).toBe('fake-precise')
      // When *we* fetched it: the provider's own instant, not "now".
      expect(stored.fxRateFetchedAt.toISOString()).toBe(f.fetchedAt.toISOString())
      // Which day the rate applies to: the UTC start of the provider's
      // effective day, i.e. the cache key the rate is filed under.
      expect(stored.fxRateEffectiveAt.toISOString()).toBe(
        utcDayStart(f.effectiveDate).toISOString(),
      )
    })

    it('stores the snapshot at exactly the precision the FX cache holds', async () => {
      const s = await setup()
      const f = fakeProvider(26123.456789, 'fake-precise')

      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: new Date() },
        f.provider,
      )

      // The snapshot and the cache row it came from are the same number, to the
      // digit. When `vndPerUsdAtEntry` was Decimal(18, 4) they silently
      // disagreed, so a transaction could never be reconciled against the rate
      // that was actually used to record it.
      const cached = await prisma.exchangeRate.findFirstOrThrow({
        where: { base: PAIR.base, quote: PAIR.quote, source: 'fake-precise' },
      })
      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      expect(stored.vndPerUsdAtEntry.equals(cached.rate)).toBe(true)
    })

    it('records the fallback provenance when the live provider is down', async () => {
      const s = await setup()
      // A cache row for *yesterday's* UTC day: inside the 48-hour fallback
      // window, but not today's cache key, so `getLatestRate` misses it and the
      // fallback path is what finds it.
      //
      // Its `fetchedAt` is deliberately a different instant from its
      // `effectiveDate` — the two answer different questions, and this is
      // exactly the case where they diverge. Both must reach the snapshot
      // unaltered; a service that wrote "now" into either, or copied one into
      // the other, would fail here.
      const seededEffectiveDate = new Date(utcDayStart(new Date()).getTime() - 24 * 60 * 60 * 1000)
      const seededFetchedAt = new Date(
        seededEffectiveDate.getTime() + 23 * 60 * 60 * 1000 + 30 * 60 * 1000,
      )
      await prisma.exchangeRate.create({
        data: {
          base: PAIR.base,
          quote: PAIR.quote,
          rate: 24800,
          effectiveDate: seededEffectiveDate,
          fetchedAt: seededFetchedAt,
          source: 'seeded',
        },
      })

      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: new Date() },
        failingProvider,
      )

      expect(tx.vndPerUsdAtEntry.toNumber()).toBe(24800)
      expect(tx.fxRateSource).toBe('cache-fallback:seeded')
      expect(tx.fxRateFetchedAt.toISOString()).toBe(seededFetchedAt.toISOString())
      expect(tx.fxRateEffectiveAt.toISOString()).toBe(seededEffectiveDate.toISOString())
      // The snapshot says honestly that it used yesterday's rate, retrieved
      // yesterday — not that either happened today.
      expect(tx.fxRateEffectiveAt.getTime()).toBeLessThan(tx.fxRateFetchedAt.getTime())
    })

    it('refuses to create anything when no rate is available at all', async () => {
      const s = await setup()
      await clearFxCache()

      await expect(
        createTransaction(
          s.userId,
          { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: new Date() },
          failingProvider,
        ),
      ).rejects.toThrow(FxUnavailableError)

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('rejects a negative amount and writes nothing', async () => {
      const s = await setup()
      await expect(
        createTransaction(
          s.userId,
          { accountId: s.accountId, type: 'CASH_OUT', amount: -100, date: new Date() },
          fakeProvider().provider,
        ),
      ).rejects.toThrow()
      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })
  })

  describe('listTransactions', () => {
    it('returns only the calling user rows, newest first', async () => {
      const s = await setup()
      const other = await setup()
      const older = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: new Date('2026-01-01') },
        fakeProvider().provider,
      )
      const newer = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_OUT', amount: 200, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )
      await createTransaction(
        other.userId,
        { accountId: other.accountId, type: 'CASH_IN', amount: 999, date: new Date('2026-03-01') },
        fakeProvider().provider,
      )

      const rows = await listTransactions(s.userId)

      expect(rows.map((r) => r.id)).toEqual([newer.id, older.id])
    })

    it('orders same-date rows by entry order, newest first, and returns the same order every call', async () => {
      const s = await setup()
      const sameDate = new Date('2026-02-01')
      const created = []
      for (const amount of [100, 200, 300]) {
        created.push(
          await createTransaction(
            s.userId,
            { accountId: s.accountId, type: 'CASH_IN', amount, date: sameDate },
            fakeProvider().provider,
          ),
        )
      }
      // `createdAt` is TIMESTAMP(3): three inserts can land in the same
      // millisecond and leave the tie-break to chance. Pinning three distinct
      // values makes the assertion about the ordering rule rather than about
      // how fast the database happened to be.
      for (const [index, tx] of created.entries()) {
        await prisma.transaction.update({
          where: { userId_id: { userId: s.userId, id: tx.id } },
          data: { createdAt: new Date(Date.UTC(2026, 1, 1, 12, 0, index)) },
        })
      }

      const first = await listTransactions(s.userId)
      const second = await listTransactions(s.userId)

      const newestFirst = created.map((tx) => tx.id).reverse()
      expect(first.map((r) => r.id)).toEqual(newestFirst)
      // Stable: the ordering is total, so a re-render cannot shuffle the list.
      expect(second.map((r) => r.id)).toEqual(newestFirst)
    })

    it('falls back to a deterministic id order when date and createdAt both tie', async () => {
      const s = await setup()
      const sameDate = new Date('2026-02-01')
      const created = []
      for (const amount of [100, 200, 300]) {
        created.push(
          await createTransaction(
            s.userId,
            { accountId: s.accountId, type: 'CASH_IN', amount, date: sameDate },
            fakeProvider().provider,
          ),
        )
      }
      const sameCreatedAt = new Date(Date.UTC(2026, 1, 1, 12, 0, 0))
      await prisma.transaction.updateMany({
        where: { userId: s.userId },
        data: { createdAt: sameCreatedAt },
      })

      const rows = await listTransactions(s.userId)

      // The expected order comes from the database's own `id DESC` (its
      // collation, not JavaScript's), so this asserts the tie-break clause is
      // applied rather than re-implementing string comparison here.
      const byIdDesc = await prisma.transaction.findMany({
        where: { userId: s.userId },
        orderBy: { id: 'desc' },
        select: { id: true },
      })
      expect(rows.map((r) => r.id)).toEqual(byIdDesc.map((r) => r.id))
      expect(rows).toHaveLength(created.length)
    })

    it('honours an explicit limit, keeping the newest rows', async () => {
      const s = await setup()
      const created = []
      for (const day of ['2026-01-01', '2026-02-01', '2026-03-01']) {
        created.push(
          await createTransaction(
            s.userId,
            { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: new Date(day) },
            fakeProvider().provider,
          ),
        )
      }

      const rows = await listTransactions(s.userId, { limit: 2 })

      expect(rows).toHaveLength(2)
      // Newest first, so the January row is the one dropped.
      expect(rows.map((r) => r.id)).toEqual([created[2].id, created[1].id])
    })

    it('clamps a limit above the hard cap and refuses a non-positive one', async () => {
      const s = await setup()
      await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: new Date('2026-01-01') },
        fakeProvider().provider,
      )

      // An absurd limit is clamped rather than honoured — the point of the
      // bound is that no caller can ask the page to load the whole ledger.
      expect(await listTransactions(s.userId, { limit: 10_000 })).toHaveLength(1)
      await expect(listTransactions(s.userId, { limit: 0 })).rejects.toThrow('limit')
      await expect(listTransactions(s.userId, { limit: -5 })).rejects.toThrow('limit')
    })

    it('selects only the columns the list renders — no userId or initialBalance on the joined account', async () => {
      const s = await setup()
      await createTransaction(
        s.userId,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1000,
          date: new Date('2026-02-01'),
        },
        fakeProvider().provider,
      )

      const [row] = await listTransactions(s.userId)

      expect(Object.keys(row).sort()).toEqual(
        [
          'account',
          'amount',
          'category',
          'currency',
          'date',
          'fxRateSource',
          'id',
          'note',
          'type',
        ].sort(),
      )
      expect(Object.keys(row.account)).toEqual(['name'])
      expect(row.category).not.toBeNull()
      expect(Object.keys(row.category as { name: string })).toEqual(['name'])
      // Nothing the list never renders travels to the client component: no
      // `userId`, no FX rate, no opening balance of the joined account.
      expect(row).not.toHaveProperty('userId')
      expect(row).not.toHaveProperty('vndPerUsdAtEntry')
      expect(row.account).not.toHaveProperty('initialBalance')
    })
  })

  describe('updateTransaction — FX re-snapshot on economic edits (R-6)', () => {
    async function createBase(s: Awaited<ReturnType<typeof setup>>) {
      return createTransaction(
        s.userId,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1000,
          date: new Date('2026-02-01'),
          note: 'original',
        },
        fakeProvider().provider,
      )
    }

    it('keeps the original snapshot when only the note changes', async () => {
      const s = await setup()
      const tx = await createBase(s)
      // Cleared so a re-snapshot would have to call the (different) provider —
      // if the snapshot still says 'fake' afterwards, no FX call happened.
      await clearFxCache()

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1000,
          date: new Date('2026-02-01'),
          note: 'corrected wording',
        },
        fakeProvider(25500, 'fake-2').provider,
      )

      expect(updated.note).toBe('corrected wording')
      expect(updated.vndPerUsdAtEntry.toString()).toBe(tx.vndPerUsdAtEntry.toString())
      expect(updated.fxRateSource).toBe('fake')
      expect(updated.fxRateFetchedAt.toISOString()).toBe(tx.fxRateFetchedAt.toISOString())
      expect(updated.fxRateEffectiveAt.toISOString()).toBe(tx.fxRateEffectiveAt.toISOString())
    })

    it('keeps the original snapshot when only the category changes', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )
      await clearFxCache()
      const otherCategory = await prisma.category.create({
        data: { userId: s.userId, name: 'Gifts', type: 'INCOME' },
      })

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        {
          accountId: s.accountId,
          categoryId: otherCategory.id,
          type: 'CASH_IN',
          amount: 1000,
          date: new Date('2026-02-01'),
        },
        fakeProvider(25500, 'fake-2').provider,
      )

      expect(updated.categoryId).toBe(otherCategory.id)
      expect(updated.fxRateSource).toBe('fake')
      expect(updated.vndPerUsdAtEntry.toString()).toBe(tx.vndPerUsdAtEntry.toString())
      expect(updated.fxRateFetchedAt.toISOString()).toBe(tx.fxRateFetchedAt.toISOString())
      expect(updated.fxRateEffectiveAt.toISOString()).toBe(tx.fxRateEffectiveAt.toISOString())
    })

    it('re-snapshots all four FX fields when the amount changes', async () => {
      const s = await setup()
      const tx = await createBase(s)
      await clearFxCache()
      const f2 = fakeProvider(25500, 'fake-2')

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1500,
          date: new Date('2026-02-01'),
          note: 'original',
        },
        f2.provider,
      )

      expect(updated.amount.toString()).toBe('1500')
      expect(updated.vndPerUsdAtEntry.toNumber()).toBe(25500)
      expect(updated.fxRateSource).toBe('fake-2')
      expect(updated.fxRateFetchedAt.toISOString()).toBe(f2.fetchedAt.toISOString())
      expect(updated.fxRateEffectiveAt.toISOString()).toBe(
        utcDayStart(f2.effectiveDate).toISOString(),
      )
    })

    it('re-snapshots when only the date changes', async () => {
      const s = await setup()
      const tx = await createBase(s)
      await clearFxCache()
      const f2 = fakeProvider(25500, 'fake-2')

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1000,
          date: new Date('2026-02-05'),
          note: 'original',
        },
        f2.provider,
      )

      expect(updated.date.toISOString()).toBe(new Date('2026-02-05').toISOString())
      expect(updated.vndPerUsdAtEntry.toNumber()).toBe(25500)
      expect(updated.fxRateSource).toBe('fake-2')
      expect(updated.fxRateFetchedAt.toISOString()).toBe(f2.fetchedAt.toISOString())
      expect(updated.fxRateEffectiveAt.toISOString()).toBe(
        utcDayStart(f2.effectiveDate).toISOString(),
      )
    })

    it('re-snapshots and re-derives the currency when the account changes within the same currency', async () => {
      const s = await setup()
      const tx = await createBase(s)
      expect(tx.currency).toBe('VND')
      await clearFxCache()
      const f2 = fakeProvider(25500, 'fake-2')

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        {
          accountId: s.secondAccountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1000,
          date: new Date('2026-02-01'),
          note: 'original',
        },
        f2.provider,
      )

      expect(updated.accountId).toBe(s.secondAccountId)
      expect(updated.currency).toBe('VND')
      expect(updated.vndPerUsdAtEntry.toNumber()).toBe(25500)
      expect(updated.fxRateSource).toBe('fake-2')
      expect(updated.fxRateFetchedAt.toISOString()).toBe(f2.fetchedAt.toISOString())
      expect(updated.fxRateEffectiveAt.toISOString()).toBe(
        utcDayStart(f2.effectiveDate).toISOString(),
      )
    })

    it('refuses to move a transaction to an account in another currency, leaving the row untouched', async () => {
      const s = await setup()
      const tx = await createBase(s)
      expect(tx.currency).toBe('VND')

      await expect(
        updateTransaction(
          s.userId,
          tx.id,
          {
            accountId: s.usdAccountId,
            categoryId: s.expenseCategoryId,
            type: 'EXPENSE',
            amount: 1000,
            date: new Date('2026-02-01'),
            note: 'original',
          },
          fakeProvider(25500, 'fake-2').provider,
        ),
      ).rejects.toThrow(CurrencyMismatchError)

      // 1000 VND is not 1000 USD: silently re-labelling the amount would
      // multiply this row's real value by ~25000.
      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      expect(stored.accountId).toBe(s.accountId)
      expect(stored.currency).toBe('VND')
      expect(stored.amount.toString()).toBe('1000')
      expect(stored.fxRateSource).toBe('fake')
    })

    it('re-snapshots when only the type changes', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )
      await clearFxCache()

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        { accountId: s.accountId, type: 'CASH_OUT', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider(25500, 'fake-2').provider,
      )

      expect(updated.type).toBe('CASH_OUT')
      expect(updated.fxRateSource).toBe('fake-2')
    })

    it('leaves the row completely unchanged when FX is unavailable during an economic edit', async () => {
      const s = await setup()
      const tx = await createBase(s)
      await clearFxCache()

      await expect(
        updateTransaction(
          s.userId,
          tx.id,
          {
            accountId: s.accountId,
            categoryId: s.expenseCategoryId,
            type: 'EXPENSE',
            amount: 9999,
            date: new Date('2026-03-03'),
            note: 'should not land',
          },
          failingProvider,
        ),
      ).rejects.toThrow(FxUnavailableError)

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      expect(stored.accountId).toBe(tx.accountId)
      expect(stored.categoryId).toBe(tx.categoryId)
      expect(stored.type).toBe(tx.type)
      expect(stored.amount.toString()).toBe(tx.amount.toString())
      expect(stored.currency).toBe(tx.currency)
      expect(stored.date.toISOString()).toBe(tx.date.toISOString())
      expect(stored.note).toBe('original')
      expect(stored.vndPerUsdAtEntry.toString()).toBe(tx.vndPerUsdAtEntry.toString())
      expect(stored.fxRateFetchedAt.toISOString()).toBe(tx.fxRateFetchedAt.toISOString())
      expect(stored.fxRateEffectiveAt.toISOString()).toBe(tx.fxRateEffectiveAt.toISOString())
      expect(stored.fxRateSource).toBe(tx.fxRateSource)
    })
  })

  describe('updateTransaction — an archived category does not freeze its history', () => {
    async function createExpense(s: Awaited<ReturnType<typeof setup>>) {
      const tx = await createTransaction(
        s.userId,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1000,
          date: new Date('2026-02-01'),
          note: 'original',
        },
        fakeProvider().provider,
      )
      await prisma.category.update({
        where: { userId_id: { userId: s.userId, id: s.expenseCategoryId } },
        data: { status: 'ARCHIVED' },
      })
      return tx
    }

    it('allows a note-only edit that keeps a now-archived category, preserving the snapshot', async () => {
      const s = await setup()
      const tx = await createExpense(s)
      await clearFxCache()

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1000,
          date: new Date('2026-02-01'),
          note: 'corrected wording',
        },
        fakeProvider(25500, 'fake-2').provider,
      )

      expect(updated.note).toBe('corrected wording')
      expect(updated.categoryId).toBe(s.expenseCategoryId)
      // Non-economic, so the original snapshot survives untouched.
      expect(updated.fxRateSource).toBe('fake')
      expect(updated.vndPerUsdAtEntry.toString()).toBe(tx.vndPerUsdAtEntry.toString())
      expect(updated.fxRateFetchedAt.toISOString()).toBe(tx.fxRateFetchedAt.toISOString())
      expect(updated.fxRateEffectiveAt.toISOString()).toBe(tx.fxRateEffectiveAt.toISOString())
    })

    it('allows an economic edit that keeps a now-archived category, re-snapshotting FX', async () => {
      const s = await setup()
      const tx = await createExpense(s)
      await clearFxCache()
      const f2 = fakeProvider(25500, 'fake-2')

      const updated = await updateTransaction(
        s.userId,
        tx.id,
        {
          accountId: s.accountId,
          categoryId: s.expenseCategoryId,
          type: 'EXPENSE',
          amount: 1200,
          date: new Date('2026-02-01'),
          note: 'original',
        },
        f2.provider,
      )

      expect(updated.amount.toString()).toBe('1200')
      expect(updated.fxRateSource).toBe('fake-2')
      expect(updated.fxRateFetchedAt.toISOString()).toBe(f2.fetchedAt.toISOString())
      expect(updated.fxRateEffectiveAt.toISOString()).toBe(
        utcDayStart(f2.effectiveDate).toISOString(),
      )
    })

    it('still refuses to move a transaction to a different archived category', async () => {
      const s = await setup()
      const tx = await createExpense(s)
      const otherArchived = await prisma.category.create({
        data: { userId: s.userId, name: 'Old Food', type: 'EXPENSE', status: 'ARCHIVED' },
      })

      await expect(
        updateTransaction(
          s.userId,
          tx.id,
          {
            accountId: s.accountId,
            categoryId: otherArchived.id,
            type: 'EXPENSE',
            amount: 1000,
            date: new Date('2026-02-01'),
            note: 'original',
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(InvalidCategoryError)

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      expect(stored.categoryId).toBe(s.expenseCategoryId)
    })

    it('still refuses a type change that contradicts the kept archived category', async () => {
      const s = await setup()
      const tx = await createExpense(s)

      await expect(
        updateTransaction(
          s.userId,
          tx.id,
          {
            accountId: s.accountId,
            categoryId: s.expenseCategoryId,
            type: 'INCOME',
            amount: 1000,
            date: new Date('2026-02-01'),
            note: 'original',
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(InvalidCategoryError)

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      expect(stored.type).toBe('EXPENSE')
    })

    it('still refuses a new transaction filed under an archived category', async () => {
      const s = await setup()
      await createExpense(s)

      await expect(
        createTransaction(
          s.userId,
          {
            accountId: s.accountId,
            categoryId: s.expenseCategoryId,
            type: 'EXPENSE',
            amount: 500,
            date: new Date('2026-02-02'),
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(InvalidCategoryError)
    })
  })

  describe('updateTransaction / deleteTransaction — archived accounts are frozen (R-7)', () => {
    it('refuses to edit a transaction whose account has been archived', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )
      await archiveAccount(s.userId, s.accountId)

      await expect(
        updateTransaction(
          s.userId,
          tx.id,
          { accountId: s.accountId, type: 'CASH_IN', amount: 2000, date: new Date('2026-02-01') },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      expect(stored.amount.toString()).toBe('1000')
    })

    it('refuses to delete a transaction whose account has been archived', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )
      await archiveAccount(s.userId, s.accountId)

      await expect(deleteTransaction(s.userId, tx.id)).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.transaction.count({ where: { userId: s.userId, id: tx.id } })).toBe(1)
    })

    it('refuses to move a transaction into an archived account', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )
      await archiveAccount(s.userId, s.usdAccountId)

      await expect(
        updateTransaction(
          s.userId,
          tx.id,
          {
            accountId: s.usdAccountId,
            type: 'CASH_IN',
            amount: 1000,
            date: new Date('2026-02-01'),
          },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: tx.id } },
      })
      expect(stored.accountId).toBe(s.accountId)
      expect(stored.currency).toBe('VND')
    })
  })

  describe('date and time are both preserved', () => {
    const TIMEZONE = 'Asia/Ho_Chi_Minh'

    it('stores two entries on the same local day as distinct instants, newest first', async () => {
      const s = await setup()
      // What the action layer does with what the form submitted.
      const morning = localDateTimeToInstant('2026-02-01T09:15', TIMEZONE)
      const evening = localDateTimeToInstant('2026-02-01T18:45', TIMEZONE)

      const morningTx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 100, date: morning },
        fakeProvider().provider,
      )
      const eveningTx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_OUT', amount: 200, date: evening },
        fakeProvider().provider,
      )

      // Two different moments in the database, not two copies of midnight.
      const storedMorning = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: morningTx.id } },
      })
      const storedEvening = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: eveningTx.id } },
      })
      expect(storedMorning.date.toISOString()).toBe('2026-02-01T02:15:00.000Z')
      expect(storedEvening.date.toISOString()).toBe('2026-02-01T11:45:00.000Z')

      // And they read back as the two times the user actually entered.
      expect(instantToLocalDateTime(storedMorning.date, TIMEZONE)).toBe('2026-02-01T09:15')
      expect(instantToLocalDateTime(storedEvening.date, TIMEZONE)).toBe('2026-02-01T18:45')

      // The list orders by `date` first, so the evening entry leads — under the
      // old calendar-midnight convention both rows tied and the order came
      // from `createdAt` by accident.
      const rows = await listTransactions(s.userId)
      expect(rows.map((r) => r.id)).toEqual([eveningTx.id, morningTx.id])
    })
  })

  describe('createTransactionSchema', () => {
    function parseWithAmount(amount: number) {
      return createTransactionSchema.safeParse({
        accountId: 'abc',
        type: 'CASH_IN',
        amount,
        date: new Date(),
      }).success
    }

    it('rejects an amount of zero', () => {
      expect(parseWithAmount(0)).toBe(false)
    })

    it('rejects a negative amount', () => {
      expect(parseWithAmount(-1)).toBe(false)
    })

    it('rejects an amount with more than 2 decimal places', () => {
      expect(parseWithAmount(12.345)).toBe(false)
    })

    it('accepts an amount with exactly 2 decimal places', () => {
      expect(parseWithAmount(12.34)).toBe(true)
    })

    it('rejects an unparseable date', () => {
      expect(
        createTransactionSchema.safeParse({
          accountId: 'abc',
          type: 'CASH_IN',
          amount: 10,
          date: 'not-a-date',
        }).success,
      ).toBe(false)
    })

    it('rejects an unknown transaction type', () => {
      expect(
        createTransactionSchema.safeParse({
          accountId: 'abc',
          type: 'TRANSFER',
          amount: 10,
          date: new Date(),
        }).success,
      ).toBe(false)
    })
  })
})
