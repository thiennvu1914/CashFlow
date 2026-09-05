import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { ArchivedAccountError, createTransaction, updateTransaction } from './transaction'
import { createTransfer } from './transfer'
import { AccountHasNonZeroBalanceError, archiveFinancialAccount } from './financial-account'

/**
 * Deterministic concurrency tests for the archive/activity invariant.
 *
 * The invariant: an ARCHIVED account can never gain Transaction or Transfer
 * activity, and an account cannot be archived while activity is being written
 * to it. Both directions of the race are exercised here against the real
 * database, without a single `sleep`-and-hope: `holdLock` opens an interactive
 * transaction, takes `SELECT … FOR UPDATE` on the account row, performs the
 * competing mutation, and then parks on a promise the test itself resolves. So
 * the test — not the scheduler — decides when the competing write commits.
 *
 * Each case then asserts two things that together prove the write is actually
 * serialised rather than merely lucky:
 *
 * 1. the service call is **still pending** after `LOCK_WAIT_MS` (it is queued
 *    behind the row lock, not racing the check), and
 * 2. once the gate is released it fails with the domain error and leaves zero
 *    rows behind.
 *
 * The last `describe` is the control: with no lock held, the very same calls
 * settle inside the same window. Without it, "still pending" would also pass
 * for a call that was simply slow, and the suite would prove nothing.
 *
 * Connection pool: `PrismaPg` uses node-postgres' default pool (max 10), so
 * the held transaction and the blocked service call are always on different
 * connections — a pool of 1 would deadlock instead of blocking.
 *
 * `fileParallelism: false` (vitest.config.mts) keeps this file from racing the
 * other database-backed suites over the shared USD/VND FX cache rows.
 */

/** How long a blocked call must stay pending before we believe it is blocked. */
const LOCK_WAIT_MS = 300

/** Generous, because the holder deliberately idles while the test inspects the
 *  blocked call; the production services all use Prisma's 5s default. */
const HOLD_TIMEOUT_MS = 30_000

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

function fakeProvider(rate = 25000, source = 'fake') {
  const fetchedAt = new Date(Date.now() - 5 * 60 * 1000)
  const effectiveDate = new Date()
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => ({ rate, effectiveDate, fetchedAt, source }),
    getHistoricalRate: async () => null,
  }
  return { provider, fetchedAt, effectiveDate, rate, source }
}

/** Resolves once `promise` settles, or to `false` after `ms` — never rejects,
 *  so the caller can still await (and assert on) `promise` itself afterwards. */
function hasSettledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = promise.then(
    () => true,
    () => true,
  )
  const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
  return Promise.race([settled, timer])
}

async function assertStillPending(promise: Promise<unknown>) {
  expect(await hasSettledWithin(promise, LOCK_WAIT_MS)).toBe(false)
}

async function assertSettlesPromptly(promise: Promise<unknown>) {
  expect(await hasSettledWithin(promise, LOCK_WAIT_MS)).toBe(true)
}

interface HeldLock {
  /** Commits the holder transaction and waits for it to land. */
  release: () => Promise<void>
}

/**
 * Locks `accountId` with `SELECT … FOR UPDATE`, runs `mutate` inside the same
 * transaction, and holds both open until `release()` is called.
 */
async function holdLock(
  userId: string,
  accountId: string,
  mutate: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<HeldLock> {
  let openGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  let signalAcquired: () => void = () => {}
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve
  })

  const held = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "FinancialAccount" WHERE "userId"=${userId} AND "id"=${accountId} FOR UPDATE`
      await mutate(tx)
      signalAcquired()
      await gate
    },
    { timeout: HOLD_TIMEOUT_MS, maxWait: HOLD_TIMEOUT_MS },
  )
  // If the holder fails before taking the lock, surface that instead of hanging.
  await Promise.race([acquired, held])

  return {
    release: async () => {
      openGate()
      await held
    },
  }
}

describe('archive vs activity concurrency (row locks)', () => {
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
    const common = { userId: user.id, accountTypeId: accountType.id, currency: 'VND' as const }
    const account = await prisma.financialAccount.create({
      data: { ...common, name: 'A', initialBalance: 0 },
    })
    const target = await prisma.financialAccount.create({
      data: { ...common, name: 'B', initialBalance: 0 },
    })
    const funded = await prisma.financialAccount.create({
      data: { ...common, name: 'C', initialBalance: 1_000_000 },
    })
    return {
      userId: user.id,
      accountId: account.id,
      targetId: target.id,
      fundedId: funded.id,
    }
  }

  function archiveVia(userId: string, accountId: string) {
    return async (tx: Prisma.TransactionClient) => {
      await tx.financialAccount.update({
        where: { userId_id: { userId, id: accountId } },
        data: { status: 'ARCHIVED' },
      })
    }
  }

  async function statusOf(userId: string, accountId: string) {
    const account = await prisma.financialAccount.findUniqueOrThrow({
      where: { userId_id: { userId, id: accountId } },
    })
    return account.status
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    const userIds = createdUserIds.splice(0)
    try {
      await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
      if (userIds.length > 0) {
        await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    expect(fetchCalls).toBe(0)
  })

  it('createTransaction waits for a concurrent archive, then refuses to write into it', async () => {
    const s = await setup()
    const lock = await holdLock(s.userId, s.accountId, archiveVia(s.userId, s.accountId))

    const pending = createTransaction(
      s.userId,
      { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date() },
      fakeProvider().provider,
    )

    await assertStillPending(pending)
    await lock.release()

    await expect(pending).rejects.toThrow(ArchivedAccountError)
    expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(0)
  })

  it('archiveFinancialAccount waits for a concurrent transaction insert, then refuses to archive', async () => {
    const s = await setup()
    const lock = await holdLock(s.userId, s.accountId, async (tx) => {
      // Fixture FX values: this test is about the lock, not about the FX policy.
      await tx.transaction.create({
        data: {
          userId: s.userId,
          accountId: s.accountId,
          type: 'CASH_IN',
          amount: 100,
          currency: 'VND',
          date: new Date(),
          vndPerUsdAtEntry: 25000,
          fxRateTimestamp: new Date(),
          fxRateSource: 'fixture',
        },
      })
    })

    const pending = archiveFinancialAccount(s.userId, s.accountId)

    await assertStillPending(pending)
    await lock.release()

    await expect(pending).rejects.toThrow(AccountHasNonZeroBalanceError)
    expect(await statusOf(s.userId, s.accountId)).toBe('ACTIVE')
  })

  it('updateTransaction waits for a concurrent archive of the target account, then refuses the move', async () => {
    const s = await setup()
    const tx = await createTransaction(
      s.userId,
      { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
      fakeProvider().provider,
    )
    const lock = await holdLock(s.userId, s.targetId, archiveVia(s.userId, s.targetId))

    const pending = updateTransaction(
      s.userId,
      tx.id,
      { accountId: s.targetId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
      fakeProvider().provider,
    )

    await assertStillPending(pending)
    await lock.release()

    await expect(pending).rejects.toThrow(ArchivedAccountError)
    const stored = await prisma.transaction.findUniqueOrThrow({
      where: { userId_id: { userId: s.userId, id: tx.id } },
    })
    expect(stored.accountId).toBe(s.accountId)
    expect(stored.amount.toString()).toBe('1000')
  })

  it('createTransfer waits for a concurrent archive of the source account, then refuses it', async () => {
    const s = await setup()
    const lock = await holdLock(s.userId, s.fundedId, archiveVia(s.userId, s.fundedId))

    const pending = createTransfer(s.userId, {
      fromAccountId: s.fundedId,
      toAccountId: s.targetId,
      fromAmount: 100,
      toAmount: 100,
      date: new Date(),
    })

    await assertStillPending(pending)
    await lock.release()

    await expect(pending).rejects.toThrow(ArchivedAccountError)
    expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
  })

  it('createTransfer waits for a concurrent archive of the destination account, then refuses it', async () => {
    const s = await setup()
    const lock = await holdLock(s.userId, s.targetId, archiveVia(s.userId, s.targetId))

    const pending = createTransfer(s.userId, {
      fromAccountId: s.fundedId,
      toAccountId: s.targetId,
      fromAmount: 100,
      toAmount: 100,
      date: new Date(),
    })

    await assertStillPending(pending)
    await lock.release()

    await expect(pending).rejects.toThrow(ArchivedAccountError)
    expect(await prisma.transfer.count({ where: { userId: s.userId } })).toBe(0)
  })

  /**
   * The control group. Every assertion above rests on "still pending after
   * 300 ms" meaning "blocked on a row lock" — which is only true if these same
   * calls settle well inside that window when nothing is holding the lock.
   */
  describe('control: the same calls settle promptly when no lock is held', () => {
    it('createTransaction', async () => {
      const s = await setup()

      const pending = createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date() },
        fakeProvider().provider,
      )

      await assertSettlesPromptly(pending)
      await expect(pending).resolves.toMatchObject({ accountId: s.accountId })
    })

    it('updateTransaction moving to another account', async () => {
      const s = await setup()
      const tx = await createTransaction(
        s.userId,
        { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )

      const pending = updateTransaction(
        s.userId,
        tx.id,
        { accountId: s.targetId, type: 'CASH_IN', amount: 1000, date: new Date('2026-02-01') },
        fakeProvider().provider,
      )

      await assertSettlesPromptly(pending)
      await expect(pending).resolves.toMatchObject({ accountId: s.targetId })
    })

    it('createTransfer', async () => {
      const s = await setup()

      const pending = createTransfer(s.userId, {
        fromAccountId: s.fundedId,
        toAccountId: s.targetId,
        fromAmount: 100,
        toAmount: 100,
        date: new Date(),
      })

      await assertSettlesPromptly(pending)
      await expect(pending).resolves.toMatchObject({ toAccountId: s.targetId })
    })

    it('archiveFinancialAccount of a zero-balance account', async () => {
      const s = await setup()

      const pending = archiveFinancialAccount(s.userId, s.targetId)

      await assertSettlesPromptly(pending)
      await expect(pending).resolves.toMatchObject({ status: 'ARCHIVED' })
    })
  })
})
