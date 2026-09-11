import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { formatInTimeZone } from 'date-fns-tz'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getAccountBalance } from '@/lib/server/services/balance'
// The view model's own definition of "overdue", imported so the service's
// `count` predicate is asserted against the very function the widget uses
// rather than against a copy of it.
import { toOccurrenceDto } from '@/lib/ui/reminder-view-model'
import {
  InvalidReminderAccountError,
  InvalidReminderCategoryError,
  OCCURRENCE_LOOKAHEAD_DAYS,
  acknowledgeOccurrence,
  countOverdueOccurrences,
  createReminder,
  dismissOccurrence,
  listDashboardOccurrences,
  listOccurrences,
  listReminders,
  listUpcomingOccurrences,
  localCarrierToInstant,
  materializeDueOccurrences,
  setReminderActive,
  toLocalCalendarCarrier,
  type OccurrenceRow,
  type ReminderRow,
} from './reminder'

/**
 * Group 6's data-layer acceptance check (spec §4.7).
 *
 * Eight properties are what this suite exists to hold:
 *
 * 1. **Nothing here moves money.** A reminder is not a Transaction (directive
 *    M): the fixture seeds an account and an EXPENSE transaction, and `afterEach`
 *    re-asserts the account / transaction / transfer counts, the two seeded rows
 *    field for field, and the account's derived balance — after *every* case, not
 *    just a dedicated one. Materializing, acknowledging and dismissing all run
 *    under that guard, so a stray write to any of them fails the test that made
 *    it.
 * 2. **Materialization is lazy, and it is a read.** No occurrence exists until
 *    something reads the upcoming list; `createReminder` writes one row and no
 *    occurrences at all.
 * 3. **It is idempotent — including under genuine concurrency.** Two sequential
 *    reads produce the same set, and three *simultaneous* reads
 *    (`Promise.all`) produce no duplicate `(reminderId, dueAt)` pair. That is the
 *    unique index plus `skipDuplicates` doing the work, not an application check,
 *    so a direct duplicate insert is refused with P2002 too.
 * 4. **An actioned occurrence never comes back.** Materialization only ever
 *    inserts, so an ACKNOWLEDGED or DISMISSED row is untouched by every later
 *    read; and acknowledging an already-dismissed row is a no-op rather than a
 *    flip between the two states.
 * 5. **An overdue ONE_TIME reminder still surfaces** (directive O). A one-off
 *    from 2020 read in 2026 yields exactly one PENDING occurrence, dated 2020,
 *    and a second read adds nothing. This is the case the one-interval backfill
 *    clamp would silently swallow, which is why ONE_TIME is never clamped.
 * 6. **"Due on the 1st" is the 1st where the user lives.** Every `dueAt` is the
 *    instant of *local* midnight: `America/New_York` day 1 reads `01 00:00` in
 *    that zone and is 05:00Z or 04:00Z depending on the season, and
 *    `Asia/Ho_Chi_Minh` day 1 is 17:00Z of the previous UTC day. `now` is
 *    injected everywhere, so none of this depends on the clock or on the host's
 *    own `TZ`.
 * 7. **Every query is tenant-scoped.** A second user's occurrence is targeted by
 *    each mutation, which must fail with P2025 and leave the row byte-identical;
 *    the composite FKs refuse a cross-user occurrence, category and account with
 *    P2003 even when the service is bypassed entirely.
 * 8. **No N+1.** Three active reminders cost one reminder `findMany`, one
 *    batched `createMany` for all of them, and one occurrence `findMany` —
 *    asserted with spies, and `batched materialization` pins the batch's rows
 *    against the per-reminder loop's output date by date.
 *
 * `fetch` is a throwing spy for every test and `afterEach` asserts it was never
 * called: a reminder keeps its own currency and nothing here converts one, so any
 * network access would be a bug rather than a slow test.
 */

/** UTC+7, no DST — the app's default zone, and the one whose local midnight is
 *  17:00Z of the *previous* UTC day, which is the shift a UTC-only
 *  implementation gets wrong. */
const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

/** UTC−5/−4, with a DST transition on 8 March 2026 — so a March and an April
 *  occurrence in this zone have different UTC offsets, and only a real
 *  zone-aware conversion gets both onto the 1st. */
const DST_TIMEZONE = 'America/New_York'

/**
 * The instant every case is read at, injected rather than read from the clock.
 * 17:00 on 15 March 2026 in `Asia/Ho_Chi_Minh`, 06:00 the same day in
 * `America/New_York` — so `nowLocal` is 2026-03-15 in both, and the backfill and
 * lookahead windows below are the same calendar days for both users.
 */
const NOW = new Date('2026-03-15T10:00:00Z')

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** `NOW` shifted by whole days, for the cases that need a second read at a later
 *  instant. */
const at = (days: number) => new Date(NOW.getTime() + days * MS_PER_DAY)

interface ReminderFixture {
  userId: string
  accountId: string
  archivedAccountId: string
  expenseCategoryId: string
  incomeCategoryId: string
  archivedCategoryId: string
  transactionId: string
}

/** The minimum a create needs — every case overrides what it cares about. */
const BASE_REMINDER = {
  title: 'Rent',
  type: 'EXPENSE' as const,
  expectedAmount: 5_000_000,
  currency: 'VND' as const,
  frequency: 'MONTHLY' as const,
  interval: 1,
  dayOfMonth: 1,
  startDate: '2026-01-01',
}

/**
 * A user with one active account, one archived account, an EXPENSE and an INCOME
 * category, one archived EXPENSE category, and one expense already recorded.
 *
 * The account and the transaction exist purely so "no money moves" has something
 * that *could* be corrupted: with an empty ledger, "counts unchanged" and
 * "balance unchanged" would both hold trivially.
 */
async function createReminderUser(timezone = TEST_TIMEZONE): Promise<ReminderFixture> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `reminder-${randomUUID()}@example.com`,
      name: 'Reminder Test',
      emailVerified: false,
      timezone,
    },
  })
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Wallet',
      accountTypeId: accountType.id,
      initialBalance: new Prisma.Decimal('5000000'),
      currency: 'VND',
    },
  })
  const archived = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Old wallet',
      accountTypeId: accountType.id,
      initialBalance: new Prisma.Decimal('0'),
      currency: 'VND',
      status: 'ARCHIVED',
    },
  })
  const expenseCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Housing', type: 'EXPENSE' },
  })
  const incomeCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Salary', type: 'INCOME' },
  })
  const archivedCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Old housing', type: 'EXPENSE', status: 'ARCHIVED' },
  })
  const date = new Date('2026-03-15T05:00:00.000Z')
  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      accountId: account.id,
      type: 'EXPENSE',
      amount: new Prisma.Decimal('250000'),
      currency: 'VND',
      date,
      vndPerUsdAtEntry: new Prisma.Decimal(25000),
      fxRateFetchedAt: date,
      fxRateEffectiveAt: new Date('2026-03-15T00:00:00.000Z'),
      fxRateSource: 'reminder-test',
    },
  })
  return {
    userId: user.id,
    accountId: account.id,
    archivedAccountId: archived.id,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
    archivedCategoryId: archivedCategory.id,
    transactionId: transaction.id,
  }
}

/** Deletes a user's rows in FK order, then the user. Reminders come before
 *  categories and accounts: the composite FKs are RESTRICT, so a category with a
 *  reminder still filed under it cannot be deleted. */
async function cleanupUsers(userIds: string[]) {
  if (userIds.length === 0) return
  try {
    await prisma.reminderOccurrence.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.recurringReminder.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

/** Counts, rows and derived balance — everything a reminder must not change. */
async function snapshotLedger(fx: ReminderFixture) {
  return {
    accounts: await prisma.financialAccount.count({ where: { userId: fx.userId } }),
    transactions: await prisma.transaction.count({ where: { userId: fx.userId } }),
    transfers: await prisma.transfer.count({ where: { userId: fx.userId } }),
    balance: (await getAccountBalance(fx.userId, fx.accountId)).toString(),
    account: await prisma.financialAccount.findUniqueOrThrow({
      where: { userId_id: { userId: fx.userId, id: fx.accountId } },
    }),
    transaction: await prisma.transaction.findUniqueOrThrow({
      where: { userId_id: { userId: fx.userId, id: fx.transactionId } },
    }),
  }
}

function isKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError
}

/** Runs `promise` and returns whatever it threw, or `undefined` if it resolved. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

async function expectPrismaCode(promise: Promise<unknown>, code: string) {
  const caught = await captureRejection(promise)
  expect(isKnownRequestError(caught)).toBe(true)
  expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe(code)
}

/** The calendar days a set of occurrences falls on, read in the user's own zone
 *  — the days the user would see, rather than the UTC ones. */
const localDays = (rows: OccurrenceRow[], timezone = TEST_TIMEZONE) =>
  rows.map((row) => formatInTimeZone(row.dueAt, timezone, 'yyyy-MM-dd'))

const utcInstants = (rows: OccurrenceRow[]) => rows.map((row) => row.dueAt.toISOString())

describe('OCCURRENCE_LOOKAHEAD_DAYS', () => {
  it('is the 30 days spec §4.7 specifies', () => {
    expect(OCCURRENCE_LOOKAHEAD_DAYS).toBe(30)
  })
})

describe('toLocalCalendarCarrier / localCarrierToInstant', () => {
  it('reads an instant as the calendar day it falls on in the given zone', () => {
    // 17:00 the same day in Ho Chi Minh, 06:00 the same day in New York.
    expect(toLocalCalendarCarrier(NOW, TEST_TIMEZONE).toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    )
    expect(toLocalCalendarCarrier(NOW, DST_TIMEZONE).toISOString()).toBe('2026-03-15T00:00:00.000Z')
    // 20:00 UTC on the 15th is already the 16th in Ho Chi Minh and still the
    // 15th in New York — the day boundary a UTC-only reading gets wrong.
    const evening = new Date('2026-03-15T20:00:00Z')
    expect(toLocalCalendarCarrier(evening, TEST_TIMEZONE).toISOString()).toBe(
      '2026-03-16T00:00:00.000Z',
    )
    expect(toLocalCalendarCarrier(evening, DST_TIMEZONE).toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    )
  })

  it('turns a calendar day into the instant of local midnight in the given zone', () => {
    const carrier = new Date('2026-03-01T00:00:00.000Z')

    // UTC+7 with no DST: local midnight is 17:00Z of the previous day.
    expect(localCarrierToInstant(carrier, TEST_TIMEZONE).toISOString()).toBe(
      '2026-02-28T17:00:00.000Z',
    )
    // EST in March before the 8th: 05:00Z the same day.
    expect(localCarrierToInstant(carrier, DST_TIMEZONE).toISOString()).toBe(
      '2026-03-01T05:00:00.000Z',
    )
    // EDT in April: 04:00Z. Same calendar day, one hour earlier in UTC — which
    // is why a fixed offset would be wrong for half the year.
    expect(
      localCarrierToInstant(new Date('2026-04-01T00:00:00.000Z'), DST_TIMEZONE).toISOString(),
    ).toBe('2026-04-01T04:00:00.000Z')
  })

  it('round-trips every day of a DST transition week in both zones', () => {
    for (const timezone of [TEST_TIMEZONE, DST_TIMEZONE]) {
      for (let day = 5; day <= 12; day += 1) {
        const carrier = new Date(`2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`)
        expect(
          toLocalCalendarCarrier(localCarrierToInstant(carrier, timezone), timezone).toISOString(),
        ).toBe(carrier.toISOString())
      }
    }
  })
})

describe('reminder service', () => {
  let fetchSpy: MockInstance
  let fx: ReminderFixture
  let ledger: Awaited<ReturnType<typeof snapshotLedger>>
  /** Extra users a single case created; cleaned up with the fixture. */
  let extraUserIds: string[]

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    extraUserIds = []
    fx = await createReminderUser()
    ledger = await snapshotLedger(fx)
    // 5,000,000 initial minus the fixture's 250,000 expense — a real,
    // non-trivial figure, so "unchanged" is a meaningful assertion.
    expect(ledger.balance).toBe('4750000')
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    try {
      // A reminder is not a Transaction, asserted after *every* case rather than
      // in one dedicated test: whichever mutation a case ran, the ledger it did
      // not ask about is still exactly as it was — counts, the two seeded rows
      // field for field, and the derived balance.
      expect(await snapshotLedger(fx)).toEqual(ledger)
    } finally {
      // In `finally`, so a ledger assertion that fails still leaves the database
      // clean for the next case rather than turning one real failure into a
      // cascade of unrelated ones.
      await cleanupUsers([fx.userId, ...extraUserIds])
    }
    // A reminder keeps its own currency and is never converted, so no code path
    // here has any reason to reach an FX provider.
    expect(fetchCalls).toBe(0)
  })

  function occurrenceCount(reminderId?: string): Promise<number> {
    return prisma.reminderOccurrence.count({
      where: { userId: fx.userId, ...(reminderId ? { reminderId } : {}) },
    })
  }

  function storedReminder(reminderId: string) {
    return prisma.recurringReminder.findUniqueOrThrow({
      where: { userId_id: { userId: fx.userId, id: reminderId } },
    })
  }

  function storedOccurrence(occurrenceId: string) {
    return prisma.reminderOccurrence.findUniqueOrThrow({
      where: { userId_id: { userId: fx.userId, id: occurrenceId } },
    })
  }

  /** A raw `RecurringReminder` insert, for the CHECK-constraint cases that
   *  bypass the service entirely. */
  function directReminderData(
    overrides: Partial<Prisma.RecurringReminderUncheckedCreateInput> = {},
  ) {
    return {
      userId: fx.userId,
      title: 'Direct',
      type: 'EXPENSE' as const,
      expectedAmount: new Prisma.Decimal('5000000'),
      currency: 'VND' as const,
      frequency: 'MONTHLY' as const,
      interval: 1,
      dayOfMonth: 1,
      // Local midnight on 1 January 2026 in the zone below — the pairing the
      // column means, spelled out rather than left to a default (ruling R6-22
      // removed the database default so a forgotten zone fails loudly).
      startDate: new Date('2025-12-31T17:00:00.000Z'),
      timezone: TEST_TIMEZONE,
      ...overrides,
    }
  }

  describe('createReminder', () => {
    it('creates an active reminder with every field, and no occurrences yet', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        categoryId: fx.expenseCategoryId,
        accountId: fx.accountId,
        note: 'Transfer to the landlord',
      })

      expect(reminder.title).toBe('Rent')
      expect(reminder.type).toBe('EXPENSE')
      expect(reminder.expectedAmount.toString()).toBe('5000000')
      expect(reminder.currency).toBe('VND')
      expect(reminder.categoryId).toBe(fx.expenseCategoryId)
      expect(reminder.accountId).toBe(fx.accountId)
      expect(reminder.frequency).toBe('MONTHLY')
      expect(reminder.interval).toBe(1)
      expect(reminder.dayOfMonth).toBe(1)
      expect(reminder.month).toBeNull()
      expect(reminder.note).toBe('Transfer to the landlord')
      expect(reminder.active).toBe(true)
      // The instant of LOCAL midnight on 1 January 2026 in UTC+7.
      expect(reminder.startDate.toISOString()).toBe('2025-12-31T17:00:00.000Z')
      // The joined names the UI and the dashboard widget render, so neither
      // needs a second query.
      expect(reminder.category?.name).toBe('Housing')
      expect(reminder.account?.name).toBe('Wallet')
      // Lazy: creating a reminder writes one row and materializes nothing.
      expect(await occurrenceCount()).toBe(0)
    })

    it('creates a reminder with no category and no account', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)

      expect(reminder.categoryId).toBeNull()
      expect(reminder.accountId).toBeNull()
      expect(reminder.category).toBeNull()
      expect(reminder.account).toBeNull()
      expect(reminder.note).toBeNull()
    })

    it('stores the start date as local midnight in the user’s own zone', async () => {
      const [hcm, ny] = await Promise.all([
        createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER),
        createReminder(fx.userId, DST_TIMEZONE, { ...BASE_REMINDER, title: 'Rent NY' }),
      ])

      expect(hcm.startDate.toISOString()).toBe('2025-12-31T17:00:00.000Z')
      expect(ny.startDate.toISOString()).toBe('2026-01-01T05:00:00.000Z')
      // Both read back as the day the user picked, in their own zone.
      expect(formatInTimeZone(hcm.startDate, TEST_TIMEZONE, 'yyyy-MM-dd')).toBe('2026-01-01')
      expect(formatInTimeZone(ny.startDate, DST_TIMEZONE, 'yyyy-MM-dd')).toBe('2026-01-01')
    })

    it('defaults dayOfMonth from the local start day for MONTHLY', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        dayOfMonth: undefined,
        startDate: '2026-01-20',
      })

      expect(reminder.dayOfMonth).toBe(20)
      expect(reminder.month).toBeNull()
    })

    it('defaults both month and dayOfMonth from the local start day for YEARLY', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'YEARLY',
        dayOfMonth: undefined,
        startDate: '2026-12-25',
      })

      // 12, not 11: the column is the human month number, not JavaScript's
      // 0-based index — an off-by-one here would shift the reminder to November.
      expect(reminder.month).toBe(12)
      expect(reminder.dayOfMonth).toBe(25)
    })

    it('keeps an explicit month and dayOfMonth for YEARLY', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'YEARLY',
        month: 4,
        dayOfMonth: 15,
        startDate: '2026-01-01',
      })

      expect(reminder.month).toBe(4)
      expect(reminder.dayOfMonth).toBe(15)
    })

    it.each(['WEEKLY', 'ONE_TIME'] as const)(
      'stores no anchors at all for %s',
      async (frequency) => {
        const reminder = await createReminder(fx.userId, TEST_TIMEZONE, {
          ...BASE_REMINDER,
          frequency,
          dayOfMonth: undefined,
          startDate: '2026-01-05',
        })

        expect(reminder.dayOfMonth).toBeNull()
        expect(reminder.month).toBeNull()
      },
    )

    it('rejects the input Zod refuses before touching the database', async () => {
      await expect(
        createReminder(fx.userId, TEST_TIMEZONE, { ...BASE_REMINDER, title: '   ' }),
      ).rejects.toThrow()
      await expect(
        createReminder(fx.userId, TEST_TIMEZONE, {
          ...BASE_REMINDER,
          frequency: 'WEEKLY',
          dayOfMonth: 15,
        }),
      ).rejects.toThrow()

      expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
    })

    describe('category and account validation', () => {
      it('refuses another user’s category without revealing that it exists', async () => {
        const other = await createReminderUser()
        extraUserIds.push(other.userId)

        const caught = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, {
            ...BASE_REMINDER,
            categoryId: other.expenseCategoryId,
          }),
        )

        expect(caught).toBeInstanceOf(InvalidReminderCategoryError)
        expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
      })

      it('refuses a category id that does not exist, with the same error class', async () => {
        // The same class as a foreign id on purpose: "no such category" and "not
        // your category" must be indistinguishable, or the error itself is an
        // existence oracle.
        const caught = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, {
            ...BASE_REMINDER,
            categoryId: 'does-not-exist',
          }),
        )

        expect(caught).toBeInstanceOf(InvalidReminderCategoryError)
        expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
      })

      it('refuses an INCOME category on an EXPENSE reminder and vice versa', async () => {
        const onExpense = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, {
            ...BASE_REMINDER,
            type: 'EXPENSE',
            categoryId: fx.incomeCategoryId,
          }),
        )
        const onIncome = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, {
            ...BASE_REMINDER,
            type: 'INCOME',
            categoryId: fx.expenseCategoryId,
          }),
        )

        expect(onExpense).toBeInstanceOf(InvalidReminderCategoryError)
        expect(onIncome).toBeInstanceOf(InvalidReminderCategoryError)
        expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
      })

      it('accepts a matching category for each type', async () => {
        const expense = await createReminder(fx.userId, TEST_TIMEZONE, {
          ...BASE_REMINDER,
          type: 'EXPENSE',
          categoryId: fx.expenseCategoryId,
        })
        const income = await createReminder(fx.userId, TEST_TIMEZONE, {
          ...BASE_REMINDER,
          title: 'Salary',
          type: 'INCOME',
          categoryId: fx.incomeCategoryId,
        })

        expect(expense.category?.name).toBe('Housing')
        expect(income.category?.name).toBe('Salary')
      })

      it('refuses an archived category', async () => {
        // Ruling R6-17, and the same rule `transaction.ts` and `budget.ts`
        // apply: a *new* record may not be filed under a category the user has
        // retired, even though an existing one survives its category being
        // archived.
        const caught = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, {
            ...BASE_REMINDER,
            categoryId: fx.archivedCategoryId,
          }),
        )

        expect(caught).toBeInstanceOf(InvalidReminderCategoryError)
        expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
      })

      it('refuses an archived account', async () => {
        const caught = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, {
            ...BASE_REMINDER,
            accountId: fx.archivedAccountId,
          }),
        )

        expect(caught).toBeInstanceOf(InvalidReminderAccountError)
        expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
      })

      it('refuses another user’s account, and a nonexistent one, with the same class', async () => {
        const other = await createReminderUser()
        extraUserIds.push(other.userId)

        const foreign = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, {
            ...BASE_REMINDER,
            accountId: other.accountId,
          }),
        )
        const missing = await captureRejection(
          createReminder(fx.userId, TEST_TIMEZONE, { ...BASE_REMINDER, accountId: 'nope' }),
        )

        expect(foreign).toBeInstanceOf(InvalidReminderAccountError)
        expect(missing).toBeInstanceOf(InvalidReminderAccountError)
        expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
      })
    })

    it('refuses a cross-user category reference even bypassing the service', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)

      // The composite (userId, categoryId) foreign key, not application code.
      await expectPrismaCode(
        prisma.recurringReminder.create({
          data: directReminderData({ categoryId: other.expenseCategoryId }),
        }),
        'P2003',
      )
      await expectPrismaCode(
        prisma.recurringReminder.create({
          data: directReminderData({ accountId: other.accountId }),
        }),
        'P2003',
      )
      expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
    })
  })

  describe('listReminders', () => {
    it('lists active reminders first, then oldest first', async () => {
      const first = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'First',
      })
      const second = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Second',
      })
      const third = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Third',
      })
      await setReminderActive(fx.userId, first.id, false)

      expect((await listReminders(fx.userId)).map((row) => row.title)).toEqual([
        'Second',
        'Third',
        'First',
      ])
      expect((await listReminders(fx.userId)).map((row) => row.id)).toEqual([
        second.id,
        third.id,
        first.id,
      ])
    })

    it('carries the joined category and account names', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        categoryId: fx.expenseCategoryId,
        accountId: fx.accountId,
      })

      const [row] = await listReminders(fx.userId)

      expect(row.category?.name).toBe('Housing')
      expect(row.account?.name).toBe('Wallet')
    })

    it('returns nothing for a user with no reminders', async () => {
      expect(await listReminders(fx.userId)).toEqual([])
    })

    it('never returns another user’s reminders', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)
      await createReminder(other.userId, TEST_TIMEZONE, { ...BASE_REMINDER, title: 'Theirs' })

      expect(await listReminders(fx.userId)).toEqual([])
    })
  })

  describe('setReminderActive', () => {
    it('pauses and resumes a reminder', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)

      expect((await setReminderActive(fx.userId, reminder.id, false)).active).toBe(false)
      expect((await storedReminder(reminder.id)).active).toBe(false)
      expect((await setReminderActive(fx.userId, reminder.id, true)).active).toBe(true)
      expect((await storedReminder(reminder.id)).active).toBe(true)
    })

    it('raises P2025 for another user’s reminder and leaves it untouched', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)
      const theirs = await createReminder(other.userId, TEST_TIMEZONE, BASE_REMINDER)

      await expectPrismaCode(setReminderActive(fx.userId, theirs.id, false), 'P2025')

      expect(
        (
          await prisma.recurringReminder.findUniqueOrThrow({
            where: { userId_id: { userId: other.userId, id: theirs.id } },
          })
        ).active,
      ).toBe(true)
    })
  })

  describe('materialization', () => {
    it('creates exactly one occurrence for a ONE_TIME reminder due in 10 days', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Annual fee',
        frequency: 'ONE_TIME',
        dayOfMonth: undefined,
        startDate: '2026-03-25',
      })

      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(localDays(rows)).toEqual(['2026-03-25'])
      // Local midnight in UTC+7 — 17:00Z of the previous UTC day.
      expect(utcInstants(rows)).toEqual(['2026-03-24T17:00:00.000Z'])
      expect(rows[0].reminderId).toBe(reminder.id)
      expect(rows[0].status).toBe('PENDING')
      expect(rows[0].actionedAt).toBeNull()
    })

    it('holds back a ONE_TIME reminder beyond the lookahead until the window reaches it', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'ONE_TIME',
        dayOfMonth: undefined,
        startDate: '2026-04-29',
      })

      expect(await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toEqual([])
      expect(await occurrenceCount()).toBe(0)

      const later = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, at(20))

      expect(localDays(later)).toEqual(['2026-04-29'])
    })

    it('still surfaces a ONE_TIME reminder six years overdue, exactly once', async () => {
      // Directive O, and the regression this whole design turns on: the
      // one-interval backfill clamp must not apply to ONE_TIME, or the one-off
      // payment the user is *already late for* is the single thing the app never
      // shows them.
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Passport renewal',
        frequency: 'ONE_TIME',
        dayOfMonth: undefined,
        startDate: '2020-01-01',
      })

      const first = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(localDays(first)).toEqual(['2020-01-01'])
      expect(utcInstants(first)).toEqual(['2019-12-31T17:00:00.000Z'])

      // A second read adds nothing: the same date, the same row.
      const second = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id))
      expect(await occurrenceCount()).toBe(1)
    })

    it('materializes every Monday in the backfill and lookahead window for WEEKLY interval 1', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Weekly savings',
        frequency: 'WEEKLY',
        dayOfMonth: undefined,
        startDate: '2026-01-05',
      })

      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      // `nowLocal` is 2026-03-15, so the window is [2026-03-08, 2026-04-14]:
      // one week back (the Monday the user may genuinely have missed) plus 30
      // days ahead. Every Monday in it, and nothing from January or February.
      expect(localDays(rows)).toEqual([
        '2026-03-09',
        '2026-03-16',
        '2026-03-23',
        '2026-03-30',
        '2026-04-06',
        '2026-04-13',
      ])
    })

    it('materializes a fortnightly reminder on its own phase', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'WEEKLY',
        interval: 2,
        dayOfMonth: undefined,
        startDate: '2026-01-05',
      })

      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      // Two weeks back for a fortnightly rule: [2026-03-01, 2026-04-14].
      expect(localDays(rows)).toEqual(['2026-03-02', '2026-03-16', '2026-03-30', '2026-04-13'])
    })

    it('clamps a MONTHLY dayOfMonth of 31 to February’s length', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Card payment',
        dayOfMonth: 31,
        startDate: '2026-01-31',
      })

      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      // One month back from 2026-03-15 is 2026-02-15, so January's occurrence is
      // outside the window; February's is the 28th (2026 is not a leap year) and
      // March's is the 31st — the anchor does not decay to the 28th.
      expect(localDays(rows)).toEqual(['2026-02-28', '2026-03-31'])
    })

    it('uses the start day as the anchor when MONTHLY has no explicit dayOfMonth', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        dayOfMonth: undefined,
        startDate: '2026-01-20',
      })

      expect(localDays(await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW))).toEqual([
        '2026-02-20',
        '2026-03-20',
      ])
    })

    it('materializes a YEARLY reminder anchored on 25 December when read on 1 December', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Insurance',
        frequency: 'YEARLY',
        dayOfMonth: undefined,
        startDate: '2026-12-25',
      })

      const rows = await listUpcomingOccurrences(
        fx.userId,
        TEST_TIMEZONE,
        new Date('2026-12-01T10:00:00Z'),
      )

      expect(localDays(rows)).toEqual(['2026-12-25'])
    })

    it('backfills one whole year for a YEARLY reminder that started earlier', async () => {
      // The one-interval backfill is an interval of the *rule*, so a yearly
      // reminder surfaces last year's occurrence too — the annual bill the user
      // may never have acknowledged (spec §4.7).
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'YEARLY',
        dayOfMonth: undefined,
        startDate: '2020-12-25',
      })

      const rows = await listUpcomingOccurrences(
        fx.userId,
        TEST_TIMEZONE,
        new Date('2026-12-01T10:00:00Z'),
      )

      expect(localDays(rows)).toEqual(['2025-12-25', '2026-12-25'])
    })

    it('clamps a 29 February YEARLY anchor to 28 February in a non-leap year', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Leap-day bill',
        frequency: 'YEARLY',
        dayOfMonth: undefined,
        startDate: '2028-02-29',
      })

      const rows = await listUpcomingOccurrences(
        fx.userId,
        TEST_TIMEZONE,
        new Date('2029-02-15T10:00:00Z'),
      )

      expect(localDays(rows)).toEqual(['2028-02-29', '2029-02-28'])
      expect((await storedReminder((await listReminders(fx.userId))[0].id)).dayOfMonth).toBe(29)
    })

    it('materializes nothing for an inactive reminder, and everything once resumed', async () => {
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      await setReminderActive(fx.userId, reminder.id, false)

      expect(await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toEqual([])
      expect(await occurrenceCount()).toBe(0)

      await setReminderActive(fx.userId, reminder.id, true)

      expect(localDays(await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW))).toEqual([
        '2026-03-01',
        '2026-04-01',
      ])
    })

    it('keeps occurrences a paused reminder already had', async () => {
      // Pausing stops *new* occurrences and nothing else: the ones already
      // materialized really were due, and hiding them would lose a bill the user
      // still has to deal with.
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      const before = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      expect(before).toHaveLength(2)

      await setReminderActive(fx.userId, reminder.id, false)

      expect(await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toHaveLength(2)
      expect(await occurrenceCount()).toBe(2)
    })

    it('reports how many rows it created, and zero on a repeat', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)

      expect(await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(2)
      expect(await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(0)
      expect(await occurrenceCount()).toBe(2)
    })

    it('does nothing at all for a user with no reminders', async () => {
      expect(await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(0)
      expect(await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toEqual([])
    })

    it('never materializes into another user’s account', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)
      await createReminder(other.userId, TEST_TIMEZONE, BASE_REMINDER)

      expect(await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(0)
      expect(await prisma.reminderOccurrence.count({ where: { userId: other.userId } })).toBe(0)
    })
  })

  describe('timezone', () => {
    it('puts every dueAt on day 1 at local midnight in America/New_York, across a DST change', async () => {
      const reminder = await createReminder(fx.userId, DST_TIMEZONE, {
        ...BASE_REMINDER,
        dayOfMonth: 1,
        startDate: '2026-01-01',
      })

      const rows = await listUpcomingOccurrences(fx.userId, DST_TIMEZONE, NOW)

      expect(rows.every((row) => row.reminderId === reminder.id)).toBe(true)
      // The property that matters to the user: whatever the offset, it is the
      // 1st at midnight where they live. A UTC-only implementation would put
      // these on the last day of the previous month.
      expect(rows.map((row) => formatInTimeZone(row.dueAt, DST_TIMEZONE, 'dd HH:mm'))).toEqual([
        '01 00:00',
        '01 00:00',
      ])
      // And the two instants differ by an hour, because 1 March is EST and
      // 1 April is EDT — which is exactly what a fixed offset would get wrong.
      expect(utcInstants(rows)).toEqual(['2026-03-01T05:00:00.000Z', '2026-04-01T04:00:00.000Z'])
      expect(localDays(rows, DST_TIMEZONE)).toEqual(['2026-03-01', '2026-04-01'])
    })

    it('puts day 1 in Asia/Ho_Chi_Minh at 17:00Z of the previous UTC day', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        dayOfMonth: 1,
        startDate: '2026-01-01',
      })

      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(utcInstants(rows)).toEqual(['2026-02-28T17:00:00.000Z', '2026-03-31T17:00:00.000Z'])
      // The UTC day is the 28th and the 31st; the *local* day — the only one the
      // user ever sees — is the 1st.
      expect(rows.map((row) => row.dueAt.getUTCDate())).toEqual([28, 31])
      expect(rows.map((row) => formatInTimeZone(row.dueAt, TEST_TIMEZONE, 'dd HH:mm'))).toEqual([
        '01 00:00',
        '01 00:00',
      ])
    })

    it('never re-phases or duplicates an existing series when the profile zone changes', async () => {
      // Ruling R6-22, and the reason `RecurringReminder.timezone` exists.
      //
      // `User.timezone` is editable. Re-deriving each reminder's local start day
      // from its stored instant in whatever zone the *request* carries would
      // shift the whole series — a Ho Chi Minh City reminder's
      // `2025-12-31T17:00Z` reads as 31 December in New York — and would write
      // every `dueAt` at a different instant. Different instants are different
      // rows: `@@unique([reminderId, dueAt])` cannot dedupe them, so the user
      // would get a second PENDING occurrence for every bill they already had.
      const monthly = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        dayOfMonth: 1,
        startDate: '2026-01-01',
      })
      const weekly = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Weekly savings',
        frequency: 'WEEKLY',
        dayOfMonth: undefined,
        startDate: '2026-01-05',
      })

      const before = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      // Two monthly firsts plus every Monday in the window — a real series, so
      // "unchanged" is a meaningful assertion.
      expect(before).toHaveLength(8)
      const countBefore = await occurrenceCount()

      // The user moves to New York and their profile follows.
      await prisma.user.update({ where: { id: fx.userId }, data: { timezone: DST_TIMEZONE } })

      const after = await listUpcomingOccurrences(fx.userId, DST_TIMEZONE, NOW)

      // Not one new row, not one moved instant, and the same rows in the same
      // order — the schedule belongs to the reminder, not to the request.
      expect(await occurrenceCount()).toBe(countBefore)
      expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id))
      expect(utcInstants(after)).toEqual(utcInstants(before))
      // Still anchored to Ho Chi Minh City's local midnight, 17:00Z of the
      // previous UTC day, every one of them.
      expect(after.every((row) => row.dueAt.toISOString().endsWith('T17:00:00.000Z'))).toBe(true)
      // And each series still falls on the days the user chose, read in the zone
      // they chose them in: the 1st, and Mondays.
      expect(localDays(after.filter((row) => row.reminderId === monthly.id))).toEqual([
        '2026-03-01',
        '2026-04-01',
      ])
      expect(localDays(after.filter((row) => row.reminderId === weekly.id))).toEqual([
        '2026-03-09',
        '2026-03-16',
        '2026-03-23',
        '2026-03-30',
        '2026-04-06',
        '2026-04-13',
      ])
    })

    it('anchors a reminder created after the switch to the new zone, beside the old series', async () => {
      // The other half of R6-22: pinning the old series must not freeze the new
      // one. Two reminders with the same start date and the same anchor day,
      // created either side of a profile change, keep two different anchors —
      // and both are local midnight on the 1st where they were created.
      const hcm = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        dayOfMonth: 1,
        startDate: '2026-01-01',
      })

      await prisma.user.update({ where: { id: fx.userId }, data: { timezone: DST_TIMEZONE } })

      const ny = await createReminder(fx.userId, DST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Rent NY',
        dayOfMonth: 1,
        startDate: '2026-01-01',
      })

      // The zone is recorded on the row, so nothing later has to guess it.
      expect((await storedReminder(hcm.id)).timezone).toBe(TEST_TIMEZONE)
      expect((await storedReminder(ny.id)).timezone).toBe(DST_TIMEZONE)

      const rows = await listUpcomingOccurrences(fx.userId, DST_TIMEZONE, NOW)
      const instantsFor = (reminderId: string) =>
        utcInstants(rows.filter((row) => row.reminderId === reminderId))

      expect(instantsFor(hcm.id)).toEqual(['2026-02-28T17:00:00.000Z', '2026-03-31T17:00:00.000Z'])
      // EST in March, EDT in April — 05:00Z then 04:00Z, both midnight on the
      // 1st in New York.
      expect(instantsFor(ny.id)).toEqual(['2026-03-01T05:00:00.000Z', '2026-04-01T04:00:00.000Z'])
    })
  })

  describe('idempotency', () => {
    it('is lazy: nothing exists until the first read', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)

      expect(await occurrenceCount()).toBe(0)

      await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(await occurrenceCount()).toBe(2)
    })

    it('produces the same set on two sequential reads', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'WEEKLY',
        dayOfMonth: undefined,
        startDate: '2026-01-05',
      })

      const first = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      const second = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id))
      expect(await occurrenceCount()).toBe(first.length)
    })

    it('produces no duplicates under three simultaneous reads', async () => {
      // The real concurrency proof, against the real database: without the
      // unique index and `skipDuplicates` all three of these would insert the
      // same six dates and the user would see every occurrence three times.
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'WEEKLY',
        dayOfMonth: undefined,
        startDate: '2026-01-05',
      })

      const [a, b, c] = await Promise.all([
        listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW),
        listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW),
        listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW),
      ])

      const rows = await prisma.reminderOccurrence.findMany({ where: { userId: fx.userId } })
      const keys = new Set(rows.map((row) => `${row.reminderId}|${row.dueAt.toISOString()}`))

      expect(keys.size).toBe(rows.length)
      expect(rows).toHaveLength(6)
      // Every reader ends up seeing the same six, whichever of them won the
      // insert race.
      for (const result of [a, b, c]) {
        expect(localDays(result)).toEqual([
          '2026-03-09',
          '2026-03-16',
          '2026-03-23',
          '2026-03-30',
          '2026-04-06',
          '2026-04-13',
        ])
      }
    })

    it('refuses a duplicate (reminderId, dueAt) even bypassing the service', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      const [existing] = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      const caught = await captureRejection(
        prisma.reminderOccurrence.create({
          data: { userId: fx.userId, reminderId: existing.reminderId, dueAt: existing.dueAt },
        }),
      )

      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')
      expect(await occurrenceCount()).toBe(2)
    })
  })

  describe('acknowledge and dismiss', () => {
    async function firstOccurrence(): Promise<OccurrenceRow> {
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      const [row] = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      return row
    }

    it('acknowledges a pending occurrence, stamping actionedAt with the injected now', async () => {
      const occurrence = await firstOccurrence()

      const actioned = await acknowledgeOccurrence(fx.userId, occurrence.id, NOW)

      expect(actioned.status).toBe('ACKNOWLEDGED')
      expect(actioned.actionedAt?.toISOString()).toBe(NOW.toISOString())
      // The joined reminder travels with it, so the UI can render the row it
      // just changed without a second query.
      expect(actioned.reminder.title).toBe('Rent')
    })

    it('dismisses a pending occurrence the same way', async () => {
      const occurrence = await firstOccurrence()

      const actioned = await dismissOccurrence(fx.userId, occurrence.id, NOW)

      expect(actioned.status).toBe('DISMISSED')
      expect(actioned.actionedAt?.toISOString()).toBe(NOW.toISOString())
    })

    it.each([
      ['acknowledged', acknowledgeOccurrence, 'ACKNOWLEDGED'],
      ['dismissed', dismissOccurrence, 'DISMISSED'],
    ] as const)(
      'excludes an %s occurrence from upcoming, and never resurrects it',
      async (_label, action, status) => {
        const occurrence = await firstOccurrence()
        await action(fx.userId, occurrence.id, NOW)

        const upcoming = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

        expect(upcoming.map((row) => row.id)).not.toContain(occurrence.id)
        // Read again, at a later instant, so materialization definitely runs
        // again: the actioned row is still actioned and no replacement appears.
        await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, at(1))

        const stored = await storedOccurrence(occurrence.id)
        expect(stored.status).toBe(status)
        expect(stored.actionedAt?.toISOString()).toBe(NOW.toISOString())
        expect(await occurrenceCount()).toBe(2)
      },
    )

    it('never flips a dismissed occurrence to acknowledged, or the reverse', async () => {
      const occurrence = await firstOccurrence()
      await dismissOccurrence(fx.userId, occurrence.id, NOW)
      const afterDismiss = await storedOccurrence(occurrence.id)

      // Idempotent, and deliberately not an error: a double-clicked button or a
      // stale tab is the same request as the one that succeeded. But it must not
      // *change* the answer the user already gave.
      const again = await acknowledgeOccurrence(fx.userId, occurrence.id, at(1))

      expect(again.status).toBe('DISMISSED')
      expect(again.actionedAt?.toISOString()).toBe(NOW.toISOString())
      // Byte for byte the row the dismiss left behind: no write happened at all,
      // so `actionedAt` still says when the user actually decided.
      expect(await storedOccurrence(occurrence.id)).toEqual(afterDismiss)
    })

    it('is a true no-op on an already-acknowledged occurrence', async () => {
      const occurrence = await firstOccurrence()
      await acknowledgeOccurrence(fx.userId, occurrence.id, NOW)
      const before = await storedOccurrence(occurrence.id)

      const again = await acknowledgeOccurrence(fx.userId, occurrence.id, at(1))
      const dismissAttempt = await dismissOccurrence(fx.userId, occurrence.id, at(2))

      expect(again.status).toBe('ACKNOWLEDGED')
      expect(dismissAttempt.status).toBe('ACKNOWLEDGED')
      expect(await storedOccurrence(occurrence.id)).toEqual(before)
    })

    it('raises P2025 for another user’s occurrence and leaves it untouched', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)
      await createReminder(other.userId, TEST_TIMEZONE, BASE_REMINDER)
      const [theirs] = await listUpcomingOccurrences(other.userId, TEST_TIMEZONE, NOW)

      await expectPrismaCode(acknowledgeOccurrence(fx.userId, theirs.id, NOW), 'P2025')
      await expectPrismaCode(dismissOccurrence(fx.userId, theirs.id, NOW), 'P2025')

      const stored = await prisma.reminderOccurrence.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
      })
      expect(stored.status).toBe('PENDING')
      expect(stored.actionedAt).toBeNull()
    })

    it('refuses a cross-user occurrence even bypassing the service', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)
      const mine = await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)

      // The composite (userId, reminderId) foreign key: user B cannot file an
      // occurrence against user A's reminder however they ask.
      await expectPrismaCode(
        prisma.reminderOccurrence.create({
          data: { userId: other.userId, reminderId: mine.id, dueAt: NOW },
        }),
        'P2003',
      )
      expect(await prisma.reminderOccurrence.count({ where: { userId: other.userId } })).toBe(0)
    })
  })

  describe('listOccurrences', () => {
    it('is a history view: it materializes nothing', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      const createMany = vi.spyOn(prisma.reminderOccurrence, 'createMany')

      expect(await listOccurrences(fx.userId)).toEqual([])

      expect(createMany).not.toHaveBeenCalled()
      expect(await occurrenceCount()).toBe(0)
    })

    it('returns every status, newest due first, with the joined reminder', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        categoryId: fx.expenseCategoryId,
        accountId: fx.accountId,
      })
      const upcoming = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      await acknowledgeOccurrence(fx.userId, upcoming[0].id, NOW)

      const history = await listOccurrences(fx.userId)

      expect(localDays(history)).toEqual(['2026-04-01', '2026-03-01'])
      expect(history.map((row) => row.status)).toEqual(['PENDING', 'ACKNOWLEDGED'])
      expect(history[0].reminder.category?.name).toBe('Housing')
      expect(history[0].reminder.account?.name).toBe('Wallet')
    })

    it('filters by status and honours a limit', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      const upcoming = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      await dismissOccurrence(fx.userId, upcoming[0].id, NOW)

      expect((await listOccurrences(fx.userId, { status: 'DISMISSED' })).map((r) => r.id)).toEqual([
        upcoming[0].id,
      ])
      expect(await listOccurrences(fx.userId, { status: 'ACKNOWLEDGED' })).toEqual([])
      expect(await listOccurrences(fx.userId, { limit: 1 })).toHaveLength(1)
    })

    it('never returns another user’s occurrences', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)
      await createReminder(other.userId, TEST_TIMEZONE, BASE_REMINDER)
      await listUpcomingOccurrences(other.userId, TEST_TIMEZONE, NOW)

      expect(await listOccurrences(fx.userId)).toEqual([])
    })
  })

  /**
   * The two reads of the same PENDING set (Phase 8, Task 4 — pre-flight
   * finding B-6).
   *
   * `listUpcomingOccurrences` is the **Reminders page's** read and stays
   * complete: that page groups rather than truncates, and states the true size
   * of the overdue group above it (`reminders.overdueCount`), so a cap there
   * would be the app quietly forgetting bills on the user's behalf.
   *
   * `listDashboardOccurrences` is the **widget's** read and is bounded: five
   * rows, at most two of them overdue. Because `dueAt asc` puts the whole
   * overdue backlog at the head of the list, one `take` over that order cannot
   * express the widget — a user a year behind on one weekly reminder has ~52
   * overdue rows, so `take: 7` would return seven overdue rows and *no*
   * upcoming ones, and the widget would render two rows instead of five while
   * reporting "7 overdue" instead of 52. The bound is therefore one `take` per
   * half over the same order, plus a `count` for the tally — three constant
   * queries in place of one unbounded one.
   *
   * These cases build that user honestly (a year of weekly reads, each
   * materializing its own window) and pin both contracts against each other:
   * the bounded rows must be exactly the head of each half of the complete
   * list, and the tally must be the complete overdue count.
   */
  describe('the two occurrence reads', () => {
    /** The widget's caps, as `lib/ui/dashboard-view-model.ts` defines them. The
     *  page passes the exported constant; a test may state the numbers. */
    const LIMITS = { overdue: 2, upcoming: 5 }

    /** A user who has ignored one weekly reminder for a year: 52 rows already
     *  overdue and five still to come, accumulated the way a year of dashboard
     *  views would have accumulated them. */
    async function seedAYearOfIgnoredReads() {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Weekly savings',
        frequency: 'WEEKLY',
        dayOfMonth: undefined,
        startDate: '2025-01-06',
      })
      // Each read materializes its own [one week back, 30 days ahead] window,
      // and the 30-day step keeps them contiguous.
      for (let day = -360; day <= 0; day += 30) {
        await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, at(day))
      }
    }

    /** The instant the viewer's calendar day begins — the boundary both the
     *  service's `count` and the view model's `overdue` flag decide on. */
    const dayStart = (timezone: string, now = NOW) =>
      localCarrierToInstant(toLocalCalendarCarrier(now, timezone), timezone)

    it('leaves the Reminders page’s read complete, however large the backlog', async () => {
      await seedAYearOfIgnoredReads()

      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      // Nothing is dropped: the page's own list is the complete PENDING set.
      expect(rows).toHaveLength(await occurrenceCount())
      expect(rows.length).toBeGreaterThan(50)
      // Ascending, so the backlog is at the head and the upcoming rows behind
      // it — the order both pages' partitions depend on.
      expect(utcInstants(rows)).toEqual([...utcInstants(rows)].sort())
      expect(rows.every((row) => row.status === 'PENDING')).toBe(true)
      // The oldest unanswered bill is still in the list a year later, which is
      // the whole reason this read is not clamped to the lookahead window.
      expect(localDays(rows)[0]).toBe('2025-03-17')
    })

    it('gives the dashboard the widget’s own rows and the complete tally', async () => {
      await seedAYearOfIgnoredReads()
      // The complete list the widget used to be built from, partitioned exactly
      // as `buildDashboardViewModel` partitions it.
      const complete = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      const boundary = dayStart(TEST_TIMEZONE)
      const overdue = complete.filter((row) => row.dueAt < boundary)
      const upcoming = complete.filter((row) => row.dueAt >= boundary)
      expect(overdue.length).toBeGreaterThan(50)
      expect(upcoming.length).toBeGreaterThanOrEqual(LIMITS.upcoming)

      const read = await listDashboardOccurrences(fx.userId, TEST_TIMEZONE, LIMITS, NOW)

      // The head of each half, in one ascending list — the same rows, in the
      // same order, that the widget selected out of the complete list.
      expect(read.rows.map((row) => row.id)).toEqual([
        ...overdue.slice(0, LIMITS.overdue).map((row) => row.id),
        ...upcoming.slice(0, LIMITS.upcoming).map((row) => row.id),
      ])
      expect(utcInstants(read.rows)).toEqual([...utcInstants(read.rows)].sort())
      expect(read.rows.length).toBeLessThanOrEqual(LIMITS.overdue + LIMITS.upcoming)
      // And the tally is the whole backlog, not the two rows on show.
      expect(read.overdueCount).toBe(overdue.length)
    })

    it('fetches at most cap + max rows, with a take on each half', async () => {
      await seedAYearOfIgnoredReads()
      const findMany = vi.spyOn(prisma.reminderOccurrence, 'findMany')
      const count = vi.spyOn(prisma.reminderOccurrence, 'count')

      const read = await listDashboardOccurrences(fx.userId, TEST_TIMEZONE, LIMITS, NOW)

      // Two bounded reads and one count, whatever the size of the backlog —
      // the whole of finding B-6.
      expect(findMany).toHaveBeenCalledTimes(2)
      expect(findMany.mock.calls.map((call) => call[0]?.take)).toEqual([
        LIMITS.overdue,
        LIMITS.upcoming,
      ])
      expect(count).toHaveBeenCalledTimes(1)
      expect(read.rows).toHaveLength(LIMITS.overdue + LIMITS.upcoming)
    })

    it('materializes first, so a first-ever view counts the rows it just created', async () => {
      // The one ordering that matters: the tally is a `count`, and counting
      // before the insert would report zero on the very first dashboard view.
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Late rent',
        dayOfMonth: 1,
        startDate: '2026-01-01',
      })

      const read = await listDashboardOccurrences(fx.userId, TEST_TIMEZONE, LIMITS, NOW)

      // 1 March is behind 15 March, 1 April ahead of it.
      expect(localDays(read.rows)).toEqual(['2026-03-01', '2026-04-01'])
      expect(read.overdueCount).toBe(1)
    })

    it('counts exactly the rows the widget calls overdue, in either viewer zone', async () => {
      await seedAYearOfIgnoredReads()
      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      for (const timezone of [TEST_TIMEZONE, DST_TIMEZONE]) {
        // The view model's own definition of late: two calendar days in the
        // viewer's zone, compared as strings (`lib/ui/reminder-view-model.ts`).
        const today = todayCalendarDateInZone(timezone, NOW)
        const fromTheWidget = rows.filter(
          (row) => toOccurrenceDto(row, timezone, today).overdue,
        ).length

        expect(await countOverdueOccurrences(fx.userId, timezone, NOW)).toBe(fromTheWidget)
      }
    })

    it('treats an occurrence due today as not overdue, at the local-midnight boundary', async () => {
      // Local midnight of the user's today is 17:00Z the previous day in UTC+7,
      // which is exactly the instant a UTC-only comparison gets wrong: it reads
      // as "yesterday" in UTC and would count today's bill as late.
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Due today',
        frequency: 'ONE_TIME',
        dayOfMonth: undefined,
        startDate: '2026-03-15',
      })
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Due yesterday',
        frequency: 'ONE_TIME',
        dayOfMonth: undefined,
        startDate: '2026-03-14',
      })
      await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      // The user has the whole of today to pay today's bill.
      expect(await countOverdueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(1)
      expect(utcInstants(await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW))).toEqual([
        '2026-03-13T17:00:00.000Z',
        '2026-03-14T17:00:00.000Z',
      ])
    })

    it('counts only PENDING rows, and only this user’s', async () => {
      const other = await createReminderUser()
      extraUserIds.push(other.userId)
      await createReminder(other.userId, TEST_TIMEZONE, BASE_REMINDER)
      await listUpcomingOccurrences(other.userId, TEST_TIMEZONE, NOW)
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      const mine = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      // The 1 March row is overdue at `NOW`; the 1 April one is not.
      expect(await countOverdueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(1)

      await acknowledgeOccurrence(fx.userId, mine[0].id, NOW)

      // An answered bill is no longer something the user is late for.
      expect(await countOverdueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(0)
      // And the other user's identical row was never in the tally.
      expect(await countOverdueOccurrences(other.userId, TEST_TIMEZONE, NOW)).toBe(1)
    })

    it('materializes nothing when only the tally is asked for', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, BASE_REMINDER)
      const createMany = vi.spyOn(prisma.reminderOccurrence, 'createMany')

      expect(await countOverdueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(0)

      // A count is a question about the past, and answering it must not write —
      // the same rule `listOccurrences` follows.
      expect(createMany).not.toHaveBeenCalled()
      expect(await occurrenceCount()).toBe(0)
    })
  })

  describe('query shape', () => {
    it('costs one reminder read, one insert, and one occurrence read', async () => {
      for (const title of ['Rent', 'Electricity', 'Water']) {
        await createReminder(fx.userId, TEST_TIMEZONE, { ...BASE_REMINDER, title })
      }
      const reminderFindMany = vi.spyOn(prisma.recurringReminder, 'findMany')
      const createMany = vi.spyOn(prisma.reminderOccurrence, 'createMany')
      const occurrenceFindMany = vi.spyOn(prisma.reminderOccurrence, 'findMany')

      const rows = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(rows).toHaveLength(6)
      // One query for the reminders however many there are — never one per row.
      expect(reminderFindMany).toHaveBeenCalledTimes(1)
      // And one insert for all three of them (finding B-3): the write cost of a
      // dashboard render does not follow the number of reminders.
      expect(createMany).toHaveBeenCalledTimes(1)
      // And one query for the occurrences, joining the reminder, its category and
      // its account — so the dashboard widget needs no follow-up read.
      expect(occurrenceFindMany).toHaveBeenCalledTimes(1)
    })

    it('skips the insert entirely for a reminder with nothing due', async () => {
      await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        frequency: 'ONE_TIME',
        dayOfMonth: undefined,
        startDate: '2027-01-01',
      })
      const createMany = vi.spyOn(prisma.reminderOccurrence, 'createMany')

      await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(createMany).not.toHaveBeenCalled()
    })
  })

  /**
   * The batched insert (Phase 8, Task 4 — pre-flight finding B-3).
   *
   * Materialization used to issue one `createMany` per active reminder, so a
   * dashboard render cost a write round trip per reminder the user keeps —
   * whether or not anything was actually due. Batching it is only safe if the
   * rows it writes are *the same rows*, and the four properties that could
   * plausibly change when a per-reminder insert becomes one insert are all
   * pinned here:
   *
   * 1. **Per-reminder zone anchoring.** Four reminders, four frequencies, two
   *    zones — the monthly and yearly ones anchored in `America/New_York`
   *    across its 8 March DST transition, the one-off and weekly ones in
   *    `Asia/Ho_Chi_Minh`. A batch that hoisted `nowLocal`, the window or the
   *    conversion out of the loop would move an instant, and every instant is
   *    asserted literally.
   * 2. **The windows themselves.** ONE_TIME is never clamped (a 2020 one-off
   *    still appears); everything else is clamped to one interval back — so the
   *    yearly reminder contributes 2025 and 2026 but not 2024.
   * 3. **Answered rows survive.** An ACKNOWLEDGED and a DISMISSED occurrence
   *    are re-derived by the next batch and must be skipped, not reset: the
   *    batch still only ever inserts.
   * 4. **The insert count no longer follows the reminder count.** One
   *    `createMany` for four reminders, and the rows inside it ordered by
   *    `(reminderId, dueAt)` — the ordering the module's deadlock argument
   *    depends on, which per-reminder inserts got for free and a batch has to
   *    arrange for itself.
   */
  describe('batched materialization', () => {
    /**
     * One reminder of every frequency, deliberately spanning a zone boundary:
     * the Ho Chi Minh pair fall due at 17:00Z of the previous UTC day, the New
     * York pair at 05:00Z (EST) or 04:00Z (EDT) of the day itself.
     */
    async function createMixedReminders() {
      const oneTime = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Passport renewal',
        frequency: 'ONE_TIME',
        dayOfMonth: undefined,
        startDate: '2020-05-17',
      })
      const weekly = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Weekly savings',
        frequency: 'WEEKLY',
        dayOfMonth: undefined,
        startDate: '2026-01-05',
      })
      const monthly = await createReminder(fx.userId, DST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Rent NY',
        dayOfMonth: 1,
        startDate: '2026-01-01',
      })
      const yearly = await createReminder(fx.userId, DST_TIMEZONE, {
        ...BASE_REMINDER,
        title: 'Insurance NY',
        frequency: 'YEARLY',
        dayOfMonth: 20,
        month: 3,
        startDate: '2024-03-20',
      })
      return { oneTime, weekly, monthly, yearly }
    }

    /** Every stored occurrence as `title dueAt status`, due date ascending —
     *  the set-equality shape, with each reminder identified by something a
     *  reader can check against the fixture above. */
    async function storedRows(reminders: Record<string, ReminderRow>) {
      const titleOf = new Map(Object.values(reminders).map((row) => [row.id, row.title]))
      const rows = await prisma.reminderOccurrence.findMany({
        where: { userId: fx.userId },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      })
      return rows.map(
        (row) => `${titleOf.get(row.reminderId)} ${row.dueAt.toISOString()} ${row.status}`,
      )
    }

    /**
     * The golden set: what the per-reminder loop wrote for this fixture, instant
     * by instant. Eleven rows — one 2020 one-off, six Mondays, two New York
     * firsts either side of the DST switch, two March 20ths.
     */
    const EXPECTED_ROWS = [
      'Passport renewal 2020-05-16T17:00:00.000Z PENDING',
      'Insurance NY 2025-03-20T04:00:00.000Z PENDING',
      'Rent NY 2026-03-01T05:00:00.000Z PENDING',
      'Weekly savings 2026-03-08T17:00:00.000Z PENDING',
      'Weekly savings 2026-03-15T17:00:00.000Z PENDING',
      'Insurance NY 2026-03-20T04:00:00.000Z PENDING',
      'Weekly savings 2026-03-22T17:00:00.000Z PENDING',
      'Weekly savings 2026-03-29T17:00:00.000Z PENDING',
      'Rent NY 2026-04-01T04:00:00.000Z PENDING',
      'Weekly savings 2026-04-05T17:00:00.000Z PENDING',
      'Weekly savings 2026-04-12T17:00:00.000Z PENDING',
    ]

    it('writes exactly the rows a per-reminder loop wrote, across four frequencies and two zones', async () => {
      const reminders = await createMixedReminders()

      const created = await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(created).toBe(EXPECTED_ROWS.length)
      expect(await storedRows(reminders)).toEqual(EXPECTED_ROWS)
    })

    it('re-deriving the same set skips the answered rows instead of resetting them', async () => {
      const reminders = await createMixedReminders()
      await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      const stored = await prisma.reminderOccurrence.findMany({
        where: { userId: fx.userId },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      })
      // The 2020 one-off is acknowledged and the first Monday dismissed — two
      // of the eleven rows the very next batch recomputes.
      await acknowledgeOccurrence(fx.userId, stored[0].id, NOW)
      await dismissOccurrence(fx.userId, stored[3].id, NOW)

      // A second read at the same instant: the same eleven dates, nothing new.
      expect(await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)).toBe(0)

      expect(await storedRows(reminders)).toEqual(
        EXPECTED_ROWS.map((row) => {
          if (row.startsWith('Passport renewal')) return row.replace('PENDING', 'ACKNOWLEDGED')
          if (row === 'Weekly savings 2026-03-08T17:00:00.000Z PENDING') {
            return row.replace('PENDING', 'DISMISSED')
          }
          return row
        }),
      )
      // And each answer keeps the instant the user gave it at.
      const answered = await prisma.reminderOccurrence.findMany({
        where: { userId: fx.userId, status: { not: 'PENDING' } },
      })
      expect(answered.map((row) => row.actionedAt?.toISOString())).toEqual([
        NOW.toISOString(),
        NOW.toISOString(),
      ])
    })

    it('costs one insert for four reminders, with the rows ordered by (reminderId, dueAt)', async () => {
      await createMixedReminders()
      const createMany = vi.spyOn(prisma.reminderOccurrence, 'createMany')

      await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      // The insert count is a property of the *call*, not of how many reminders
      // the user keeps — which is the whole of finding B-3.
      expect(createMany).toHaveBeenCalledTimes(1)
      const argument = createMany.mock.calls[0][0] as {
        data: { reminderId: string; dueAt: Date }[]
        skipDuplicates?: boolean
      }
      expect(argument.data).toHaveLength(11)
      // Ascending `(reminderId, dueAt)`, so concurrent callers take their row
      // locks in the same order and cannot deadlock — the property the
      // per-reminder loop had for free.
      const keys = argument.data.map((row) => `${row.reminderId} ${row.dueAt.toISOString()}`)
      expect(keys).toEqual([...keys].sort())
      // `skipDuplicates` is the whole idempotency mechanism: without it the
      // second read would fail with P2002.
      expect(argument.skipDuplicates).toBe(true)
    })

    it('does not grow its insert count with the number of reminders', async () => {
      for (let index = 0; index < 12; index += 1) {
        await createReminder(fx.userId, TEST_TIMEZONE, {
          ...BASE_REMINDER,
          title: `Bill ${index}`,
          dayOfMonth: 1,
        })
      }
      const createMany = vi.spyOn(prisma.reminderOccurrence, 'createMany')

      await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, NOW)

      expect(createMany).toHaveBeenCalledTimes(1)
      // Twelve reminders × two firsts in the window, in one round trip.
      expect(await occurrenceCount()).toBe(24)
    })
  })

  describe('database constraints', () => {
    it.each([
      [{ expectedAmount: new Prisma.Decimal('0') }, 'RecurringReminder_expectedAmount_positive'],
      [{ expectedAmount: new Prisma.Decimal('-1') }, 'RecurringReminder_expectedAmount_positive'],
      [{ interval: 0 }, 'RecurringReminder_interval_min'],
      [{ interval: -1 }, 'RecurringReminder_interval_min'],
      [{ dayOfMonth: 0 }, 'RecurringReminder_dayOfMonth_range'],
      [{ dayOfMonth: 32 }, 'RecurringReminder_dayOfMonth_range'],
      [{ month: 0 }, 'RecurringReminder_month_range'],
      [{ month: 13 }, 'RecurringReminder_month_range'],
    ])('rejects %o even bypassing the service', async (patch, constraint) => {
      const caught = await captureRejection(
        prisma.recurringReminder.create({ data: directReminderData(patch) }),
      )

      // The CHECK's own name, so a migration that dropped it fails here rather
      // than passing quietly.
      expect(String(caught)).toContain(constraint)
      expect(await prisma.recurringReminder.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('accepts NULL anchors, which is what WEEKLY and ONE_TIME store', async () => {
      // The `IS NULL` arm of the two range CHECKs: written without it, every
      // weekly and one-off reminder would be refused by the database.
      const created = await prisma.recurringReminder.create({
        data: directReminderData({ frequency: 'WEEKLY', dayOfMonth: null, month: null }),
      })

      expect(created.dayOfMonth).toBeNull()
      expect(created.month).toBeNull()
    })
  })

  describe('tracking only — no money moves', () => {
    it('leaves accounts, transactions, transfers and the balance untouched by every mutation', async () => {
      // Every mutation the service has, in the sequence a real user would
      // produce. `afterEach` checks the ledger after every case; this one exists
      // so the check has run against the whole surface at least once, in one
      // place a reviewer can read.
      const reminder = await createReminder(fx.userId, TEST_TIMEZONE, {
        ...BASE_REMINDER,
        categoryId: fx.expenseCategoryId,
        accountId: fx.accountId,
        note: 'Tracking only',
      })
      const upcoming = await listUpcomingOccurrences(fx.userId, TEST_TIMEZONE, NOW)
      await acknowledgeOccurrence(fx.userId, upcoming[0].id, NOW)
      await dismissOccurrence(fx.userId, upcoming[1].id, NOW)
      await setReminderActive(fx.userId, reminder.id, false)
      await setReminderActive(fx.userId, reminder.id, true)
      await materializeDueOccurrences(fx.userId, TEST_TIMEZONE, at(40))
      await listOccurrences(fx.userId)

      expect(await prisma.financialAccount.count({ where: { userId: fx.userId } })).toBe(
        ledger.accounts,
      )
      expect(await prisma.transaction.count({ where: { userId: fx.userId } })).toBe(
        ledger.transactions,
      )
      expect(await prisma.transfer.count({ where: { userId: fx.userId } })).toBe(ledger.transfers)
      expect((await getAccountBalance(fx.userId, fx.accountId)).toString()).toBe(ledger.balance)
      expect(
        await prisma.financialAccount.findUniqueOrThrow({
          where: { userId_id: { userId: fx.userId, id: fx.accountId } },
        }),
      ).toEqual(ledger.account)
      expect(
        await prisma.transaction.findUniqueOrThrow({
          where: { userId_id: { userId: fx.userId, id: fx.transactionId } },
        }),
      ).toEqual(ledger.transaction)
    })

    /**
     * The structural half of "a reminder is not a Transaction": the service
     * cannot touch the ledger because it does not import anything that writes to
     * it.
     *
     * Reading the source is deliberate rather than fragile. The behavioural
     * checks can only catch a write they happen to provoke, whereas a later
     * phase adding "record the bill as a transaction when acknowledged" would
     * reintroduce exactly the coupling directive M exists to forbid — and
     * importing the module is the first step of doing so. Only import specifiers
     * are matched, so the doc comment may keep naming these modules to say why
     * they are absent.
     */
    it('imports nothing that could move money or reach a live rate', () => {
      const source = readFileSync(fileURLToPath(new URL('./reminder.ts', import.meta.url)), 'utf8')

      for (const forbidden of [
        'services/transaction',
        'services/transfer',
        'services/balance',
        'services/financial-account',
        'current-rate-policy',
        'fx-service',
        'current-amount',
        'historical-amount',
      ]) {
        expect(source).not.toMatch(new RegExp(`from '[^']*${forbidden}`))
      }
    })

    it('never reads the host timezone, and never puts money through a float', () => {
      // Every date this service builds goes through `date-fns-tz` with the
      // user's own zone. A `new Date(y, m, d)` or a bare `getFullYear()` would
      // silently use the *server's* zone, which is the bug the carrier
      // convention exists to prevent — and it would pass every test on a CI box
      // running `TZ=UTC` while shipping wrong dates in production.
      //
      // Comments are stripped before matching, so the doc comments may keep
      // *naming* the anti-patterns in order to explain why they are absent —
      // which is precisely what makes the reasoning readable next to the code.
      const source = readFileSync(fileURLToPath(new URL('./reminder.ts', import.meta.url)), 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

      expect(code).not.toMatch(/new Date\(\s*\d/)
      expect(code).not.toMatch(/\.getFullYear\(|\.getMonth\(|\.getDate\(\)/)
      expect(code).not.toMatch(/toZonedTime\(/)
      // Money never travels through a float in a service (spec §5).
      expect(code).not.toMatch(/toNumber\(/)
      // The stripper really did leave the code behind — otherwise every
      // assertion above would pass vacuously on an empty string.
      expect(code).toContain('export async function materializeDueOccurrences')
      expect(code).toContain('new Prisma.Decimal(String(parsed.expectedAmount))')
    })
  })
})
