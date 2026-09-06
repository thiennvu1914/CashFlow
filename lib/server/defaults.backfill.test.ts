import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import { readMigrationSql, splitSqlStatements } from '@/lib/testing/migration-sql'
import {
  DEFAULT_ACCOUNT_TYPES,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  seedDefaultsForUser,
} from './defaults'

/**
 * Executes the REAL `backfill_default_taxonomy` migration SQL against the test
 * database — not a re-implementation of it — so what these tests prove is what
 * production will run.
 *
 * `vitest.global-setup.ts` has already applied the migration via
 * `prisma migrate deploy`, so every run here is a *second* execution of the
 * same statements. That is deliberate: it means the whole file doubles as an
 * idempotency proof at the SQL level.
 *
 * The migration deliberately touches every row of `"user"`, so assertions are
 * always scoped to the users a test created; other rows in the shared test
 * database are irrelevant to (and unharmed by) it.
 */
const statements = splitSqlStatements(readMigrationSql('backfill_default_taxonomy'))

async function runBackfill(): Promise<void> {
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
}

describe('backfill_default_taxonomy migration SQL', () => {
  const createdUserIds: string[] = []

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `backfill-${randomUUID()}@example.com`,
        name: 'Backfill Test',
        emailVerified: false,
      },
    })
    createdUserIds.push(user.id)
    return user.id
  }

  afterEach(async () => {
    const userIds = createdUserIds.splice(0)
    if (userIds.length === 0) return
    try {
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
  })

  it('parses the migration into three executable statements', () => {
    expect(statements).toHaveLength(3)
    expect(statements.every((statement) => statement.startsWith('INSERT INTO'))).toBe(true)
  })

  it('gives a user with no taxonomy the full 5 account types and 16 categories', async () => {
    const userId = await createUser()

    await runBackfill()

    const accountTypes = await prisma.accountType.findMany({ where: { userId } })
    const categories = await prisma.category.findMany({ where: { userId } })

    expect(accountTypes).toHaveLength(5)
    expect(accountTypes.every((t) => t.isDefault && t.status === 'ACTIVE')).toBe(true)
    expect(accountTypes.map((t) => t.name).sort()).toEqual([...DEFAULT_ACCOUNT_TYPES].sort())

    expect(categories).toHaveLength(16)
    expect(categories.every((c) => c.isDefault && c.status === 'ACTIVE')).toBe(true)
    expect(
      categories
        .filter((c) => c.type === 'EXPENSE')
        .map((c) => c.name)
        .sort(),
    ).toEqual([...DEFAULT_EXPENSE_CATEGORIES].sort())
    expect(
      categories
        .filter((c) => c.type === 'INCOME')
        .map((c) => c.name)
        .sort(),
    ).toEqual([...DEFAULT_INCOME_CATEGORIES].sort())
  })

  it('changes nothing when run a second time', async () => {
    const userId = await createUser()

    await runBackfill()
    const accountTypesBefore = await prisma.accountType.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    })
    const categoriesBefore = await prisma.category.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    })

    await runBackfill()

    const accountTypesAfter = await prisma.accountType.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    })
    const categoriesAfter = await prisma.category.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    })

    // Same rows, same ids — nothing inserted, nothing rewritten.
    expect(accountTypesAfter).toEqual(accountTypesBefore)
    expect(categoriesAfter).toEqual(categoriesBefore)
    expect(accountTypesAfter).toHaveLength(5)
    expect(categoriesAfter).toHaveLength(16)
  })

  it('preserves a custom account type and never duplicates a name the user already uses', async () => {
    const userId = await createUser()
    const custom = await prisma.accountType.create({
      data: { userId, name: 'My Wallet', isDefault: false },
    })
    // A user-created row that happens to carry a default name: the guard keys on
    // (userId, name) and ignores `isDefault`, so this must survive as-is.
    const shadowingCash = await prisma.accountType.create({
      data: { userId, name: 'Cash', isDefault: false, icon: 'wallet' },
    })

    await runBackfill()

    const accountTypes = await prisma.accountType.findMany({ where: { userId } })
    // "My Wallet" + the user's own "Cash" + the 4 remaining defaults.
    expect(accountTypes).toHaveLength(6)
    expect(accountTypes.filter((t) => t.name === 'Cash')).toHaveLength(1)

    const cashAfter = accountTypes.find((t) => t.name === 'Cash')
    expect(cashAfter).toEqual(shadowingCash)
    expect(accountTypes.find((t) => t.name === 'My Wallet')).toEqual(custom)
    expect(
      accountTypes
        .filter((t) => t.isDefault)
        .map((t) => t.name)
        .sort(),
    ).toEqual(DEFAULT_ACCOUNT_TYPES.filter((name) => name !== 'Cash').sort())
  })

  it('preserves custom categories and matches on (name, type) rather than name alone', async () => {
    const userId = await createUser()
    const coffee = await prisma.category.create({
      data: { userId, name: 'Coffee', type: 'EXPENSE', isDefault: false },
    })
    const salary = await prisma.category.create({
      data: { userId, name: 'Salary', type: 'INCOME', isDefault: false, icon: 'banknote' },
    })

    await runBackfill()

    const categories = await prisma.category.findMany({ where: { userId } })
    // "Coffee" + the user's own "Salary" + 10 expense defaults + 5 income defaults.
    expect(categories).toHaveLength(17)
    expect(categories.find((c) => c.name === 'Coffee')).toEqual(coffee)
    expect(categories.filter((c) => c.name === 'Salary')).toEqual([salary])

    // "Other" exists as both an EXPENSE and an INCOME default: the (name, type)
    // key is what lets both be inserted for the same user.
    expect(
      categories
        .filter((c) => c.name === 'Other')
        .map((c) => c.type)
        .sort(),
    ).toEqual(['EXPENSE', 'INCOME'])
    expect(categories.filter((c) => c.type === 'EXPENSE')).toHaveLength(11)
    expect(categories.filter((c) => c.type === 'INCOME')).toHaveLength(6)
  })

  it('adds nothing for a user who already has every default', async () => {
    const userId = await createUser()
    await seedDefaultsForUser(userId)
    const accountTypesBefore = await prisma.accountType.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    })
    const categoriesBefore = await prisma.category.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    })

    await runBackfill()

    expect(
      await prisma.accountType.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    ).toEqual(accountTypesBefore)
    expect(await prisma.category.findMany({ where: { userId }, orderBy: { id: 'asc' } })).toEqual(
      categoriesBefore,
    )
  })

  it('leaves a freshly hook-seeded user at exactly 5 + 16', async () => {
    const userId = await createUser()

    // The registration path: `onUserCreated` -> `seedDefaultsForUser`.
    await seedDefaultsForUser(userId)
    expect(await prisma.accountType.count({ where: { userId } })).toBe(5)
    expect(await prisma.category.count({ where: { userId } })).toBe(16)

    await runBackfill()

    expect(await prisma.accountType.count({ where: { userId } })).toBe(5)
    expect(await prisma.category.count({ where: { userId } })).toBe(16)
  })

  it('keeps every inserted row scoped to its own user', async () => {
    const userA = await createUser()
    const userB = await createUser()
    await prisma.accountType.create({ data: { userId: userB, name: 'B Wallet' } })
    await prisma.category.create({ data: { userId: userB, name: 'B Snacks', type: 'EXPENSE' } })

    await runBackfill()

    const aTypes = await prisma.accountType.findMany({ where: { userId: userA } })
    const bTypes = await prisma.accountType.findMany({ where: { userId: userB } })
    const aCategories = await prisma.category.findMany({ where: { userId: userA } })
    const bCategories = await prisma.category.findMany({ where: { userId: userB } })

    expect(aTypes).toHaveLength(5)
    expect(bTypes).toHaveLength(6)
    expect(aCategories).toHaveLength(16)
    expect(bCategories).toHaveLength(17)

    // Neither user's custom rows leaked into the other's taxonomy...
    expect(aTypes.some((t) => t.name === 'B Wallet')).toBe(false)
    expect(aCategories.some((c) => c.name === 'B Snacks')).toBe(false)
    // ...and every row really does carry the userId it was inserted for.
    expect(aTypes.every((t) => t.userId === userA)).toBe(true)
    expect(aCategories.every((c) => c.userId === userA)).toBe(true)
    expect(bTypes.every((t) => t.userId === userB)).toBe(true)
    expect(bCategories.every((c) => c.userId === userB)).toBe(true)
  })
})
