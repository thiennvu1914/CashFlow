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
  closeLoan,
  createLoan,
  deriveLoanDisplayStatus,
  deriveLoanOutstandingPrincipal,
  getLoanOutstandingPrincipal,
  getLoansWithOutstanding,
  listLoans,
  recordLoanPayment,
  updateLoan,
  LoanNotActiveError,
  LoanOverpaymentError,
  LoanSplitMismatchError,
  type LoanWithOutstanding,
} from './loan'

/**
 * Group 4's data-layer acceptance check (spec §4.10).
 *
 * Seven properties are what this suite exists to hold:
 *
 * 1. **Nothing here moves money.** The fixture seeds an account and an EXPENSE
 *    transaction, and `afterEach` re-asserts the account / transaction /
 *    transfer counts, the two seeded rows field for field, and the account's
 *    derived balance — after *every* case, not just a dedicated one. A stray
 *    write to any of them fails the test that made it.
 * 2. **Outstanding principal is derived, never stored.** Every assertion goes
 *    through `principal − Σ principalAmount`; there is no column to check, and
 *    the `groupBy` sums and the included payment rows are asserted to agree.
 * 3. **Interest never reduces the principal.** An interest-only instalment is
 *    accepted and leaves the outstanding principal exactly where it was, which
 *    is the case a single-`amount` payment model cannot express at all.
 * 4. **The split holds at three layers.** Zod refuses a mismatched total before
 *    the database is touched, and the `LoanPayment_total_matches_split` CHECK
 *    refuses it even when the service is bypassed entirely.
 * 5. **The payment rule holds at the boundary and under concurrency.** The exact
 *    final principal payment is accepted, one cent more is refused, and two
 *    concurrent payments that would each fit alone cannot both commit — proved
 *    against the real database with `Promise.allSettled`, three times over. Two
 *    concurrent payments that *both* fit commit both, and advance the due date
 *    twice rather than losing one update.
 * 6. **The schedule does not drift.** `nextDueDate` advances by exactly one
 *    interval per accepted payment, from the anchor day: Jan 31 → Feb 28 →
 *    Mar 31, and 29 February in a leap year. Deterministic, because a carrier's
 *    UTC components are the calendar date.
 * 7. **Every query is tenant-scoped.** A second user's loan is targeted by each
 *    mutation and each read, which must fail with P2025 and leave the rows
 *    byte-identical; the composite FK refuses a cross-user payment with P2003
 *    even when the service is bypassed entirely.
 *
 * `fetch` is a throwing spy for every test and `afterEach` asserts it was never
 * called: a loan keeps its own currency and nothing here converts one, so any
 * network access — inside a held row lock, no less — would be a bug rather than
 * a slow test.
 */

/** UTC+7, no DST — so no assertion below depends on a DST date. */
const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

/**
 * The "today" every display-status assertion is made against, passed in
 * explicitly rather than read from the clock. `deriveLoanDisplayStatus` takes
 * `today` as an argument precisely so OVERDUE is deterministic: a suite that
 * used the real date would start failing on its own the day a fixture's due date
 * passed.
 */
const TODAY = '2026-03-15'

interface LoanFixture {
  userId: string
  accountId: string
  transactionId: string
}

/** The minimum a create needs — every case overrides what it cares about. */
const BASE_LOAN = {
  lender: 'Vietcombank',
  principal: 1_000_000,
  currency: 'VND' as const,
  interestRate: 8.5,
  startDate: '2026-01-01',
  termMonths: 12,
  paymentFrequency: 'MONTHLY' as const,
  scheduledPaymentAmount: 90_000,
  nextDueDate: '2026-02-01',
}

/**
 * A user with one account and one expense already recorded.
 *
 * The account and the transaction exist purely so "no account mutation" has
 * something that *could* be corrupted: with an empty ledger, "counts unchanged"
 * and "balance unchanged" would both hold trivially.
 */
async function createLoanUser(): Promise<LoanFixture> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `loan-${randomUUID()}@example.com`,
      name: 'Loan Test',
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
      fxRateSource: 'loan-test',
    },
  })
  return { userId: user.id, accountId: account.id, transactionId: transaction.id }
}

/** Deletes a user's rows in FK order, then the user. */
async function cleanupUsers(userIds: string[]) {
  if (userIds.length === 0) return
  try {
    await prisma.loanPayment.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.loan.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

/** Counts, rows and derived balance — everything a loan must not change. */
async function snapshotLedger(fx: LoanFixture) {
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

describe('deriveLoanOutstandingPrincipal', () => {
  it('is the principal minus the principal parts paid, and nothing else', () => {
    expect(deriveLoanOutstandingPrincipal(d('1000000'), d('0')).toString()).toBe('1000000')
    expect(deriveLoanOutstandingPrincipal(d('1000000'), d('80000')).toString()).toBe('920000')
    expect(deriveLoanOutstandingPrincipal(d('1000000'), d('1000000')).toString()).toBe('0')
  })

  it('keeps 2 decimal places exact rather than losing them to a float detour', () => {
    // 0.1 + 0.2 as doubles is 0.30000000000000004, so a `number` subtraction of
    // these values is where a naive implementation reports a residual cent the
    // user never owed — and "is this loan paid off?" is decided by comparing
    // this value with zero.
    expect(deriveLoanOutstandingPrincipal(d('0.30'), d('0.10').add(d('0.20'))).toString()).toBe('0')
    expect(deriveLoanOutstandingPrincipal(d('5000000'), d('1234.56')).toString()).toBe('4998765.44')
  })
})

describe('deriveLoanDisplayStatus', () => {
  const active = (nextDueDate: string) => ({
    status: 'ACTIVE' as const,
    nextDueDate: calendarDateToUtcCarrier(nextDueDate),
  })

  it('reports CLOSED whatever the arithmetic and the due date say', () => {
    const closed = { ...active('2020-01-01'), status: 'CLOSED' as const }

    expect(deriveLoanDisplayStatus(closed, d('500000'), TODAY)).toBe('CLOSED')
    expect(deriveLoanDisplayStatus(closed, d('0'), TODAY)).toBe('CLOSED')
  })

  it('reports PAID_OFF at zero outstanding principal, ahead of a past due date', () => {
    // The order matters: a loan whose principal is fully repaid is finished, and
    // telling the user an instalment is overdue on it would be chasing a debt
    // that no longer exists.
    expect(deriveLoanDisplayStatus(active('2026-01-31'), d('0'), TODAY)).toBe('PAID_OFF')
    expect(deriveLoanDisplayStatus(active('2026-04-30'), d('0'), TODAY)).toBe('PAID_OFF')
    // `lte(0)` rather than `eq(0)`: what Postgres hands back for a
    // `Decimal(18, 2)` column is "0.00", and any negative residue (only
    // reachable by writing rows outside the service) still reads as finished.
    expect(deriveLoanDisplayStatus(active('2026-01-31'), d('0.00'), TODAY)).toBe('PAID_OFF')
  })

  it('reports OVERDUE when the next instalment was due before today', () => {
    expect(deriveLoanDisplayStatus(active('2026-03-14'), d('1000000'), TODAY)).toBe('OVERDUE')
    expect(deriveLoanDisplayStatus(active('2026-01-31'), d('0.01'), TODAY)).toBe('OVERDUE')
  })

  it('does not report OVERDUE on the due date itself', () => {
    // "Due today" is not late — the comparison is strictly `nextDueDate < today`
    // on the two calendar strings, so the user has the whole day.
    expect(deriveLoanDisplayStatus(active(TODAY), d('1000000'), TODAY)).toBe('ACTIVE')
    expect(deriveLoanDisplayStatus(active('2026-03-16'), d('1000000'), TODAY)).toBe('ACTIVE')
  })
})

describe('LoanSplitMismatchError', () => {
  it('carries the split copy the action layer maps', () => {
    // The service re-checks `total = principal + interest` in `Prisma.Decimal`
    // under the row lock, as the second of the invariant's three layers. No case
    // in this suite can provoke it end to end — `recordLoanPaymentSchema`'s
    // exact-cents refine runs first and rejects the same inputs — which is
    // precisely why the class is asserted here rather than left untested: Group
    // 5's error map imports it, so its name and message are contract.
    const error = new LoanSplitMismatchError()

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('LoanSplitMismatchError')
    expect(error.message).toBe('Total must equal principal plus interest.')
  })
})

describe('loan service', () => {
  let fetchSpy: MockInstance
  let fx: LoanFixture
  let ledger: Awaited<ReturnType<typeof snapshotLedger>>
  /** Extra users a single case created; cleaned up with the fixture. */
  let extraUserIds: string[]

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    extraUserIds = []
    fx = await createLoanUser()
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
      // In `finally`, so a ledger assertion that fails still leaves the database
      // clean for the next case rather than turning one real failure into a
      // cascade of unrelated ones.
      await cleanupUsers([fx.userId, ...extraUserIds])
    }
    // A loan keeps its own currency and is never converted, so no code path here
    // has any reason to reach an FX provider.
    expect(fetchCalls).toBe(0)
  })

  /** The `getLoansWithOutstanding` entry for one loan — the real read path the
   *  page uses, rather than a second derivation written in the test. */
  async function entryFor(loanId: string, today = TODAY): Promise<LoanWithOutstanding> {
    const entries = await getLoansWithOutstanding(fx.userId, today)
    const entry = entries.find((candidate) => candidate.loan.id === loanId)
    if (!entry) throw new Error(`Loan ${loanId} is missing from getLoansWithOutstanding`)
    return entry
  }

  function storedLoan(loanId: string) {
    return prisma.loan.findUniqueOrThrow({
      where: { userId_id: { userId: fx.userId, id: loanId } },
    })
  }

  /** The stored `nextDueDate` as a calendar string — the only honest way to read
   *  a carrier back. */
  async function dueDate(loanId: string): Promise<string> {
    return formatCalendarDate((await storedLoan(loanId)).nextDueDate)
  }

  async function paymentCount(loanId: string): Promise<number> {
    return prisma.loanPayment.count({ where: { userId: fx.userId, loanId } })
  }

  /** A raw `Loan` insert, for the CHECK-constraint cases that bypass the
   *  service entirely. */
  function directLoanData(overrides: Partial<Prisma.LoanUncheckedCreateInput> = {}) {
    return {
      userId: fx.userId,
      lender: 'Direct',
      principal: new Prisma.Decimal('1000000'),
      currency: 'VND' as const,
      interestRate: new Prisma.Decimal('8.5'),
      startDate: calendarDateToUtcCarrier('2026-01-01'),
      termMonths: 12,
      paymentFrequency: 'MONTHLY' as const,
      scheduledPaymentAmount: new Prisma.Decimal('90000'),
      nextDueDate: calendarDateToUtcCarrier('2026-02-01'),
      dueDayOfMonth: 1,
      ...overrides,
    }
  }

  describe('create', () => {
    it('creates a loan with every field, ACTIVE, and dates that round-trip', async () => {
      const loan = await createLoan(fx.userId, {
        lender: 'Vietcombank',
        principal: 100_000_000,
        currency: 'VND',
        interestRate: 8.5,
        startDate: '2026-01-01',
        termMonths: 24,
        paymentFrequency: 'MONTHLY',
        scheduledPaymentAmount: 4_600_000,
        nextDueDate: '2026-01-31',
        notes: 'Home improvement loan',
      })

      expect(loan.userId).toBe(fx.userId)
      expect(loan.lender).toBe('Vietcombank')
      expect(loan.principal.toString()).toBe('100000000')
      expect(loan.currency).toBe('VND')
      expect(loan.interestRate.toString()).toBe('8.5')
      expect(loan.termMonths).toBe(24)
      expect(loan.paymentFrequency).toBe('MONTHLY')
      expect(loan.scheduledPaymentAmount.toString()).toBe('4600000')
      expect(loan.notes).toBe('Home improvement loan')
      expect(loan.status).toBe('ACTIVE')
      expect(loan.payments).toEqual([])

      // The anchor, derived rather than submitted: this loan is due on the 31st,
      // and that is what keeps the schedule off the 28th from February onwards.
      expect(loan.dueDayOfMonth).toBe(31)

      // Not 2026-01-30T17:00Z (the +07 midnight) and not the 30th read back: the
      // stored instants' UTC components ARE the calendar dates the user picked,
      // in every zone.
      expect(loan.startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z')
      expect(loan.nextDueDate.toISOString()).toBe('2026-01-31T00:00:00.000Z')
      const stored = await storedLoan(loan.id)
      expect(formatCalendarDate(stored.startDate)).toBe('2026-01-01')
      expect(formatCalendarDate(stored.nextDueDate)).toBe('2026-01-31')
    })

    it('creates a loan with no notes and a zero interest rate', async () => {
      const loan = await createLoan(fx.userId, {
        ...BASE_LOAN,
        lender: 'Family',
        interestRate: 0,
        currency: 'USD',
        principal: 2_000,
      })

      expect(loan.notes).toBeNull()
      expect(loan.interestRate.toString()).toBe('0')
      expect(loan.currency).toBe('USD')
      expect(loan.status).toBe('ACTIVE')
    })

    it('takes the anchor day from the due date, whichever day that is', async () => {
      for (const [nextDueDate, expected] of [
        ['2026-02-01', 1],
        ['2026-02-15', 15],
        ['2026-01-31', 31],
        ['2028-02-29', 29],
      ] as const) {
        const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate })

        expect(loan.dueDayOfMonth).toBe(expected)
      }
    })

    it('ignores a client-supplied status and anchor day', async () => {
      // Zod strips both and the service writes neither from input: a crafted
      // request cannot create an already-closed loan, nor an anchor that
      // disagrees with the stored due date.
      const loan = await createLoan(fx.userId, {
        ...BASE_LOAN,
        nextDueDate: '2026-01-31',
        ...({ status: 'CLOSED', dueDayOfMonth: 5 } as object),
      })

      expect(loan.status).toBe('ACTIVE')
      expect(loan.dueDayOfMonth).toBe(31)
    })

    it('rejects an impossible date rather than storing a rolled-over one', async () => {
      await expect(
        createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-02-30' }),
      ).rejects.toThrow()
      await expect(
        createLoan(fx.userId, { ...BASE_LOAN, startDate: '2026-02-30' }),
      ).rejects.toThrow()

      expect(await prisma.loan.count({ where: { userId: fx.userId } })).toBe(0)
    })
  })

  describe('outstanding principal and display status', () => {
    it('reports the full principal and ACTIVE before any payment', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })

      expect((await getLoanOutstandingPrincipal(fx.userId, loan.id)).toString()).toBe('1000000')
      const entry = await entryFor(loan.id)
      expect(entry.principalPaid.toString()).toBe('0')
      expect(entry.interestPaid.toString()).toBe('0')
      expect(entry.outstandingPrincipal.toString()).toBe('1000000')
      expect(entry.displayStatus).toBe('ACTIVE')
    })

    it('reduces the outstanding principal by the principal part only', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })

      const { payment, nextDueDate } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-03-01',
        note: 'February instalment',
      })

      expect(payment.userId).toBe(fx.userId)
      expect(payment.loanId).toBe(loan.id)
      expect(payment.totalAmount.toString()).toBe('90000')
      expect(payment.principalAmount.toString()).toBe('80000')
      expect(payment.interestAmount.toString()).toBe('10000')
      expect(payment.note).toBe('February instalment')
      expect(formatCalendarDate(payment.paymentDate)).toBe('2026-03-01')
      expect(formatCalendarDate(nextDueDate)).toBe('2026-05-01')

      // 1,000,000 − 80,000: the 10,000 of interest is the cost of the loan and
      // reduces nothing.
      expect((await getLoanOutstandingPrincipal(fx.userId, loan.id)).toString()).toBe('920000')
      const entry = await entryFor(loan.id)
      expect(entry.principalPaid.toString()).toBe('80000')
      expect(entry.interestPaid.toString()).toBe('10000')
      expect(entry.outstandingPrincipal.toString()).toBe('920000')
      expect(entry.displayStatus).toBe('ACTIVE')
    })

    it('accepts an interest-only instalment and leaves the principal untouched', async () => {
      // Ruling R6-6: a grace period, and the early months of many loans, are
      // interest only. Refusing a zero principal would make those instalments
      // unrecordable.
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })

      const { payment } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 5_000,
        principalAmount: 0,
        interestAmount: 5_000,
        paymentDate: '2026-03-01',
      })

      expect(payment.principalAmount.toString()).toBe('0')
      const entry = await entryFor(loan.id)
      expect(entry.outstandingPrincipal.toString()).toBe('1000000')
      expect(entry.interestPaid.toString()).toBe('5000')
      // Still owed in full, and the schedule still moved on — the instalment did
      // happen.
      expect(entry.displayStatus).toBe('ACTIVE')
      expect(await dueDate(loan.id)).toBe('2026-05-01')
    })

    it('keeps a 2dp split exact rather than losing a cent to a float', async () => {
      const loan = await createLoan(fx.userId, {
        ...BASE_LOAN,
        principal: 5_000_000,
        nextDueDate: '2026-04-01',
      })

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 0.03,
        principalAmount: 0.01,
        interestAmount: 0.02,
        paymentDate: '2026-03-01',
      })

      const entry = await entryFor(loan.id)
      expect(entry.principalPaid.toString()).toBe('0.01')
      expect(entry.interestPaid.toString()).toBe('0.02')
      expect(entry.outstandingPrincipal.toString()).toBe('4999999.99')
    })

    it('accepts the exact final principal payment: outstanding 0 and PAID_OFF', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 410_000,
        principalAmount: 400_000,
        interestAmount: 10_000,
        paymentDate: '2026-03-01',
      })

      // Exactly what is left — the boundary the overpayment rule must not
      // refuse, and the one a float comparison is most likely to get wrong.
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 600_000,
        principalAmount: 600_000,
        interestAmount: 0,
        paymentDate: '2026-03-10',
      })

      expect((await getLoanOutstandingPrincipal(fx.userId, loan.id)).toString()).toBe('0')
      const entry = await entryFor(loan.id)
      expect(entry.outstandingPrincipal.toString()).toBe('0')
      expect(entry.displayStatus).toBe('PAID_OFF')
      // The row itself is still ACTIVE: PAID_OFF is derived, never stored.
      expect(entry.loan.status).toBe('ACTIVE')
    })

    it('reports OVERDUE once the next instalment is past due', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-03-14' })

      expect((await entryFor(loan.id)).displayStatus).toBe('OVERDUE')
    })

    it('does not report OVERDUE on the due date itself', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: TODAY })

      expect((await entryFor(loan.id)).displayStatus).toBe('ACTIVE')
      // And the day after, the same row is overdue — the only thing that changed
      // is the `today` the caller passed in.
      expect((await entryFor(loan.id, '2026-03-16')).displayStatus).toBe('OVERDUE')
    })

    it('reports PAID_OFF rather than OVERDUE on a fully repaid, past-due loan', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-01-31' })

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000_000,
        principalAmount: 1_000_000,
        interestAmount: 0,
        paymentDate: '2026-02-01',
      })

      // A repaid loan is finished. Showing an overdue instalment on it would be
      // chasing money the user no longer owes — even though the stored
      // `nextDueDate` (advanced to 2026-02-28) is still in the past.
      expect(await dueDate(loan.id)).toBe('2026-02-28')
      expect((await entryFor(loan.id)).displayStatus).toBe('PAID_OFF')
    })
  })

  describe('overpayment', () => {
    it('refuses a principal above the outstanding principal, writes nothing and does not advance the due date', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 600_000,
        principalAmount: 600_000,
        interestAmount: 0,
        paymentDate: '2026-03-01',
      })

      const caught = await captureRejection(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 400_000.01,
          principalAmount: 400_000.01,
          interestAmount: 0,
          paymentDate: '2026-03-10',
        }),
      )

      expect(caught).toBeInstanceOf(LoanOverpaymentError)
      // The outstanding principal travels on the error so the form can say what
      // would fit, without the caller re-querying (and re-racing) for it.
      expect((caught as LoanOverpaymentError).outstandingPrincipal.toString()).toBe('400000')
      expect((caught as LoanOverpaymentError).message).toBe(
        'Principal payment exceeds the outstanding principal.',
      )
      // Nothing partially applied. This is what proves atomicity without
      // simulating a crash: if the rejected payment had got as far as its own
      // write, the due date would have advanced with no instalment behind it.
      expect(await paymentCount(loan.id)).toBe(1)
      expect(await dueDate(loan.id)).toBe('2026-05-01')
      expect((await getLoanOutstandingPrincipal(fx.userId, loan.id)).toString()).toBe('400000')
    })

    it('refuses any principal against a fully repaid loan but still accepts interest', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000_000,
        principalAmount: 1_000_000,
        interestAmount: 0,
        paymentDate: '2026-03-01',
      })

      const caught = await captureRejection(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 0.01,
          principalAmount: 0.01,
          interestAmount: 0,
          paymentDate: '2026-03-10',
        }),
      )

      expect(caught).toBeInstanceOf(LoanOverpaymentError)
      expect((caught as LoanOverpaymentError).outstandingPrincipal.toString()).toBe('0')
      // A repaid loan can still owe a final interest charge, so a zero-principal
      // instalment is not an overpayment.
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000,
        principalAmount: 0,
        interestAmount: 1_000,
        paymentDate: '2026-03-11',
      })

      expect(await paymentCount(loan.id)).toBe(2)
      expect((await entryFor(loan.id)).interestPaid.toString()).toBe('1000')
    })

    it('rejects a mismatched split, a negative part and an invalid date before touching the database', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })

      // Zod, the first of the split's three layers: the database is never
      // reached, so the due date cannot move either.
      await expect(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 90_000,
          principalAmount: 80_000,
          interestAmount: 9_999.99,
          paymentDate: '2026-03-01',
        }),
      ).rejects.toThrow(/Total must equal principal plus interest/)
      await expect(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 80_000,
          principalAmount: -10_000,
          interestAmount: 90_000,
          paymentDate: '2026-03-01',
        }),
      ).rejects.toThrow(/The principal cannot be negative/)
      await expect(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 70_000,
          principalAmount: 80_000,
          interestAmount: -10_000,
          paymentDate: '2026-03-01',
        }),
      ).rejects.toThrow(/The interest cannot be negative/)
      await expect(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 0,
          principalAmount: 0,
          interestAmount: 0,
          paymentDate: '2026-03-01',
        }),
      ).rejects.toThrow(/Amount must be greater than zero/)
      await expect(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 90_000,
          principalAmount: 80_000,
          interestAmount: 10_000,
          paymentDate: '2026-02-30',
        }),
      ).rejects.toThrow(/Enter a real date/)

      expect(await paymentCount(loan.id)).toBe(0)
      expect(await dueDate(loan.id)).toBe('2026-04-01')
    })
  })

  describe('the due date advances by exactly one interval', () => {
    it('advances a MONTHLY loan one month per accepted payment', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)

      const first = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })

      expect(formatCalendarDate(first.nextDueDate)).toBe('2026-03-01')
      expect(await dueDate(loan.id)).toBe('2026-03-01')

      const second = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-03-01',
      })

      expect(formatCalendarDate(second.nextDueDate)).toBe('2026-04-01')
    })

    it('keeps a month-end loan on the last day, then back on the 31st', async () => {
      // The case `+30 days` and a plain clamp both get wrong: without the anchor
      // this schedule would read Jan 31 → Feb 28 → Mar 28 and stay three days
      // early for the rest of the term.
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-01-31' })
      expect(loan.dueDayOfMonth).toBe(31)

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-01-31',
      })
      expect(await dueDate(loan.id)).toBe('2026-02-28')

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-28',
      })

      expect(await dueDate(loan.id)).toBe('2026-03-31')
    })

    it('lands on 29 February in a leap year, then back on the 31st', async () => {
      const loan = await createLoan(fx.userId, {
        ...BASE_LOAN,
        startDate: '2028-01-01',
        nextDueDate: '2028-01-31',
      })

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2028-01-31',
      })
      expect(await dueDate(loan.id)).toBe('2028-02-29')

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2028-02-29',
      })

      expect(await dueDate(loan.id)).toBe('2028-03-31')
    })

    it('advances a WEEKLY loan by exactly seven days, across a month end', async () => {
      const loan = await createLoan(fx.userId, {
        ...BASE_LOAN,
        paymentFrequency: 'WEEKLY',
        nextDueDate: '2026-01-31',
      })

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 20_000,
        principalAmount: 18_000,
        interestAmount: 2_000,
        paymentDate: '2026-01-31',
      })

      // The anchor day is 31 and is deliberately ignored: a weekly schedule has
      // no day of the month to hold on to.
      expect(await dueDate(loan.id)).toBe('2026-02-07')
    })

    it('advances a YEARLY loan twelve months, clamping a 29 February anchor', async () => {
      const loan = await createLoan(fx.userId, {
        ...BASE_LOAN,
        startDate: '2028-01-01',
        paymentFrequency: 'YEARLY',
        nextDueDate: '2028-02-29',
      })
      expect(loan.dueDayOfMonth).toBe(29)

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2028-02-29',
      })
      expect(await dueDate(loan.id)).toBe('2029-02-28')

      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2029-02-28',
      })

      // The anchor survives the clamp: still the 29th when the day exists again,
      // and the 28th while it does not.
      expect(await dueDate(loan.id)).toBe('2030-02-28')
    })
  })

  describe('close', () => {
    it('sets CLOSED and then refuses further payments and edits', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-03-01',
      })

      const closed = await closeLoan(fx.userId, loan.id)

      expect(closed.status).toBe('CLOSED')
      const entry = await entryFor(loan.id)
      expect(entry.displayStatus).toBe('CLOSED')
      // The arithmetic still says 920,000 of principal is outstanding; the
      // user's decision outranks it, and the figure is kept rather than zeroed.
      expect(entry.outstandingPrincipal.toString()).toBe('920000')

      await expect(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 1_000,
          principalAmount: 1_000,
          interestAmount: 0,
          paymentDate: '2026-03-16',
        }),
      ).rejects.toThrow(LoanNotActiveError)
      await expect(
        updateLoan(fx.userId, loan.id, { lender: 'Renamed', scheduledPaymentAmount: 1 }),
      ).rejects.toThrow(LoanNotActiveError)
      expect(await paymentCount(loan.id)).toBe(1)
      expect(await dueDate(loan.id)).toBe('2026-05-01')
    })

    it('is a no-op when the loan is already closed', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const first = await closeLoan(fx.userId, loan.id)

      const second = await closeLoan(fx.userId, loan.id)

      expect(second.status).toBe('CLOSED')
      // A true no-op: no write happened, so `updatedAt` did not move. A
      // double-click on "Close" is the same request that already succeeded.
      expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime())
    })

    it('keeps the loan and its instalment history readable afterwards', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-03-10',
      })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 50_000,
        principalAmount: 45_000,
        interestAmount: 5_000,
        paymentDate: '2026-02-01',
      })
      await closeLoan(fx.userId, loan.id)

      const [listed] = await listLoans(fx.userId)

      expect(listed.id).toBe(loan.id)
      expect(listed.status).toBe('CLOSED')
      // Closing a loan records a decision; it never deletes what happened.
      // Instalments come back oldest first, whatever order they were entered in.
      expect(listed.payments.map((p) => p.totalAmount.toString())).toEqual(['50000', '90000'])
      expect(listed.payments.map((p) => formatCalendarDate(p.paymentDate))).toEqual([
        '2026-02-01',
        '2026-03-10',
      ])
    })
  })

  describe('update', () => {
    it('changes the lender, the scheduled instalment and the notes', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, notes: 'Original notes' })

      const updated = await updateLoan(fx.userId, loan.id, {
        lender: 'Vietcombank (refinanced)',
        scheduledPaymentAmount: 95_000,
        notes: 'Rate reset in March',
      })

      expect(updated.lender).toBe('Vietcombank (refinanced)')
      expect(updated.scheduledPaymentAmount.toString()).toBe('95000')
      expect(updated.notes).toBe('Rate reset in March')
      // The defining terms are untouched — they are not editable at all.
      expect(updated.principal.toString()).toBe('1000000')
      expect(updated.currency).toBe('VND')
      expect(updated.interestRate.toString()).toBe('8.5')
      expect(updated.termMonths).toBe(12)
      expect(updated.paymentFrequency).toBe('MONTHLY')
      expect(formatCalendarDate(updated.nextDueDate)).toBe('2026-02-01')
      expect(updated.dueDayOfMonth).toBe(1)
    })

    it('clears the notes when the field comes back empty', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, notes: 'Original notes' })

      const updated = await updateLoan(fx.userId, loan.id, {
        lender: 'Vietcombank',
        scheduledPaymentAmount: 90_000,
      })

      // The absence has to be *written*: skipping the field would leave the old
      // notes in place, so a user could never remove them.
      expect(updated.notes).toBeNull()
    })
  })

  describe('getLoansWithOutstanding', () => {
    it('returns one entry per loan whose sums agree with the included payments', async () => {
      const none = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'None' })
      const partly = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Partly' })
      const full = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Full' })
      await recordLoanPayment(fx.userId, partly.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })
      await recordLoanPayment(fx.userId, partly.id, {
        totalAmount: 250_000.5,
        principalAmount: 200_000.25,
        interestAmount: 50_000.25,
        paymentDate: '2026-03-01',
      })
      await recordLoanPayment(fx.userId, full.id, {
        totalAmount: 1_050_000,
        principalAmount: 1_000_000,
        interestAmount: 50_000,
        paymentDate: '2026-02-01',
      })

      const entries = await getLoansWithOutstanding(fx.userId, TODAY)

      expect(entries.map((entry) => entry.loan.id)).toEqual([none.id, partly.id, full.id])
      for (const entry of entries) {
        // The `groupBy` sums are the authoritative figures and the included
        // payments are the history the page renders. If they ever disagreed, the
        // UI would show a total its own rows do not add up to.
        const fromRows = entry.loan.payments.reduce(
          (totals, payment) => ({
            principal: totals.principal.add(payment.principalAmount),
            interest: totals.interest.add(payment.interestAmount),
          }),
          { principal: new Prisma.Decimal(0), interest: new Prisma.Decimal(0) },
        )
        expect(entry.principalPaid.toString()).toBe(fromRows.principal.toString())
        expect(entry.interestPaid.toString()).toBe(fromRows.interest.toString())
        expect(entry.outstandingPrincipal.toString()).toBe(
          entry.loan.principal.sub(fromRows.principal).toString(),
        )
      }
      expect(entries.map((entry) => entry.principalPaid.toString())).toEqual([
        '0',
        '280000.25',
        '1000000',
      ])
      expect(entries.map((entry) => entry.interestPaid.toString())).toEqual([
        '0',
        '60000.25',
        '50000',
      ])
      // All three statuses are derived from the same two facts and disagree for
      // good reasons: 'None' never paid, so its due date is still 2026-02-01 and
      // it is late; 'Partly' paid twice, so its schedule has moved to
      // 2026-04-01; and 'Full' is PAID_OFF even though *its* due date
      // (2026-03-01) is also in the past — the repayment outranks the schedule.
      expect(entries.map((entry) => entry.displayStatus)).toEqual(['OVERDUE', 'ACTIVE', 'PAID_OFF'])
    })

    it('uses one findMany and one groupBy however many loans there are', async () => {
      for (const lender of ['A', 'B', 'C']) {
        const loan = await createLoan(fx.userId, { ...BASE_LOAN, lender })
        await recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 3_000,
          principalAmount: 1_000,
          interestAmount: 2_000,
          paymentDate: '2026-02-01',
        })
        await recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 3_000,
          principalAmount: 2_000,
          interestAmount: 1_000,
          paymentDate: '2026-03-01',
        })
      }
      const findMany = vi.spyOn(prisma.loan, 'findMany')
      const groupBy = vi.spyOn(prisma.loanPayment, 'groupBy')

      const entries = await getLoansWithOutstanding(fx.userId, TODAY)

      expect(entries).toHaveLength(3)
      // Three loans, six instalments, two queries: a per-loan sum would be two
      // more round trips for every loan the user adds.
      expect(findMany).toHaveBeenCalledTimes(1)
      expect(groupBy).toHaveBeenCalledTimes(1)
      expect(entries.every((entry) => entry.principalPaid.toString() === '3000')).toBe(true)
      expect(entries.every((entry) => entry.interestPaid.toString() === '3000')).toBe(true)
    })

    it('excludes closed loans when activeOnly is set', async () => {
      const live = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Live' })
      const gone = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Gone' })
      await closeLoan(fx.userId, gone.id)

      const activeOnly = await getLoansWithOutstanding(fx.userId, TODAY, { activeOnly: true })
      const everything = await getLoansWithOutstanding(fx.userId, TODAY)

      expect(activeOnly.map((entry) => entry.loan.id)).toEqual([live.id])
      expect(everything.map((entry) => entry.loan.id)).toEqual([live.id, gone.id])
      expect(everything[1].displayStatus).toBe('CLOSED')
    })

    it('returns nothing for a user with no loans', async () => {
      expect(await getLoansWithOutstanding(fx.userId, TODAY)).toEqual([])
      expect(await listLoans(fx.userId)).toEqual([])
    })
  })

  describe('listLoans', () => {
    it('lists every status, active first, then oldest first', async () => {
      const first = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'First' })
      const second = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Second' })
      const third = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Third' })
      await closeLoan(fx.userId, first.id)

      const listed = await listLoans(fx.userId)

      // ACTIVE before CLOSED, and within a status the creation order — even
      // though 'First' was created first.
      expect(listed.map((loan) => `${loan.lender}:${loan.status}`)).toEqual([
        'Second:ACTIVE',
        'Third:ACTIVE',
        'First:CLOSED',
      ])
      expect(listed.map((loan) => loan.id)).toEqual([second.id, third.id, first.id])
    })
  })

  describe('concurrency', () => {
    it('lets only one of two concurrent payments through when both would fit alone', async () => {
      // Three runs, because a race that passes once may simply have been
      // scheduled kindly. Each run is a fresh loan so the previous run's
      // payments cannot mask a failure.
      for (const run of [1, 2, 3]) {
        const loan = await createLoan(fx.userId, { ...BASE_LOAN, lender: `Race ${run}` })

        // 600,000 of principal each: either alone fits inside 1,000,000, both
        // together do not. Without the row lock both would read the same
        // outstanding principal, both would pass their check, and the loan would
        // end up 200,000 over-repaid.
        const results = await Promise.allSettled([
          recordLoanPayment(fx.userId, loan.id, {
            totalAmount: 600_000,
            principalAmount: 600_000,
            interestAmount: 0,
            paymentDate: '2026-02-01',
          }),
          recordLoanPayment(fx.userId, loan.id, {
            totalAmount: 600_000,
            principalAmount: 600_000,
            interestAmount: 0,
            paymentDate: '2026-02-01',
          }),
        ])

        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        const rejected = results.filter((result) => result.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0].reason).toBeInstanceOf(LoanOverpaymentError)
        // The loser saw the winner's committed payment, not the pre-race state.
        expect((rejected[0].reason as LoanOverpaymentError).outstandingPrincipal.toString()).toBe(
          '400000',
        )

        expect(await paymentCount(loan.id)).toBe(1)
        expect((await getLoanOutstandingPrincipal(fx.userId, loan.id)).toString()).toBe('400000')
        // And the schedule moved exactly once: the rejected payment left no
        // trace at all.
        expect(await dueDate(loan.id)).toBe('2026-03-01')
      }
    }, 30_000)

    it('commits both of two concurrent payments that fit, advancing the due date twice', async () => {
      for (const run of [1, 2, 3]) {
        const loan = await createLoan(fx.userId, { ...BASE_LOAN, lender: `Both ${run}` })

        const results = await Promise.allSettled([
          recordLoanPayment(fx.userId, loan.id, {
            totalAmount: 110_000,
            principalAmount: 100_000,
            interestAmount: 10_000,
            paymentDate: '2026-02-01',
          }),
          recordLoanPayment(fx.userId, loan.id, {
            totalAmount: 110_000,
            principalAmount: 100_000,
            interestAmount: 10_000,
            paymentDate: '2026-02-01',
          }),
        ])

        expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
        expect(await paymentCount(loan.id)).toBe(2)
        expect((await getLoanOutstandingPrincipal(fx.userId, loan.id)).toString()).toBe('800000')
        // The point of holding the lock across the *whole* read-modify-write of
        // the due date: the second payment re-read 2026-03-01 rather than the
        // pre-race 2026-02-01, so neither advance was lost.
        expect(await dueDate(loan.id)).toBe('2026-04-01')
      }
    }, 30_000)

    it('resolves a payment racing a close one way or the other, never both', async () => {
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01' })

      const [payment, close] = await Promise.allSettled([
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 1_000,
          principalAmount: 900,
          interestAmount: 100,
          paymentDate: '2026-03-01',
        }),
        closeLoan(fx.userId, loan.id),
      ])

      // The close always wins the *outcome*: whichever order the lock is
      // acquired in, the loan ends up closed.
      expect(close.status).toBe('fulfilled')
      const stored = await storedLoan(loan.id)
      expect(stored.status).toBe('CLOSED')

      const payments = await prisma.loanPayment.findMany({
        where: { userId: fx.userId, loanId: loan.id },
      })
      if (payment.status === 'fulfilled') {
        // The payment got the lock first: it committed before the close could
        // see it, and the history keeps it.
        expect(payments).toHaveLength(1)
        expect(payments[0].createdAt.getTime()).toBeLessThanOrEqual(stored.updatedAt.getTime())
        expect(formatCalendarDate(stored.nextDueDate)).toBe('2026-05-01')
      } else {
        // The close got the lock first: the payment re-read the row under the
        // lock, saw CLOSED, and wrote nothing — not the instalment, and not the
        // due date.
        expect(payment.reason).toBeInstanceOf(LoanNotActiveError)
        expect(payments).toHaveLength(0)
        expect(formatCalendarDate(stored.nextDueDate)).toBe('2026-04-01')
      }
    }, 30_000)
  })

  describe('tenant isolation', () => {
    it("refuses every mutation and read on another user's loan and leaves their rows identical", async () => {
      const other = await createLoanUser()
      extraUserIds.push(other.userId)
      const theirs = await createLoan(other.userId, {
        ...BASE_LOAN,
        lender: 'Their bank',
        principal: 9_000_000,
        notes: 'Theirs',
      })
      await recordLoanPayment(other.userId, theirs.id, {
        totalAmount: 1_000,
        principalAmount: 900,
        interestAmount: 100,
        paymentDate: '2026-02-01',
      })
      const before = await prisma.loan.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
        include: { payments: true },
      })

      await expectPrismaCode(
        recordLoanPayment(fx.userId, theirs.id, {
          totalAmount: 1,
          principalAmount: 1,
          interestAmount: 0,
          paymentDate: TODAY,
        }),
        'P2025',
      )
      await expectPrismaCode(
        updateLoan(fx.userId, theirs.id, { lender: 'Stolen', scheduledPaymentAmount: 1 }),
        'P2025',
      )
      await expectPrismaCode(closeLoan(fx.userId, theirs.id), 'P2025')
      await expectPrismaCode(getLoanOutstandingPrincipal(fx.userId, theirs.id), 'P2025')

      const after = await prisma.loan.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
        include: { payments: true },
      })
      // Byte-identical, `updatedAt`, `nextDueDate` and the payment row included:
      // not one of the four attempts reached a write.
      expect(after).toEqual(before)
      // And the loan is invisible to the other user's reads, not merely
      // unwritable.
      expect(await listLoans(fx.userId)).toEqual([])
      expect(await getLoansWithOutstanding(fx.userId, TODAY)).toEqual([])
    })

    it("rejects a LoanPayment pointing at another user's loan at the database level", async () => {
      const other = await createLoanUser()
      extraUserIds.push(other.userId)
      const mine = await createLoan(fx.userId, BASE_LOAN)

      const caught = await captureRejection(
        prisma.loanPayment.create({
          data: {
            userId: other.userId,
            loanId: mine.id,
            totalAmount: new Prisma.Decimal('1'),
            principalAmount: new Prisma.Decimal('1'),
            interestAmount: new Prisma.Decimal('0'),
            paymentDate: calendarDateToUtcCarrier(TODAY),
          },
        }),
      )

      // The composite (userId, loanId) foreign key, not application code: even
      // bypassing the service entirely, a payment cannot reference another
      // user's loan.
      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')
      expect(await paymentCount(mine.id)).toBe(0)
    })
  })

  describe('database constraints', () => {
    it.each([
      [{ principal: new Prisma.Decimal('0') }, 'Loan_principal_positive'],
      [{ principal: new Prisma.Decimal('-1') }, 'Loan_principal_positive'],
      [{ interestRate: new Prisma.Decimal('-0.001') }, 'Loan_interestRate_nonnegative'],
      [{ termMonths: 0 }, 'Loan_termMonths_positive'],
      [{ termMonths: -12 }, 'Loan_termMonths_positive'],
      [{ scheduledPaymentAmount: new Prisma.Decimal('0') }, 'Loan_scheduledPaymentAmount_positive'],
      [{ dueDayOfMonth: 0 }, 'Loan_dueDayOfMonth_range'],
      [{ dueDayOfMonth: 32 }, 'Loan_dueDayOfMonth_range'],
    ])('rejects %o even bypassing the service', async (patch, constraint) => {
      const caught = await captureRejection(prisma.loan.create({ data: directLoanData(patch) }))

      // The CHECK's own name, so a migration that dropped it fails here rather
      // than passing quietly.
      expect(String(caught)).toContain(constraint)
      expect(await prisma.loan.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it.each([
      // The split invariant's third layer: the only one a direct insert still
      // has to answer to.
      [
        { totalAmount: '90000', principalAmount: '80000', interestAmount: '9999.99' },
        'LoanPayment_total_matches_split',
      ],
      [
        { totalAmount: '90000', principalAmount: '80000', interestAmount: '0' },
        'LoanPayment_total_matches_split',
      ],
      [
        { totalAmount: '70000', principalAmount: '80000', interestAmount: '-10000' },
        'LoanPayment_interest_nonnegative',
      ],
      [
        { totalAmount: '70000', principalAmount: '-10000', interestAmount: '80000' },
        'LoanPayment_principal_nonnegative',
      ],
      // A zero-amount instalment row would let a history claim a payment that
      // never happened.
      [
        { totalAmount: '0', principalAmount: '0', interestAmount: '0' },
        'LoanPayment_total_positive',
      ],
    ])('rejects %o even bypassing the service', async (amounts, constraint) => {
      const loan = await createLoan(fx.userId, BASE_LOAN)

      const caught = await captureRejection(
        prisma.loanPayment.create({
          data: {
            userId: fx.userId,
            loanId: loan.id,
            totalAmount: new Prisma.Decimal(amounts.totalAmount),
            principalAmount: new Prisma.Decimal(amounts.principalAmount),
            interestAmount: new Prisma.Decimal(amounts.interestAmount),
            paymentDate: calendarDateToUtcCarrier(TODAY),
          },
        }),
      )

      expect(String(caught)).toContain(constraint)
      expect(await paymentCount(loan.id)).toBe(0)
    })

    it('accepts an interest-only and a principal-only instalment at the database level', async () => {
      // The mirror of the two `nonnegative` cases above: zero is valid on either
      // side of the split (ruling R6-6), and only the total must be positive.
      const loan = await createLoan(fx.userId, BASE_LOAN)

      await prisma.loanPayment.create({
        data: {
          userId: fx.userId,
          loanId: loan.id,
          totalAmount: new Prisma.Decimal('5000'),
          principalAmount: new Prisma.Decimal('0'),
          interestAmount: new Prisma.Decimal('5000'),
          paymentDate: calendarDateToUtcCarrier(TODAY),
        },
      })
      await prisma.loanPayment.create({
        data: {
          userId: fx.userId,
          loanId: loan.id,
          totalAmount: new Prisma.Decimal('5000'),
          principalAmount: new Prisma.Decimal('5000'),
          interestAmount: new Prisma.Decimal('0'),
          paymentDate: calendarDateToUtcCarrier(TODAY),
        },
      })

      expect(await paymentCount(loan.id)).toBe(2)
    })
  })

  describe('tracking only — no money moves', () => {
    it('leaves accounts, transactions, transfers and the balance untouched by every mutation', async () => {
      // Every mutation the service has, in the sequence a real user would
      // produce, ending in a close. `afterEach` checks the ledger after every
      // case; this one exists so the check has run against the whole surface at
      // least once, in one place a reviewer can read.
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, notes: 'Tracking only' })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 410_000,
        principalAmount: 400_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })
      await updateLoan(fx.userId, loan.id, {
        lender: 'Vietcombank',
        scheduledPaymentAmount: 95_000,
        notes: 'Edited',
      })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 600_000,
        principalAmount: 600_000,
        interestAmount: 0,
        paymentDate: '2026-03-01',
      })
      await captureRejection(
        recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 1,
          principalAmount: 1,
          interestAmount: 0,
          paymentDate: '2026-03-11',
        }),
      )
      await closeLoan(fx.userId, loan.id)
      await listLoans(fx.userId)
      await getLoansWithOutstanding(fx.userId, TODAY)
      await getLoanOutstandingPrincipal(fx.userId, loan.id)

      expect(await prisma.financialAccount.count({ where: { userId: fx.userId } })).toBe(
        ledger.accounts,
      )
      expect(await prisma.transaction.count({ where: { userId: fx.userId } })).toBe(
        ledger.transactions,
      )
      expect(await prisma.transfer.count({ where: { userId: fx.userId } })).toBe(ledger.transfers)
      expect((await getAccountBalance(fx.userId, fx.accountId)).toString()).toBe(ledger.balance)
      // Not just the counts: the rows themselves, field for field. A loan that
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
     * phase adding "record the instalment as a transaction too" would
     * reintroduce exactly the coupling spec §4.10 exists to avoid — and
     * importing the module is the first step of doing so. Only import
     * specifiers are matched, so the doc comment may keep naming these modules
     * to say why they are absent.
     */
    it('imports nothing that could move money or reach a live rate', () => {
      const source = readFileSync(fileURLToPath(new URL('./loan.ts', import.meta.url)), 'utf8')

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
