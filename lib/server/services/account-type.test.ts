import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import { listAccountTypes, createAccountType, archiveAccountType } from './account-type'
import { createAccountTypeSchema } from '@/lib/validation/account-type'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every user is created with a fresh id
 * and deleted again in `afterEach`, so repeated runs stay identical.
 */
describe('account-type service', () => {
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
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
  })

  describe('listAccountTypes', () => {
    it('returns only ACTIVE rows for the given user, defaults first then by name', async () => {
      const userId = await createUser()
      await prisma.accountType.createMany({
        data: [
          { userId, name: 'Zebra Wallet', isDefault: false },
          { userId, name: 'Cash', isDefault: true },
          { userId, name: 'Bank Account', isDefault: true },
          { userId, name: 'Archived One', isDefault: false, status: 'ARCHIVED' },
        ],
      })

      const result = await listAccountTypes(userId)

      expect(result.map((r) => r.name)).toEqual(['Bank Account', 'Cash', 'Zebra Wallet'])
      expect(result.every((r) => r.status === 'ACTIVE')).toBe(true)
    })

    it('does not return another user rows (tenant isolation)', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      await prisma.accountType.create({ data: { userId: otherUserId, name: 'Other Cash' } })

      const result = await listAccountTypes(userId)

      expect(result).toHaveLength(0)
    })
  })

  describe('createAccountType', () => {
    it('stores isDefault: false and the userId from the argument only', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()

      const created = await createAccountType(userId, {
        name: 'Custom Wallet',
        // @ts-expect-error - verifying an extraneous userId key is ignored/stripped by Zod
        userId: otherUserId,
      })

      expect(created.userId).toBe(userId)
      expect(created.isDefault).toBe(false)
      expect(created.name).toBe('Custom Wallet')

      const stored = await prisma.accountType.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.userId).toBe(userId)
    })
  })

  describe('archiveAccountType', () => {
    it('sets ARCHIVED and the row disappears from listAccountTypes', async () => {
      const userId = await createUser()
      const created = await createAccountType(userId, { name: 'Temp' })

      await archiveAccountType(userId, created.id)

      const stored = await prisma.accountType.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.status).toBe('ARCHIVED')
      expect(await listAccountTypes(userId)).toHaveLength(0)
    })

    it('rejects archiving a row belonging to another user and leaves it ACTIVE', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const created = await createAccountType(otherUserId, { name: 'Not Yours' })

      await expect(archiveAccountType(userId, created.id)).rejects.toThrow()

      const stored = await prisma.accountType.findUniqueOrThrow({
        where: { userId_id: { userId: otherUserId, id: created.id } },
      })
      expect(stored.status).toBe('ACTIVE')
    })
  })

  describe('createAccountTypeSchema', () => {
    it('rejects an empty name', () => {
      expect(createAccountTypeSchema.safeParse({ name: '' }).success).toBe(false)
    })

    it('rejects a 51-char name', () => {
      expect(createAccountTypeSchema.safeParse({ name: 'a'.repeat(51) }).success).toBe(false)
    })

    it('accepts a 50-char name', () => {
      expect(createAccountTypeSchema.safeParse({ name: 'a'.repeat(50) }).success).toBe(true)
    })
  })
})
