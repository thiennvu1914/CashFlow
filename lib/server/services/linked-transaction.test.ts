import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import { readMigrationSql, splitSqlStatements } from '@/lib/testing/migration-sql'
import { LOAN_INTEREST_CATEGORY_NAME } from '@/lib/server/defaults'
import { ArchivedAccountError, lockAccountsForUpdate, type LockedAccountRow } from './account-lock'
import { InvalidCategoryError } from './transaction'
import {
  LinkedAccountCurrencyMismatchError,
  ensureLoanInterestCategoryId,
  getMostRecentlyUsedAccountId,
  insertTransactionInTx,
  linkTransactionOptions,
  type LinkedTransactionInput,
} from './linked-transaction'

/**
 * The shared linking core (spec §6.1) against the real `cashflow_test`
 * database.
 *
 * The core never fetches FX itself — the caller resolves the snapshot before
 * opening its transaction and hands it in — so every case here passes a
 * hand-built `UsableRateResult` and nothing in this file reads or writes the
 * `ExchangeRate` cache or the FX service's in-process memo. That is also what
 * lets the snapshot assertions be exact: the values are deliberately unlike
 * anything a provider would return "now", so a core that substituted its own
 * rate or timestamp could not pass.
 */

/** A snapshot no provider would produce today: a past fetch, a past UTC day,
 *  six decimal places, and a source string that exists only in this file. */
function fxSnapshot(): UsableRateResult {
  return {
    rate: 25432.123456,
    rateDecimal: new Prisma.Decimal('25432.123456'),
    effectiveDate: new Date('2026-03-01T00:00:00.000Z'),
    fetchedAt: new Date('2026-03-01T04:05:06.789Z'),
    source: 'linked-core-test',
    isFallback: false,
  }
}

/** The four snapshot columns every directly-inserted fixture row needs. */
const FIXTURE_FX = {
  vndPerUsdAtEntry: new Prisma.Decimal('25000'),
  fxRateFetchedAt: new Date('2026-03-01T04:05:06.789Z'),
  fxRateEffectiveAt: new Date('2026-03-01T00:00:00.000Z'),
  fxRateSource: 'linked-core-fixture',
}

describe('linked-transaction core', () => {
  const createdUserIds: string[] = []

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `linked-${randomUUID()}@example.com`,
        name: 'Linked Test',
        emailVerified: false,
      },
    })
    createdUserIds.push(user.id)
    return user.id
  }

  async function setup() {
    const userId = await createUser()
    const accountType = await prisma.accountType.create({ data: { userId, name: 'Cash' } })
    const account = (currency: 'VND' | 'USD', name: string) =>
      prisma.financialAccount.create({
        data: { userId, name, accountTypeId: accountType.id, initialBalance: 0, currency },
      })
    const vndAccount = await account('VND', 'Wallet')
    const usdAccount = await account('USD', 'Dollars')
    const expenseCategory = await prisma.category.create({
      data: { userId, name: 'Food', type: 'EXPENSE' },
    })
    const incomeCategory = await prisma.category.create({
      data: { userId, name: 'Salary', type: 'INCOME' },
    })
    return {
      userId,
      accountTypeId: accountType.id,
      vndAccountId: vndAccount.id,
      usdAccountId: usdAccount.id,
      expenseCategoryId: expenseCategory.id,
      incomeCategoryId: incomeCategory.id,
    }
  }

  /** `insertTransactionInTx` inside its own `prisma.$transaction`, the way
   *  every real caller runs it. */
  function insert(userId: string, input: LinkedTransactionInput, fx = fxSnapshot()) {
    return prisma.$transaction((tx) => insertTransactionInTx(tx, userId, input, fx))
  }

  function cashOut(accountId: string, overrides: Partial<LinkedTransactionInput> = {}) {
    return {
      accountId,
      type: 'CASH_OUT' as const,
      amount: new Prisma.Decimal('1234.56'),
      date: new Date('2026-04-10T05:00:00.000Z'),
      note: 'Cho mượn – An',
      ...overrides,
    }
  }

  async function archiveAccount(userId: string, accountId: string) {
    await prisma.financialAccount.update({
      where: { userId_id: { userId, id: accountId } },
      data: { status: 'ARCHIVED' },
    })
  }

  /** A transaction row inserted directly, so its `createdAt` can be pinned. */
  async function insertFixtureRow(
    userId: string,
    accountId: string,
    createdAt: Date,
    date: Date = createdAt,
  ) {
    const account = await prisma.financialAccount.findUniqueOrThrow({
      where: { userId_id: { userId, id: accountId } },
    })
    return prisma.transaction.create({
      data: {
        userId,
        accountId,
        type: 'CASH_IN',
        amount: 1,
        currency: account.currency,
        date,
        createdAt,
        ...FIXTURE_FX,
      },
    })
  }

  afterEach(async () => {
    const userIds = createdUserIds.splice(0)
    if (userIds.length === 0) return
    try {
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
  })

  describe('insertTransactionInTx', () => {
    it('inserts the row with the passed FX snapshot verbatim and the account currency', async () => {
      const s = await setup()
      const fx = fxSnapshot()

      const row = await insert(s.userId, cashOut(s.usdAccountId, { expectedCurrency: 'USD' }), fx)

      expect(row.userId).toBe(s.userId)
      expect(row.accountId).toBe(s.usdAccountId)
      expect(row.type).toBe('CASH_OUT')
      expect(row.amount.toString()).toBe('1234.56')
      // Currency is the account's, never a caller's: nothing in the input names it.
      expect(row.currency).toBe('USD')
      expect(row.date.toISOString()).toBe('2026-04-10T05:00:00.000Z')
      expect(row.note).toBe('Cho mượn – An')
      expect(row.categoryId).toBeNull()
      // Written from `rateDecimal` to the digit, and both timestamps are the
      // snapshot's own — not "now".
      expect(row.vndPerUsdAtEntry.toString()).toBe('25432.123456')
      expect(row.fxRateFetchedAt.toISOString()).toBe(fx.fetchedAt.toISOString())
      expect(row.fxRateEffectiveAt.toISOString()).toBe(fx.effectiveDate.toISOString())
      expect(row.fxRateSource).toBe('linked-core-test')

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: s.userId, id: row.id } },
      })
      expect(stored).toEqual(row)
    })

    it('writes through the caller transaction, so a later failure rolls the row back', async () => {
      const s = await setup()

      await expect(
        prisma.$transaction(async (tx) => {
          await insertTransactionInTx(tx, s.userId, cashOut(s.vndAccountId), fxSnapshot())
          throw new Error('caller failed after the insert')
        }),
      ).rejects.toThrow('caller failed after the insert')

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it("refuses another user's account with P2025 and writes nothing", async () => {
      const s = await setup()
      const other = await setup()

      await expect(insert(s.userId, cashOut(other.vndAccountId))).rejects.toMatchObject({
        name: 'PrismaClientKnownRequestError',
        code: 'P2025',
      })

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
      expect(await prisma.transaction.count({ where: { userId: other.userId } })).toBe(0)
    })

    it('refuses an archived account', async () => {
      const s = await setup()
      await archiveAccount(s.userId, s.vndAccountId)

      await expect(insert(s.userId, cashOut(s.vndAccountId))).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('refuses an account whose currency differs from expectedCurrency', async () => {
      const s = await setup()

      await expect(
        insert(s.userId, cashOut(s.vndAccountId, { expectedCurrency: 'USD' })),
      ).rejects.toThrow(LinkedAccountCurrencyMismatchError)

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('refuses a non-positive amount', async () => {
      const s = await setup()

      await expect(
        insert(s.userId, cashOut(s.vndAccountId, { amount: new Prisma.Decimal(0) })),
      ).rejects.toThrow(RangeError)

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('files an EXPENSE under an active EXPENSE category of the user', async () => {
      const s = await setup()

      const row = await insert(
        s.userId,
        cashOut(s.vndAccountId, { type: 'EXPENSE', categoryId: s.expenseCategoryId }),
      )

      expect(row.type).toBe('EXPENSE')
      expect(row.categoryId).toBe(s.expenseCategoryId)
    })

    it('applies the existing category rules and writes nothing on a refusal', async () => {
      const s = await setup()
      const other = await setup()
      const archived = await prisma.category.create({
        data: { userId: s.userId, name: 'Old', type: 'EXPENSE', status: 'ARCHIVED' },
      })
      const expense = (categoryId: string | null) =>
        insert(s.userId, cashOut(s.vndAccountId, { type: 'EXPENSE', categoryId }))

      // A P&L type needs a category...
      await expect(expense(null)).rejects.toThrow(InvalidCategoryError)
      // ...of the matching type...
      await expect(expense(s.incomeCategoryId)).rejects.toThrow(InvalidCategoryError)
      // ...that is still active...
      await expect(expense(archived.id)).rejects.toThrow(InvalidCategoryError)
      // ...and that is the user's own.
      await expect(expense(other.expenseCategoryId)).rejects.toMatchObject({ code: 'P2025' })

      expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
    })

    /**
     * Final review F5: a caller that locked the account first (the module's
     * lock order) hands its locked row in, and the core does not lock it again
     * — one round trip less per transaction written, which a link with many
     * payments pays once per payment. The row is still checked: it must be the
     * input's account, ACTIVE, and in `expectedCurrency`.
     */
    describe('with the account row its caller already locked', () => {
      /** `tx` with its raw statements counted — the account lock is one. */
      function countingRaw(tx: Prisma.TransactionClient) {
        const seen = { raw: 0 }
        const client = new Proxy(tx, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property !== '$queryRaw' || typeof value !== 'function') return value
            return (...args: unknown[]) => {
              seen.raw += 1
              return value.apply(target, args)
            }
          },
        })
        return { client, seen }
      }

      it('writes the same row without locking the account again', async () => {
        const s = await setup()

        const { row, raw } = await prisma.$transaction(async (tx) => {
          const [locked] = await lockAccountsForUpdate(tx, s.userId, [s.usdAccountId])
          const { client, seen } = countingRaw(tx)
          const created = await insertTransactionInTx(
            client,
            s.userId,
            cashOut(s.usdAccountId, { expectedCurrency: 'USD' }),
            fxSnapshot(),
            locked,
          )
          return { row: created, raw: seen.raw }
        })

        expect(raw).toBe(0)
        expect(row).toMatchObject({ accountId: s.usdAccountId, currency: 'USD', type: 'CASH_OUT' })
        expect(row.vndPerUsdAtEntry.toString()).toBe('25432.123456')
      })

      it('still locks the account itself when no row is handed in', async () => {
        const s = await setup()

        const raw = await prisma.$transaction(async (tx) => {
          const { client, seen } = countingRaw(tx)
          await insertTransactionInTx(client, s.userId, cashOut(s.vndAccountId), fxSnapshot())
          return seen.raw
        })

        expect(raw).toBe(1)
      })

      it.each([
        [
          'an archived row',
          (s: { vndAccountId: string }) =>
            ({ id: s.vndAccountId, status: 'ARCHIVED', currency: 'VND' }) as LockedAccountRow,
          ArchivedAccountError,
        ],
        [
          'a row in another currency than expectedCurrency',
          (s: { vndAccountId: string }) =>
            ({ id: s.vndAccountId, status: 'ACTIVE', currency: 'USD' }) as LockedAccountRow,
          LinkedAccountCurrencyMismatchError,
        ],
        [
          "a row that is not the input's account",
          (s: { usdAccountId: string }) =>
            ({ id: s.usdAccountId, status: 'ACTIVE', currency: 'VND' }) as LockedAccountRow,
          RangeError,
        ],
      ] as const)('refuses %s and writes nothing', async (_label, row, error) => {
        const s = await setup()

        await expect(
          prisma.$transaction((tx) =>
            insertTransactionInTx(
              tx,
              s.userId,
              cashOut(s.vndAccountId, { expectedCurrency: 'VND' }),
              fxSnapshot(),
              row(s),
            ),
          ),
        ).rejects.toThrow(error)

        expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
      })
    })
  })

  describe('getMostRecentlyUsedAccountId', () => {
    it('is null for a user with no accounts', async () => {
      const userId = await createUser()

      expect(await getMostRecentlyUsedAccountId(userId)).toBeNull()
    })

    it('is null when every account is archived', async () => {
      const s = await setup()
      await insertFixtureRow(s.userId, s.vndAccountId, new Date('2026-05-01T00:00:00.000Z'))
      await archiveAccount(s.userId, s.vndAccountId)
      await archiveAccount(s.userId, s.usdAccountId)

      expect(await getMostRecentlyUsedAccountId(s.userId)).toBeNull()
    })

    it('is the account of the latest transaction by createdAt, not by date', async () => {
      const s = await setup()
      // Entered last, but dated earliest: "recently used" is about when the
      // user last picked the account, not where the row sorts in the ledger.
      await insertFixtureRow(
        s.userId,
        s.vndAccountId,
        new Date('2026-05-02T00:00:00.000Z'),
        new Date('2026-01-01T00:00:00.000Z'),
      )
      await insertFixtureRow(
        s.userId,
        s.usdAccountId,
        new Date('2026-05-01T00:00:00.000Z'),
        new Date('2026-04-30T00:00:00.000Z'),
      )

      expect(await getMostRecentlyUsedAccountId(s.userId)).toBe(s.vndAccountId)
    })

    it('skips transactions in an account that has since been archived', async () => {
      const s = await setup()
      await insertFixtureRow(s.userId, s.usdAccountId, new Date('2026-05-01T00:00:00.000Z'))
      await insertFixtureRow(s.userId, s.vndAccountId, new Date('2026-05-02T00:00:00.000Z'))
      await archiveAccount(s.userId, s.vndAccountId)

      expect(await getMostRecentlyUsedAccountId(s.userId)).toBe(s.usdAccountId)
    })

    it('falls back to the first active account in picker order when nothing was used', async () => {
      const userId = await createUser()
      const accountType = await prisma.accountType.create({ data: { userId, name: 'Cash' } })
      const account = (name: string, createdAt: string) =>
        prisma.financialAccount.create({
          data: {
            userId,
            name,
            accountTypeId: accountType.id,
            initialBalance: 0,
            currency: 'VND',
            createdAt: new Date(createdAt),
          },
        })
      // Created out of order on purpose, and the oldest one is archived.
      await account('Third', '2026-01-03T00:00:00.000Z')
      const archivedFirst = await account('First', '2026-01-01T00:00:00.000Z')
      const second = await account('Second', '2026-01-02T00:00:00.000Z')
      await archiveAccount(userId, archivedFirst.id)

      expect(await getMostRecentlyUsedAccountId(userId)).toBe(second.id)
    })

    it("never answers with another user's account", async () => {
      const s = await setup()
      const other = await setup()
      await insertFixtureRow(s.userId, s.usdAccountId, new Date('2026-05-01T00:00:00.000Z'))
      await insertFixtureRow(other.userId, other.vndAccountId, new Date('2026-05-09T00:00:00.000Z'))

      expect(await getMostRecentlyUsedAccountId(s.userId)).toBe(s.usdAccountId)
    })
  })

  describe('ensureLoanInterestCategoryId', () => {
    const ensure = (userId: string) =>
      prisma.$transaction((tx) => ensureLoanInterestCategoryId(tx, userId))

    it("returns the user's existing active EXPENSE category without creating another", async () => {
      const userId = await createUser()
      const existing = await prisma.category.create({
        data: { userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE', isDefault: true },
      })

      expect(await ensure(userId)).toBe(existing.id)
      expect(await prisma.category.count({ where: { userId } })).toBe(1)
    })

    it('creates exactly one when missing and returns it again on the next call', async () => {
      const userId = await createUser()
      const other = await createUser()
      // None of these is a usable loan-interest category for `userId`: the
      // wrong type, archived, and another user's.
      await prisma.category.create({
        data: { userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'INCOME' },
      })
      await prisma.category.create({
        data: { userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE', status: 'ARCHIVED' },
      })
      const othersCategory = await prisma.category.create({
        data: { userId: other, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE' },
      })

      const first = await ensure(userId)
      const second = await ensure(userId)

      expect(second).toBe(first)
      expect(first).not.toBe(othersCategory.id)
      const active = await prisma.category.findMany({
        where: { userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE', status: 'ACTIVE' },
      })
      expect(active).toHaveLength(1)
      expect(active[0]).toMatchObject({ id: first, userId, isDefault: true })
      expect(await prisma.category.count({ where: { userId: other } })).toBe(1)
    })
  })

  describe('loan_interest_category migration SQL', () => {
    it('backfills exactly one category per user, even when run twice', async () => {
      const statements = splitSqlStatements(readMigrationSql('loan_interest_category'))
      expect(statements).toHaveLength(1)

      const bare = await createUser()
      const hasOne = await createUser()
      const hasArchived = await createUser()
      const hasIncomeOnly = await createUser()
      const kept = await prisma.category.create({
        data: { userId: hasOne, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE', icon: 'pct' },
      })
      await prisma.category.create({
        data: {
          userId: hasArchived,
          name: LOAN_INTEREST_CATEGORY_NAME,
          type: 'EXPENSE',
          status: 'ARCHIVED',
        },
      })
      await prisma.category.create({
        data: { userId: hasIncomeOnly, name: LOAN_INTEREST_CATEGORY_NAME, type: 'INCOME' },
      })

      // The migration touches every row of "user"; running it inside a
      // transaction that is then rolled back keeps the rest of the shared test
      // database exactly as it was.
      const rollback = new Error('roll back the migration run')
      await expect(
        prisma.$transaction(async (tx) => {
          for (let run = 0; run < 2; run++) {
            for (const statement of statements) await tx.$executeRawUnsafe(statement)
          }
          const rows = await tx.category.findMany({
            where: {
              userId: { in: [bare, hasOne, hasArchived, hasIncomeOnly] },
              name: LOAN_INTEREST_CATEGORY_NAME,
              type: 'EXPENSE',
            },
          })
          const forUser = (userId: string) => rows.filter((row) => row.userId === userId)

          // A user without one gets one active default category.
          expect(forUser(bare)).toHaveLength(1)
          expect(forUser(bare)[0]).toMatchObject({ isDefault: true, status: 'ACTIVE' })
          expect(forUser(bare)[0].id).toMatch(/^c[0-9a-f]{32}$/)
          // An existing one — active or archived — is left exactly as it is.
          expect(forUser(hasOne)).toEqual([kept])
          expect(forUser(hasArchived)).toHaveLength(1)
          expect(forUser(hasArchived)[0].status).toBe('ARCHIVED')
          // An INCOME category of the same name is a different category.
          expect(forUser(hasIncomeOnly)).toHaveLength(1)
          throw rollback
        }),
      ).rejects.toBe(rollback)
    })
  })
})

/**
 * The interactive-transaction options "Record in an account" opens its one
 * transaction with. Prisma's defaults (5 s to finish, 2 s to get a connection)
 * fit a single write; a link writes one or two transactions per existing
 * payment, at ~100 ms a round trip in production, so a legacy agreement with a
 * long history would expire (P2028) at the default.
 */
describe('linkTransactionOptions', () => {
  it("gives a link with no payments a base far above Prisma's 5 s and 2 s defaults", () => {
    expect(linkTransactionOptions(0)).toEqual({ timeout: 10_000, maxWait: 10_000 })
  })

  it('adds a second for every payment to record — several times what one costs in production', () => {
    expect(linkTransactionOptions(1).timeout).toBe(11_000)
    expect(linkTransactionOptions(60).timeout).toBe(70_000)
  })

  it('caps the timeout, so no link holds its locks open-endedly', () => {
    expect(linkTransactionOptions(110).timeout).toBe(120_000)
    expect(linkTransactionOptions(10_000).timeout).toBe(120_000)
    expect(linkTransactionOptions(10_000).maxWait).toBe(10_000)
  })
})
