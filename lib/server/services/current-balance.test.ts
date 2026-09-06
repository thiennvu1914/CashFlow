import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { prisma } from '@/lib/prisma'
import type { TransactionType } from '@prisma/client'
import { getAccountBalances, getCurrentAccountBalance, getCurrentAccountBalances } from './balance'
import { getCurrentPosition } from './position'

/**
 * The "as of now" semantic, pinned.
 *
 * One rule holds everywhere a *current* balance is shown — the Accounts page,
 * the dashboard's current position, the Excel Summary and Accounts sheets:
 *
 *     current balance = derived balance as of the current instant
 *
 * Future-dated activity stays stored and stays visible in its own lists, but it
 * does not move a current balance until its timestamp is reached. These cases
 * fix that rule against the database, and the last one fixes the *agreement*
 * between the two surfaces that used to disagree: the Accounts page's balances
 * and the dashboard position's `nativeBalance`.
 *
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every user created here is deleted again
 * in `afterEach`, so repeated runs stay identical.
 */
describe('current balance ("as of now") semantic', () => {
  const createdUserIds: string[] = []
  let fetchSpy: MockInstance

  /** Pinned: nothing here may depend on the wall clock. */
  const NOW = new Date('2026-09-06T12:00:00.000Z')
  const ONE_HOUR = 60 * 60 * 1000
  const PAST = new Date(NOW.getTime() - ONE_HOUR)
  const FUTURE = new Date(NOW.getTime() + ONE_HOUR)
  /** Every account predates the window so `createdAt` never truncates a balance. */
  const CREATED_AT = new Date(NOW.getTime() - 30 * 24 * ONE_HOUR)

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

  async function createAccount(userId: string, name: string, initialBalance: number) {
    const accountType = await prisma.accountType.create({ data: { userId, name: `Cash ${name}` } })
    return prisma.financialAccount.create({
      data: {
        userId,
        name,
        accountTypeId: accountType.id,
        initialBalance,
        currency: 'VND',
        createdAt: CREATED_AT,
      },
    })
  }

  /**
   * Inserted directly via Prisma, bypassing the transaction service: these cases
   * are about the balance cut-off, and going through the real service would drag
   * the FX policy into it. The `fx*` values are fixtures, not something the app
   * produced.
   */
  function makeTx(
    userId: string,
    accountId: string,
    type: TransactionType,
    amount: number,
    date: Date,
  ) {
    return prisma.transaction.create({
      data: {
        userId,
        accountId,
        type,
        amount,
        currency: 'VND',
        date,
        vndPerUsdAtEntry: 25000,
        fxRateFetchedAt: new Date(),
        fxRateEffectiveAt: new Date(),
        fxRateSource: 'fixture',
      },
    })
  }

  /** Same reasoning as `makeTx`: a transfer row written straight to the table. */
  function makeTransfer(
    userId: string,
    fromAccountId: string,
    toAccountId: string,
    amount: number,
    date: Date,
  ) {
    return prisma.transfer.create({
      data: {
        userId,
        fromAccountId,
        toAccountId,
        fromAmount: amount,
        toAmount: amount,
        date,
      },
    })
  }

  beforeEach(() => {
    // Every account below is VND and the display currency is VND, so no
    // conversion is ever required: a network call here would be a bug, not a
    // missing fixture.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    const userIds = createdUserIds.splice(0)
    try {
      if (userIds.length > 0) {
        await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      }
    } finally {
      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } })
      }
    }
    expect(fetchCalls).toBe(0)
  })

  it('a future-dated EXPENSE does not reduce the current balance', async () => {
    const userId = await createUser()
    const account = await createAccount(userId, 'Wallet', 1000)
    await makeTx(userId, account.id, 'EXPENSE', 400, FUTURE)

    const current = await getCurrentAccountBalances(userId, [account.id], NOW)

    expect(current.get(account.id)?.toString()).toBe('1000')
    // The booked figure — every entry, future-dated included — is a different
    // number, so this fixture really does exercise the cut-off.
    const booked = await getAccountBalances(userId, [account.id])
    expect(booked.get(account.id)?.toString()).toBe('600')
  })

  it('a future-dated INCOME does not increase the current balance', async () => {
    const userId = await createUser()
    const account = await createAccount(userId, 'Wallet', 1000)
    await makeTx(userId, account.id, 'INCOME', 500, FUTURE)

    const current = await getCurrentAccountBalances(userId, [account.id], NOW)

    expect(current.get(account.id)?.toString()).toBe('1000')
    const booked = await getAccountBalances(userId, [account.id])
    expect(booked.get(account.id)?.toString()).toBe('1500')
  })

  it('a future-dated outgoing transfer does not reduce the source account current balance', async () => {
    const userId = await createUser()
    const source = await createAccount(userId, 'Source', 1000)
    const destination = await createAccount(userId, 'Destination', 0)
    await makeTransfer(userId, source.id, destination.id, 300, FUTURE)

    const current = await getCurrentAccountBalances(userId, [source.id], NOW)

    expect(current.get(source.id)?.toString()).toBe('1000')
    const booked = await getAccountBalances(userId, [source.id])
    expect(booked.get(source.id)?.toString()).toBe('700')
  })

  it('a future-dated incoming transfer does not increase the destination account current balance', async () => {
    const userId = await createUser()
    const source = await createAccount(userId, 'Source', 1000)
    const destination = await createAccount(userId, 'Destination', 0)
    await makeTransfer(userId, source.id, destination.id, 300, FUTURE)

    const current = await getCurrentAccountBalance(userId, destination.id, NOW)

    expect(current.toString()).toBe('0')
    const booked = await getAccountBalances(userId, [destination.id])
    expect(booked.get(destination.id)?.toString()).toBe('300')
  })

  it('the same activity IS included one millisecond after its timestamp — the historical path is unchanged', async () => {
    const userId = await createUser()
    const source = await createAccount(userId, 'Source', 1000)
    const destination = await createAccount(userId, 'Destination', 0)
    await makeTx(userId, source.id, 'EXPENSE', 400, FUTURE)
    await makeTx(userId, source.id, 'INCOME', 500, FUTURE)
    await makeTransfer(userId, source.id, destination.id, 300, FUTURE)
    const justAfter = new Date(FUTURE.getTime() + 1)

    const asOf = await getAccountBalances(userId, [source.id, destination.id], justAfter)

    // 1000 − 400 + 500 − 300 = 800, and the arriving 300 on the other side.
    expect(asOf.get(source.id)?.toString()).toBe('800')
    expect(asOf.get(destination.id)?.toString()).toBe('300')
  })

  it('the Accounts page and the dashboard position report identical balances for every account', async () => {
    const userId = await createUser()
    const wallet = await createAccount(userId, 'Wallet', 1000)
    const savings = await createAccount(userId, 'Savings', 250)
    // A settled entry on each side, then the two kinds of future-dated activity
    // that used to make the two surfaces disagree.
    await makeTx(userId, wallet.id, 'INCOME', 120, PAST)
    await makeTx(userId, wallet.id, 'EXPENSE', 700, FUTURE)
    await makeTransfer(userId, savings.id, wallet.id, 200, FUTURE)

    // What the Accounts page renders…
    const pageBalances = await getCurrentAccountBalances(userId, [wallet.id, savings.id], NOW)
    // …and what the dashboard's current position renders.
    const position = await getCurrentPosition(userId, 'VND', { now: NOW })

    expect(position.accounts).toHaveLength(2)
    for (const account of position.accounts) {
      const pageBalance = pageBalances.get(account.id)
      expect(pageBalance).toBeDefined()
      expect(account.nativeBalance.toString()).toBe(pageBalance?.toString())
    }
    // Not a vacuous agreement: both are the as-of-now figures (1120 and 250),
    // not the booked ones (420 and 50).
    expect(pageBalances.get(wallet.id)?.toString()).toBe('1120')
    expect(pageBalances.get(savings.id)?.toString()).toBe('250')
  })
})
