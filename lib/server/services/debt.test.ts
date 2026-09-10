import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { getAccountBalance } from '@/lib/server/services/balance'
import {
  createDebt,
  deriveDebtDisplayStatus,
  deriveDebtOutstanding,
  getDebtOutstanding,
  getDebtsWithOutstanding,
  listDebts,
  recordDebtPayment,
  updateDebt,
  writeOffDebt,
  DebtNotActiveError,
  DebtOverpaymentError,
  type DebtTotals,
  type DebtWithOutstanding,
} from './debt'

/**
 * Group 2's data-layer acceptance check (spec §4.9).
 *
 * Six properties are what this suite exists to hold:
 *
 * 1. **Nothing here moves money.** The fixture seeds an account and an EXPENSE
 *    transaction, and `afterEach` re-asserts the account / transaction /
 *    transfer counts, the two seeded rows field for field, and the account's
 *    derived balance — after *every* case, not just a dedicated one. A stray
 *    write to any of them fails the test that made it.
 * 2. **Outstanding is derived, never stored.** Every assertion goes through
 *    `originalAmount − Σ payments`; there is no column to check, and the
 *    `groupBy` sum and the included payment rows are asserted to agree.
 * 3. **The payment rule holds at the boundary and under concurrency.** The
 *    exact final payment is accepted, one cent more is refused, and two
 *    concurrent payments that would each fit alone cannot both commit — proved
 *    against the real database with `Promise.allSettled`, three times over.
 * 4. **WRITTEN_OFF is terminal but writing off is idempotent**, and it never
 *    erases history: the debt and its payments stay readable.
 * 5. **A calendar date survives the round trip.** A due date written as
 *    `2026-06-30` comes back out of Postgres as `2026-06-30` — at UTC
 *    midnight, never shifted by the server's or the user's zone — and
 *    "overdue" is a comparison of two `yyyy-MM-dd` strings, so it never
 *    depends on when the test runs.
 * 6. **Every query is tenant-scoped.** A second user's debt is targeted by each
 *    mutation and each read, which must fail with P2025 and leave the rows
 *    byte-identical; the composite FK refuses a cross-user payment with P2003
 *    even when the service is bypassed entirely.
 *
 * `fetch` is a throwing spy for every test and `afterEach` asserts it was never
 * called: a debt keeps its own currency and nothing here converts one, so any
 * network access would be a bug rather than a slow test.
 */

/** UTC+7, no DST — so no assertion below depends on a DST date. */
const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

/**
 * The "today" every display-status assertion is made against, passed in
 * explicitly rather than read from the clock. `deriveDebtDisplayStatus` takes
 * `today` as an argument precisely so OVERDUE is deterministic: a suite that
 * used the real date would start failing on its own the day a fixture's due
 * date passed.
 */
const TODAY = '2026-03-15'

interface DebtFixture {
  userId: string
  accountId: string
  transactionId: string
}

/** The minimum a create needs — every case overrides what it cares about. */
const BASE_DEBT = {
  direction: 'RECEIVABLE' as const,
  person: 'Nguyen An',
  originalAmount: 1_000_000,
  currency: 'VND' as const,
}

/**
 * A user with one account and one expense already recorded.
 *
 * The account and the transaction exist purely so "no account mutation" has
 * something that *could* be corrupted: with an empty ledger, "counts unchanged"
 * and "balance unchanged" would both hold trivially.
 */
async function createDebtUser(): Promise<DebtFixture> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `debt-${randomUUID()}@example.com`,
      name: 'Debt Test',
      emailVerified: false,
      timezone: TEST_TIMEZONE,
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
      fxRateSource: 'debt-test',
    },
  })
  return { userId: user.id, accountId: account.id, transactionId: transaction.id }
}

/** Deletes a user's rows in FK order, then the user. */
async function cleanupUsers(userIds: string[]) {
  if (userIds.length === 0) return
  try {
    await prisma.debtPayment.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.debt.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

/** Counts, rows and derived balance — everything a debt must not change. */
async function snapshotLedger(fx: DebtFixture) {
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

const d = (value: string) => new Prisma.Decimal(value)

describe('deriveDebtOutstanding', () => {
  it('is the original amount minus what has been paid', () => {
    expect(deriveDebtOutstanding(d('1000000'), d('0')).toString()).toBe('1000000')
    expect(deriveDebtOutstanding(d('1000000'), d('400000')).toString()).toBe('600000')
    expect(deriveDebtOutstanding(d('1000000'), d('1000000')).toString()).toBe('0')
  })

  it('keeps 2 decimal places exact rather than losing them to a float detour', () => {
    // 0.1 + 0.2 as doubles is 0.30000000000000004, so a `number` subtraction of
    // these values is where a naive implementation reports a residual cent that
    // the user never owed.
    expect(deriveDebtOutstanding(d('0.30'), d('0.10').add(d('0.20'))).toString()).toBe('0')
    expect(deriveDebtOutstanding(d('5000000'), d('1234.56')).toString()).toBe('4998765.44')
  })
})

describe('deriveDebtDisplayStatus', () => {
  const active = (originalAmount: string, dueDate: string | null) => ({
    status: 'ACTIVE' as const,
    originalAmount: d(originalAmount),
    dueDate: dueDate === null ? null : calendarDateToUtcCarrier(dueDate),
  })

  it('reports WRITTEN_OFF whatever the arithmetic and the due date say', () => {
    const writtenOff = { ...active('1000', '2020-01-01'), status: 'WRITTEN_OFF' as const }

    expect(deriveDebtDisplayStatus(writtenOff, d('1000'), TODAY)).toBe('WRITTEN_OFF')
    expect(deriveDebtDisplayStatus(writtenOff, d('0'), TODAY)).toBe('WRITTEN_OFF')
  })

  it('reports PAID at exactly zero outstanding, ahead of an overdue due date', () => {
    // The order matters: a debt repaid *late* is repaid, not overdue. Showing
    // OVERDUE on a settled debt would be telling the user to chase money they
    // already have.
    expect(deriveDebtDisplayStatus(active('1000', null), d('0'), TODAY)).toBe('PAID')
    expect(deriveDebtDisplayStatus(active('1000', '2026-01-31'), d('0'), TODAY)).toBe('PAID')
  })

  it('reports OVERDUE when the due date is past and something is still owed', () => {
    // Ahead of PARTIALLY_PAID as well as OPEN: what the user needs to see about
    // a late debt is that it is late.
    expect(deriveDebtDisplayStatus(active('1000', '2026-03-14'), d('1000'), TODAY)).toBe('OVERDUE')
    expect(deriveDebtDisplayStatus(active('1000', '2026-03-14'), d('400'), TODAY)).toBe('OVERDUE')
  })

  it('does not report OVERDUE on the due date itself', () => {
    // "Due today" is not late — the comparison is strictly `dueDate < today`,
    // on the two calendar strings, so the user has the whole day.
    expect(deriveDebtDisplayStatus(active('1000', TODAY), d('1000'), TODAY)).toBe('OPEN')
    expect(deriveDebtDisplayStatus(active('1000', TODAY), d('400'), TODAY)).toBe('PARTIALLY_PAID')
    expect(deriveDebtDisplayStatus(active('1000', '2026-03-16'), d('1000'), TODAY)).toBe('OPEN')
  })

  it('reports PARTIALLY_PAID below the original amount and OPEN at it', () => {
    expect(deriveDebtDisplayStatus(active('1000', null), d('999.99'), TODAY)).toBe('PARTIALLY_PAID')
    expect(deriveDebtDisplayStatus(active('1000', null), d('1000'), TODAY)).toBe('OPEN')
    // What Postgres hands back for a `Decimal(18, 2)` column is "1000.00", not
    // "1000": the same number, and a string comparison would call it partial.
    expect(deriveDebtDisplayStatus(active('1000', null), d('1000.00'), TODAY)).toBe('OPEN')
  })
})

describe('debt service', () => {
  let fetchSpy: MockInstance
  let fx: DebtFixture
  let ledger: Awaited<ReturnType<typeof snapshotLedger>>
  /** Extra users a single case created; cleaned up with the fixture. */
  let extraUserIds: string[]

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    extraUserIds = []
    fx = await createDebtUser()
    ledger = await snapshotLedger(fx)
    // 5,000,000 initial minus the fixture's 250,000 expense — a real,
    // non-trivial figure, so "unchanged" is a meaningful assertion.
    expect(ledger.balance).toBe('4750000')
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    try {
      // Tracking only, asserted after *every* case rather than in one dedicated
      // test: whichever mutation a case ran, the ledger it did not ask about is
      // still exactly as it was — counts, the two seeded rows field for field,
      // and the derived balance.
      expect(await snapshotLedger(fx)).toEqual(ledger)
    } finally {
      // In `finally`, so a ledger assertion that fails still leaves the
      // database clean for the next case rather than turning one real failure
      // into a cascade of unrelated ones.
      await cleanupUsers([fx.userId, ...extraUserIds])
    }
    // A debt keeps its own currency and is never converted, so no code path
    // here has any reason to reach an FX provider.
    expect(fetchCalls).toBe(0)
  })

  /** The `getDebtsWithOutstanding` entry for one debt — the real read path the
   *  page uses, rather than a second derivation written in the test. */
  async function entryFor(debtId: string, today = TODAY): Promise<DebtWithOutstanding> {
    const entries = await getDebtsWithOutstanding(fx.userId, today)
    const entry = entries.find((candidate) => candidate.debt.id === debtId)
    if (!entry) throw new Error(`Debt ${debtId} is missing from getDebtsWithOutstanding`)
    return entry
  }

  async function paymentCount(debtId: string): Promise<number> {
    return prisma.debtPayment.count({ where: { userId: fx.userId, debtId } })
  }

  describe('create', () => {
    it('creates a RECEIVABLE with every field, ACTIVE, and a due date that round-trips', async () => {
      const debt = await createDebt(fx.userId, {
        direction: 'RECEIVABLE',
        person: 'Nguyen An',
        description: 'Lent for a motorbike repair',
        originalAmount: 5_000_000,
        currency: 'VND',
        dueDate: '2026-06-30',
        notes: 'Paying back monthly',
      })

      expect(debt.userId).toBe(fx.userId)
      expect(debt.direction).toBe('RECEIVABLE')
      expect(debt.person).toBe('Nguyen An')
      expect(debt.description).toBe('Lent for a motorbike repair')
      expect(debt.originalAmount.toString()).toBe('5000000')
      expect(debt.currency).toBe('VND')
      expect(debt.notes).toBe('Paying back monthly')
      expect(debt.status).toBe('ACTIVE')
      expect(debt.payments).toEqual([])

      // Not 2026-06-29T17:00Z (the +07 midnight) and not the 29th read back:
      // the stored instant's UTC components ARE the calendar date the user
      // picked, in every zone.
      expect(debt.dueDate?.toISOString()).toBe('2026-06-30T00:00:00.000Z')
      const stored = await prisma.debt.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: debt.id } },
      })
      expect(formatCalendarDate(stored.dueDate as Date)).toBe('2026-06-30')
    })

    it('creates a PAYABLE with no description, due date or notes', async () => {
      const debt = await createDebt(fx.userId, {
        direction: 'PAYABLE',
        person: 'Binh',
        originalAmount: 200,
        currency: 'USD',
      })

      expect(debt.direction).toBe('PAYABLE')
      expect(debt.currency).toBe('USD')
      expect(debt.originalAmount.toString()).toBe('200')
      expect(debt.description).toBeNull()
      expect(debt.dueDate).toBeNull()
      expect(debt.notes).toBeNull()
      expect(debt.status).toBe('ACTIVE')
    })

    it('ignores a client-supplied status', async () => {
      // Zod strips it and the service never writes one, so a crafted request
      // cannot create an already-written-off debt.
      const debt = await createDebt(fx.userId, {
        ...BASE_DEBT,
        ...({ status: 'WRITTEN_OFF' } as object),
      })

      expect(debt.status).toBe('ACTIVE')
    })

    it('rejects an impossible due date rather than storing a rolled-over date', async () => {
      await expect(createDebt(fx.userId, { ...BASE_DEBT, dueDate: '2026-02-30' })).rejects.toThrow()

      expect(await prisma.debt.count({ where: { userId: fx.userId } })).toBe(0)
    })
  })

  describe('outstanding and display status', () => {
    it('reports the full original amount and OPEN before any payment', async () => {
      const debt = await createDebt(fx.userId, { ...BASE_DEBT, originalAmount: 5_000_000 })

      expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('5000000')
      const entry = await entryFor(debt.id)
      expect(entry.paid.toString()).toBe('0')
      expect(entry.outstanding.toString()).toBe('5000000')
      expect(entry.displayStatus).toBe('OPEN')
    })

    it('records a partial payment with an exact 2dp outstanding and reports PARTIALLY_PAID', async () => {
      const debt = await createDebt(fx.userId, { ...BASE_DEBT, originalAmount: 5_000_000 })

      const payment = await recordDebtPayment(fx.userId, debt.id, {
        amount: 1_234.56,
        date: '2026-03-01',
        note: 'First instalment',
      })

      expect(payment.userId).toBe(fx.userId)
      expect(payment.debtId).toBe(debt.id)
      expect(payment.amount.toString()).toBe('1234.56')
      expect(payment.note).toBe('First instalment')
      expect(formatCalendarDate(payment.date)).toBe('2026-03-01')

      // 5,000,000 − 1,234.56 to the cent: no float residue, no rounding.
      expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('4998765.44')
      const entry = await entryFor(debt.id)
      expect(entry.paid.toString()).toBe('1234.56')
      expect(entry.outstanding.toString()).toBe('4998765.44')
      expect(entry.displayStatus).toBe('PARTIALLY_PAID')
    })

    it('stays PARTIALLY_PAID after a second partial payment', async () => {
      const debt = await createDebt(fx.userId, { ...BASE_DEBT, originalAmount: 5_000_000 })
      await recordDebtPayment(fx.userId, debt.id, { amount: 1_234.56, date: '2026-03-01' })

      await recordDebtPayment(fx.userId, debt.id, { amount: 1_234.56, date: '2026-03-10' })

      const entry = await entryFor(debt.id)
      expect(entry.paid.toString()).toBe('2469.12')
      expect(entry.outstanding.toString()).toBe('4997530.88')
      expect(entry.displayStatus).toBe('PARTIALLY_PAID')
      expect(await paymentCount(debt.id)).toBe(2)
    })

    it('accepts the exact final payment: outstanding 0 and PAID', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      await recordDebtPayment(fx.userId, debt.id, { amount: 400_000, date: '2026-03-01' })

      // Exactly what is left — the boundary the overpayment rule must not
      // refuse, and the one a float comparison is most likely to get wrong.
      await recordDebtPayment(fx.userId, debt.id, { amount: 600_000, date: '2026-03-10' })

      expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('0')
      const entry = await entryFor(debt.id)
      expect(entry.outstanding.toString()).toBe('0')
      expect(entry.displayStatus).toBe('PAID')
      // The debt row itself is still ACTIVE: PAID is derived, never stored.
      expect(entry.debt.status).toBe('ACTIVE')
    })

    it('reports PAID rather than OVERDUE once a past-due debt is fully repaid', async () => {
      const debt = await createDebt(fx.userId, { ...BASE_DEBT, dueDate: '2026-01-31' })

      await recordDebtPayment(fx.userId, debt.id, { amount: 1_000_000, date: '2026-03-01' })

      // Paid late is paid. Chasing a settled debt would be worse than showing
      // nothing at all.
      expect((await entryFor(debt.id)).displayStatus).toBe('PAID')
    })

    it('reports OVERDUE when the due date is past and something is still owed', async () => {
      const unpaid = await createDebt(fx.userId, { ...BASE_DEBT, dueDate: '2026-03-14' })
      const partly = await createDebt(fx.userId, { ...BASE_DEBT, dueDate: '2026-02-28' })
      await recordDebtPayment(fx.userId, partly.id, { amount: 600_000, date: '2026-02-20' })

      expect((await entryFor(unpaid.id)).displayStatus).toBe('OVERDUE')
      // OVERDUE outranks PARTIALLY_PAID: being late is the thing to act on.
      expect((await entryFor(partly.id)).displayStatus).toBe('OVERDUE')
      expect((await entryFor(partly.id)).outstanding.toString()).toBe('400000')
    })

    it('does not report OVERDUE on the due date itself', async () => {
      const debt = await createDebt(fx.userId, { ...BASE_DEBT, dueDate: TODAY })

      expect((await entryFor(debt.id)).displayStatus).toBe('OPEN')
      // And the day after, the same row is overdue — the only thing that
      // changed is the `today` the caller passed in.
      expect((await entryFor(debt.id, '2026-03-16')).displayStatus).toBe('OVERDUE')
    })
  })

  describe('overpayment', () => {
    it('refuses a payment above the outstanding amount, carries it on the error, and writes nothing', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      await recordDebtPayment(fx.userId, debt.id, { amount: 600_000, date: '2026-03-01' })

      const caught = await captureRejection(
        recordDebtPayment(fx.userId, debt.id, { amount: 400_000.01, date: '2026-03-10' }),
      )

      expect(caught).toBeInstanceOf(DebtOverpaymentError)
      // The outstanding travels on the error so the form can say what would
      // fit, without the caller re-querying (and re-racing) for it.
      expect((caught as DebtOverpaymentError).outstanding.toString()).toBe('400000')
      expect((caught as DebtOverpaymentError).message).toBe(
        'Payment exceeds the amount still owed.',
      )
      // Nothing partially applied: exactly what the first, accepted payment
      // left behind.
      expect(await paymentCount(debt.id)).toBe(1)
      expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('400000')
    })

    it('refuses any payment against a fully repaid debt', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      await recordDebtPayment(fx.userId, debt.id, { amount: 1_000_000, date: '2026-03-01' })

      const caught = await captureRejection(
        recordDebtPayment(fx.userId, debt.id, { amount: 0.01, date: '2026-03-10' }),
      )

      // A settled debt is not written off — it is simply full, so the honest
      // answer is the overpayment error rather than "not active".
      expect(caught).toBeInstanceOf(DebtOverpaymentError)
      expect((caught as DebtOverpaymentError).outstanding.toString()).toBe('0')
      expect(await paymentCount(debt.id)).toBe(1)
    })

    it('rejects an invalid amount or date before touching the database', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)

      await expect(
        recordDebtPayment(fx.userId, debt.id, { amount: 0, date: '2026-03-01' }),
      ).rejects.toThrow(/Amount must be greater than zero/)
      await expect(
        recordDebtPayment(fx.userId, debt.id, { amount: 100, date: '2026-02-30' }),
      ).rejects.toThrow(/Enter a real date/)

      expect(await paymentCount(debt.id)).toBe(0)
    })
  })

  describe('write-off', () => {
    it('sets WRITTEN_OFF and then refuses further payments and edits', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      await recordDebtPayment(fx.userId, debt.id, { amount: 100_000, date: '2026-03-01' })

      const writtenOff = await writeOffDebt(fx.userId, debt.id)

      expect(writtenOff.status).toBe('WRITTEN_OFF')
      const entry = await entryFor(debt.id)
      expect(entry.displayStatus).toBe('WRITTEN_OFF')
      // The arithmetic still says 900,000 is owed; the user's decision outranks
      // it, and the figure is kept rather than zeroed.
      expect(entry.outstanding.toString()).toBe('900000')

      await expect(
        recordDebtPayment(fx.userId, debt.id, { amount: 1, date: '2026-03-16' }),
      ).rejects.toThrow(DebtNotActiveError)
      await expect(updateDebt(fx.userId, debt.id, { person: 'Renamed' })).rejects.toThrow(
        DebtNotActiveError,
      )
      expect(await paymentCount(debt.id)).toBe(1)
    })

    it('is a no-op when the debt is already written off', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      const first = await writeOffDebt(fx.userId, debt.id)

      const second = await writeOffDebt(fx.userId, debt.id)

      expect(second.status).toBe('WRITTEN_OFF')
      // A true no-op: no write happened, so `updatedAt` did not move. A
      // double-click on "Write off" is the same request that already succeeded.
      expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime())
    })

    it('keeps the debt and its payment history readable afterwards', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      await recordDebtPayment(fx.userId, debt.id, { amount: 250_000, date: '2026-03-10' })
      await recordDebtPayment(fx.userId, debt.id, { amount: 150_000, date: '2026-02-01' })
      await writeOffDebt(fx.userId, debt.id)

      const [listed] = await listDebts(fx.userId)

      expect(listed.id).toBe(debt.id)
      expect(listed.status).toBe('WRITTEN_OFF')
      // Writing a debt off records a decision; it never deletes what happened.
      // Payments come back oldest first, whatever order they were entered in.
      expect(listed.payments.map((p) => p.amount.toString())).toEqual(['150000', '250000'])
      expect(listed.payments.map((p) => formatCalendarDate(p.date))).toEqual([
        '2026-02-01',
        '2026-03-10',
      ])
    })
  })

  describe('update', () => {
    it('changes person, description, due date and notes', async () => {
      const debt = await createDebt(fx.userId, {
        ...BASE_DEBT,
        description: 'Original',
        dueDate: '2026-06-30',
        notes: 'Original notes',
      })

      const updated = await updateDebt(fx.userId, debt.id, {
        person: 'Nguyen An Jr',
        description: 'Corrected',
        dueDate: '2026-09-30',
        notes: 'Agreed a later date',
      })

      expect(updated.person).toBe('Nguyen An Jr')
      expect(updated.description).toBe('Corrected')
      expect(formatCalendarDate(updated.dueDate as Date)).toBe('2026-09-30')
      expect(updated.notes).toBe('Agreed a later date')
      // The three defining fields are untouched — they are not editable at all.
      expect(updated.direction).toBe('RECEIVABLE')
      expect(updated.originalAmount.toString()).toBe('1000000')
      expect(updated.currency).toBe('VND')
    })

    it('clears a due date, a description and notes when the fields come back empty', async () => {
      const debt = await createDebt(fx.userId, {
        ...BASE_DEBT,
        description: 'Original',
        dueDate: '2026-06-30',
        notes: 'Original notes',
      })

      const updated = await updateDebt(fx.userId, debt.id, { person: 'Nguyen An', dueDate: '' })

      // The absence has to be *written*: skipping the field would leave the old
      // due date in place, so a user could never remove one.
      expect(updated.dueDate).toBeNull()
      expect(updated.description).toBeNull()
      expect(updated.notes).toBeNull()
    })
  })

  describe('getDebtsWithOutstanding', () => {
    it('returns one entry per debt whose paid total agrees with the included payments', async () => {
      const none = await createDebt(fx.userId, { ...BASE_DEBT, person: 'None' })
      const partly = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Partly' })
      const full = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Full' })
      await recordDebtPayment(fx.userId, partly.id, { amount: 100_000, date: '2026-03-01' })
      await recordDebtPayment(fx.userId, partly.id, { amount: 250_000.5, date: '2026-03-02' })
      await recordDebtPayment(fx.userId, full.id, { amount: 1_000_000, date: '2026-03-03' })

      const entries = await getDebtsWithOutstanding(fx.userId, TODAY)

      expect(entries.map((entry) => entry.debt.id)).toEqual([none.id, partly.id, full.id])
      for (const entry of entries) {
        // The `groupBy` sum is the authoritative figure and the included
        // payments are the history the page renders. If they ever disagreed,
        // the UI would show a total its own rows do not add up to.
        const fromRows = entry.debt.payments.reduce(
          (total, payment) => total.add(payment.amount),
          new Prisma.Decimal(0),
        )
        expect(entry.paid.toString()).toBe(fromRows.toString())
        expect(entry.outstanding.toString()).toBe(
          entry.debt.originalAmount.sub(fromRows).toString(),
        )
      }
      expect(entries.map((entry) => entry.paid.toString())).toEqual(['0', '350000.5', '1000000'])
      expect(entries.map((entry) => entry.displayStatus)).toEqual([
        'OPEN',
        'PARTIALLY_PAID',
        'PAID',
      ])
    })

    it('uses one findMany and one groupBy however many debts there are', async () => {
      for (const person of ['A', 'B', 'C']) {
        const debt = await createDebt(fx.userId, { ...BASE_DEBT, person })
        await recordDebtPayment(fx.userId, debt.id, { amount: 1_000, date: '2026-03-01' })
        await recordDebtPayment(fx.userId, debt.id, { amount: 2_000, date: '2026-03-02' })
      }
      const findMany = vi.spyOn(prisma.debt, 'findMany')
      const groupBy = vi.spyOn(prisma.debtPayment, 'groupBy')

      const entries = await getDebtsWithOutstanding(fx.userId, TODAY)

      expect(entries).toHaveLength(3)
      // Three debts, six payments, two queries: a per-debt sum would be three
      // more round trips for every debt the user adds.
      expect(findMany).toHaveBeenCalledTimes(1)
      expect(groupBy).toHaveBeenCalledTimes(1)
      expect(entries.every((entry) => entry.paid.toString() === '3000')).toBe(true)
    })

    it('excludes written-off debts when activeOnly is set', async () => {
      const live = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Live' })
      const gone = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Gone' })
      await writeOffDebt(fx.userId, gone.id)

      const activeOnly = await getDebtsWithOutstanding(fx.userId, TODAY, { activeOnly: true })
      const everything = await getDebtsWithOutstanding(fx.userId, TODAY)

      expect(activeOnly.map((entry) => entry.debt.id)).toEqual([live.id])
      expect(everything.map((entry) => entry.debt.id)).toEqual([live.id, gone.id])
      expect(everything[1].displayStatus).toBe('WRITTEN_OFF')
    })

    it('returns nothing for a user with no debts', async () => {
      expect(await getDebtsWithOutstanding(fx.userId, TODAY)).toEqual([])
      expect(await listDebts(fx.userId)).toEqual([])
    })

    /**
     * `includePayments: false` — the totals-only read (Phase 8, Task 4,
     * pre-flight finding B-7).
     *
     * The dashboard, the Accounts page header and two export sheets need
     * `paid`, `outstanding` and `displayStatus` and nothing else, but every one
     * of them used to pull the user's whole payment history across the wire to
     * get them — the `groupBy` beside the `findMany` was already the
     * authoritative sum, and the included rows were discarded.
     *
     * The one thing that must not change is the arithmetic, so this compares the
     * two paths figure by figure on a fixture that covers every shape the
     * derivation has a branch for: no payments, a fractional part-payment, an
     * exactly-settled debt, and a written-off one that has payments against it.
     */
    it('derives identical figures with and without the payment history', async () => {
      const none = await createDebt(fx.userId, { ...BASE_DEBT, person: 'None' })
      const partly = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Partly' })
      const full = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Full' })
      const gone = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Gone' })
      await recordDebtPayment(fx.userId, partly.id, { amount: 100_000, date: '2026-03-01' })
      await recordDebtPayment(fx.userId, partly.id, { amount: 250_000.5, date: '2026-03-02' })
      await recordDebtPayment(fx.userId, full.id, { amount: 1_000_000, date: '2026-03-03' })
      await recordDebtPayment(fx.userId, gone.id, { amount: 400_000, date: '2026-03-04' })
      await writeOffDebt(fx.userId, gone.id)

      const withHistory = await getDebtsWithOutstanding(fx.userId, TODAY)
      const totalsOnly = await getDebtsWithOutstanding(fx.userId, TODAY, { includePayments: false })

      // Every figure the callers actually read, to the digit — `toString()` so a
      // Decimal's scale is compared too, not just its value.
      const figures = (entries: DebtWithOutstanding[] | DebtTotals[]) =>
        entries.map((entry) => [
          entry.debt.person,
          entry.debt.originalAmount.toString(),
          entry.paid.toString(),
          entry.outstanding.toString(),
          entry.displayStatus,
        ])

      expect(figures(totalsOnly)).toEqual(figures(withHistory))
      expect(figures(totalsOnly)).toEqual([
        ['None', '1000000', '0', '1000000', 'OPEN'],
        ['Partly', '1000000', '350000.5', '649999.5', 'PARTIALLY_PAID'],
        ['Full', '1000000', '1000000', '0', 'PAID'],
        ['Gone', '1000000', '400000', '600000', 'WRITTEN_OFF'],
      ])
      // Same rows, same order, same ids — only the history is left behind.
      expect(totalsOnly.map((entry) => entry.debt.id)).toEqual([
        none.id,
        partly.id,
        full.id,
        gone.id,
      ])
      expect(withHistory[1].debt.payments).toHaveLength(2)
      expect(totalsOnly.every((entry) => !('payments' in entry.debt))).toBe(true)
    })

    it('fetches no payment rows for a totals-only read, and still one aggregate', async () => {
      for (const person of ['A', 'B', 'C']) {
        const debt = await createDebt(fx.userId, { ...BASE_DEBT, person })
        await recordDebtPayment(fx.userId, debt.id, { amount: 1_000, date: '2026-03-01' })
        await recordDebtPayment(fx.userId, debt.id, { amount: 2_000, date: '2026-03-02' })
      }
      const findMany = vi.spyOn(prisma.debt, 'findMany')
      const groupBy = vi.spyOn(prisma.debtPayment, 'groupBy')

      const entries = await getDebtsWithOutstanding(fx.userId, TODAY, { includePayments: false })

      // Still two queries — the point is the *payload*: no `payments` include,
      // so a user with a thousand instalments costs the dashboard nothing.
      expect(findMany).toHaveBeenCalledTimes(1)
      expect(findMany.mock.calls[0][0]?.include).toBeUndefined()
      expect(groupBy).toHaveBeenCalledTimes(1)
      expect(entries.every((entry) => entry.paid.toString() === '3000')).toBe(true)
    })
  })

  describe('listDebts', () => {
    it('lists every status, active first, then oldest first', async () => {
      const first = await createDebt(fx.userId, { ...BASE_DEBT, person: 'First' })
      const second = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Second' })
      const third = await createDebt(fx.userId, { ...BASE_DEBT, person: 'Third' })
      await writeOffDebt(fx.userId, first.id)

      const listed = await listDebts(fx.userId)

      // ACTIVE before WRITTEN_OFF, and within a status the creation order —
      // even though 'First' was created first.
      expect(listed.map((debt) => `${debt.person}:${debt.status}`)).toEqual([
        'Second:ACTIVE',
        'Third:ACTIVE',
        'First:WRITTEN_OFF',
      ])
      expect(listed.map((debt) => debt.id)).toEqual([second.id, third.id, first.id])
    })
  })

  describe('concurrency', () => {
    it('lets only one of two concurrent payments through when both would fit alone', async () => {
      // Three runs, because a race that passes once may simply have been
      // scheduled kindly. Each run is a fresh debt so the previous run's
      // payments cannot mask a failure.
      for (const run of [1, 2, 3]) {
        const debt = await createDebt(fx.userId, {
          ...BASE_DEBT,
          person: `Race ${run}`,
          originalAmount: 1_000_000,
        })

        // 600,000 each: either alone fits inside 1,000,000, both together do
        // not. Without the row lock both would read the same outstanding, both
        // would pass their check, and the debt would end up 200,000
        // over-repaid.
        const results = await Promise.allSettled([
          recordDebtPayment(fx.userId, debt.id, { amount: 600_000, date: '2026-03-01' }),
          recordDebtPayment(fx.userId, debt.id, { amount: 600_000, date: '2026-03-01' }),
        ])

        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        const rejected = results.filter((result) => result.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0].reason).toBeInstanceOf(DebtOverpaymentError)
        // The loser saw the winner's committed payment, not the pre-race state.
        expect((rejected[0].reason as DebtOverpaymentError).outstanding.toString()).toBe('400000')

        expect(await paymentCount(debt.id)).toBe(1)
        expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('400000')
      }
    }, 30_000)

    it('resolves a payment racing a write-off one way or the other, never both', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)

      const [payment, writeOff] = await Promise.allSettled([
        recordDebtPayment(fx.userId, debt.id, { amount: 100, date: '2026-03-01' }),
        writeOffDebt(fx.userId, debt.id),
      ])

      // The write-off always wins the *outcome*: whichever order the lock is
      // acquired in, the debt ends up written off.
      expect(writeOff.status).toBe('fulfilled')
      const stored = await prisma.debt.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: debt.id } },
      })
      expect(stored.status).toBe('WRITTEN_OFF')

      const payments = await prisma.debtPayment.findMany({
        where: { userId: fx.userId, debtId: debt.id },
      })
      if (payment.status === 'fulfilled') {
        // The payment got the lock first: it committed before the write-off
        // could see it, and the history keeps it.
        expect(payments).toHaveLength(1)
        // And it landed *before* the write-off, never after it.
        expect(payments[0].createdAt.getTime()).toBeLessThanOrEqual(stored.updatedAt.getTime())
      } else {
        // The write-off got the lock first: the payment re-read the row under
        // the lock, saw WRITTEN_OFF, and wrote nothing.
        expect(payment.reason).toBeInstanceOf(DebtNotActiveError)
        expect(payments).toHaveLength(0)
      }
    }, 30_000)
  })

  describe('tenant isolation', () => {
    it("refuses every mutation and read on another user's debt and leaves their rows identical", async () => {
      const other = await createDebtUser()
      extraUserIds.push(other.userId)
      const theirs = await createDebt(other.userId, {
        direction: 'PAYABLE',
        person: 'Their lender',
        description: 'Theirs',
        originalAmount: 9_000_000,
        currency: 'VND',
        dueDate: '2027-01-31',
        notes: 'Theirs',
      })
      await recordDebtPayment(other.userId, theirs.id, { amount: 1_000, date: '2026-03-01' })
      const before = await prisma.debt.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
        include: { payments: true },
      })

      await expectPrismaCode(
        recordDebtPayment(fx.userId, theirs.id, { amount: 1, date: TODAY }),
        'P2025',
      )
      await expectPrismaCode(updateDebt(fx.userId, theirs.id, { person: 'Stolen' }), 'P2025')
      await expectPrismaCode(writeOffDebt(fx.userId, theirs.id), 'P2025')
      await expectPrismaCode(getDebtOutstanding(fx.userId, theirs.id), 'P2025')

      const after = await prisma.debt.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
        include: { payments: true },
      })
      // Byte-identical, `updatedAt` and the payment row included: not one of
      // the four attempts reached a write.
      expect(after).toEqual(before)
      // And the debt is invisible to the other user's reads, not merely
      // unwritable.
      expect(await listDebts(fx.userId)).toEqual([])
      expect(await getDebtsWithOutstanding(fx.userId, TODAY)).toEqual([])
    })

    it("rejects a DebtPayment pointing at another user's debt at the database level", async () => {
      const other = await createDebtUser()
      extraUserIds.push(other.userId)
      const mine = await createDebt(fx.userId, BASE_DEBT)

      const caught = await captureRejection(
        prisma.debtPayment.create({
          data: {
            userId: other.userId,
            debtId: mine.id,
            amount: new Prisma.Decimal('1'),
            date: calendarDateToUtcCarrier(TODAY),
          },
        }),
      )

      // The composite (userId, debtId) foreign key, not application code: even
      // bypassing the service entirely, a payment cannot reference another
      // user's debt.
      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')
      expect(await paymentCount(mine.id)).toBe(0)
    })
  })

  describe('database constraints', () => {
    it('rejects a zero or negative original amount even bypassing the service', async () => {
      for (const originalAmount of ['0', '-1']) {
        const caught = await captureRejection(
          prisma.debt.create({
            data: {
              userId: fx.userId,
              direction: 'RECEIVABLE',
              person: 'Bad amount',
              originalAmount: new Prisma.Decimal(originalAmount),
              currency: 'VND',
            },
          }),
        )

        // The CHECK's own name, so a migration that dropped it fails here
        // rather than passing quietly.
        expect(String(caught)).toContain('Debt_originalAmount_positive')
      }

      expect(await prisma.debt.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('rejects a zero or negative payment amount even bypassing the service', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)

      for (const amount of ['0', '-1']) {
        const caught = await captureRejection(
          prisma.debtPayment.create({
            data: {
              userId: fx.userId,
              debtId: debt.id,
              amount: new Prisma.Decimal(amount),
              date: calendarDateToUtcCarrier(TODAY),
            },
          }),
        )

        // A zero-amount payment row would also let "outstanding" claim progress
        // that never happened.
        expect(String(caught)).toContain('DebtPayment_amount_positive')
      }

      expect(await paymentCount(debt.id)).toBe(0)
    })
  })

  describe('tracking only — no money moves', () => {
    it('leaves accounts, transactions, transfers and the balance untouched by every mutation', async () => {
      // Every mutation the service has, in the sequence a real user would
      // produce, ending in a write-off. `afterEach` checks the ledger after
      // every case; this one exists so the check has run against the whole
      // surface at least once, in one place a reviewer can read.
      const debt = await createDebt(fx.userId, {
        ...BASE_DEBT,
        description: 'Tracking only',
        dueDate: '2026-06-30',
        notes: 'Tracking only',
      })
      await recordDebtPayment(fx.userId, debt.id, { amount: 400_000, date: '2026-03-01' })
      await updateDebt(fx.userId, debt.id, {
        person: 'Nguyen An',
        description: 'Edited',
        dueDate: '2026-07-31',
        notes: 'Edited',
      })
      await recordDebtPayment(fx.userId, debt.id, { amount: 600_000, date: '2026-03-10' })
      await captureRejection(
        recordDebtPayment(fx.userId, debt.id, { amount: 1, date: '2026-03-11' }),
      )
      await writeOffDebt(fx.userId, debt.id)
      await listDebts(fx.userId)
      await getDebtsWithOutstanding(fx.userId, TODAY)
      await getDebtOutstanding(fx.userId, debt.id)

      expect(await prisma.financialAccount.count({ where: { userId: fx.userId } })).toBe(
        ledger.accounts,
      )
      expect(await prisma.transaction.count({ where: { userId: fx.userId } })).toBe(
        ledger.transactions,
      )
      expect(await prisma.transfer.count({ where: { userId: fx.userId } })).toBe(ledger.transfers)
      expect((await getAccountBalance(fx.userId, fx.accountId)).toString()).toBe(ledger.balance)
      // Not just the counts: the rows themselves, field for field. A debt that
      // quietly rewrote an account's currency or an expense's amount would keep
      // every count identical.
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
     * The structural half of "no money moves": the service cannot touch the
     * ledger because it does not import anything that writes to it.
     *
     * Reading the source is deliberate rather than fragile. The behavioural
     * checks can only catch a write they happen to provoke, whereas a later
     * phase adding "record the repayment as a transaction too" would
     * reintroduce exactly the coupling spec §4.9 exists to avoid — and
     * importing the module is the first step of doing so. Only import
     * specifiers are matched, so the doc comment may keep naming these modules
     * to say why they are absent.
     */
    it('imports nothing that could move money or reach a live rate', () => {
      const source = readFileSync(fileURLToPath(new URL('./debt.ts', import.meta.url)), 'utf8')

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
  })
})
