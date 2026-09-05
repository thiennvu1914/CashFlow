import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import { listCategories, createCategory, archiveCategory } from './category'
import { createCategorySchema } from '@/lib/validation/category'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every user is created with a fresh id
 * and deleted again in `afterEach`, so repeated runs stay identical.
 */
describe('category service', () => {
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
    try {
      await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
  })

  describe('listCategories', () => {
    it('returns only ACTIVE rows for the given user, defaults first then by name', async () => {
      const userId = await createUser()
      await prisma.category.createMany({
        data: [
          { userId, name: 'Zebra Spend', type: 'EXPENSE', isDefault: false },
          { userId, name: 'Food & Dining', type: 'EXPENSE', isDefault: true },
          { userId, name: 'Bills & Utilities', type: 'EXPENSE', isDefault: true },
          { userId, name: 'Archived One', type: 'EXPENSE', isDefault: false, status: 'ARCHIVED' },
        ],
      })

      const result = await listCategories(userId)

      expect(result.map((r) => r.name)).toEqual([
        'Bills & Utilities',
        'Food & Dining',
        'Zebra Spend',
      ])
      expect(result.every((r) => r.status === 'ACTIVE')).toBe(true)
    })

    it('filters by type when given', async () => {
      const userId = await createUser()
      await prisma.category.createMany({
        data: [
          { userId, name: 'Salary', type: 'INCOME', isDefault: true },
          { userId, name: 'Food & Dining', type: 'EXPENSE', isDefault: true },
        ],
      })

      const incomeOnly = await listCategories(userId, 'INCOME')

      expect(incomeOnly).toHaveLength(1)
      expect(incomeOnly[0]!.name).toBe('Salary')
      expect(incomeOnly[0]!.type).toBe('INCOME')
    })

    it('does not return another user rows (tenant isolation)', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      await prisma.category.create({
        data: { userId: otherUserId, name: 'Other Category', type: 'EXPENSE' },
      })

      const result = await listCategories(userId)

      expect(result).toHaveLength(0)
    })
  })

  describe('createCategory', () => {
    it('stores isDefault: false, the given type, and the userId from the argument only', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()

      const created = await createCategory(userId, {
        name: 'Custom Expense',
        type: 'EXPENSE',
        // @ts-expect-error - verifying an extraneous userId key is ignored/stripped by Zod
        userId: otherUserId,
      })

      expect(created.userId).toBe(userId)
      expect(created.isDefault).toBe(false)
      expect(created.type).toBe('EXPENSE')

      const stored = await prisma.category.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.userId).toBe(userId)
    })

    it('creates an INCOME category distinct from an EXPENSE one', async () => {
      const userId = await createUser()

      const income = await createCategory(userId, { name: 'Bonus', type: 'INCOME' })
      const expense = await createCategory(userId, { name: 'Bonus', type: 'EXPENSE' })

      expect(income.type).toBe('INCOME')
      expect(expense.type).toBe('EXPENSE')
      expect(await listCategories(userId, 'INCOME')).toHaveLength(1)
      expect(await listCategories(userId, 'EXPENSE')).toHaveLength(1)
    })
  })

  describe('archiveCategory', () => {
    it('sets ARCHIVED and the row disappears from listCategories', async () => {
      const userId = await createUser()
      const created = await createCategory(userId, { name: 'Temp', type: 'EXPENSE' })

      await archiveCategory(userId, created.id)

      const stored = await prisma.category.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.status).toBe('ARCHIVED')
      expect(await listCategories(userId)).toHaveLength(0)
    })

    it('rejects archiving a row belonging to another user and leaves it ACTIVE', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const created = await createCategory(otherUserId, { name: 'Not Yours', type: 'EXPENSE' })

      await expect(archiveCategory(userId, created.id)).rejects.toThrow()

      const stored = await prisma.category.findUniqueOrThrow({
        where: { userId_id: { userId: otherUserId, id: created.id } },
      })
      expect(stored.status).toBe('ACTIVE')
    })

    it('is idempotent: archiving an already-ARCHIVED category is a no-op that does not throw', async () => {
      const userId = await createUser()
      const created = await createCategory(userId, { name: 'Temp', type: 'EXPENSE' })

      await archiveCategory(userId, created.id)
      await expect(archiveCategory(userId, created.id)).resolves.not.toThrow()

      const stored = await prisma.category.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.status).toBe('ARCHIVED')
    })
  })

  describe('createCategorySchema', () => {
    it('rejects an empty name', () => {
      expect(createCategorySchema.safeParse({ name: '', type: 'EXPENSE' }).success).toBe(false)
    })

    it('rejects a 51-char name', () => {
      expect(
        createCategorySchema.safeParse({ name: 'a'.repeat(51), type: 'EXPENSE' }).success,
      ).toBe(false)
    })

    it('rejects an unknown type', () => {
      expect(createCategorySchema.safeParse({ name: 'Valid', type: 'SAVINGS' }).success).toBe(false)
    })

    it('accepts a valid 50-char name and known type', () => {
      expect(createCategorySchema.safeParse({ name: 'a'.repeat(50), type: 'INCOME' }).success).toBe(
        true,
      )
    })
  })
})
