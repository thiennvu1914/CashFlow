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
import { getAccountBalance } from '@/lib/server/services/balance'
import type { CreateDebtInput, RecordDebtPaymentInput } from '@/lib/validation/debt'
import { ArchivedAccountError } from './account-lock'
import { LinkedAccountCurrencyMismatchError } from './linked-transaction'
import { ConcurrentModificationError, createTransaction, updateTransaction } from './transaction'
import {
  createDebt as createDebtIn,
  deleteDebtPayment,
  deriveDebtDisplayStatus,
  deriveDebtOutstanding,
  getDebtOutstanding,
  getDebtsWithOutstanding,
  listDebts,
  recordDebtPayment as recordDebtPaymentIn,
  updateDebt,
  updateDebtPayment as updateDebtPaymentIn,
  writeOffDebt,
  DebtNotActiveError,
  DebtOverpaymentError,
  type DebtLinkContext,
  type DebtTotals,
  type DebtWithOutstanding,
} from './debt'

/**
 * Group 2's data-layer acceptance check (spec §4.9), extended by money-source
 * linking (spec 2026-10-12 §4, §6.2).
 *
 * Six properties are what the `debt service` block exists to hold:
 *
 * 1. **Without an account, nothing moves.** The fixture seeds an account and an
 *    EXPENSE transaction, and `afterEach` re-asserts the account / transaction
 *    /transfer counts, the two seeded rows field for field, and the account's
 *    derived balance — after *every* case, not just a dedicated one. Every case
 *    in that block records its debts and payments with no account (the
 *    "don't record in an account" choice), so a stray write to the ledger fails
 *    the test that made it.
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
 *
 * The `money-source linking` block below covers the other choice — a debt or a
 * payment recorded in an account — where the matching Transaction is written in
 * the same database transaction (spec §4's mapping, an injected FX provider for
 * the snapshot, balances moving, refusals writing nothing, payment edits and
 * deletes keeping both sides consistent, and the lock order).
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

/**
 * What the action layer passes from the session (`resolveProfileDefaults(user)`):
 * the zone a calendar date is pinned to 12:00 in, and the language a default
 * transaction note is written in.
 */
const CONTEXT: DebtLinkContext = { timezone: TEST_TIMEZONE, locale: 'vi' }

/** The three writes that take a context, with the test default applied — the
 *  `…In` originals are called directly where a case needs another locale. */
function createDebt(userId: string, input: CreateDebtInput, provider?: ExchangeRateProvider) {
  return createDebtIn(userId, input, CONTEXT, provider)
}

function recordDebtPayment(
  userId: string,
  debtId: string,
  input: RecordDebtPaymentInput,
  provider?: ExchangeRateProvider,
) {
  return recordDebtPaymentIn(userId, debtId, input, CONTEXT, provider)
}

function updateDebtPayment(
  userId: string,
  paymentId: string,
  input: RecordDebtPaymentInput,
  provider?: ExchangeRateProvider,
) {
  return updateDebtPaymentIn(userId, paymentId, input, CONTEXT, provider)
}

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

  describe('payment edit and delete', () => {
    it('edits the amount, date and note of a payment', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      const payment = await recordDebtPayment(fx.userId, debt.id, {
        amount: 250_000,
        date: '2026-03-01',
        note: 'First',
      })

      const updated = await updateDebtPayment(fx.userId, payment.id, {
        amount: 300_000.5,
        date: '2026-03-02',
      })

      expect(updated.id).toBe(payment.id)
      expect(updated.debtId).toBe(debt.id)
      expect(updated.amount.toString()).toBe('300000.5')
      expect(formatCalendarDate(updated.date)).toBe('2026-03-02')
      // A cleared note is written as null, not skipped.
      expect(updated.note).toBeNull()
      expect(updated.transactionId).toBeNull()
      expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('699999.5')
    })

    it('measures an edit against what is owed without the payment being edited', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      await recordDebtPayment(fx.userId, debt.id, { amount: 600_000, date: '2026-03-01' })
      const second = await recordDebtPayment(fx.userId, debt.id, {
        amount: 300_000,
        date: '2026-03-02',
      })

      // 600,000 + 400,000 settles the debt exactly — the edited payment's own
      // old 300,000 must not count against it.
      await updateDebtPayment(fx.userId, second.id, { amount: 400_000, date: '2026-03-02' })
      const caught = await captureRejection(
        updateDebtPayment(fx.userId, second.id, { amount: 400_000.01, date: '2026-03-02' }),
      )

      expect(caught).toBeInstanceOf(DebtOverpaymentError)
      // What would have fitted: the original amount minus every *other* payment.
      expect((caught as DebtOverpaymentError).outstanding.toString()).toBe('400000')
      const stored = await prisma.debtPayment.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: second.id } },
      })
      expect(stored.amount.toString()).toBe('400000')
      expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('0')
    })

    it('deletes a payment, and the outstanding amount comes back', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      const kept = await recordDebtPayment(fx.userId, debt.id, {
        amount: 100_000,
        date: '2026-03-01',
      })
      const removed = await recordDebtPayment(fx.userId, debt.id, {
        amount: 250_000,
        date: '2026-03-02',
      })

      await deleteDebtPayment(fx.userId, removed.id)

      const payments = await prisma.debtPayment.findMany({
        where: { userId: fx.userId, debtId: debt.id },
      })
      expect(payments.map((payment) => payment.id)).toEqual([kept.id])
      expect((await getDebtOutstanding(fx.userId, debt.id)).toString()).toBe('900000')
    })

    it('refuses to edit or delete a payment of a written-off debt — its history is frozen', async () => {
      const debt = await createDebt(fx.userId, BASE_DEBT)
      const payment = await recordDebtPayment(fx.userId, debt.id, {
        amount: 100_000,
        date: '2026-03-01',
      })
      await writeOffDebt(fx.userId, debt.id)

      await expect(
        updateDebtPayment(fx.userId, payment.id, { amount: 1, date: '2026-03-01' }),
      ).rejects.toThrow(DebtNotActiveError)
      await expect(deleteDebtPayment(fx.userId, payment.id)).rejects.toThrow(DebtNotActiveError)

      const stored = await prisma.debtPayment.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: payment.id } },
      })
      expect(stored).toEqual(payment)
    })

    it('answers a payment id that does not exist with P2025', async () => {
      await expectPrismaCode(
        updateDebtPayment(fx.userId, 'missing-payment', { amount: 1, date: TODAY }),
        'P2025',
      )
      await expectPrismaCode(deleteDebtPayment(fx.userId, 'missing-payment'), 'P2025')
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
      const theirPayment = await recordDebtPayment(other.userId, theirs.id, {
        amount: 1_000,
        date: '2026-03-01',
      })
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
      await expectPrismaCode(
        updateDebtPayment(fx.userId, theirPayment.id, { amount: 1, date: TODAY }),
        'P2025',
      )
      await expectPrismaCode(deleteDebtPayment(fx.userId, theirPayment.id), 'P2025')

      const after = await prisma.debt.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
        include: { payments: true },
      })
      // Byte-identical, `updatedAt` and the payment row included: not one of
      // the six attempts reached a write.
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

  describe('without an account — no money moves', () => {
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
      const first = await recordDebtPayment(fx.userId, debt.id, {
        amount: 400_000,
        date: '2026-03-01',
      })
      await updateDebt(fx.userId, debt.id, {
        person: 'Nguyen An',
        description: 'Edited',
        dueDate: '2026-07-31',
        notes: 'Edited',
      })
      await updateDebtPayment(fx.userId, first.id, { amount: 300_000, date: '2026-03-02' })
      const extra = await recordDebtPayment(fx.userId, debt.id, {
        amount: 100_000,
        date: '2026-03-05',
      })
      await deleteDebtPayment(fx.userId, extra.id)
      await recordDebtPayment(fx.userId, debt.id, { amount: 700_000, date: '2026-03-10' })
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
  })
})

/**
 * Money-source linking for debts (spec 2026-10-12 §4, §6.2, §6.8) against the
 * real database.
 *
 * Every FX lookup goes through an injected fake provider whose snapshot values
 * are asserted exactly, and `fetch` is a throwing spy, so nothing here can reach
 * the network. The USD/VND `ExchangeRate` cache rows are global, so `afterEach`
 * deletes them and resets the in-process FX memo (the rule
 * `transaction.test.ts` follows).
 *
 * "No FX lookup happened" is proved with `failingProvider` over an empty cache
 * (`beforeEach` empties it; a case that has already cached a rate empties it
 * again): a lookup there could only end in `FxUnavailableError`, so a write
 * that succeeds never asked.
 */
describe('money-source linking', () => {
  const LINK_FX_SOURCE = 'debt-link-fake'
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
   * VND one. Each funded account starts at a distinct round figure, so every
   * balance assertion below is a delta anyone can check by eye.
   */
  async function setup() {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `debt-link-${randomUUID()}@example.com`,
        name: 'Debt Link Test',
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

  async function paymentById(s: Setup, id: string) {
    return prisma.debtPayment.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
  }

  /** A RECEIVABLE of 1,000,000 recorded with no account, so the cases about
   *  payments start from an untouched ledger. */
  function unlinkedDebt(s: Setup, overrides: Partial<CreateDebtInput> = {}) {
    return createDebt(s.userId, { ...BASE_DEBT, ...overrides })
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
        // Payments and debts first: they reference the transactions now.
        await prisma.debtPayment.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.debt.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    expect(fetchCalls).toBe(0)
  })

  describe('createDebt with an account', () => {
    it('records a RECEIVABLE as a CASH_OUT on the money-moved day, in the account currency', async () => {
      const s = await setup()
      const { provider, fetchedAt, effectiveDate } = fakeProvider()

      const debt = await createDebt(
        s.userId,
        // `currency: 'USD'` is the form's leftover choice: with an account, the
        // debt is in the account's currency, whatever the form said.
        { ...BASE_DEBT, currency: 'USD', accountId: s.walletId, movedOn: '2026-03-10' },
        provider,
      )

      expect(debt.currency).toBe('VND')
      expect(debt.openingTransactionId).not.toBeNull()
      // What the payment picker pre-selects (spec §6.2) travels with the row.
      expect(debt.openingTransaction).toMatchObject({
        accountId: s.walletId,
        account: { status: 'ACTIVE' },
      })

      const opening = await transactionById(s, debt.openingTransactionId)
      expect(opening).toMatchObject({
        accountId: s.walletId,
        type: 'CASH_OUT',
        currency: 'VND',
        categoryId: null,
        // No notes given: the label, rendered once in the user's locale.
        note: 'Cho mượn – Nguyen An',
        fxRateSource: LINK_FX_SOURCE,
      })
      expect(opening.amount.toString()).toBe('1000000')
      // 12:00 on 2026-03-10 in Asia/Ho_Chi_Minh (UTC+7): the same calendar day
      // in every zone the user could later read it in.
      expect(opening.date.toISOString()).toBe('2026-03-10T05:00:00.000Z')
      expect(opening.vndPerUsdAtEntry.toString()).toBe('25000')
      expect(opening.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())
      expect(opening.fxRateEffectiveAt.toISOString()).toBe(utcDayStart(effectiveDate).toISOString())

      expect(await balanceOf(s, s.walletId)).toBe('4000000')
      expect(await transactionCount(s)).toBe(1)
    })

    it('records a PAYABLE as a CASH_IN, carrying the user notes as the transaction note', async () => {
      const s = await setup()

      const debt = await createDebt(
        s.userId,
        {
          direction: 'PAYABLE',
          person: 'Binh',
          originalAmount: 300_000,
          currency: 'VND',
          notes: 'For the rent',
          accountId: s.bankId,
          movedOn: '2026-03-01',
        },
        fakeProvider().provider,
      )

      const opening = await transactionById(s, debt.openingTransactionId)
      expect(opening).toMatchObject({ accountId: s.bankId, type: 'CASH_IN', note: 'For the rent' })
      expect(opening.amount.toString()).toBe('300000')
      expect(await balanceOf(s, s.bankId)).toBe('2300000')
    })

    it('records nothing and asks for no rate without an account, keeping the chosen currency', async () => {
      const s = await setup()

      const debt = await createDebt(s.userId, { ...BASE_DEBT, currency: 'USD' }, failingProvider)

      expect(debt.currency).toBe('USD')
      expect(debt.openingTransactionId).toBeNull()
      expect(debt.openingTransaction).toBeNull()
      expect(await transactionCount(s)).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
    })

    it("refuses another user's account with P2025 and writes nothing for either user", async () => {
      const s = await setup()
      const other = await setup()

      await expectPrismaCode(
        createDebt(
          s.userId,
          { ...BASE_DEBT, accountId: other.walletId, movedOn: '2026-03-10' },
          fakeProvider().provider,
        ),
        'P2025',
      )

      expect(await prisma.debt.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
      expect(await transactionCount(other)).toBe(0)
      expect(await balanceOf(other, other.walletId)).toBe('5000000')
    })

    it('refuses an archived account and writes nothing', async () => {
      const s = await setup()

      await expect(
        createDebt(
          s.userId,
          { ...BASE_DEBT, accountId: s.archivedId, movedOn: '2026-03-10' },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.debt.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
    })

    it('writes nothing when no usable rate exists — no debt without its transaction', async () => {
      const s = await setup()

      await expect(
        createDebt(
          s.userId,
          { ...BASE_DEBT, accountId: s.walletId, movedOn: '2026-03-10' },
          failingProvider,
        ),
      ).rejects.toThrow(FxUnavailableError)

      expect(await prisma.debt.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
    })
  })

  describe('recordDebtPayment with an account', () => {
    it('records a RECEIVABLE repayment as a CASH_IN on the payment day; outstanding and balance move', async () => {
      const s = await setup()
      const { provider, fetchedAt } = fakeProvider()
      const debt = await createDebt(
        s.userId,
        { ...BASE_DEBT, accountId: s.walletId, movedOn: '2026-03-01' },
        provider,
      )

      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 250_000, date: '2026-03-15', accountId: s.bankId },
        provider,
      )

      const linked = await transactionById(s, payment.transactionId)
      expect(linked).toMatchObject({
        accountId: s.bankId,
        type: 'CASH_IN',
        currency: 'VND',
        note: 'Thu nợ – Nguyen An',
        fxRateSource: LINK_FX_SOURCE,
      })
      expect(linked.amount.toString()).toBe('250000')
      expect(linked.date.toISOString()).toBe('2026-03-15T05:00:00.000Z')
      expect(linked.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())
      // The payment row itself keeps its calendar-date carrier.
      expect(formatCalendarDate(payment.date)).toBe('2026-03-15')

      expect((await getDebtOutstanding(s.userId, debt.id)).toString()).toBe('750000')
      expect(await balanceOf(s, s.bankId)).toBe('2250000')
      // And the read the Debts page uses carries the link and its account.
      const [listed] = await listDebts(s.userId)
      expect(listed.payments).toHaveLength(1)
      expect(listed.payments[0]).toMatchObject({
        transactionId: linked.id,
        transaction: { accountId: s.bankId },
      })
    })

    it('dates a payment made today at the current instant, so the balance moves immediately', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      const debt = await unlinkedDebt(s)
      const today = todayCalendarDateInZone(TEST_TIMEZONE, new Date())

      const before = Date.now()
      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 250_000, date: today, accountId: s.bankId },
        provider,
      )
      const linked = await transactionById(s, payment.transactionId)

      // Not 12:00 of a day that may still be hours away.
      expect(linked.date.getTime()).toBeGreaterThanOrEqual(before)
      expect(linked.date.getTime()).toBeLessThanOrEqual(Date.now())
      expect(await balanceOf(s, s.bankId)).toBe('2250000')
    })

    it('records a PAYABLE repayment as a CASH_OUT carrying the user note', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s, { direction: 'PAYABLE', person: 'Binh' })

      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 100_000, date: '2026-03-02', note: 'Cash at lunch', accountId: s.walletId },
        fakeProvider().provider,
      )

      const linked = await transactionById(s, payment.transactionId)
      expect(linked).toMatchObject({ type: 'CASH_OUT', note: 'Cash at lunch' })
      expect(payment.note).toBe('Cash at lunch')
      expect(await balanceOf(s, s.walletId)).toBe('4900000')
    })

    it('records nothing and asks for no rate without an account', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)

      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 100_000, date: '2026-03-02' },
        failingProvider,
      )

      expect(payment.transactionId).toBeNull()
      expect(await transactionCount(s)).toBe(0)
    })

    it('refuses an overpayment and leaves no orphan transaction behind', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)
      await recordDebtPayment(s.userId, debt.id, { amount: 600_000, date: '2026-03-01' })

      const caught = await captureRejection(
        recordDebtPayment(
          s.userId,
          debt.id,
          { amount: 400_000.01, date: '2026-03-02', accountId: s.walletId },
          fakeProvider().provider,
        ),
      )

      expect(caught).toBeInstanceOf(DebtOverpaymentError)
      expect(await transactionCount(s)).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
      expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(1)
    })

    it('refuses an account in another currency than the debt', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)

      await expect(
        recordDebtPayment(
          s.userId,
          debt.id,
          { amount: 100, date: '2026-03-02', accountId: s.dollarsId },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(LinkedAccountCurrencyMismatchError)

      expect(await transactionCount(s)).toBe(0)
      expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(0)
    })

    it('refuses an archived account', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)

      await expect(
        recordDebtPayment(
          s.userId,
          debt.id,
          { amount: 100, date: '2026-03-02', accountId: s.archivedId },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(0)
    })

    it("refuses another user's account, and another user's debt, with P2025", async () => {
      const s = await setup()
      const other = await setup()
      const mine = await unlinkedDebt(s)
      const theirs = await unlinkedDebt(other)
      const { provider } = fakeProvider()

      await expectPrismaCode(
        recordDebtPayment(
          s.userId,
          mine.id,
          { amount: 100, date: '2026-03-02', accountId: other.walletId },
          provider,
        ),
        'P2025',
      )
      await expectPrismaCode(
        recordDebtPayment(
          s.userId,
          theirs.id,
          { amount: 100, date: '2026-03-02', accountId: s.walletId },
          provider,
        ),
        'P2025',
      )

      expect(
        await prisma.debtPayment.count({ where: { userId: { in: [s.userId, other.userId] } } }),
      ).toBe(0)
      expect(await transactionCount(s)).toBe(0)
      expect(await transactionCount(other)).toBe(0)
    })

    it('writes nothing when no usable rate exists', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)

      await expect(
        recordDebtPayment(
          s.userId,
          debt.id,
          { amount: 100, date: '2026-03-02', accountId: s.walletId },
          failingProvider,
        ),
      ).rejects.toThrow(FxUnavailableError)

      expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
    })
  })

  describe('default notes', () => {
    it.each([
      ['vi', ['Cho mượn – An', 'Thu nợ – An', 'Mượn – Binh', 'Trả nợ – Binh']],
      ['en', ['Lent to An', 'Repaid by An', 'Borrowed from Binh', 'Repaid to Binh']],
    ] as const)('writes the label in the user locale (%s)', async (locale, expected) => {
      const s = await setup()
      const context: DebtLinkContext = { timezone: TEST_TIMEZONE, locale }
      const { provider } = fakeProvider()
      const link = { accountId: s.walletId, movedOn: '2026-03-01' }

      const lent = await createDebtIn(
        s.userId,
        { ...BASE_DEBT, person: 'An', ...link },
        context,
        provider,
      )
      const repaidToMe = await recordDebtPaymentIn(
        s.userId,
        lent.id,
        { amount: 1, date: '2026-03-02', accountId: s.walletId },
        context,
        provider,
      )
      const borrowed = await createDebtIn(
        s.userId,
        { ...BASE_DEBT, direction: 'PAYABLE', person: 'Binh', ...link },
        context,
        provider,
      )
      const repaidByMe = await recordDebtPaymentIn(
        s.userId,
        borrowed.id,
        { amount: 1, date: '2026-03-02', accountId: s.walletId },
        context,
        provider,
      )

      const notes = await Promise.all(
        [
          lent.openingTransactionId,
          repaidToMe.transactionId,
          borrowed.openingTransactionId,
          repaidByMe.transactionId,
        ].map(async (id) => (await transactionById(s, id)).note),
      )
      expect(notes).toEqual(expected)
    })
  })

  describe('updateDebtPayment', () => {
    /** A RECEIVABLE of 1,000,000 with no account and one payment of 200,000
     *  recorded in the wallet on 2026-03-05 — wallet balance 5,200,000. */
    async function linkedPayment(s: Setup) {
      const debt = await unlinkedDebt(s)
      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 200_000, date: '2026-03-05', accountId: s.walletId },
        fakeProvider().provider,
      )
      expect(await balanceOf(s, s.walletId)).toBe('5200000')
      return { debt, payment, transaction: await transactionById(s, payment.transactionId) }
    }

    it('updates the linked transaction amount and re-snapshots FX for an economic change', async () => {
      const s = await setup()
      const { debt, payment, transaction } = await linkedPayment(s)
      // A different rate is only observable once today's cached one is gone.
      await clearFxCache()
      const second = fakeProvider(26000, 'debt-link-fake-2')

      const updated = await updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 300_000, date: '2026-03-05', accountId: s.walletId },
        second.provider,
      )

      expect(updated.transactionId).toBe(transaction.id)
      const after = await transactionById(s, transaction.id)
      expect(after.amount.toString()).toBe('300000')
      expect(after.vndPerUsdAtEntry.toString()).toBe('26000')
      expect(after.fxRateSource).toBe('debt-link-fake-2')
      expect(after.fxRateFetchedAt.toISOString()).toBe(second.fetchedAt.toISOString())
      expect(await balanceOf(s, s.walletId)).toBe('5300000')
      expect((await getDebtOutstanding(s.userId, debt.id)).toString()).toBe('700000')
    })

    it('moves the transaction to the new payment day', async () => {
      const s = await setup()
      const { payment, transaction } = await linkedPayment(s)

      await updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 200_000, date: '2026-03-07', accountId: s.walletId },
        fakeProvider().provider,
      )

      const after = await transactionById(s, transaction.id)
      expect(after.date.toISOString()).toBe('2026-03-07T05:00:00.000Z')
      expect(formatCalendarDate((await paymentById(s, payment.id)).date)).toBe('2026-03-07')
    })

    it('keeps the FX snapshot exactly, and asks for no rate, when only the note changes', async () => {
      const s = await setup()
      const { payment, transaction } = await linkedPayment(s)
      await clearFxCache()

      await updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 200_000, date: '2026-03-05', note: 'Corrected', accountId: s.walletId },
        failingProvider,
      )

      const after = await transactionById(s, transaction.id)
      expect(after.note).toBe('Corrected')
      expect(after.vndPerUsdAtEntry.toString()).toBe(transaction.vndPerUsdAtEntry.toString())
      expect(after.fxRateFetchedAt).toEqual(transaction.fxRateFetchedAt)
      expect(after.fxRateEffectiveAt).toEqual(transaction.fxRateEffectiveAt)
      expect(after.fxRateSource).toBe(transaction.fxRateSource)
      expect((await paymentById(s, payment.id)).note).toBe('Corrected')
    })

    it('moves the same transaction to another account, re-snapshotting for the move', async () => {
      const s = await setup()
      const { payment, transaction } = await linkedPayment(s)
      await clearFxCache()
      const second = fakeProvider(26000, 'debt-link-fake-2')

      await updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 200_000, date: '2026-03-05', accountId: s.bankId },
        second.provider,
      )

      const after = await transactionById(s, transaction.id)
      expect(after.accountId).toBe(s.bankId)
      expect(after.fxRateSource).toBe('debt-link-fake-2')
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
      expect(await balanceOf(s, s.bankId)).toBe('2200000')
      expect(await transactionCount(s)).toBe(1)
    })

    it('deletes the linked transaction when the account is removed, asking for no rate', async () => {
      const s = await setup()
      const { payment, transaction } = await linkedPayment(s)
      await clearFxCache()

      const updated = await updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 200_000, date: '2026-03-05' },
        failingProvider,
      )

      expect(updated.transactionId).toBeNull()
      expect(
        await prisma.transaction.count({ where: { userId: s.userId, id: transaction.id } }),
      ).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
    })

    it('creates a linked transaction when an account is added', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)
      const payment = await recordDebtPayment(s.userId, debt.id, {
        amount: 150_000,
        date: '2026-03-03',
        note: 'Late note',
      })

      const updated = await updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 150_000, date: '2026-03-03', note: 'Late note', accountId: s.bankId },
        fakeProvider().provider,
      )

      const linked = await transactionById(s, updated.transactionId)
      expect(linked).toMatchObject({ accountId: s.bankId, type: 'CASH_IN', note: 'Late note' })
      expect(linked.date.toISOString()).toBe('2026-03-03T05:00:00.000Z')
      expect(await balanceOf(s, s.bankId)).toBe('2150000')
    })

    it('keeps the over-payment rule and changes neither side when it refuses', async () => {
      const s = await setup()
      const { debt, payment, transaction } = await linkedPayment(s)
      await recordDebtPayment(s.userId, debt.id, { amount: 700_000, date: '2026-03-06' })

      const caught = await captureRejection(
        updateDebtPayment(
          s.userId,
          payment.id,
          { amount: 300_000.01, date: '2026-03-05', accountId: s.walletId },
          fakeProvider().provider,
        ),
      )

      expect(caught).toBeInstanceOf(DebtOverpaymentError)
      expect((caught as DebtOverpaymentError).outstanding.toString()).toBe('300000')
      expect(await transactionById(s, transaction.id)).toEqual(transaction)
      expect((await paymentById(s, payment.id)).amount.toString()).toBe('200000')
    })

    it('refuses an account in another currency, and an archived account, changing nothing', async () => {
      const s = await setup()
      const { payment, transaction } = await linkedPayment(s)
      const { provider } = fakeProvider()

      await expect(
        updateDebtPayment(
          s.userId,
          payment.id,
          { amount: 200_000, date: '2026-03-05', accountId: s.dollarsId },
          provider,
        ),
      ).rejects.toThrow(LinkedAccountCurrencyMismatchError)
      await expect(
        updateDebtPayment(
          s.userId,
          payment.id,
          { amount: 200_000, date: '2026-03-05', accountId: s.archivedId },
          provider,
        ),
      ).rejects.toThrow(ArchivedAccountError)

      expect(await transactionById(s, transaction.id)).toEqual(transaction)
      expect(await paymentById(s, payment.id)).toEqual(payment)
    })

    it("refuses another user's payment, and moving mine into another user's account", async () => {
      const s = await setup()
      const other = await setup()
      const mine = await linkedPayment(s)
      const theirs = await linkedPayment(other)
      const { provider } = fakeProvider()

      await expectPrismaCode(
        updateDebtPayment(
          s.userId,
          theirs.payment.id,
          { amount: 1, date: '2026-03-05', accountId: s.walletId },
          provider,
        ),
        'P2025',
      )
      await expectPrismaCode(
        updateDebtPayment(
          s.userId,
          mine.payment.id,
          { amount: 200_000, date: '2026-03-05', accountId: other.walletId },
          provider,
        ),
        'P2025',
      )

      expect(await transactionById(other, theirs.transaction.id)).toEqual(theirs.transaction)
      expect(await paymentById(other, theirs.payment.id)).toEqual(theirs.payment)
      expect(await transactionById(s, mine.transaction.id)).toEqual(mine.transaction)
    })

    it('refuses a payment of a written-off debt', async () => {
      const s = await setup()
      const { debt, payment, transaction } = await linkedPayment(s)
      await writeOffDebt(s.userId, debt.id)

      await expect(
        updateDebtPayment(
          s.userId,
          payment.id,
          { amount: 1, date: '2026-03-05', accountId: s.walletId },
          fakeProvider().provider,
        ),
      ).rejects.toThrow(DebtNotActiveError)

      expect(await transactionById(s, transaction.id)).toEqual(transaction)
    })
  })

  describe('deleteDebtPayment', () => {
    it('removes the payment and its transaction, and the balance comes back', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)
      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 400_000, date: '2026-03-05', accountId: s.walletId },
        fakeProvider().provider,
      )
      expect(await balanceOf(s, s.walletId)).toBe('5400000')

      await deleteDebtPayment(s.userId, payment.id)

      expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(0)
      expect(await transactionCount(s)).toBe(0)
      expect(await balanceOf(s, s.walletId)).toBe('5000000')
      expect((await getDebtOutstanding(s.userId, debt.id)).toString()).toBe('1000000')
    })

    it("refuses another user's payment and leaves both of its rows in place", async () => {
      const s = await setup()
      const other = await setup()
      const debt = await unlinkedDebt(other)
      const theirs = await recordDebtPayment(
        other.userId,
        debt.id,
        { amount: 1_000, date: '2026-03-05', accountId: other.walletId },
        fakeProvider().provider,
      )

      await expectPrismaCode(deleteDebtPayment(s.userId, theirs.id), 'P2025')

      expect(await paymentById(other, theirs.id)).toEqual(theirs)
      expect(await transactionCount(other)).toBe(1)
    })

    it('refuses a payment of a written-off debt', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)
      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 1_000, date: '2026-03-05', accountId: s.walletId },
        fakeProvider().provider,
      )
      await writeOffDebt(s.userId, debt.id)

      await expect(deleteDebtPayment(s.userId, payment.id)).rejects.toThrow(DebtNotActiveError)

      expect(await transactionCount(s)).toBe(1)
      expect(await paymentById(s, payment.id)).toEqual(payment)
    })
  })

  describe('writeOffDebt', () => {
    it('creates no transaction and keeps the linked ones — no money moves', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      const debt = await createDebt(
        s.userId,
        { ...BASE_DEBT, accountId: s.walletId, movedOn: '2026-03-01' },
        provider,
      )
      await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 100_000, date: '2026-03-02', accountId: s.walletId },
        provider,
      )

      await writeOffDebt(s.userId, debt.id)

      expect(await transactionCount(s)).toBe(2)
      expect(await balanceOf(s, s.walletId)).toBe('4100000')
    })
  })

  describe('database constraints', () => {
    it("rejects a link to another user's transaction even bypassing the service", async () => {
      const s = await setup()
      const other = await setup()
      const debt = await unlinkedDebt(s)
      const theirDebt = await createDebt(
        other.userId,
        { ...BASE_DEBT, accountId: other.walletId, movedOn: '2026-03-01' },
        fakeProvider().provider,
      )

      // The composite (userId, openingTransactionId) foreign key, not the
      // service: a debt cannot name a transaction that is not its user's.
      await expectPrismaCode(
        prisma.debt.update({
          where: { userId_id: { userId: s.userId, id: debt.id } },
          data: { openingTransactionId: theirDebt.openingTransactionId },
        }),
        'P2003',
      )
    })

    it('refuses to delete a linked transaction out from under its debt (Restrict)', async () => {
      const s = await setup()
      const debt = await createDebt(
        s.userId,
        { ...BASE_DEBT, accountId: s.walletId, movedOn: '2026-03-01' },
        fakeProvider().provider,
      )

      await expectPrismaCode(
        prisma.transaction.delete({
          where: { userId_id: { userId: s.userId, id: debt.openingTransactionId as string } },
        }),
        'P2003',
      )

      expect(await transactionCount(s)).toBe(1)
    })
  })

  /**
   * Lock order: accounts first, then the debt row, then transaction rows — the
   * order `createTransaction`/`updateTransaction`/`deleteTransaction` already
   * use for accounts and transaction rows, so the new linked paths can run
   * beside them without a deadlock. `holdAccountLock` parks an interactive
   * transaction on an account row lock until the test releases it (the pattern
   * in `concurrency.test.ts`), so these cases decide the interleaving rather
   * than hoping the scheduler does.
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

    it('a linked payment waits on the account before it takes the debt lock', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)
      const { provider } = fakeProvider()
      // Warms the FX cache too, so the payment below waits on nothing but the
      // row lock.
      await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 1, date: '2026-03-01', accountId: s.bankId },
        provider,
      )
      const lock = await holdAccountLock(s.userId, s.walletId)

      const pending = recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 100_000, date: '2026-03-02', accountId: s.walletId },
        provider,
      )
      expect(await hasSettledWithin(pending, LOCK_WAIT_MS)).toBe(false)

      // The payment is queued on the account, so it holds no debt lock yet: a
      // write-off — which takes only the debt lock — goes straight through.
      // Had the payment locked the debt first, this would wait behind it.
      const writeOff = writeOffDebt(s.userId, debt.id)
      expect(await hasSettledWithin(writeOff, LOCK_WAIT_MS)).toBe(true)
      await expect(writeOff).resolves.toMatchObject({ status: 'WRITTEN_OFF' })

      await lock.release()
      // It then sees the committed write-off under the debt lock and writes
      // nothing — not even the transaction.
      await expect(pending).rejects.toThrow(DebtNotActiveError)
      expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(1)
      expect(await transactionCount(s)).toBe(1)
    }, 30_000)

    it('a linked payment and a transaction edit on the same account both complete', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      for (const run of [1, 2, 3]) {
        const debt = await unlinkedDebt(s, { person: `Race ${run}` })
        const ordinary = await createTransaction(
          s.userId,
          { accountId: s.walletId, type: 'CASH_IN', amount: 1000, date: new Date('2026-03-01') },
          provider,
        )

        const results = await Promise.allSettled([
          recordDebtPayment(
            s.userId,
            debt.id,
            { amount: 10_000, date: '2026-03-02', accountId: s.walletId },
            provider,
          ),
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

    it('a payment moved between two accounts races a transaction moved the other way without deadlock', async () => {
      const s = await setup()
      const { provider } = fakeProvider()
      for (const run of [1, 2, 3]) {
        const debt = await unlinkedDebt(s, { person: `Swap ${run}` })
        const payment = await recordDebtPayment(
          s.userId,
          debt.id,
          { amount: 10_000, date: '2026-03-02', accountId: s.walletId },
          provider,
        )
        const ordinary = await createTransaction(
          s.userId,
          { accountId: s.bankId, type: 'CASH_IN', amount: 1000, date: new Date('2026-03-01') },
          provider,
        )

        // wallet → bank for the payment, bank → wallet for the transaction: the
        // opposite-order pair, safe only because both lock the two accounts in
        // one sorted statement before anything else.
        const results = await Promise.allSettled([
          updateDebtPayment(
            s.userId,
            payment.id,
            { amount: 10_000, date: '2026-03-02', accountId: s.bankId },
            provider,
          ),
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

    it('refuses a payment edit whose linked transaction changed after it was read', async () => {
      const s = await setup()
      const debt = await unlinkedDebt(s)
      const { provider } = fakeProvider()
      const payment = await recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 10_000, date: '2026-03-02', accountId: s.walletId },
        provider,
      )
      const transactionId = payment.transactionId as string
      // Another session edits the linked transaction (as the Transactions page
      // still can until linked rows are locked there) while holding the wallet.
      const lock = await holdAccountLock(s.userId, s.walletId, async (tx) => {
        await tx.transaction.update({
          where: { userId_id: { userId: s.userId, id: transactionId } },
          data: { note: 'Edited elsewhere' },
        })
      })

      const pending = updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 20_000, date: '2026-03-02', accountId: s.walletId },
        provider,
      )
      expect(await hasSettledWithin(pending, LOCK_WAIT_MS)).toBe(false)
      await lock.release()

      // The edit decided its FX and its write against a copy that no longer
      // exists, so it is refused rather than overwriting the other change.
      await expect(pending).rejects.toThrow(ConcurrentModificationError)
      const stored = await transactionById(s, transactionId)
      expect(stored.note).toBe('Edited elsewhere')
      expect(stored.amount.toString()).toBe('10000')
      expect((await paymentById(s, payment.id)).amount.toString()).toBe('10000')
    }, 30_000)
  })
})
