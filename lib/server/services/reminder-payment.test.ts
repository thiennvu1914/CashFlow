import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { FxUnavailableError, getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import { resetFxMemoForTests } from '@/lib/currency/fx-service'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { getAccountBalance } from '@/lib/server/services/balance'
import {
  OccurrenceNotPendingError,
  acknowledgeOccurrence,
  createReminder,
  dismissOccurrence,
  getOccurrencePrefill,
  listUpcomingOccurrences,
  lockPendingOccurrence,
  markOccurrencePaidInTx,
  materializeDueOccurrences,
  payOccurrence,
} from './reminder'
import { ArchivedAccountError } from './account-lock'
import { InvalidCategoryError, SNAPSHOT_PAIR } from './linked-transaction'
import { createTransaction, deleteTransaction, updateTransaction } from './transaction'

/**
 * Reminder "Đã trả / Paid" (money-source linking spec 2026-10-12 §2 Q6, §6.5,
 * §6.6), against the real database.
 *
 * One tap on a pending occurrence records the INCOME or EXPENSE it reminds the
 * user of — the reminder's type, expected amount, category and account, dated
 * on the occurrence's due day — and marks the occurrence ACKNOWLEDGED with a
 * link to that transaction, in one database transaction. A reminder that lacks
 * what a transaction needs (no account, an archived one, one in another
 * currency, no usable category) writes nothing and answers with the prefill
 * the create form opens with; saving that form with the occurrence id links it
 * the same way. Deleting the transaction returns the occurrence to PENDING.
 *
 * Every FX lookup goes through an injected fake provider and `fetch` is a
 * throwing spy, so nothing here reaches the network. The USD/VND cache rows are
 * global, so they are cleared with the in-process memo around every case.
 */

const TIMEZONE = 'Asia/Ho_Chi_Minh'
const FX_SOURCE = 'reminder-payment-fake'

/** 17:00 on 15 March 2026 in Ho Chi Minh — "today" there is 2026-03-15. */
const NOW = new Date('2026-03-15T10:00:00.000Z')

/** A ONE_TIME reminder due today (15 March), the shape most cases start from. */
const RENT = {
  title: 'Rent',
  type: 'EXPENSE' as const,
  expectedAmount: 1_250_000,
  currency: 'VND' as const,
  frequency: 'ONE_TIME' as const,
  interval: 1,
  startDate: '2026-03-15',
}

const createdUserIds: string[] = []
let fetchSpy: MockInstance

function fakeProvider(rate = 25000) {
  // In the past, so a write that stamped "now" instead of the provider's own
  // fetch instant could not pass an equality check.
  const fetchedAt = new Date(Date.now() - 5 * 60 * 1000)
  const effectiveDate = new Date()
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => ({ rate, effectiveDate, fetchedAt, source: FX_SOURCE }),
    getHistoricalRate: async () => null,
  }
  return { provider, fetchedAt }
}

/** Fails every lookup — with an empty cache, the FX policy has nothing to use. */
const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

/** A provider the case must never reach: a needs-form answer writes nothing,
 *  so it has no reason to look up a rate. */
const unreachableProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('FX looked up for a write that never happens')
  },
  getHistoricalRate: async () => null,
}

async function clearFxCache() {
  await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
  // The in-process memo would otherwise outlive the rows just deleted.
  resetFxMemoForTests()
}

/**
 * A user with a funded VND wallet, a USD account, an EXPENSE and an INCOME
 * category — everything a reminder can point at.
 */
async function setup() {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `reminder-pay-${randomUUID()}@example.com`,
      name: 'Reminder Payment Test',
      emailVerified: false,
      timezone: TIMEZONE,
    },
  })
  createdUserIds.push(user.id)
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const wallet = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Wallet',
      accountTypeId: accountType.id,
      initialBalance: new Prisma.Decimal('5000000'),
      currency: 'VND',
    },
  })
  const usd = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Dollars',
      accountTypeId: accountType.id,
      initialBalance: new Prisma.Decimal('100'),
      currency: 'USD',
    },
  })
  const housing = await prisma.category.create({
    data: { userId: user.id, name: 'Housing', type: 'EXPENSE' },
  })
  const salary = await prisma.category.create({
    data: { userId: user.id, name: 'Salary', type: 'INCOME' },
  })
  return {
    userId: user.id,
    walletId: wallet.id,
    usdId: usd.id,
    housingId: housing.id,
    salaryId: salary.id,
  }
}

type Fixture = Awaited<ReturnType<typeof setup>>

/** Creates a reminder through the service, materializes it at `NOW`, and
 *  returns its (single, for a ONE_TIME reminder) occurrence. */
async function pendingOccurrence(
  userId: string,
  overrides: Partial<Parameters<typeof createReminder>[2]> = {},
) {
  const reminder = await createReminder(userId, TIMEZONE, { ...RENT, ...overrides })
  await materializeDueOccurrences(userId, TIMEZONE, NOW)
  return prisma.reminderOccurrence.findFirstOrThrow({
    where: { userId, reminderId: reminder.id },
  })
}

function storedOccurrence(userId: string, occurrenceId: string) {
  return prisma.reminderOccurrence.findUniqueOrThrow({
    where: { userId_id: { userId, id: occurrenceId } },
  })
}

function transactionCount(userId: string) {
  return prisma.transaction.count({ where: { userId } })
}

async function expectPrismaCode(promise: Promise<unknown>, code: string) {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe(code)
}

beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in test')
  })
  // The fallback path warns by design; silenced to keep the output pristine.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await clearFxCache()
})

afterEach(async () => {
  const fetchCalls = fetchSpy.mock.calls.length
  vi.restoreAllMocks()
  const userIds = createdUserIds.splice(0)
  try {
    await clearFxCache()
    if (userIds.length > 0) {
      // Occurrences first: a paid one references its transaction, ON DELETE
      // RESTRICT.
      await prisma.reminderOccurrence.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.recurringReminder.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
  expect(fetchCalls).toBe(0)
})

describe('payOccurrence — one tap records the transaction', () => {
  it('records the EXPENSE in the reminder’s account and category, links it, and moves the balance', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })
    const { provider, fetchedAt } = fakeProvider(25000)

    const result = await payOccurrence(s.userId, occurrence.id, TIMEZONE, provider, NOW)

    expect(result.status).toBe('created')
    if (result.status !== 'created') return
    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { userId_id: { userId: s.userId, id: result.transactionId } },
    })
    expect(transaction.type).toBe('EXPENSE')
    expect(transaction.amount.equals(new Prisma.Decimal('1250000'))).toBe(true)
    expect(transaction.currency).toBe('VND')
    expect(transaction.accountId).toBe(s.walletId)
    expect(transaction.categoryId).toBe(s.housingId)
    expect(transaction.note).toBe('Rent')
    // Due today in the user's zone, so it is dated now and counts at once
    // (Ruling P4) — not at noon, hours away.
    expect(transaction.date.toISOString()).toBe(NOW.toISOString())
    // The real FX policy's snapshot, with the provider's own fetch instant.
    expect(transaction.vndPerUsdAtEntry.equals(new Prisma.Decimal('25000'))).toBe(true)
    expect(transaction.fxRateSource).toBe(FX_SOURCE)
    expect(transaction.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())

    const stored = await storedOccurrence(s.userId, occurrence.id)
    expect(stored.status).toBe('ACKNOWLEDGED')
    expect(stored.actionedAt?.toISOString()).toBe(NOW.toISOString())
    expect(stored.transactionId).toBe(result.transactionId)

    expect((await getAccountBalance(s.userId, s.walletId)).toString()).toBe('3750000')
  })

  it('records an INCOME dated 12:00 on an overdue due day, and adds to the balance', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      title: 'Salary',
      type: 'INCOME',
      expectedAmount: 2_000_000.5,
      startDate: '2026-03-10',
      accountId: s.walletId,
      categoryId: s.salaryId,
    })

    const result = await payOccurrence(
      s.userId,
      occurrence.id,
      TIMEZONE,
      fakeProvider().provider,
      NOW,
    )

    expect(result.status).toBe('created')
    if (result.status !== 'created') return
    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { userId_id: { userId: s.userId, id: result.transactionId } },
    })
    expect(transaction.type).toBe('INCOME')
    expect(transaction.categoryId).toBe(s.salaryId)
    // 12:00 on 10 March in Ho Chi Minh (UTC+7): the due day, not the day it
    // was paid, and never a time that could cross into another day.
    expect(transaction.date.toISOString()).toBe('2026-03-10T05:00:00.000Z')
    expect((await getAccountBalance(s.userId, s.walletId)).toString()).toBe('7000000.5')
  })

  it('dates it on the due day the user sees in their own zone, not the reminder’s', async () => {
    const s = await setup()
    // Created in Ho Chi Minh: due at local midnight on 10 March there, which
    // is still 9 March in New York — the day a New York viewer's list shows.
    const occurrence = await pendingOccurrence(s.userId, {
      startDate: '2026-03-10',
      accountId: s.walletId,
      categoryId: s.housingId,
    })

    const result = await payOccurrence(
      s.userId,
      occurrence.id,
      'America/New_York',
      fakeProvider().provider,
      NOW,
    )

    if (result.status !== 'created') throw new Error('expected a created transaction')
    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { userId_id: { userId: s.userId, id: result.transactionId } },
    })
    // 12:00 on 9 March in New York — EDT (UTC−4) since the 8 March switch.
    expect(transaction.date.toISOString()).toBe('2026-03-09T16:00:00.000Z')
  })

  it('writes nothing and leaves the occurrence pending when FX is unavailable', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })

    await expect(
      payOccurrence(s.userId, occurrence.id, TIMEZONE, failingProvider, NOW),
    ).rejects.toBeInstanceOf(FxUnavailableError)

    expect(await transactionCount(s.userId)).toBe(0)
    const stored = await storedOccurrence(s.userId, occurrence.id)
    expect(stored.status).toBe('PENDING')
    expect(stored.transactionId).toBeNull()
  })

  it('records exactly one transaction when the same occurrence is paid twice at once', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })
    const { provider } = fakeProvider()
    // Warm the cache, so both calls reach their transactions together rather
    // than racing each other to store the day's rate.
    await getUsableCurrentRate(SNAPSHOT_PAIR, provider)

    const outcomes = await Promise.allSettled([
      payOccurrence(s.userId, occurrence.id, TIMEZONE, provider, NOW),
      payOccurrence(s.userId, occurrence.id, TIMEZONE, provider, NOW),
    ])

    const created = outcomes.filter((o) => o.status === 'fulfilled')
    const refused = outcomes.filter((o) => o.status === 'rejected')
    expect(created).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(OccurrenceNotPendingError)
    expect(await transactionCount(s.userId)).toBe(1)
    expect((await getAccountBalance(s.userId, s.walletId)).toString()).toBe('3750000')
  })

  it('never leaves a dismissed occurrence holding a transaction when Dismiss races Paid', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })

    await Promise.allSettled([
      payOccurrence(s.userId, occurrence.id, TIMEZONE, fakeProvider().provider, NOW),
      dismissOccurrence(s.userId, occurrence.id, NOW),
    ])

    // Either answer may win, but the row must be one of the two whole states.
    const stored = await storedOccurrence(s.userId, occurrence.id)
    if (stored.status === 'DISMISSED') {
      expect(stored.transactionId).toBeNull()
      expect(await transactionCount(s.userId)).toBe(0)
    } else {
      expect(stored.status).toBe('ACKNOWLEDGED')
      expect(stored.transactionId).not.toBeNull()
      expect(await transactionCount(s.userId)).toBe(1)
    }
  })

  it('lets a Paid that already holds the occurrence win over a Dismiss that read it as pending', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })
    // The row Paid will link — recorded beforehand, so the interleaving below
    // is only the occurrence lock and the two writes to it.
    const paidWith = await createTransaction(
      s.userId,
      { accountId: s.walletId, type: 'EXPENSE', categoryId: s.housingId, amount: 1, date: NOW },
      fakeProvider().provider,
    )

    // Paid's order, by hand: lock the occurrence, and while the lock is held
    // the Dismiss starts — it sees PENDING in any read it makes — then Paid
    // marks the row and commits.
    let dismissed: ReturnType<typeof dismissOccurrence> | undefined
    await prisma.$transaction(async (tx) => {
      await lockPendingOccurrence(tx, s.userId, occurrence.id)
      dismissed = dismissOccurrence(s.userId, occurrence.id, NOW)
      // Long enough for the Dismiss to reach the row and wait on the lock.
      await new Promise((resolve) => setTimeout(resolve, 500))
      await markOccurrencePaidInTx(tx, s.userId, occurrence.id, paidWith.id, NOW)
    })
    const answer = await dismissed!

    // The Dismiss changed nothing: the occurrence is paid, with its
    // transaction, and that is what the Dismiss reports back.
    expect(answer.status).toBe('ACKNOWLEDGED')
    const stored = await storedOccurrence(s.userId, occurrence.id)
    expect(stored.status).toBe('ACKNOWLEDGED')
    expect(stored.transactionId).toBe(paidWith.id)
  })

  it('records an upcoming bill paid early on today, so the balance moves now (Ruling P8)', async () => {
    const s = await setup()
    // Due on 20 March, paid on the 15th: the money moved today.
    const occurrence = await pendingOccurrence(s.userId, {
      startDate: '2026-03-20',
      accountId: s.walletId,
      categoryId: s.housingId,
    })

    const result = await payOccurrence(
      s.userId,
      occurrence.id,
      TIMEZONE,
      fakeProvider().provider,
      NOW,
    )

    if (result.status !== 'created') throw new Error('expected a created transaction')
    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { userId_id: { userId: s.userId, id: result.transactionId } },
    })
    // Dated now, not 12:00 on the 20th — so it counts in today's balance and
    // this month's budget rather than appearing next week.
    expect(transaction.date.toISOString()).toBe(NOW.toISOString())
    expect((await getAccountBalance(s.userId, s.walletId)).toString()).toBe('3750000')
  })
})

describe('payOccurrence — falls back to the prefilled form', () => {
  /** Pays with a provider that must never be reached, and asserts nothing was
   *  written: no transaction, and the occurrence still pending and unlinked. */
  async function expectNeedsForm(s: Fixture, occurrenceId: string) {
    const result = await payOccurrence(s.userId, occurrenceId, TIMEZONE, unreachableProvider, NOW)
    expect(result.status).toBe('needs-form')
    expect(await transactionCount(s.userId)).toBe(0)
    const stored = await storedOccurrence(s.userId, occurrenceId)
    expect(stored.status).toBe('PENDING')
    expect(stored.actionedAt).toBeNull()
    expect(stored.transactionId).toBeNull()
    if (result.status !== 'needs-form') throw new Error('unreachable')
    return result.prefill
  }

  it('answers with the prefill when the reminder has no account', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, { categoryId: s.housingId })

    const prefill = await expectNeedsForm(s, occurrence.id)

    expect(prefill).toEqual({
      type: 'EXPENSE',
      amount: '1250000.00',
      currency: 'VND',
      accountId: null,
      categoryId: s.housingId,
      date: '2026-03-15',
      note: 'Rent',
      occurrenceId: occurrence.id,
    })
  })

  it('leaves out an account archived since the reminder was set up', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })
    await prisma.financialAccount.update({
      where: { userId_id: { userId: s.userId, id: s.walletId } },
      data: { status: 'ARCHIVED' },
    })

    const prefill = await expectNeedsForm(s, occurrence.id)

    expect(prefill.accountId).toBeNull()
    expect(prefill.categoryId).toBe(s.housingId)
  })

  it('leaves out an account in another currency than the reminder', async () => {
    const s = await setup()
    // A 20 USD subscription the user expects to pay from a VND wallet: writing
    // "20" into that wallet would record 20 VND.
    const occurrence = await pendingOccurrence(s.userId, {
      title: 'Cloud storage',
      expectedAmount: 20,
      currency: 'USD',
      accountId: s.walletId,
      categoryId: s.housingId,
    })

    const prefill = await expectNeedsForm(s, occurrence.id)

    expect(prefill.currency).toBe('USD')
    expect(prefill.amount).toBe('20.00')
    expect(prefill.accountId).toBeNull()
  })

  it('offers today, not a future due day, for an upcoming occurrence (Ruling P8)', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, { startDate: '2026-03-20' })

    const prefill = await expectNeedsForm(s, occurrence.id)

    expect(prefill.date).toBe('2026-03-15')
  })

  it('answers with the prefill when the reminder has no category', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, { accountId: s.walletId })

    const prefill = await expectNeedsForm(s, occurrence.id)

    expect(prefill.accountId).toBe(s.walletId)
    expect(prefill.categoryId).toBeNull()
  })

  it('leaves out a category archived since the reminder was set up', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })
    await prisma.category.update({
      where: { userId_id: { userId: s.userId, id: s.housingId } },
      data: { status: 'ARCHIVED' },
    })

    const prefill = await expectNeedsForm(s, occurrence.id)

    expect(prefill.accountId).toBe(s.walletId)
    expect(prefill.categoryId).toBeNull()
  })
})

describe('payOccurrence — refusals', () => {
  it.each([
    ['acknowledged', acknowledgeOccurrence],
    ['dismissed', dismissOccurrence],
  ] as const)('refuses an occurrence already %s, writing nothing', async (_label, answer) => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })
    await answer(s.userId, occurrence.id, NOW)
    const before = await storedOccurrence(s.userId, occurrence.id)

    await expect(
      payOccurrence(s.userId, occurrence.id, TIMEZONE, unreachableProvider, NOW),
    ).rejects.toBeInstanceOf(OccurrenceNotPendingError)

    expect(await transactionCount(s.userId)).toBe(0)
    expect(await storedOccurrence(s.userId, occurrence.id)).toEqual(before)
  })

  it('refuses another user’s occurrence with P2025 and leaves it untouched', async () => {
    const s = await setup()
    const other = await setup()
    const theirs = await pendingOccurrence(other.userId, {
      accountId: other.walletId,
      categoryId: other.housingId,
    })

    await expectPrismaCode(
      payOccurrence(s.userId, theirs.id, TIMEZONE, unreachableProvider, NOW),
      'P2025',
    )

    expect(await transactionCount(other.userId)).toBe(0)
    const stored = await storedOccurrence(other.userId, theirs.id)
    expect(stored.status).toBe('PENDING')
    expect(stored.transactionId).toBeNull()
  })
})

describe('getOccurrencePrefill', () => {
  it('reads the create form’s prefill for a pending occurrence of this user', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })

    expect(await getOccurrencePrefill(s.userId, occurrence.id, TIMEZONE)).toEqual({
      type: 'EXPENSE',
      amount: '1250000.00',
      currency: 'VND',
      accountId: s.walletId,
      categoryId: s.housingId,
      date: '2026-03-15',
      note: 'Rent',
      occurrenceId: occurrence.id,
    })
  })

  it('reads the payment day as today for an occurrence still ahead, and the due day once it has passed', async () => {
    const s = await setup()
    const upcoming = await pendingOccurrence(s.userId, { startDate: '2026-03-20' })
    const overdue = await pendingOccurrence(s.userId, { title: 'Water', startDate: '2026-03-10' })

    expect((await getOccurrencePrefill(s.userId, upcoming.id, TIMEZONE, NOW))?.date).toBe(
      '2026-03-15',
    )
    expect((await getOccurrencePrefill(s.userId, overdue.id, TIMEZONE, NOW))?.date).toBe(
      '2026-03-10',
    )
  })

  it('reads nothing for an answered occurrence, another user’s, or an unknown id', async () => {
    const s = await setup()
    const other = await setup()
    const answered = await pendingOccurrence(s.userId)
    await acknowledgeOccurrence(s.userId, answered.id, NOW)
    const theirs = await pendingOccurrence(other.userId)

    expect(await getOccurrencePrefill(s.userId, answered.id, TIMEZONE)).toBeNull()
    expect(await getOccurrencePrefill(s.userId, theirs.id, TIMEZONE)).toBeNull()
    expect(await getOccurrencePrefill(s.userId, 'no-such-occurrence', TIMEZONE)).toBeNull()
  })
})

describe('createTransaction with an occurrenceId', () => {
  it('links the occurrence to the transaction it saves, in the same write', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId)

    const transaction = await createTransaction(
      s.userId,
      {
        accountId: s.walletId,
        type: 'EXPENSE',
        categoryId: s.housingId,
        amount: 1_300_000,
        date: NOW,
        note: 'Rent, with the late fee',
        occurrenceId: occurrence.id,
      },
      fakeProvider().provider,
    )

    const stored = await storedOccurrence(s.userId, occurrence.id)
    expect(stored.status).toBe('ACKNOWLEDGED')
    expect(stored.transactionId).toBe(transaction.id)
    expect(stored.actionedAt).not.toBeNull()
    expect((await getAccountBalance(s.userId, s.walletId)).toString()).toBe('3700000')
  })

  it('refuses an occurrence that is no longer pending, writing nothing', async () => {
    const s = await setup()
    const occurrence = await pendingOccurrence(s.userId)
    await dismissOccurrence(s.userId, occurrence.id, NOW)

    await expect(
      createTransaction(
        s.userId,
        {
          accountId: s.walletId,
          type: 'EXPENSE',
          categoryId: s.housingId,
          amount: 1_250_000,
          date: NOW,
          occurrenceId: occurrence.id,
        },
        fakeProvider().provider,
      ),
    ).rejects.toBeInstanceOf(OccurrenceNotPendingError)

    expect(await transactionCount(s.userId)).toBe(0)
    expect((await storedOccurrence(s.userId, occurrence.id)).status).toBe('DISMISSED')
  })

  it.each([
    ['an archived account', ArchivedAccountError],
    ['a category of the wrong type', InvalidCategoryError],
  ] as const)(
    'rolls the link back with the transaction when the write is refused for %s',
    async (label, errorClass) => {
      const s = await setup()
      const occurrence = await pendingOccurrence(s.userId)
      if (errorClass === ArchivedAccountError) {
        await prisma.financialAccount.update({
          where: { userId_id: { userId: s.userId, id: s.walletId } },
          data: { status: 'ARCHIVED' },
        })
      }

      await expect(
        createTransaction(
          s.userId,
          {
            accountId: s.walletId,
            type: 'EXPENSE',
            // An INCOME category on an EXPENSE: refused by the core, after the
            // occurrence was locked.
            categoryId: label === 'a category of the wrong type' ? s.salaryId : s.housingId,
            amount: 1_250_000,
            date: NOW,
            occurrenceId: occurrence.id,
          },
          fakeProvider().provider,
        ),
      ).rejects.toBeInstanceOf(errorClass)

      expect(await transactionCount(s.userId)).toBe(0)
      const stored = await storedOccurrence(s.userId, occurrence.id)
      expect(stored.status).toBe('PENDING')
      expect(stored.actionedAt).toBeNull()
      expect(stored.transactionId).toBeNull()
    },
  )

  it('refuses another user’s occurrence with P2025, writing nothing', async () => {
    const s = await setup()
    const other = await setup()
    const theirs = await pendingOccurrence(other.userId)

    await expectPrismaCode(
      createTransaction(
        s.userId,
        {
          accountId: s.walletId,
          type: 'EXPENSE',
          categoryId: s.housingId,
          amount: 1_250_000,
          date: NOW,
          occurrenceId: theirs.id,
        },
        fakeProvider().provider,
      ),
      'P2025',
    )

    expect(await transactionCount(s.userId)).toBe(0)
    expect((await storedOccurrence(other.userId, theirs.id)).status).toBe('PENDING')
  })
})

describe('a reminder-paid transaction stays an ordinary one', () => {
  async function paidOccurrence(s: Fixture) {
    const occurrence = await pendingOccurrence(s.userId, {
      accountId: s.walletId,
      categoryId: s.housingId,
    })
    const result = await payOccurrence(
      s.userId,
      occurrence.id,
      TIMEZONE,
      fakeProvider().provider,
      NOW,
    )
    if (result.status !== 'created') throw new Error('expected a created transaction')
    return { occurrenceId: occurrence.id, transactionId: result.transactionId }
  }

  it('deleting it returns the occurrence to pending, and it is due again', async () => {
    const s = await setup()
    const { occurrenceId, transactionId } = await paidOccurrence(s)

    await deleteTransaction(s.userId, transactionId)

    const stored = await storedOccurrence(s.userId, occurrenceId)
    expect(stored.status).toBe('PENDING')
    expect(stored.actionedAt).toBeNull()
    expect(stored.transactionId).toBeNull()
    expect(await transactionCount(s.userId)).toBe(0)
    expect((await getAccountBalance(s.userId, s.walletId)).toString()).toBe('5000000')
    const upcoming = await listUpcomingOccurrences(s.userId, TIMEZONE, NOW)
    expect(upcoming.map((row) => row.id)).toContain(occurrenceId)
  })

  it('stays editable from the Transactions page, and keeps its link', async () => {
    const s = await setup()
    const { occurrenceId, transactionId } = await paidOccurrence(s)

    await updateTransaction(
      s.userId,
      transactionId,
      {
        accountId: s.walletId,
        type: 'EXPENSE',
        categoryId: s.housingId,
        amount: 1_250_000,
        date: NOW,
        note: 'Rent for March',
      },
      unreachableProvider,
    )

    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { userId_id: { userId: s.userId, id: transactionId } },
    })
    expect(transaction.note).toBe('Rent for March')
    expect((await storedOccurrence(s.userId, occurrenceId)).transactionId).toBe(transactionId)
  })

  it('cannot be deleted out from under its occurrence even bypassing the service', async () => {
    const s = await setup()
    const { transactionId } = await paidOccurrence(s)

    await expectPrismaCode(
      prisma.transaction.delete({ where: { userId_id: { userId: s.userId, id: transactionId } } }),
      'P2003',
    )
  })

  it('an occurrence can never name another user’s transaction, even bypassing the service', async () => {
    const s = await setup()
    const other = await setup()
    const mine = await pendingOccurrence(s.userId)
    const theirs = await paidOccurrence(other)

    await expectPrismaCode(
      prisma.reminderOccurrence.update({
        where: { userId_id: { userId: s.userId, id: mine.id } },
        data: { transactionId: theirs.transactionId },
      }),
      'P2003',
    )
  })
})
