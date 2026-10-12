import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { FxUnavailableError } from '@/lib/currency/current-rate-policy'
import { resetFxMemoForTests } from '@/lib/currency/fx-service'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import {
  calendarDateToUtcCarrier,
  formatCalendarDate,
  todayCalendarDateInZone,
} from '@/lib/datetime/calendar-date'
import { LOAN_INTEREST_CATEGORY_NAME } from '@/lib/server/defaults'
import { getAccountBalance } from '@/lib/server/services/balance'
import type { CreateLoanInput, RecordLoanPaymentInput } from '@/lib/validation/loan'
import { ArchivedAccountError } from './account-lock'
import { LinkedAccountCurrencyMismatchError } from './linked-transaction'
import { ConcurrentModificationError, createTransaction, updateTransaction } from './transaction'
import {
  closeLoan,
  createLoan as createLoanIn,
  deleteLoanPayment,
  deriveLoanDisplayStatus,
  deriveLoanOutstandingPrincipal,
  getLoanOutstandingPrincipal,
  getLoansWithOutstanding,
  listLoans,
  recordLoanPayment as recordLoanPaymentIn,
  updateLoan,
  updateLoanPayment as updateLoanPaymentIn,
  LoanNotActiveError,
  LoanOverpaymentError,
  LoanSplitMismatchError,
  type LoanLinkContext,
  type LoanTotals,
  type LoanWithOutstanding,
} from './loan'

/**
 * Group 4's data-layer acceptance check (spec §4.10), extended by money-source
 * linking (spec 2026-10-12 §4, §6.3).
 *
 * Seven properties are what the `loan service` block exists to hold:
 *
 * 1. **Without an account, nothing moves.** The fixture seeds an account and
 *    an EXPENSE transaction, and `afterEach` re-asserts the account /
 *    transaction / transfer counts, the two seeded rows field for field, and
 *    the account's derived balance — after *every* case, not just a dedicated
 *    one. Every case in that block records its loans and instalments with no
 *    account (the "don't record in an account" choice), so a stray write to
 *    the ledger fails the test that made it.
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
 *
 * The `money-source linking` block below covers the other choice — a loan
 * received into an account, or an instalment paid from one — where the
 * matching Transactions are written in the same database transaction (spec
 * §4's mapping: CASH_IN for the principal received, CASH_OUT for each
 * instalment's principal and EXPENSE in "Loan Interest & Fees" for its
 * interest; an injected FX provider for the snapshot, balances moving,
 * refusals and injected failures writing nothing, instalment edits and deletes
 * keeping all three rows consistent, and the lock order).
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

/**
 * What the action layer passes from the session (`resolveProfileDefaults(user)`):
 * the zone a calendar date becomes an instant in, and the language a default
 * transaction note is written in.
 */
const CONTEXT: LoanLinkContext = { timezone: TEST_TIMEZONE, locale: 'vi' }

/** The three writes that take a context, with the test default applied — the
 *  `…In` originals are called directly where a case needs another context. */
function createLoan(userId: string, input: CreateLoanInput, provider?: ExchangeRateProvider) {
  return createLoanIn(userId, input, CONTEXT, provider)
}

function recordLoanPayment(
  userId: string,
  loanId: string,
  input: RecordLoanPaymentInput,
  provider?: ExchangeRateProvider,
) {
  return recordLoanPaymentIn(userId, loanId, input, CONTEXT, provider)
}

function updateLoanPayment(
  userId: string,
  paymentId: string,
  input: RecordLoanPaymentInput,
  provider?: ExchangeRateProvider,
) {
  return updateLoanPaymentIn(userId, paymentId, input, CONTEXT, provider)
}

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
      // Without an account nothing moves, asserted after *every* case rather
      // than in one dedicated test: whichever mutation a case ran, the ledger it
      // did not ask about is still exactly as it was — counts, the two seeded
      // rows field for field, and the derived balance.
      expect(await snapshotLedger(fx)).toEqual(ledger)
    } finally {
      // In `finally`, so a ledger assertion that fails still leaves the database
      // clean for the next case rather than turning one real failure into a
      // cascade of unrelated ones.
      await cleanupUsers([fx.userId, ...extraUserIds])
    }
    // A loan keeps its own currency and is never converted, and without an
    // account no transaction (so no FX snapshot) is written, so no code path
    // here has any reason to reach an FX provider.
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
      expect((await listLoans(fx.userId))[0].payments).toEqual([])

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

    /**
     * `includePayments: false` — the totals-only read (Phase 8, Task 4,
     * pre-flight finding B-7), the mirror of `debt.ts`.
     *
     * Net Worth's liability term and the export's Loans sheet need
     * `principalPaid`, `interestPaid`, `outstandingPrincipal` and
     * `displayStatus`; every instalment row they used to fetch was discarded.
     * The interest split is the part that would be easiest to get wrong, so both
     * sums are compared, on a fixture covering no instalments, a fractional
     * part-payment, a fully repaid loan and a closed one.
     */
    it('derives identical figures with and without the instalment history', async () => {
      const none = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'None' })
      const partly = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Partly' })
      const full = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Full' })
      const gone = await createLoan(fx.userId, { ...BASE_LOAN, lender: 'Gone' })
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
      await recordLoanPayment(fx.userId, gone.id, {
        totalAmount: 110_000,
        principalAmount: 100_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })
      await closeLoan(fx.userId, gone.id)

      const withHistory = await getLoansWithOutstanding(fx.userId, TODAY)
      const totalsOnly = await getLoansWithOutstanding(fx.userId, TODAY, { includePayments: false })

      const figures = (entries: LoanWithOutstanding[] | LoanTotals[]) =>
        entries.map((entry) => [
          entry.loan.lender,
          entry.loan.principal.toString(),
          entry.principalPaid.toString(),
          entry.interestPaid.toString(),
          entry.outstandingPrincipal.toString(),
          entry.displayStatus,
        ])

      expect(figures(totalsOnly)).toEqual(figures(withHistory))
      expect(figures(totalsOnly)).toEqual([
        ['None', '1000000', '0', '0', '1000000', 'OVERDUE'],
        ['Partly', '1000000', '280000.25', '60000.25', '719999.75', 'ACTIVE'],
        ['Full', '1000000', '1000000', '50000', '0', 'PAID_OFF'],
        ['Gone', '1000000', '100000', '10000', '900000', 'CLOSED'],
      ])
      expect(totalsOnly.map((entry) => entry.loan.id)).toEqual([
        none.id,
        partly.id,
        full.id,
        gone.id,
      ])
      expect(withHistory[1].loan.payments).toHaveLength(2)
      expect(totalsOnly.every((entry) => !('payments' in entry.loan))).toBe(true)
    })

    it('fetches no instalment rows for a totals-only read, and still one aggregate', async () => {
      for (const lender of ['A', 'B', 'C']) {
        const loan = await createLoan(fx.userId, { ...BASE_LOAN, lender })
        await recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 3_000,
          principalAmount: 1_000,
          interestAmount: 2_000,
          paymentDate: '2026-02-01',
        })
      }
      const findMany = vi.spyOn(prisma.loan, 'findMany')
      const groupBy = vi.spyOn(prisma.loanPayment, 'groupBy')

      const entries = await getLoansWithOutstanding(fx.userId, TODAY, { includePayments: false })

      expect(findMany).toHaveBeenCalledTimes(1)
      expect(findMany.mock.calls[0][0]?.include).toBeUndefined()
      expect(groupBy).toHaveBeenCalledTimes(1)
      expect(entries.every((entry) => entry.principalPaid.toString() === '1000')).toBe(true)
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

  describe('instalment edit and delete', () => {
    function paymentRow(paymentId: string) {
      return prisma.loanPayment.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: paymentId } },
      })
    }

    it('edits the split, the date and the note of an instalment, leaving the schedule alone', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const { payment } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })

      const updated = await updateLoanPayment(fx.userId, payment.id, {
        totalAmount: 95_000.5,
        principalAmount: 70_000.25,
        interestAmount: 25_000.25,
        paymentDate: '2026-02-03',
        note: 'Corrected from the statement',
      })

      expect(updated.id).toBe(payment.id)
      expect(updated.totalAmount.toString()).toBe('95000.5')
      expect(updated.principalAmount.toString()).toBe('70000.25')
      expect(updated.interestAmount.toString()).toBe('25000.25')
      expect(formatCalendarDate(updated.paymentDate)).toBe('2026-02-03')
      expect(updated.note).toBe('Corrected from the statement')
      expect(updated.principalTransactionId).toBeNull()
      expect(updated.interestTransactionId).toBeNull()
      const entry = await entryFor(loan.id)
      expect(entry.outstandingPrincipal.toString()).toBe('929999.75')
      expect(entry.interestPaid.toString()).toBe('25000.25')
      // Correcting an instalment is not paying another one: the schedule moved
      // once, when it was recorded, and stays there.
      expect(await dueDate(loan.id)).toBe('2026-03-01')
    })

    it('clears the note when it comes back empty', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const { payment } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
        note: 'Typo',
      })

      const updated = await updateLoanPayment(fx.userId, payment.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })

      expect(updated.note).toBeNull()
    })

    it('measures an edited principal against what is owed without the instalment being edited', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const { payment } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 300_000,
        principalAmount: 300_000,
        interestAmount: 0,
        paymentDate: '2026-02-01',
      })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 600_000,
        principalAmount: 600_000,
        interestAmount: 0,
        paymentDate: '2026-03-01',
      })

      // 1,000,000 − 600,000 = 400,000 is owed without this instalment, so its
      // principal may grow from 300,000 to exactly 400,000…
      await updateLoanPayment(fx.userId, payment.id, {
        totalAmount: 400_000,
        principalAmount: 400_000,
        interestAmount: 0,
        paymentDate: '2026-02-01',
      })
      // …and not a cent further.
      const caught = await captureRejection(
        updateLoanPayment(fx.userId, payment.id, {
          totalAmount: 400_000.01,
          principalAmount: 400_000.01,
          interestAmount: 0,
          paymentDate: '2026-02-01',
        }),
      )

      expect(caught).toBeInstanceOf(LoanOverpaymentError)
      expect((caught as LoanOverpaymentError).outstandingPrincipal.toString()).toBe('400000')
      expect((await paymentRow(payment.id)).principalAmount.toString()).toBe('400000')
      expect((await entryFor(loan.id)).outstandingPrincipal.toString()).toBe('0')
    })

    it('deletes an instalment, stepping the due date back by the one period recording it advanced', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })
      const { payment: latest } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-03-01',
      })
      expect(await dueDate(loan.id)).toBe('2026-04-01')

      await deleteLoanPayment(fx.userId, latest.id)

      expect(await paymentCount(loan.id)).toBe(1)
      expect(await dueDate(loan.id)).toBe('2026-03-01')
      const entry = await entryFor(loan.id)
      expect(entry.outstandingPrincipal.toString()).toBe('920000')
      expect(entry.interestPaid.toString()).toBe('10000')
    })

    it('deletes an earlier instalment and still steps the due date back one period', async () => {
      // Recording advances the schedule one period per instalment whatever its
      // payment date, so the stored due date is "first due + N periods" and
      // removing *any* one of the N must take one period off (Ruling P5).
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const { payment: earlier } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })
      await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-03-01',
      })
      expect(await dueDate(loan.id)).toBe('2026-04-01')

      await deleteLoanPayment(fx.userId, earlier.id)

      expect(await paymentCount(loan.id)).toBe(1)
      expect(await dueDate(loan.id)).toBe('2026-03-01')
      expect((await entryFor(loan.id)).outstandingPrincipal.toString()).toBe('920000')
    })

    it('deletes the earlier of two same-day instalments, stepping the due date back once', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const { payment: first } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000,
        principalAmount: 1_000,
        interestAmount: 0,
        paymentDate: '2026-02-01',
      })
      const { payment: second } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 2_000,
        principalAmount: 2_000,
        interestAmount: 0,
        paymentDate: '2026-02-01',
      })
      expect(await dueDate(loan.id)).toBe('2026-04-01')

      await deleteLoanPayment(fx.userId, first.id)

      expect(await dueDate(loan.id)).toBe('2026-03-01')
      const remaining = await prisma.loanPayment.findMany({
        where: { userId: fx.userId, loanId: loan.id },
      })
      expect(remaining.map((payment) => payment.id)).toEqual([second.id])
      expect((await entryFor(loan.id)).outstandingPrincipal.toString()).toBe('998000')
    })

    it('returns the schedule to the first due date once every instalment is deleted, in any order', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const { payment: march } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000,
        principalAmount: 1_000,
        interestAmount: 0,
        paymentDate: '2026-03-01',
      })
      // Entered after March but paid before it.
      const { payment: backdated } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000,
        principalAmount: 1_000,
        interestAmount: 0,
        paymentDate: '2026-02-01',
      })
      const { payment: sameDay } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000,
        principalAmount: 1_000,
        interestAmount: 0,
        paymentDate: '2026-03-01',
      })
      expect(await dueDate(loan.id)).toBe('2026-05-01')

      await deleteLoanPayment(fx.userId, backdated.id)
      expect(await dueDate(loan.id)).toBe('2026-04-01')
      await deleteLoanPayment(fx.userId, march.id)
      expect(await dueDate(loan.id)).toBe('2026-03-01')
      await deleteLoanPayment(fx.userId, sameDay.id)

      // Three instalments recorded, three deleted: the loan asks for its very
      // first instalment again, exactly as it did before any was recorded.
      expect(await paymentCount(loan.id)).toBe(0)
      expect(await dueDate(loan.id)).toBe(BASE_LOAN.nextDueDate)
    })

    it('steps a month-end schedule back across February onto its anchor day', async () => {
      // Due on the 31st: recording walks Jan 31 → Feb 28 → Mar 31, so deleting
      // must walk Mar 31 → Feb 28 → Jan 31 — not Mar 31 → Feb 28 → Jan 28.
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, nextDueDate: '2026-01-31' })
      const { payment: first } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-01-31',
      })
      const { payment: second } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-28',
      })
      expect(await dueDate(loan.id)).toBe('2026-03-31')

      // The earlier one first: which instalment goes does not matter, each
      // deletion takes exactly one period off the anchored schedule.
      await deleteLoanPayment(fx.userId, first.id)
      expect(await dueDate(loan.id)).toBe('2026-02-28')

      await deleteLoanPayment(fx.userId, second.id)
      expect(await dueDate(loan.id)).toBe('2026-01-31')
    })

    it('steps a WEEKLY schedule back by exactly seven days', async () => {
      const loan = await createLoan(fx.userId, {
        ...BASE_LOAN,
        paymentFrequency: 'WEEKLY',
        nextDueDate: '2026-02-26',
      })
      const { payment } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 20_000,
        principalAmount: 18_000,
        interestAmount: 2_000,
        paymentDate: '2026-02-26',
      })
      expect(await dueDate(loan.id)).toBe('2026-03-05')

      await deleteLoanPayment(fx.userId, payment.id)

      expect(await dueDate(loan.id)).toBe('2026-02-26')
    })

    it('refuses to edit or delete an instalment of a closed loan — its history is frozen', async () => {
      const loan = await createLoan(fx.userId, BASE_LOAN)
      const { payment } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
      })
      await closeLoan(fx.userId, loan.id)

      await expect(
        updateLoanPayment(fx.userId, payment.id, {
          totalAmount: 1_000,
          principalAmount: 1_000,
          interestAmount: 0,
          paymentDate: '2026-02-01',
        }),
      ).rejects.toThrow(LoanNotActiveError)
      await expect(deleteLoanPayment(fx.userId, payment.id)).rejects.toThrow(LoanNotActiveError)

      expect(await paymentRow(payment.id)).toEqual(payment)
      expect(await dueDate(loan.id)).toBe('2026-03-01')
    })

    it('answers an instalment id that does not exist with P2025', async () => {
      await expectPrismaCode(
        updateLoanPayment(fx.userId, 'no-such-payment', {
          totalAmount: 1,
          principalAmount: 1,
          interestAmount: 0,
          paymentDate: TODAY,
        }),
        'P2025',
      )
      await expectPrismaCode(deleteLoanPayment(fx.userId, 'no-such-payment'), 'P2025')
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

    it('steps the due date back twice for two concurrent deletions, losing neither', async () => {
      for (const run of [1, 2, 3]) {
        const loan = await createLoan(fx.userId, { ...BASE_LOAN, lender: `Delete ${run}` })
        const { payment: first } = await recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 1_000,
          principalAmount: 1_000,
          interestAmount: 0,
          paymentDate: '2026-02-01',
        })
        const { payment: second } = await recordLoanPayment(fx.userId, loan.id, {
          totalAmount: 1_000,
          principalAmount: 1_000,
          interestAmount: 0,
          paymentDate: '2026-03-01',
        })
        expect(await dueDate(loan.id)).toBe('2026-04-01')

        const results = await Promise.allSettled([
          deleteLoanPayment(fx.userId, first.id),
          deleteLoanPayment(fx.userId, second.id),
        ])

        // Both re-read the due date under the loan lock, so the second steps
        // back from where the first left it rather than from the pre-race value.
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(await paymentCount(loan.id)).toBe(0)
        expect(await dueDate(loan.id)).toBe(BASE_LOAN.nextDueDate)
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
      await expectPrismaCode(
        updateLoanPayment(fx.userId, before.payments[0].id, {
          totalAmount: 1,
          principalAmount: 1,
          interestAmount: 0,
          paymentDate: TODAY,
        }),
        'P2025',
      )
      await expectPrismaCode(deleteLoanPayment(fx.userId, before.payments[0].id), 'P2025')

      const after = await prisma.loan.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
        include: { payments: true },
      })
      // Byte-identical, `updatedAt`, `nextDueDate` and the payment row included:
      // not one of the six attempts reached a write.
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

  describe('without an account — no money moves', () => {
    it('leaves accounts, transactions, transfers and the balance untouched by every mutation', async () => {
      // Every mutation the service has, in the sequence a real user would
      // produce, ending in a close. `afterEach` checks the ledger after every
      // case; this one exists so the check has run against the whole surface at
      // least once, in one place a reviewer can read.
      const loan = await createLoan(fx.userId, { ...BASE_LOAN, notes: 'Tracking only' })
      const { payment } = await recordLoanPayment(fx.userId, loan.id, {
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
      await updateLoanPayment(fx.userId, payment.id, {
        totalAmount: 420_000,
        principalAmount: 400_000,
        interestAmount: 20_000,
        paymentDate: '2026-02-02',
      })
      const { payment: extra } = await recordLoanPayment(fx.userId, loan.id, {
        totalAmount: 1_000,
        principalAmount: 0,
        interestAmount: 1_000,
        paymentDate: '2026-02-03',
      })
      await deleteLoanPayment(fx.userId, extra.id)
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
  })
})

/**
 * Money-source linking for loans (spec 2026-10-12 §4, §6.3, §6.8) against the
 * real database.
 *
 * Every FX lookup goes through an injected fake provider whose snapshot values
 * are asserted exactly, and `fetch` is a throwing spy, so nothing here can reach
 * the network. The USD/VND `ExchangeRate` cache rows are global, so
 * `beforeEach` and `afterEach` delete them and reset the in-process FX memo
 * (`resetFxMemoForTests`, the rule `transaction.test.ts` follows).
 *
 * "No FX lookup happened" is proved with `failingProvider` over an empty cache
 * (`beforeEach` empties it; a case that has already cached a rate empties it
 * again): a lookup there could only end in `FxUnavailableError`, so a write
 * that succeeds never asked.
 */
describe('money-source linking', () => {
  const LINK_FX_SOURCE = 'loan-link-fake'
  const createdUserIds: string[] = []
  let fetchSpy: MockInstance

  function fakeProvider(rate = 25000, source = LINK_FX_SOURCE) {
    // In the past, so a service that stamped "now" instead of the provider's
    // own fetch instant could not pass an equality check.
    const fetchedAt = new Date(Date.now() - 5 * 60 * 1000)
    const effectiveDate = new Date()
    const provider: ExchangeRateProvider = {
      getLatestRate: async () => ({ rate, effectiveDate, fetchedAt, source }),
      getHistoricalRate: async () => null,
    }
    return { provider, fetchedAt, effectiveDate }
  }

  const failingProvider: ExchangeRateProvider = {
    getLatestRate: async () => {
      throw new Error('provider down')
    },
    getHistoricalRate: async () => null,
  }

  /** The `ExchangeRate` cache key — the `fxRateEffectiveAt` a live lookup stores. */
  function utcDayStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  }

  async function clearFxCache() {
    await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
    // The in-process memo would otherwise outlive the rows just deleted.
    resetFxMemoForTests()
  }

  /**
   * A user with three active accounts — two in VND, one in USD — and an archived
   * VND one, and no categories at all (so the first interest payment has to
   * create "Loan Interest & Fees"). Each funded account starts at a distinct
   * round figure, so every balance assertion below is a delta anyone can check
   * by eye.
   */
  async function setup() {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `loan-link-${randomUUID()}@example.com`,
        name: 'Loan Link Test',
        emailVerified: false,
        timezone: TEST_TIMEZONE,
      },
    })
    createdUserIds.push(user.id)
    const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
    const account = (name: string, currency: 'VND' | 'USD', initialBalance: string) =>
      prisma.financialAccount.create({
        data: {
          userId: user.id,
          name,
          accountTypeId: accountType.id,
          initialBalance: new Prisma.Decimal(initialBalance),
          currency,
        },
      })
    const wallet = await account('Wallet', 'VND', '5000000')
    const bank = await account('Bank', 'VND', '2000000')
    const dollars = await account('Dollars', 'USD', '1000')
    const archived = await account('Old', 'VND', '0')
    await prisma.financialAccount.update({
      where: { userId_id: { userId: user.id, id: archived.id } },
      data: { status: 'ARCHIVED' },
    })
    return {
      userId: user.id,
      walletId: wallet.id,
      bankId: bank.id,
      dollarsId: dollars.id,
      archivedId: archived.id,
    }
  }

  type Setup = Awaited<ReturnType<typeof setup>>

  async function balanceOf(s: Setup, accountId: string): Promise<string> {
    return (await getAccountBalance(s.userId, accountId)).toString()
  }

  async function transactionCount(s: Setup): Promise<number> {
    return prisma.transaction.count({ where: { userId: s.userId } })
  }

  async function transactionById(s: Setup, id: string | null) {
    if (id === null) throw new Error('expected a linked transaction')
    return prisma.transaction.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
  }

  async function transactionExists(s: Setup, id: string): Promise<boolean> {
    return (await prisma.transaction.count({ where: { userId: s.userId, id } })) === 1
  }

  async function paymentById(s: Setup, id: string) {
    return prisma.loanPayment.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
  }

  async function loanById(s: Setup, id: string) {
    return prisma.loan.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
  }

  /** The user's "Loan Interest & Fees" categories — normally exactly one. */
  function interestCategories(s: Setup) {
    return prisma.category.findMany({
      where: { userId: s.userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE' },
    })
  }

  /** A loan of 1,000,000 VND recorded with no account, so the cases about
   *  instalments start from an untouched ledger. Next due 2026-04-01. */
  function unlinkedLoan(s: Setup, overrides: Partial<CreateLoanInput> = {}) {
    return createLoan(s.userId, { ...BASE_LOAN, nextDueDate: '2026-04-01', ...overrides })
  }

  /** 90,000 = 80,000 principal + 10,000 interest, on a day that is not today. */
  const INSTALMENT = {
    totalAmount: 90_000,
    principalAmount: 80_000,
    interestAmount: 10_000,
    paymentDate: '2026-03-05',
  }

  /**
   * Makes the next interactive transaction fail at one write *after* the linked
   * transactions have been written inside it — the only way to watch the
   * rollback itself, since every refusal the service makes on its own happens
   * before its first write. `prisma.$transaction` is wrapped so the callback
   * receives a transaction client whose `model.method` throws; everything else
   * is the real client on the real transaction.
   */
  function failInsideTransaction(
    model: 'loan' | 'loanPayment',
    method: 'create' | 'update' | 'delete',
  ) {
    const original = prisma.$transaction.bind(prisma) as (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => Promise<unknown>
    const failure = new Error(`injected ${model}.${method} failure`)
    vi.spyOn(prisma, '$transaction').mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      original((tx) =>
        callback(
          new Proxy(tx, {
            get(target, property) {
              const value = Reflect.get(target, property)
              if (property !== model) return value
              return new Proxy(value as object, {
                get(delegate, name) {
                  if (name === method) {
                    return async () => {
                      throw failure
                    }
                  }
                  return Reflect.get(delegate, name)
                },
              })
            },
          }),
        ),
      )) as never)
    return failure
  }

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    // The FX fallback path warns by design; silenced to keep the output pristine.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Today's USD/VND row is shared by every suite, so a rate another file left
    // behind would otherwise be served instead of this file's fake provider.
    await clearFxCache()
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    const userIds = createdUserIds.splice(0)
    try {
      await clearFxCache()
      if (userIds.length > 0) {
        // Instalments and loans first: they reference the transactions now.
        await prisma.loanPayment.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.loan.deleteMany({ where: { userId: { in: userIds } } })
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

  describe('createLoan with an account', () => {
    it('records the principal received as a CASH_IN on the start date, in the account currency', async () => {
      const s = await setup()
      const { provider, fetchedAt, effectiveDate } = fakeProvider()

      const loan = await createLoan(
        s.userId,
        // `currency: 'USD'` is the form's leftover choice: with an account, the
        // loan is in the account's currency, whatever the form said.
        { ...BASE_LOAN, currency: 'USD', startDate: '2026-03-10', accountId: s.walletId },
        provider,
      )

      expect(loan.currency).toBe('VND')
      expect(loan.disbursementTransactionId).not.toBeNull()
      // What the instalment picker pre-selects (spec §6.3) travels with the row
      // the Loans page reads.
      const [listed] = await listLoans(s.userId)
      expect(listed.disbursementTransaction).toMatchObject({
        accountId: s.walletId,
        account: { name: 'Wallet', status: 'ACTIVE' },
      })

      const disbursement = await transactionById(s, loan.disbursementTransactionId)
      expect(disbursement).toMatchObject({
        accountId: s.walletId,
        type: 'CASH_IN',
        currency: 'VND',
        categoryId: null,
        // No notes given: the label, rendered once in the user's locale.
        note: 'Vay – Vietcombank',
        fxRateSource: LINK_FX_SOURCE,
      })
      expect(disbursement.amount.toString()).toBe('1000000')
      // 12:00 on 2026-03-10 in Asia/Ho_Chi_Minh (UTC+7): the same calendar day
      // in every zone the user could later read it in.
      expect(disbursement.date.toISOString()).toBe('2026-03-10T05:00:00.000Z')
      expect(disbursement.vndPerUsdAtEntry.toString()).toBe('25000')
      expect(disbursement.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())
      expect(disbursement.fxRateEffectiveAt.toISOString()).toBe(
        utcDayStart(effectiveDate).toISOString(),
      )

      expect(await balanceOf(s, s.walletId)).toBe('6000000')
      expect(await transactionCount(s)).toBe(1)
      // The loan's own figures are unchanged by where the money went.
      expect((await getLoanOutstandingPrincipal(s.userId, loan.id)).toString()).toBe('1000000')
    })

    it('carries the loan notes as the transaction note', async () => {
      const s = await setup()

      const loan = await createLoan(
        s.userId,
        { ...BASE_LOAN, notes: 'For the roof', accountId: s.bankId },
        fakeProvider().provider,
      )

      const disbursement = await transactionById(s, loan.disbursementTransactionId)
      expect(disbursement).toMatchObject({ accountId: s.bankId, note: 'For the roof' })
      expect(await balanceOf(s, s.bankId)).toBe('3000000')
    })

    it('dates a loan that starts today at the current instant, so the balance moves immediately', async () => {
      const s = await setup()
      const today = todayCalendarDateInZone(TEST_TIMEZONE, new Date())

      const before = Date.now()
      const loan = await createLoan(
        s.userId,
        { ...BASE_LOAN, startDate: today, accountId: s.walletId },
        fakeProvider().provider,
      )
      const disbursement = await transactionById(s, loan.disbursementTransactionId)

      // Not 12:00 of a day that may still be hours away.
      expect(disbursement.date.getTime()).toBeGreaterThanOrEqual(before)
      expect(disbursement.date.getTime()).toBeLessThanOrEqual(Date.now())
      expect(await balanceOf(s, s.walletId)).toBe('6000000')
    })

    it('records nothing and asks for no rate without an account, keeping the chosen currency', async () => {
      const s = await setup()

      const loan = await createLoan(s.userId, { ...BASE_LOAN, currency: 'USD' }, failingProvider)

      expect(loan.currency).toBe('USD')
      expect(loan.disbursementTransactionId).toBeNull()
      expect((await listLoans(s.userId))[0].disbursementTransaction).toBeNull()
      expect(await transactionCount(s)).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
    })

    it("refuses another user's account with P2025 and writes nothing for either user", async () => {
      const s = await setup()
      const other = await setup()

      await expectPrismaCode(
        createLoan(s.userId, { ...BASE_LOAN, accountId: other.walletId }, fakeProvider().provider),
        'P2025',
      )

      expect(await prisma.loan.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
      expect(await transactionCount(other)).toBe(0)
      expect(await balanceOf(other, other.walletId)).toBe('5000000')
    })

    it('refuses an archived account and writes nothing', async () => {
      const s = await setup()

      await expect(
        createLoan(s.userId, { ...BASE_LOAN, accountId: s.archivedId }, fakeProvider().provider),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.loan.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
    })

    it('writes nothing when no usable rate exists — no loan without its transaction', async () => {
      const s = await setup()

      await expect(
        createLoan(s.userId, { ...BASE_LOAN, accountId: s.walletId }, failingProvider),
      ).rejects.toThrow(FxUnavailableError)

      expect(await prisma.loan.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
    })

    it('returns the committed loan without a read after the write, so a failing read cannot report a lost write', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      // Every way of reading a loan back fails from here on. A read made after
      // the write had committed would turn a successful create into an error —
      // and the user's retry into a second loan with a second CASH_IN.
      for (const method of ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findMany'] as const) {
        vi.spyOn(prisma.loan, method).mockRejectedValue(new Error('read failed'))
      }

      const linked = await createLoan(
        s.userId,
        { ...BASE_LOAN, lender: 'Linked', accountId: s.walletId },
        provider,
      )
      const unlinked = await createLoan(s.userId, { ...BASE_LOAN, lender: 'Unlinked' }, provider)
      vi.restoreAllMocks()

      expect(linked).toMatchObject({ lender: 'Linked', currency: 'VND', status: 'ACTIVE' })
      expect(linked.disbursementTransactionId).not.toBeNull()
      expect(unlinked).toMatchObject({ lender: 'Unlinked', disbursementTransactionId: null })
      expect((await listLoans(s.userId)).map((loan) => loan.id).sort()).toEqual(
        [linked.id, unlinked.id].sort(),
      )
      expect(await transactionCount(s)).toBe(1)
      expect(await balanceOf(s, s.walletId)).toBe('6000000')
    })

    it('rolls the disbursement back when the loan row itself fails to write', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      const failure = failInsideTransaction('loan', 'create')

      await expect(
        createLoan(s.userId, { ...BASE_LOAN, accountId: s.walletId }, provider),
      ).rejects.toBe(failure)

      expect(await prisma.loan.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
    })
  })

  describe('recordLoanPayment with an account', () => {
    it('records the principal as a CASH_OUT and the interest as an EXPENSE in "Loan Interest & Fees"', async () => {
      const s = await setup()
      const { provider, fetchedAt } = fakeProvider()
      const loan = await unlinkedLoan(s)

      const { payment, nextDueDate } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        provider,
      )

      const [category] = await interestCategories(s)
      expect(category).toMatchObject({ type: 'EXPENSE', status: 'ACTIVE' })

      const principal = await transactionById(s, payment.principalTransactionId)
      expect(principal).toMatchObject({
        accountId: s.walletId,
        type: 'CASH_OUT',
        currency: 'VND',
        categoryId: null,
        note: 'Trả gốc – Vietcombank',
        fxRateSource: LINK_FX_SOURCE,
      })
      expect(principal.amount.toString()).toBe('80000')
      expect(principal.date.toISOString()).toBe('2026-03-05T05:00:00.000Z')
      expect(principal.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())

      const interest = await transactionById(s, payment.interestTransactionId)
      expect(interest).toMatchObject({
        accountId: s.walletId,
        type: 'EXPENSE',
        currency: 'VND',
        categoryId: category.id,
        note: 'Lãi vay – Vietcombank',
        fxRateSource: LINK_FX_SOURCE,
      })
      expect(interest.amount.toString()).toBe('10000')
      expect(interest.date.toISOString()).toBe('2026-03-05T05:00:00.000Z')

      // The account pays the whole instalment; only the principal pays the
      // loan down; the schedule moves on exactly as without an account.
      expect(await balanceOf(s, s.walletId)).toBe('4910000')
      expect((await getLoanOutstandingPrincipal(s.userId, loan.id)).toString()).toBe('920000')
      expect(formatCalendarDate(nextDueDate)).toBe('2026-05-01')
      // The payment row keeps its calendar-date carrier.
      expect(formatCalendarDate(payment.paymentDate)).toBe('2026-03-05')

      // And the read the Loans page uses carries both links and their account.
      const [listed] = await listLoans(s.userId)
      expect(listed.payments[0]).toMatchObject({
        principalTransactionId: principal.id,
        interestTransactionId: interest.id,
        principalTransaction: { accountId: s.walletId, account: { name: 'Wallet' } },
        interestTransaction: { accountId: s.walletId },
      })
    })

    it('files the interest under the existing "Loan Interest & Fees" category rather than a new one', async () => {
      const s = await setup()
      const existing = await prisma.category.create({
        data: { userId: s.userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE' },
      })
      const loan = await unlinkedLoan(s)

      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        fakeProvider().provider,
      )

      expect((await transactionById(s, payment.interestTransactionId)).categoryId).toBe(existing.id)
      expect(await interestCategories(s)).toHaveLength(1)
    })

    it('writes no interest transaction when the interest is zero', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)

      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        {
          totalAmount: 80_000,
          principalAmount: 80_000,
          interestAmount: 0,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        fakeProvider().provider,
      )

      expect(payment.interestTransactionId).toBeNull()
      expect((await transactionById(s, payment.principalTransactionId)).amount.toString()).toBe(
        '80000',
      )
      expect(await transactionCount(s)).toBe(1)
      // Nothing needed the interest category, so none was made.
      expect(await interestCategories(s)).toHaveLength(0)
      expect(await balanceOf(s, s.walletId)).toBe('4920000')
    })

    it('writes no principal transaction for an interest-only instalment', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)

      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        {
          totalAmount: 5_000,
          principalAmount: 0,
          interestAmount: 5_000,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        fakeProvider().provider,
      )

      expect(payment.principalTransactionId).toBeNull()
      const interest = await transactionById(s, payment.interestTransactionId)
      expect(interest).toMatchObject({ type: 'EXPENSE' })
      expect(interest.amount.toString()).toBe('5000')
      expect(await transactionCount(s)).toBe(1)
      expect(await balanceOf(s, s.walletId)).toBe('4995000')
      expect((await getLoanOutstandingPrincipal(s.userId, loan.id)).toString()).toBe('1000000')
    })

    it('carries the user note on both transactions', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)

      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, note: 'March instalment', accountId: s.bankId },
        fakeProvider().provider,
      )

      expect(payment.note).toBe('March instalment')
      expect((await transactionById(s, payment.principalTransactionId)).note).toBe(
        'March instalment',
      )
      expect((await transactionById(s, payment.interestTransactionId)).note).toBe(
        'March instalment',
      )
      expect(await balanceOf(s, s.bankId)).toBe('1910000')
    })

    it('dates an instalment paid today at the current instant, so the balance moves immediately', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const today = todayCalendarDateInZone(TEST_TIMEZONE, new Date())

      const before = Date.now()
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, paymentDate: today, accountId: s.walletId },
        fakeProvider().provider,
      )

      for (const id of [payment.principalTransactionId, payment.interestTransactionId]) {
        const linked = await transactionById(s, id)
        expect(linked.date.getTime()).toBeGreaterThanOrEqual(before)
        expect(linked.date.getTime()).toBeLessThanOrEqual(Date.now())
      }
      expect(await balanceOf(s, s.walletId)).toBe('4910000')
    })

    it('records nothing and asks for no rate without an account', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)

      const { payment } = await recordLoanPayment(s.userId, loan.id, INSTALMENT, failingProvider)

      expect(payment.principalTransactionId).toBeNull()
      expect(payment.interestTransactionId).toBeNull()
      expect(await transactionCount(s)).toBe(0)
      expect(await interestCategories(s)).toHaveLength(0)
    })

    it('refuses a principal overpayment and leaves no orphan transaction or category behind', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      await recordLoanPayment(s.userId, loan.id, {
        totalAmount: 600_000,
        principalAmount: 600_000,
        interestAmount: 0,
        paymentDate: '2026-03-01',
      })

      const caught = await captureRejection(
        recordLoanPayment(
          s.userId,
          loan.id,
          {
            totalAmount: 410_000.01,
            principalAmount: 400_000.01,
            interestAmount: 10_000,
            paymentDate: '2026-03-02',
            accountId: s.walletId,
          },
          fakeProvider().provider,
        ),
      )

      expect(caught).toBeInstanceOf(LoanOverpaymentError)
      expect(await transactionCount(s)).toBe(0)
      expect(await interestCategories(s)).toHaveLength(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(1)
      expect(formatCalendarDate((await loanById(s, loan.id)).nextDueDate)).toBe('2026-05-01')
    })

    it('refuses an account in another currency than the loan, writing nothing', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)

      await expect(
        recordLoanPayment(
          s.userId,
          loan.id,
          { ...INSTALMENT, accountId: s.dollarsId },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(LinkedAccountCurrencyMismatchError)

      expect(await transactionCount(s)).toBe(0)
      expect(await interestCategories(s)).toHaveLength(0)
      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(0)
      expect(formatCalendarDate((await loanById(s, loan.id)).nextDueDate)).toBe('2026-04-01')
    })

    it('refuses an archived account', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)

      await expect(
        recordLoanPayment(
          s.userId,
          loan.id,
          { ...INSTALMENT, accountId: s.archivedId },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
    })

    it("refuses another user's account, and another user's loan, with P2025", async () => {
      const s = await setup()
      const other = await setup()
      const mine = await unlinkedLoan(s)
      const theirs = await unlinkedLoan(other)
      const { provider } = fakeProvider()

      await expectPrismaCode(
        recordLoanPayment(
          s.userId,
          mine.id,
          { ...INSTALMENT, accountId: other.walletId },
          provider,
        ),
        'P2025',
      )
      await expectPrismaCode(
        recordLoanPayment(s.userId, theirs.id, { ...INSTALMENT, accountId: s.walletId }, provider),
        'P2025',
      )

      expect(
        await prisma.loanPayment.count({ where: { userId: { in: [s.userId, other.userId] } } }),
      ).toBe(0)
      expect(await transactionCount(s)).toBe(0)
      expect(await transactionCount(other)).toBe(0)
      expect(formatCalendarDate((await loanById(other, theirs.id)).nextDueDate)).toBe('2026-04-01')
    })

    it('refuses a closed loan, writing nothing', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      await closeLoan(s.userId, loan.id)

      await expect(
        recordLoanPayment(
          s.userId,
          loan.id,
          { ...INSTALMENT, accountId: s.walletId },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(LoanNotActiveError)

      expect(await transactionCount(s)).toBe(0)
      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('writes nothing when no usable rate exists', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)

      await expect(
        recordLoanPayment(
          s.userId,
          loan.id,
          { ...INSTALMENT, accountId: s.walletId },
          failingProvider,
        ),
      ).rejects.toThrow(FxUnavailableError)

      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
    })

    it('rolls both transactions back when the instalment row fails to write', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { provider } = fakeProvider()
      const failure = failInsideTransaction('loanPayment', 'create')

      await expect(
        recordLoanPayment(s.userId, loan.id, { ...INSTALMENT, accountId: s.walletId }, provider),
      ).rejects.toBe(failure)

      // Both transactions had been inserted when the failure struck; neither
      // survived it, and neither did the interest category made for them.
      expect(await transactionCount(s)).toBe(0)
      expect(await interestCategories(s)).toHaveLength(0)
      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
      expect(formatCalendarDate((await loanById(s, loan.id)).nextDueDate)).toBe('2026-04-01')
    })
  })

  describe('default notes', () => {
    it.each([
      ['vi', ['Vay – Agribank', 'Trả gốc – Agribank', 'Lãi vay – Agribank']],
      ['en', ['Loan from Agribank', 'Principal repaid to Agribank', 'Interest paid to Agribank']],
    ] as const)('writes the label in the user locale (%s)', async (locale, expected) => {
      const s = await setup()
      const context: LoanLinkContext = { timezone: TEST_TIMEZONE, locale }
      const { provider } = fakeProvider()

      const loan = await createLoanIn(
        s.userId,
        { ...BASE_LOAN, lender: 'Agribank', accountId: s.walletId },
        context,
        provider,
      )
      const { payment } = await recordLoanPaymentIn(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        context,
        provider,
      )

      const notes = await Promise.all(
        [
          loan.disbursementTransactionId,
          payment.principalTransactionId,
          payment.interestTransactionId,
        ].map(async (id) => (await transactionById(s, id)).note),
      )
      expect(notes).toEqual(expected)
    })
  })

  describe('updateLoanPayment', () => {
    /** A loan of 1,000,000 with no account and one instalment of 90,000
     *  (80,000 + 10,000) paid from the wallet on 2026-03-05 — wallet balance
     *  4,910,000, next due 2026-05-01. */
    async function linkedPayment(s: Setup, provider = fakeProvider().provider) {
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        provider,
      )
      expect(await balanceOf(s, s.walletId)).toBe('4910000')
      return {
        loan,
        payment,
        principal: await transactionById(s, payment.principalTransactionId),
        interest: await transactionById(s, payment.interestTransactionId),
      }
    }

    it('updates both linked amounts and re-snapshots FX for an economic change', async () => {
      const s = await setup()
      const { loan, payment, principal, interest } = await linkedPayment(s)
      // A different rate is only observable once today's cached one is gone.
      await clearFxCache()
      const second = fakeProvider(26000, 'loan-link-fake-2')

      const updated = await updateLoanPayment(
        s.userId,
        payment.id,
        {
          totalAmount: 120_000,
          principalAmount: 100_000,
          interestAmount: 20_000,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        second.provider,
      )

      expect(updated.principalTransactionId).toBe(principal.id)
      expect(updated.interestTransactionId).toBe(interest.id)
      const principalAfter = await transactionById(s, principal.id)
      const interestAfter = await transactionById(s, interest.id)
      expect(principalAfter.amount.toString()).toBe('100000')
      expect(interestAfter.amount.toString()).toBe('20000')
      for (const after of [principalAfter, interestAfter]) {
        expect(after.vndPerUsdAtEntry.toString()).toBe('26000')
        expect(after.fxRateSource).toBe('loan-link-fake-2')
        expect(after.fxRateFetchedAt.toISOString()).toBe(second.fetchedAt.toISOString())
      }
      expect(await balanceOf(s, s.walletId)).toBe('4880000')
      expect((await getLoanOutstandingPrincipal(s.userId, loan.id)).toString()).toBe('900000')
      // An edit is not another instalment: the schedule stays where it was.
      expect(formatCalendarDate((await loanById(s, loan.id)).nextDueDate)).toBe('2026-05-01')
    })

    it('re-snapshots only the transaction whose economic content changed (ruling R-6)', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)
      await clearFxCache()
      const second = fakeProvider(26000, 'loan-link-fake-2')

      // Only the interest part changes.
      await updateLoanPayment(
        s.userId,
        payment.id,
        {
          totalAmount: 95_000,
          principalAmount: 80_000,
          interestAmount: 15_000,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        second.provider,
      )

      const principalAfter = await transactionById(s, principal.id)
      expect(principalAfter.vndPerUsdAtEntry.toString()).toBe(principal.vndPerUsdAtEntry.toString())
      expect(principalAfter.fxRateSource).toBe(principal.fxRateSource)
      expect(principalAfter.fxRateFetchedAt).toEqual(principal.fxRateFetchedAt)
      const interestAfter = await transactionById(s, interest.id)
      expect(interestAfter.amount.toString()).toBe('15000')
      expect(interestAfter.fxRateSource).toBe('loan-link-fake-2')
    })

    it('moves both transactions to the new payment day', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)

      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, paymentDate: '2026-03-07', accountId: s.walletId },
        fakeProvider().provider,
      )

      expect((await transactionById(s, principal.id)).date.toISOString()).toBe(
        '2026-03-07T05:00:00.000Z',
      )
      expect((await transactionById(s, interest.id)).date.toISOString()).toBe(
        '2026-03-07T05:00:00.000Z',
      )
      expect(formatCalendarDate((await paymentById(s, payment.id)).paymentDate)).toBe('2026-03-07')
    })

    it('keeps both FX snapshots exactly, and asks for no rate, when only the note changes', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)
      await clearFxCache()

      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, note: 'Corrected', accountId: s.walletId },
        failingProvider,
      )

      for (const before of [principal, interest]) {
        const after = await transactionById(s, before.id)
        expect(after.note).toBe('Corrected')
        expect(after.date).toEqual(before.date)
        expect(after.vndPerUsdAtEntry.toString()).toBe(before.vndPerUsdAtEntry.toString())
        expect(after.fxRateFetchedAt).toEqual(before.fxRateFetchedAt)
        expect(after.fxRateEffectiveAt).toEqual(before.fxRateEffectiveAt)
        expect(after.fxRateSource).toBe(before.fxRateSource)
      }
      expect((await paymentById(s, payment.id)).note).toBe('Corrected')
    })

    it('keeps the instant of an instalment paid today when its date is unchanged', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const today = todayCalendarDateInZone(TEST_TIMEZONE, new Date())
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, paymentDate: today, accountId: s.walletId },
        fakeProvider().provider,
      )
      const principal = await transactionById(s, payment.principalTransactionId)
      await clearFxCache()

      // Not restamped with a later "now", which would read as an economic
      // change and ask for a rate.
      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, paymentDate: today, note: 'Same day', accountId: s.walletId },
        failingProvider,
      )

      expect((await transactionById(s, principal.id)).date).toEqual(principal.date)
    })

    it('keeps the default note written at creation rather than re-rendering it in the current locale', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPaymentIn(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        { timezone: TEST_TIMEZONE, locale: 'en' },
        fakeProvider().provider,
      )

      // Edited later from a Vietnamese session, still with no note of its own.
      await updateLoanPaymentIn(
        s.userId,
        payment.id,
        { ...INSTALMENT, totalAmount: 95_000, interestAmount: 15_000, accountId: s.walletId },
        { timezone: TEST_TIMEZONE, locale: 'vi' },
        fakeProvider().provider,
      )

      expect((await transactionById(s, payment.principalTransactionId)).note).toBe(
        'Principal repaid to Vietcombank',
      )
      expect((await transactionById(s, payment.interestTransactionId)).note).toBe(
        'Interest paid to Vietcombank',
      )
    })

    it('brings the default note back when the user clears their own', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, note: 'Typo', accountId: s.walletId },
        fakeProvider().provider,
      )

      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, accountId: s.walletId },
        fakeProvider().provider,
      )

      expect((await transactionById(s, payment.principalTransactionId)).note).toBe(
        'Trả gốc – Vietcombank',
      )
      expect((await transactionById(s, payment.interestTransactionId)).note).toBe(
        'Lãi vay – Vietcombank',
      )
      expect((await paymentById(s, payment.id)).note).toBeNull()
    })

    it('moves both transactions to another account, re-snapshotting for the move', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)
      await clearFxCache()
      const second = fakeProvider(26000, 'loan-link-fake-2')

      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, accountId: s.bankId },
        second.provider,
      )

      for (const id of [principal.id, interest.id]) {
        const after = await transactionById(s, id)
        expect(after.accountId).toBe(s.bankId)
        expect(after.fxRateSource).toBe('loan-link-fake-2')
      }
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
      expect(await balanceOf(s, s.bankId)).toBe('1910000')
      expect(await transactionCount(s)).toBe(2)
    })

    it('deletes both linked transactions when the account is removed, asking for no rate', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)
      await clearFxCache()

      const updated = await updateLoanPayment(s.userId, payment.id, INSTALMENT, failingProvider)

      expect(updated.principalTransactionId).toBeNull()
      expect(updated.interestTransactionId).toBeNull()
      expect(await transactionExists(s, principal.id)).toBe(false)
      expect(await transactionExists(s, interest.id)).toBe(false)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
    })

    it('creates both linked transactions when an account is added', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(s.userId, loan.id, {
        ...INSTALMENT,
        note: 'Late note',
      })

      const updated = await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, note: 'Late note', accountId: s.bankId },
        fakeProvider().provider,
      )

      const principal = await transactionById(s, updated.principalTransactionId)
      expect(principal).toMatchObject({ accountId: s.bankId, type: 'CASH_OUT', note: 'Late note' })
      expect(principal.date.toISOString()).toBe('2026-03-05T05:00:00.000Z')
      const interest = await transactionById(s, updated.interestTransactionId)
      expect(interest).toMatchObject({ accountId: s.bankId, type: 'EXPENSE', note: 'Late note' })
      expect(await balanceOf(s, s.bankId)).toBe('1910000')
    })

    it('removes the interest transaction when the interest drops to zero, and creates it again when it returns', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)

      const withoutInterest = await updateLoanPayment(
        s.userId,
        payment.id,
        {
          totalAmount: 80_000,
          principalAmount: 80_000,
          interestAmount: 0,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        fakeProvider().provider,
      )
      expect(withoutInterest.principalTransactionId).toBe(principal.id)
      expect(withoutInterest.interestTransactionId).toBeNull()
      expect(await transactionExists(s, interest.id)).toBe(false)
      expect(await balanceOf(s, s.walletId)).toBe('4920000')

      const withInterest = await updateLoanPayment(
        s.userId,
        payment.id,
        {
          totalAmount: 92_000,
          principalAmount: 80_000,
          interestAmount: 12_000,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        fakeProvider().provider,
      )
      const recreated = await transactionById(s, withInterest.interestTransactionId)
      expect(recreated).toMatchObject({ type: 'EXPENSE', categoryId: interest.categoryId })
      expect(recreated.amount.toString()).toBe('12000')
      expect(await balanceOf(s, s.walletId)).toBe('4908000')
    })

    it('removes the principal transaction when an instalment becomes interest only', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)

      const updated = await updateLoanPayment(
        s.userId,
        payment.id,
        {
          totalAmount: 10_000,
          principalAmount: 0,
          interestAmount: 10_000,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        fakeProvider().provider,
      )

      expect(updated.principalTransactionId).toBeNull()
      expect(updated.interestTransactionId).toBe(interest.id)
      expect(await transactionExists(s, principal.id)).toBe(false)
      expect(await balanceOf(s, s.walletId)).toBe('4990000')
    })

    it('re-asserts the type of both linked transactions, and keeps the category the interest was filed under', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)
      const elsewhere = await prisma.category.create({
        data: { userId: s.userId, name: 'Bank fees', type: 'EXPENSE' },
      })
      // As the Transactions page could still do to a linked row before it is
      // locked there (spec §6.5): a stray type change, and a refiled category.
      await prisma.transaction.update({
        where: { userId_id: { userId: s.userId, id: principal.id } },
        data: { type: 'CASH_IN' },
      })
      await prisma.transaction.update({
        where: { userId_id: { userId: s.userId, id: interest.id } },
        data: { categoryId: elsewhere.id },
      })

      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, note: 'Healed', accountId: s.walletId },
        fakeProvider().provider,
      )

      // The type is what makes the money move the right way, so it heals; the
      // interest's category is the user's own filing (Ruling P6), so it stays.
      expect(await transactionById(s, principal.id)).toMatchObject({
        type: 'CASH_OUT',
        categoryId: null,
      })
      expect(await transactionById(s, interest.id)).toMatchObject({
        type: 'EXPENSE',
        categoryId: elsewhere.id,
      })
      expect(await balanceOf(s, s.walletId)).toBe('4910000')
    })

    it('keeps an archived "Loan Interest & Fees" on the interest transaction and creates no new category', async () => {
      const s = await setup()
      const { payment, interest } = await linkedPayment(s)
      await prisma.category.update({
        where: { userId_id: { userId: s.userId, id: interest.categoryId as string } },
        data: { status: 'ARCHIVED' },
      })

      // A note-only edit…
      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, note: 'Note only', accountId: s.walletId },
        fakeProvider().provider,
      )
      // …and a principal-only one.
      await updateLoanPayment(
        s.userId,
        payment.id,
        {
          totalAmount: 80_000,
          principalAmount: 70_000,
          interestAmount: 10_000,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        fakeProvider().provider,
      )

      expect((await transactionById(s, interest.id)).categoryId).toBe(interest.categoryId)
      // Still only the one, archived category: nothing was created beside it.
      const categories = await interestCategories(s)
      expect(categories.map((category) => [category.id, category.status])).toEqual([
        [interest.categoryId, 'ARCHIVED'],
      ])
      expect(await balanceOf(s, s.walletId)).toBe('4920000')
    })

    it('files an interest transaction that lost its category under "Loan Interest & Fees" again', async () => {
      const s = await setup()
      const { payment, interest } = await linkedPayment(s)
      await prisma.transaction.update({
        where: { userId_id: { userId: s.userId, id: interest.id } },
        data: { categoryId: null },
      })

      await updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, note: 'Refiled', accountId: s.walletId },
        fakeProvider().provider,
      )

      expect((await transactionById(s, interest.id)).categoryId).toBe(interest.categoryId)
      expect(await interestCategories(s)).toHaveLength(1)
    })

    it('keeps the over-payment rule and changes nothing when it refuses', async () => {
      const s = await setup()
      const { loan, payment, principal, interest } = await linkedPayment(s)
      await recordLoanPayment(s.userId, loan.id, {
        totalAmount: 900_000,
        principalAmount: 900_000,
        interestAmount: 0,
        paymentDate: '2026-03-06',
      })

      const caught = await captureRejection(
        updateLoanPayment(
          s.userId,
          payment.id,
          {
            totalAmount: 110_000.01,
            principalAmount: 100_000.01,
            interestAmount: 10_000,
            paymentDate: '2026-03-05',
            accountId: s.walletId,
          },
          fakeProvider().provider,
        ),
      )

      expect(caught).toBeInstanceOf(LoanOverpaymentError)
      expect((caught as LoanOverpaymentError).outstandingPrincipal.toString()).toBe('100000')
      expect(await transactionById(s, principal.id)).toEqual(principal)
      expect(await transactionById(s, interest.id)).toEqual(interest)
      expect(await paymentById(s, payment.id)).toEqual(payment)
    })

    it('refuses an account in another currency, and an archived account, changing nothing', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)
      const { provider } = fakeProvider()

      await expect(
        updateLoanPayment(
          s.userId,
          payment.id,
          { ...INSTALMENT, accountId: s.dollarsId },
          provider,
        ),
      ).rejects.toThrow(LinkedAccountCurrencyMismatchError)
      await expect(
        updateLoanPayment(
          s.userId,
          payment.id,
          { ...INSTALMENT, accountId: s.archivedId },
          provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await transactionById(s, principal.id)).toEqual(principal)
      expect(await transactionById(s, interest.id)).toEqual(interest)
      expect(await paymentById(s, payment.id)).toEqual(payment)
    })

    it("refuses another user's instalment, and moving mine into another user's account", async () => {
      const s = await setup()
      const other = await setup()
      const mine = await linkedPayment(s)
      const theirs = await linkedPayment(other)
      const { provider } = fakeProvider()

      await expectPrismaCode(
        updateLoanPayment(
          s.userId,
          theirs.payment.id,
          { ...INSTALMENT, accountId: s.walletId },
          provider,
        ),
        'P2025',
      )
      await expectPrismaCode(
        updateLoanPayment(
          s.userId,
          mine.payment.id,
          { ...INSTALMENT, accountId: other.walletId },
          provider,
        ),
        'P2025',
      )

      expect(await paymentById(other, theirs.payment.id)).toEqual(theirs.payment)
      expect(await transactionById(other, theirs.principal.id)).toEqual(theirs.principal)
      expect(await transactionById(other, theirs.interest.id)).toEqual(theirs.interest)
      expect(await transactionById(s, mine.principal.id)).toEqual(mine.principal)
    })

    it('refuses an instalment of a closed loan', async () => {
      const s = await setup()
      const { loan, payment, principal } = await linkedPayment(s)
      await closeLoan(s.userId, loan.id)

      await expect(
        updateLoanPayment(
          s.userId,
          payment.id,
          { ...INSTALMENT, totalAmount: 91_000, interestAmount: 11_000, accountId: s.walletId },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(LoanNotActiveError)

      expect(await transactionById(s, principal.id)).toEqual(principal)
      expect(await paymentById(s, payment.id)).toEqual(payment)
    })

    it('rolls every linked change back when the instalment row fails to write', async () => {
      const s = await setup()
      const { payment, principal, interest } = await linkedPayment(s)
      const { provider } = fakeProvider()
      const failure = failInsideTransaction('loanPayment', 'update')

      // Moves both to the bank and drops the interest — every kind of linked
      // write happens before the failing payment update.
      await expect(
        updateLoanPayment(
          s.userId,
          payment.id,
          {
            totalAmount: 80_000,
            principalAmount: 80_000,
            interestAmount: 0,
            paymentDate: '2026-03-05',
            accountId: s.bankId,
          },
          provider,
        ),
      ).rejects.toBe(failure)

      expect(await transactionById(s, principal.id)).toEqual(principal)
      expect(await transactionById(s, interest.id)).toEqual(interest)
      expect(await paymentById(s, payment.id)).toEqual(payment)
      expect(await balanceOf(s, s.walletId)).toBe('4910000')
      expect(await balanceOf(s, s.bankId)).toBe('2000000')
    })
  })

  describe('deleteLoanPayment', () => {
    it('removes the instalment and both transactions; the balance and the schedule come back', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        fakeProvider().provider,
      )
      expect(await balanceOf(s, s.walletId)).toBe('4910000')

      await deleteLoanPayment(s.userId, payment.id)

      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
      expect((await getLoanOutstandingPrincipal(s.userId, loan.id)).toString()).toBe('1000000')
      // The due date steps back the one period recording it advanced.
      expect(formatCalendarDate((await loanById(s, loan.id)).nextDueDate)).toBe('2026-04-01')
    })

    it('removes an interest-only instalment and its one transaction', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        {
          totalAmount: 5_000,
          principalAmount: 0,
          interestAmount: 5_000,
          paymentDate: '2026-03-05',
          accountId: s.walletId,
        },
        fakeProvider().provider,
      )

      await deleteLoanPayment(s.userId, payment.id)

      expect(await transactionCount(s)).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
    })

    it("refuses another user's instalment and leaves its rows in place", async () => {
      const s = await setup()
      const other = await setup()
      const loan = await unlinkedLoan(other)
      const { payment: theirs } = await recordLoanPayment(
        other.userId,
        loan.id,
        { ...INSTALMENT, accountId: other.walletId },
        fakeProvider().provider,
      )

      await expectPrismaCode(deleteLoanPayment(s.userId, theirs.id), 'P2025')

      expect(await paymentById(other, theirs.id)).toEqual(theirs)
      expect(await transactionCount(other)).toBe(2)
      expect(formatCalendarDate((await loanById(other, loan.id)).nextDueDate)).toBe('2026-05-01')
    })

    it('refuses an instalment of a closed loan', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        fakeProvider().provider,
      )
      await closeLoan(s.userId, loan.id)

      await expect(deleteLoanPayment(s.userId, payment.id)).rejects.toThrow(LoanNotActiveError)

      expect(await transactionCount(s)).toBe(2)
      expect(await paymentById(s, payment.id)).toEqual(payment)
    })

    it('refuses while the account is archived — its history is frozen', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.bankId },
        fakeProvider().provider,
      )
      await prisma.financialAccount.update({
        where: { userId_id: { userId: s.userId, id: s.bankId } },
        data: { status: 'ARCHIVED' },
      })

      await expect(deleteLoanPayment(s.userId, payment.id)).rejects.toThrow(ArchivedAccountError)

      expect(await transactionCount(s)).toBe(2)
      expect(await paymentById(s, payment.id)).toEqual(payment)
    })

    it('rolls the deletions back when stepping the schedule back fails', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        fakeProvider().provider,
      )
      const failure = failInsideTransaction('loan', 'update')

      await expect(deleteLoanPayment(s.userId, payment.id)).rejects.toBe(failure)

      expect(await paymentById(s, payment.id)).toEqual(payment)
      expect(await transactionCount(s)).toBe(2)
      expect(await balanceOf(s, s.walletId)).toBe('4910000')
      expect(formatCalendarDate((await loanById(s, loan.id)).nextDueDate)).toBe('2026-05-01')
    })
  })

  describe('closeLoan', () => {
    it('creates no transaction and keeps the linked ones — no money moves', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      const loan = await createLoan(s.userId, { ...BASE_LOAN, accountId: s.walletId }, provider)
      await recordLoanPayment(s.userId, loan.id, { ...INSTALMENT, accountId: s.walletId }, provider)

      await closeLoan(s.userId, loan.id)

      expect(await transactionCount(s)).toBe(3)
      expect(await balanceOf(s, s.walletId)).toBe('5910000')
    })
  })

  describe('database constraints', () => {
    it("rejects a link to another user's transaction even bypassing the service", async () => {
      const s = await setup()
      const other = await setup()
      const loan = await unlinkedLoan(s)
      const { payment } = await recordLoanPayment(s.userId, loan.id, INSTALMENT)
      const theirLoan = await createLoan(
        other.userId,
        { ...BASE_LOAN, accountId: other.walletId },
        fakeProvider().provider,
      )

      // The composite (userId, …TransactionId) foreign keys, not the service: a
      // loan or an instalment cannot name a transaction that is not its user's.
      await expectPrismaCode(
        prisma.loan.update({
          where: { userId_id: { userId: s.userId, id: loan.id } },
          data: { disbursementTransactionId: theirLoan.disbursementTransactionId },
        }),
        'P2003',
      )
      for (const field of ['principalTransactionId', 'interestTransactionId'] as const) {
        await expectPrismaCode(
          prisma.loanPayment.update({
            where: { userId_id: { userId: s.userId, id: payment.id } },
            data: { [field]: theirLoan.disbursementTransactionId },
          }),
          'P2003',
        )
      }
    })

    it('refuses to delete a linked transaction out from under its loan or instalment (Restrict)', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      const loan = await createLoan(s.userId, { ...BASE_LOAN, accountId: s.walletId }, provider)
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        provider,
      )

      for (const id of [
        loan.disbursementTransactionId,
        payment.principalTransactionId,
        payment.interestTransactionId,
      ]) {
        await expectPrismaCode(
          prisma.transaction.delete({
            where: { userId_id: { userId: s.userId, id: id as string } },
          }),
          'P2003',
        )
      }

      expect(await transactionCount(s)).toBe(3)
    })
  })

  /**
   * Lock order: accounts first, then the loan row, then transaction rows — the
   * order `createTransaction`/`updateTransaction`/`deleteTransaction` and the
   * debt paths already use, so the new linked paths can run beside them without
   * a deadlock. `holdAccountLock` parks an interactive transaction on an account
   * row lock until the test releases it (the pattern in `concurrency.test.ts`),
   * so these cases decide the interleaving rather than hoping the scheduler
   * does.
   */
  describe('lock order and concurrency', () => {
    const LOCK_WAIT_MS = 300
    /** Every lock a case took, so one that fails before its own `release()`
     *  still frees the row instead of stalling the cleanup behind it. */
    const heldLocks: { release: () => Promise<void> }[] = []

    afterEach(async () => {
      // Runs before the suite's cleanup; releasing twice is harmless.
      for (const lock of heldLocks.splice(0)) await lock.release()
    })

    function hasSettledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
      const settled = promise.then(
        () => true,
        () => true,
      )
      const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
      return Promise.race([settled, timer])
    }

    async function holdAccountLock(
      userId: string,
      accountId: string,
      mutate: (tx: Prisma.TransactionClient) => Promise<void> = async () => {},
    ) {
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
        { timeout: 30_000, maxWait: 30_000 },
      )
      // If the holder fails before taking the lock, surface that instead of hanging.
      await Promise.race([acquired, held])
      const lock = {
        release: async () => {
          openGate()
          await held
        },
      }
      heldLocks.push(lock)
      return lock
    }

    it('a linked instalment waits on the account before it takes the loan lock', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { provider } = fakeProvider()
      // Warms the FX cache and makes the interest category, so the instalment
      // below waits on nothing but the row lock.
      await recordLoanPayment(s.userId, loan.id, { ...INSTALMENT, accountId: s.bankId }, provider)
      const lock = await holdAccountLock(s.userId, s.walletId)

      const pending = recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, paymentDate: '2026-03-06', accountId: s.walletId },
        provider,
      )
      expect(await hasSettledWithin(pending, LOCK_WAIT_MS)).toBe(false)

      // The instalment is queued on the account, so it holds no loan lock yet:
      // a close — which takes only the loan lock — goes straight through. Had
      // the instalment locked the loan first, this would wait behind it.
      const close = closeLoan(s.userId, loan.id)
      expect(await hasSettledWithin(close, LOCK_WAIT_MS)).toBe(true)
      await expect(close).resolves.toMatchObject({ status: 'CLOSED' })

      await lock.release()
      // It then sees the committed close under the loan lock and writes
      // nothing — neither transaction, nor the instalment, nor a due date move.
      await expect(pending).rejects.toThrow(LoanNotActiveError)
      expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(1)
      expect(await transactionCount(s)).toBe(2)
      expect(formatCalendarDate((await loanById(s, loan.id)).nextDueDate)).toBe('2026-05-01')
    }, 30_000)

    it('a linked instalment and a transaction edit on the same account both complete', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      for (const run of [1, 2, 3]) {
        const loan = await unlinkedLoan(s, { lender: `Race ${run}` })
        const ordinary = await createTransaction(
          s.userId,
          { accountId: s.walletId, type: 'CASH_IN', amount: 1000, date: new Date('2026-03-01') },
          provider,
        )

        const results = await Promise.allSettled([
          recordLoanPayment(s.userId, loan.id, { ...INSTALMENT, accountId: s.walletId }, provider),
          updateTransaction(
            s.userId,
            ordinary.id,
            { accountId: s.walletId, type: 'CASH_IN', amount: 2000, date: new Date('2026-03-01') },
            provider,
          ),
        ])

        // Serialised on the wallet's row lock, never deadlocked against each other.
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      }
    }, 30_000)

    it('an instalment moved between two accounts races a transaction moved the other way without deadlock', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      for (const run of [1, 2, 3]) {
        const loan = await unlinkedLoan(s, { lender: `Swap ${run}` })
        const { payment } = await recordLoanPayment(
          s.userId,
          loan.id,
          { ...INSTALMENT, accountId: s.walletId },
          provider,
        )
        const ordinary = await createTransaction(
          s.userId,
          { accountId: s.bankId, type: 'CASH_IN', amount: 1000, date: new Date('2026-03-01') },
          provider,
        )

        // wallet → bank for the instalment, bank → wallet for the transaction:
        // the opposite-order pair, safe only because both lock the two accounts
        // in one sorted statement before anything else.
        const results = await Promise.allSettled([
          updateLoanPayment(s.userId, payment.id, { ...INSTALMENT, accountId: s.bankId }, provider),
          updateTransaction(
            s.userId,
            ordinary.id,
            { accountId: s.walletId, type: 'CASH_IN', amount: 1000, date: new Date('2026-03-01') },
            provider,
          ),
        ])

        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      }
    }, 30_000)

    it('refuses an instalment edit whose linked transaction changed after it was read', async () => {
      const s = await setup()
      const loan = await unlinkedLoan(s)
      const { provider } = fakeProvider()
      const { payment } = await recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, accountId: s.walletId },
        provider,
      )
      const interestId = payment.interestTransactionId as string
      // Another session edits the linked interest transaction (as the
      // Transactions page still can until linked rows are locked there) while
      // holding the wallet.
      const lock = await holdAccountLock(s.userId, s.walletId, async (tx) => {
        await tx.transaction.update({
          where: { userId_id: { userId: s.userId, id: interestId } },
          data: { note: 'Edited elsewhere' },
        })
      })

      const pending = updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, totalAmount: 95_000, interestAmount: 15_000, accountId: s.walletId },
        provider,
      )
      expect(await hasSettledWithin(pending, LOCK_WAIT_MS)).toBe(false)
      await lock.release()

      // The edit decided its FX and its writes against a copy that no longer
      // exists, so it is refused rather than overwriting the other change.
      await expect(pending).rejects.toThrow(ConcurrentModificationError)
      const stored = await transactionById(s, interestId)
      expect(stored.note).toBe('Edited elsewhere')
      expect(stored.amount.toString()).toBe('10000')
      expect((await paymentById(s, payment.id)).interestAmount.toString()).toBe('10000')
    }, 30_000)
  })
})
