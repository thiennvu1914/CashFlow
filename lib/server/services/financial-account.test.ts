import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  listActiveFinancialAccounts,
  listAllFinancialAccounts,
  createFinancialAccount,
  updateFinancialAccount,
  AccountLockedError,
  InvalidAccountTypeError,
} from './financial-account'
import { createFinancialAccountSchema } from '@/lib/validation/financial-account'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every user is created with a fresh id
 * and deleted again in `afterEach`, so repeated runs stay identical.
 */
describe('financial-account service', () => {
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

  async function createAccountType(
    userId: string,
    overrides: { status?: 'ACTIVE' | 'ARCHIVED' } = {},
  ) {
    return prisma.accountType.create({
      data: { userId, name: 'Cash', status: overrides.status ?? 'ACTIVE' },
    })
  }

  /**
   * Inserts a transaction directly, bypassing the transaction service: this
   * file is only interested in "activity exists", and going through the real
   * service would drag the FX policy into an account test. The `fx*` values
   * here are fixture data, not something the app produced.
   */
  async function recordActivity(userId: string, accountId: string) {
    return prisma.transaction.create({
      data: {
        userId,
        accountId,
        type: 'CASH_IN',
        amount: 100,
        currency: 'VND',
        date: new Date(),
        vndPerUsdAtEntry: 25000,
        fxRateTimestamp: new Date(),
        fxRateSource: 'fixture',
      },
    })
  }

  /**
   * Inserts a transfer directly, bypassing the transfer service, for the same
   * reason as `recordActivity` above: this file only cares that activity
   * exists on one of the two legs.
   */
  async function recordTransferActivity(
    userId: string,
    fromAccountId: string,
    toAccountId: string,
  ) {
    return prisma.transfer.create({
      data: {
        userId,
        fromAccountId,
        toAccountId,
        fromAmount: 100,
        toAmount: 100,
        date: new Date(),
      },
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

  describe('createFinancialAccount', () => {
    it('stores the Decimal initialBalance exactly, the given currency, ACTIVE status, and the owner userId', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)

      const created = await createFinancialAccount(userId, {
        name: 'Main Cash',
        accountTypeId: accountType.id,
        initialBalance: 100.5,
        currency: 'VND',
      })

      expect(created.initialBalance.toString()).toBe('100.5')
      expect(created.currency).toBe('VND')
      expect(created.status).toBe('ACTIVE')
      expect(created.userId).toBe(userId)

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.initialBalance.toString()).toBe('100.5')
    })

    it('rejects an accountTypeId belonging to another user and creates nothing', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const otherAccountType = await createAccountType(otherUserId)

      await expect(
        createFinancialAccount(userId, {
          name: 'Should Not Exist',
          accountTypeId: otherAccountType.id,
          initialBalance: 0,
          currency: 'VND',
        }),
      ).rejects.toThrow(InvalidAccountTypeError)

      expect(await listAllFinancialAccounts(userId)).toHaveLength(0)
    })

    it('rejects an ARCHIVED account type and creates nothing', async () => {
      const userId = await createUser()
      const archivedAccountType = await createAccountType(userId, { status: 'ARCHIVED' })

      await expect(
        createFinancialAccount(userId, {
          name: 'Should Not Exist',
          accountTypeId: archivedAccountType.id,
          initialBalance: 0,
          currency: 'VND',
        }),
      ).rejects.toThrow(InvalidAccountTypeError)

      expect(await listAllFinancialAccounts(userId)).toHaveLength(0)
    })
  })

  describe('listActiveFinancialAccounts / listAllFinancialAccounts', () => {
    it('listActiveFinancialAccounts excludes an ARCHIVED row while listAllFinancialAccounts includes it', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const active = await createFinancialAccount(userId, {
        name: 'Active Account',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      })
      const toArchive = await createFinancialAccount(userId, {
        name: 'Archived Account',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      })
      // Set the ARCHIVED status directly via Prisma — the service does not
      // yet expose an archive function (Task 15).
      await prisma.financialAccount.update({
        where: { userId_id: { userId, id: toArchive.id } },
        data: { status: 'ARCHIVED' },
      })

      const activeOnly = await listActiveFinancialAccounts(userId)
      const all = await listAllFinancialAccounts(userId)

      expect(activeOnly.map((a) => a.id)).toEqual([active.id])
      expect(all.map((a) => a.id).sort()).toEqual([active.id, toArchive.id].sort())
    })
  })

  describe('updateFinancialAccount', () => {
    it('may freely change name, description, currency, and initialBalance before any activity exists', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const created = await createFinancialAccount(userId, {
        name: 'Original Name',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })

      const updated = await updateFinancialAccount(userId, created.id, {
        name: 'New Name',
        description: 'New description',
        currency: 'USD',
        initialBalance: 250.25,
      })

      expect(updated.name).toBe('New Name')
      expect(updated.description).toBe('New description')
      expect(updated.currency).toBe('USD')
      expect(updated.initialBalance.toString()).toBe('250.25')
    })

    it('rejects updating another user account (composite key NotFound) and leaves the row unchanged', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const otherAccountType = await createAccountType(otherUserId)
      const otherAccount = await createFinancialAccount(otherUserId, {
        name: 'Not Yours',
        accountTypeId: otherAccountType.id,
        initialBalance: 10,
        currency: 'VND',
      })

      await expect(
        updateFinancialAccount(userId, otherAccount.id, { name: 'Hijacked' }),
      ).rejects.toThrow()

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId: otherUserId, id: otherAccount.id } },
      })
      expect(stored.name).toBe('Not Yours')
    })

    it('rejects updating accountTypeId to one belonging to another user and leaves the row unchanged', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const accountType = await createAccountType(userId)
      const otherAccountType = await createAccountType(otherUserId)
      const created = await createFinancialAccount(userId, {
        name: 'Mine',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })

      await expect(
        updateFinancialAccount(userId, created.id, { accountTypeId: otherAccountType.id }),
      ).rejects.toThrow(InvalidAccountTypeError)

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.accountTypeId).toBe(accountType.id)
    })

    it('rejects updating accountTypeId to an ARCHIVED account type', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const archivedAccountType = await createAccountType(userId, { status: 'ARCHIVED' })
      const created = await createFinancialAccount(userId, {
        name: 'Mine',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })

      await expect(
        updateFinancialAccount(userId, created.id, { accountTypeId: archivedAccountType.id }),
      ).rejects.toThrow(InvalidAccountTypeError)

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.accountTypeId).toBe(accountType.id)
    })

    it('refuses to change the currency once the account has activity, leaving the row unchanged', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const created = await createFinancialAccount(userId, {
        name: 'Has Activity',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })
      await recordActivity(userId, created.id)

      await expect(updateFinancialAccount(userId, created.id, { currency: 'USD' })).rejects.toThrow(
        AccountLockedError,
      )

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.currency).toBe('VND')
      expect(stored.initialBalance.toString()).toBe('10')
    })

    it('refuses to change the initialBalance once the account has activity, leaving the row unchanged', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const created = await createFinancialAccount(userId, {
        name: 'Has Activity',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })
      await recordActivity(userId, created.id)

      await expect(
        updateFinancialAccount(userId, created.id, { initialBalance: 999.99 }),
      ).rejects.toThrow(AccountLockedError)

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: created.id } },
      })
      expect(stored.initialBalance.toString()).toBe('10')
    })

    it('refuses to change the currency once a transfer has left the account', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const source = await createFinancialAccount(userId, {
        name: 'Source',
        accountTypeId: accountType.id,
        initialBalance: 1000,
        currency: 'VND',
      })
      const destination = await createFinancialAccount(userId, {
        name: 'Destination',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      })
      await recordTransferActivity(userId, source.id, destination.id)

      await expect(updateFinancialAccount(userId, source.id, { currency: 'USD' })).rejects.toThrow(
        AccountLockedError,
      )

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: source.id } },
      })
      expect(stored.currency).toBe('VND')
    })

    it('refuses to change the initialBalance once a transfer has arrived in the account', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const source = await createFinancialAccount(userId, {
        name: 'Source',
        accountTypeId: accountType.id,
        initialBalance: 1000,
        currency: 'VND',
      })
      const destination = await createFinancialAccount(userId, {
        name: 'Destination',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      })
      await recordTransferActivity(userId, source.id, destination.id)

      // The receiving leg counts too: an arriving transfer is as much activity
      // as a departing one, and re-basing the opening balance underneath it
      // would silently rewrite the account's history.
      await expect(
        updateFinancialAccount(userId, destination.id, { initialBalance: 999.99 }),
      ).rejects.toThrow(AccountLockedError)

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: destination.id } },
      })
      expect(stored.initialBalance.toString()).toBe('0')
    })

    it('does not lock a third account because a transfer moved between two others', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const source = await createFinancialAccount(userId, {
        name: 'Source',
        accountTypeId: accountType.id,
        initialBalance: 1000,
        currency: 'VND',
      })
      const destination = await createFinancialAccount(userId, {
        name: 'Destination',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      })
      const untouched = await createFinancialAccount(userId, {
        name: 'Untouched',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })
      await recordTransferActivity(userId, source.id, destination.id)

      const updated = await updateFinancialAccount(userId, untouched.id, {
        currency: 'USD',
        initialBalance: 55.5,
      })

      expect(updated.currency).toBe('USD')
      expect(updated.initialBalance.toString()).toBe('55.5')
    })

    it('still allows renaming and re-describing an account that has activity', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const otherAccountType = await createAccountType(userId)
      const created = await createFinancialAccount(userId, {
        name: 'Has Activity',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })
      await recordActivity(userId, created.id)

      const updated = await updateFinancialAccount(userId, created.id, {
        name: 'Renamed With Activity',
        description: 'Still editable',
        accountTypeId: otherAccountType.id,
      })

      expect(updated.name).toBe('Renamed With Activity')
      expect(updated.description).toBe('Still editable')
      expect(updated.accountTypeId).toBe(otherAccountType.id)
      expect(updated.currency).toBe('VND')
      expect(updated.initialBalance.toString()).toBe('10')
    })

    it('does not lock an account because a different account of the same user has activity', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const busy = await createFinancialAccount(userId, {
        name: 'Busy',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })
      const untouched = await createFinancialAccount(userId, {
        name: 'Untouched',
        accountTypeId: accountType.id,
        initialBalance: 10,
        currency: 'VND',
      })
      await recordActivity(userId, busy.id)

      const updated = await updateFinancialAccount(userId, untouched.id, {
        currency: 'USD',
        initialBalance: 55.5,
      })

      expect(updated.currency).toBe('USD')
      expect(updated.initialBalance.toString()).toBe('55.5')
    })

    it('a partial update changing only name leaves every other field unchanged', async () => {
      const userId = await createUser()
      const accountType = await createAccountType(userId)
      const created = await createFinancialAccount(userId, {
        name: 'Original Name',
        accountTypeId: accountType.id,
        initialBalance: 42.42,
        currency: 'USD',
        description: 'Original description',
      })

      const updated = await updateFinancialAccount(userId, created.id, { name: 'Renamed' })

      expect(updated.name).toBe('Renamed')
      expect(updated.accountTypeId).toBe(accountType.id)
      expect(updated.initialBalance.toString()).toBe('42.42')
      expect(updated.currency).toBe('USD')
      expect(updated.description).toBe('Original description')
    })
  })

  describe('createFinancialAccountSchema', () => {
    it('rejects an empty name', () => {
      expect(
        createFinancialAccountSchema.safeParse({
          name: '',
          accountTypeId: 'abc',
          initialBalance: 0,
          currency: 'VND',
        }).success,
      ).toBe(false)
    })

    it('rejects an unknown currency', () => {
      expect(
        createFinancialAccountSchema.safeParse({
          name: 'Valid',
          accountTypeId: 'abc',
          initialBalance: 0,
          currency: 'EUR',
        }).success,
      ).toBe(false)
    })

    it('rejects a non-finite balance', () => {
      expect(
        createFinancialAccountSchema.safeParse({
          name: 'Valid',
          accountTypeId: 'abc',
          initialBalance: Number.POSITIVE_INFINITY,
          currency: 'VND',
        }).success,
      ).toBe(false)
    })

    it('accepts a valid input', () => {
      expect(
        createFinancialAccountSchema.safeParse({
          name: 'Valid',
          accountTypeId: 'abc',
          initialBalance: 100.5,
          currency: 'VND',
        }).success,
      ).toBe(true)
    })

    function parseWithBalance(initialBalance: number) {
      return createFinancialAccountSchema.safeParse({
        name: 'Valid',
        accountTypeId: 'abc',
        initialBalance,
        currency: 'VND',
      }).success
    }

    it('rejects a balance with more than 2 decimal places', () => {
      expect(parseWithBalance(12.345)).toBe(false)
    })

    it('accepts a balance with exactly 2 decimal places', () => {
      expect(parseWithBalance(12.34)).toBe(true)
    })

    it('accepts a balance with 1 decimal place', () => {
      expect(parseWithBalance(0.1)).toBe(true)
    })

    it('accepts a negative opening balance', () => {
      expect(parseWithBalance(-5.5)).toBe(true)
    })

    it('rejects a balance at the magnitude cap', () => {
      expect(parseWithBalance(1e15)).toBe(false)
    })
  })
})
