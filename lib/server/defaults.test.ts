import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  DEFAULT_ACCOUNT_TYPES,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  seedDefaultsForUser,
} from './defaults'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database, so nothing here can reach the dev data.
 * Every user is created with a fresh id and deleted again in `afterEach`, so
 * repeated runs stay identical.
 */
describe('seedDefaultsForUser', () => {
  const createdUserIds: string[] = []

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `test-${randomUUID()}@example.com`,
        name: 'Test',
        emailVerified: false,
      },
    })
    createdUserIds.push(user.id)
    return user.id
  }

  afterEach(async () => {
    const userIds = createdUserIds.splice(0)
    if (userIds.length === 0) return
    // The user rows go last but unconditionally: a failure while deleting the
    // seeded rows must not leave orphan users behind for the next run.
    try {
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
  })

  it('creates 5 default account types and 16 default categories owned by the user', async () => {
    const userId = await createUser()

    await seedDefaultsForUser(userId)

    const accountTypes = await prisma.accountType.findMany({ where: { userId } })
    const categories = await prisma.category.findMany({ where: { userId } })

    expect(accountTypes).toHaveLength(5)
    expect(accountTypes.every((t) => t.isDefault)).toBe(true)
    expect(accountTypes.map((t) => t.name).sort()).toEqual([...DEFAULT_ACCOUNT_TYPES].sort())

    expect(categories).toHaveLength(16)
    expect(categories.every((c) => c.isDefault)).toBe(true)
    expect(categories.filter((c) => c.type === 'EXPENSE')).toHaveLength(10)
    expect(categories.filter((c) => c.type === 'INCOME')).toHaveLength(6)
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

    // Every row is ACTIVE and owned by this user only.
    expect(accountTypes.every((t) => t.status === 'ACTIVE' && t.userId === userId)).toBe(true)
    expect(categories.every((c) => c.status === 'ACTIVE' && c.userId === userId)).toBe(true)
  })

  it('does not duplicate rows when called twice for the same user', async () => {
    const userId = await createUser()

    await seedDefaultsForUser(userId)
    await seedDefaultsForUser(userId)

    expect(await prisma.accountType.count({ where: { userId } })).toBe(5)
    expect(await prisma.category.count({ where: { userId } })).toBe(16)
  })

  it('seeds each user separately', async () => {
    const firstUserId = await createUser()
    const secondUserId = await createUser()

    await seedDefaultsForUser(firstUserId)
    await seedDefaultsForUser(secondUserId)

    expect(await prisma.accountType.count({ where: { userId: firstUserId } })).toBe(5)
    expect(await prisma.accountType.count({ where: { userId: secondUserId } })).toBe(5)
    expect(await prisma.category.count({ where: { userId: firstUserId } })).toBe(16)
    expect(await prisma.category.count({ where: { userId: secondUserId } })).toBe(16)
  })
})
