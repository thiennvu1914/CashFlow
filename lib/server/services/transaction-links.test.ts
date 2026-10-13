import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { resetFxMemoForTests } from '@/lib/currency/fx-service'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { getAccountBalance } from '@/lib/server/services/balance'
import { createDebt, recordDebtPayment, type DebtLinkContext } from './debt'
import { createLoan, recordLoanPayment, type LoanLinkContext } from './loan'
import {
  createTransaction,
  deleteTransaction,
  listTransactionLinks,
  listTransactions,
  updateTransaction,
} from './transaction'
import { LinkedTransactionError, findTransactionLinks } from './transaction-links'

/**
 * Transactions a debt or loan owns (money-source linking spec 2026-10-12 §2 Q4,
 * §6.5), against the real database.
 *
 * A debt or loan recorded in an account writes the Transaction that moved its
 * money and keeps a link to it. On the Transactions page such a row is locked:
 * it shows which debt or loan it belongs to, and `updateTransaction` /
 * `deleteTransaction` refuse it with `LinkedTransactionError` — the edit
 * belongs on the source record, which changes both sides in one database
 * transaction. An ordinary transaction stays fully editable beside them.
 *
 * Every FX lookup goes through an injected fake provider, and `fetch` is a
 * throwing spy, so nothing here can reach the network. The USD/VND cache rows
 * are global, so `beforeEach`/`afterEach` clear them and the in-process memo.
 */

const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'
const DEBT_CONTEXT: DebtLinkContext = { timezone: TEST_TIMEZONE, locale: 'vi' }
const LOAN_CONTEXT: LoanLinkContext = { timezone: TEST_TIMEZONE, locale: 'vi' }
const FX_SOURCE = 'transaction-links-fake'

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

async function clearFxCache() {
  await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
  // The in-process memo would otherwise outlive the rows just deleted.
  resetFxMemoForTests()
}

/**
 * A user with one funded VND account, one expense category, and one of every
 * kind of linked transaction — a debt's opening, a debt repayment, a loan's
 * disbursement, and both legs of a loan instalment — plus one ordinary
 * expense nothing owns.
 */
async function setup() {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `tx-links-${randomUUID()}@example.com`,
      name: 'Transaction Links Test',
      emailVerified: false,
      timezone: TEST_TIMEZONE,
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
  const food = await prisma.category.create({
    data: { userId: user.id, name: 'Food', type: 'EXPENSE' },
  })
  const { provider } = fakeProvider()

  const debt = await createDebt(
    user.id,
    {
      direction: 'RECEIVABLE',
      person: 'Minh',
      originalAmount: 1_000_000,
      currency: 'VND',
      accountId: wallet.id,
      movedOn: '2026-03-01',
    },
    DEBT_CONTEXT,
    provider,
  )
  const debtPayment = await recordDebtPayment(
    user.id,
    debt.id,
    { amount: 200_000, date: '2026-03-05', accountId: wallet.id },
    DEBT_CONTEXT,
    provider,
  )
  const loan = await createLoan(
    user.id,
    {
      lender: 'Vietcombank',
      principal: 3_000_000,
      currency: 'VND',
      interestRate: 8.5,
      startDate: '2026-01-01',
      termMonths: 12,
      paymentFrequency: 'MONTHLY',
      scheduledPaymentAmount: 300_000,
      nextDueDate: '2026-02-01',
      accountId: wallet.id,
    },
    LOAN_CONTEXT,
    provider,
  )
  const { payment: loanPayment } = await recordLoanPayment(
    user.id,
    loan.id,
    {
      totalAmount: 300_000,
      principalAmount: 250_000,
      interestAmount: 50_000,
      paymentDate: '2026-02-01',
      accountId: wallet.id,
    },
    LOAN_CONTEXT,
    provider,
  )
  const ordinary = await createTransaction(
    user.id,
    {
      accountId: wallet.id,
      categoryId: food.id,
      type: 'EXPENSE',
      amount: 120_000,
      date: new Date('2026-03-10T05:00:00.000Z'),
      note: 'Lunch',
    },
    provider,
  )

  const linked = {
    debtOpening: required(debt.openingTransactionId),
    debtPayment: required(debtPayment.transactionId),
    loanDisbursement: required(loan.disbursementTransactionId),
    loanPrincipal: required(loanPayment.principalTransactionId),
    loanInterest: required(loanPayment.interestTransactionId),
  }
  return {
    userId: user.id,
    walletId: wallet.id,
    foodId: food.id,
    debtId: debt.id,
    loanId: loan.id,
    ordinaryId: ordinary.id,
    linked,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

function required(id: string | null): string {
  if (id === null) throw new Error('expected a linked transaction')
  return id
}

function transactionById(s: Setup, id: string) {
  return prisma.transaction.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
}

async function balanceOf(s: Setup): Promise<string> {
  return (await getAccountBalance(s.userId, s.walletId)).toString()
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

/** The edit a user would submit for `row`, unchanged apart from `overrides`. */
function editOf(
  row: Awaited<ReturnType<typeof transactionById>>,
  overrides: Partial<Parameters<typeof updateTransaction>[2]> = {},
): Parameters<typeof updateTransaction>[2] {
  return {
    accountId: row.accountId,
    categoryId: row.categoryId ?? undefined,
    type: row.type,
    amount: Number(row.amount),
    date: row.date,
    note: row.note ?? undefined,
    ...overrides,
  }
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
      // Payments and agreements first: they reference the transactions.
      await prisma.debtPayment.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.debt.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.loanPayment.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.loan.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
  expect(fetchCalls).toBe(0)
})

describe('findTransactionLinks', () => {
  it('names the debt or loan behind every linked transaction, and nothing for an ordinary one', async () => {
    const s = await setup()

    const links = await findTransactionLinks(s.userId, [
      s.linked.debtOpening,
      s.linked.debtPayment,
      s.linked.loanDisbursement,
      s.linked.loanPrincipal,
      s.linked.loanInterest,
      s.ordinaryId,
    ])

    const debtLink = { kind: 'debt', debtId: s.debtId, person: 'Minh' }
    const loanLink = { kind: 'loan', loanId: s.loanId, lender: 'Vietcombank' }
    expect(Object.fromEntries(links)).toEqual({
      [s.linked.debtOpening]: debtLink,
      [s.linked.debtPayment]: debtLink,
      [s.linked.loanDisbursement]: loanLink,
      [s.linked.loanPrincipal]: loanLink,
      [s.linked.loanInterest]: loanLink,
    })
    expect(links.has(s.ordinaryId)).toBe(false)
  })

  it('answers only for the ids asked about', async () => {
    const s = await setup()

    const links = await findTransactionLinks(s.userId, [s.linked.debtPayment, s.ordinaryId])

    expect([...links.keys()]).toEqual([s.linked.debtPayment])
  })

  it('returns an empty map for no ids, or for ids that do not exist', async () => {
    const s = await setup()

    expect((await findTransactionLinks(s.userId, [])).size).toBe(0)
    expect((await findTransactionLinks(s.userId, ['no-such-transaction'])).size).toBe(0)
  })

  it("is scoped by userId: another user's linked ids resolve to nothing", async () => {
    const owner = await setup()
    const intruder = await setup()

    const links = await findTransactionLinks(intruder.userId, Object.values(owner.linked))

    expect(links.size).toBe(0)
  })
})

/**
 * The ledger reads its rows and their links side by side, so the links cannot
 * wait for the rows' ids: `listTransactionLinks` re-selects the same page
 * inside its one statement. It is only correct if that page is exactly the
 * one `listTransactions` returns — same scope, order (ties included) and
 * limit — which is what every case below compares against.
 *
 * The fixture's six rows, newest first: the lunch (10 Mar), the repayment
 * (5 Mar), the debt's opening (1 Mar), the instalment's principal and
 * interest (both 1 Feb — a date tie only `createdAt`/`id` can order), and the
 * loan's disbursement (1 Jan). Every limit cuts the page at a different place,
 * including between the two tied rows.
 */
describe('listTransactionLinks', () => {
  async function linksOfListedPage(userId: string, options?: { limit?: number }) {
    const rows = await listTransactions(userId, options)
    return findTransactionLinks(
      userId,
      rows.map((row) => row.id),
    )
  }

  it.each([1, 2, 3, 4, 5, 6, 7])(
    'names exactly the links of the rows listTransactions returns at limit %i',
    async (limit) => {
      const s = await setup()

      const [listed, expected] = await Promise.all([
        listTransactionLinks(s.userId, { limit }),
        linksOfListedPage(s.userId, { limit }),
      ])

      expect(Object.fromEntries(listed)).toEqual(Object.fromEntries(expected))
    },
  )

  it("matches the default page, and holds only the caller's own rows", async () => {
    const owner = await setup()
    const other = await setup()

    const listed = await listTransactionLinks(owner.userId)

    expect(Object.fromEntries(listed)).toEqual(
      Object.fromEntries(await linksOfListedPage(owner.userId)),
    )
    expect(listed.size).toBe(5)
    for (const id of Object.values(other.linked)) expect(listed.has(id)).toBe(false)
  })

  it('refuses a limit listTransactions refuses', async () => {
    const s = await setup()

    await expect(listTransactionLinks(s.userId, { limit: 0 })).rejects.toThrow(RangeError)
  })
})

describe('updateTransaction — a debt or loan owns its transactions (Q4)', () => {
  it.each([
    ['debt opening', 'debtOpening'],
    ['debt repayment', 'debtPayment'],
    ['loan disbursement', 'loanDisbursement'],
    ['loan instalment principal', 'loanPrincipal'],
    ['loan instalment interest', 'loanInterest'],
  ] as const)('refuses to edit a %s and leaves the row untouched', async (_label, key) => {
    const s = await setup()
    const id = s.linked[key]
    const before = await transactionById(s, id)

    const caught = await captureRejection(
      updateTransaction(
        s.userId,
        id,
        editOf(before, { amount: Number(before.amount) + 1, note: 'changed here' }),
        fakeProvider().provider,
      ),
    )

    expect(caught).toBeInstanceOf(LinkedTransactionError)
    expect(await transactionById(s, id)).toEqual(before)
  })

  it('refuses a note-only edit of a linked row too — not just an economic one', async () => {
    const s = await setup()
    const before = await transactionById(s, s.linked.debtOpening)

    const caught = await captureRejection(
      updateTransaction(
        s.userId,
        s.linked.debtOpening,
        editOf(before, { note: 'just a note' }),
        fakeProvider().provider,
      ),
    )

    expect(caught).toBeInstanceOf(LinkedTransactionError)
    expect(await transactionById(s, s.linked.debtOpening)).toEqual(before)
  })

  it('carries which debt or loan the row belongs to', async () => {
    const s = await setup()
    const before = await transactionById(s, s.linked.loanInterest)

    const caught = await captureRejection(
      updateTransaction(s.userId, s.linked.loanInterest, editOf(before), fakeProvider().provider),
    )

    expect(caught).toBeInstanceOf(LinkedTransactionError)
    expect((caught as LinkedTransactionError).link).toEqual({
      kind: 'loan',
      loanId: s.loanId,
      lender: 'Vietcombank',
    })
  })

  it("is a NotFound, not a refusal, for another user's linked transaction", async () => {
    const owner = await setup()
    const intruder = await setup()
    const before = await transactionById(owner, owner.linked.debtOpening)

    const caught = await captureRejection(
      updateTransaction(
        intruder.userId,
        owner.linked.debtOpening,
        editOf(before, { accountId: intruder.walletId }),
        fakeProvider().provider,
      ),
    )

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2025')
    expect(await transactionById(owner, owner.linked.debtOpening)).toEqual(before)
  })
})

describe('updateTransaction — an ordinary transaction beside linked ones stays editable', () => {
  it('applies an economic edit with a fresh FX snapshot (R-6), and the balance follows', async () => {
    const s = await setup()
    const before = await transactionById(s, s.ordinaryId)
    const balanceBefore = await balanceOf(s)
    await clearFxCache()
    const { provider, fetchedAt } = fakeProvider(26000)

    await updateTransaction(s.userId, s.ordinaryId, editOf(before, { amount: 150_000 }), provider)

    const after = await transactionById(s, s.ordinaryId)
    expect(after.amount.toString()).toBe('150000')
    expect(after.vndPerUsdAtEntry.toString()).toBe('26000')
    expect(after.fxRateFetchedAt).toEqual(fetchedAt)
    expect(after.fxRateSource).toBe(FX_SOURCE)
    // 30,000 more spent: the derived balance drops by exactly that.
    expect(new Prisma.Decimal(balanceBefore).minus(await balanceOf(s)).toString()).toBe('30000')
  })

  it('keeps the original snapshot on a note-only edit (R-6)', async () => {
    const s = await setup()
    const before = await transactionById(s, s.ordinaryId)
    await clearFxCache()

    await updateTransaction(
      s.userId,
      s.ordinaryId,
      editOf(before, { note: 'Lunch with Minh' }),
      fakeProvider(27000).provider,
    )

    const after = await transactionById(s, s.ordinaryId)
    expect(after.note).toBe('Lunch with Minh')
    expect(after.vndPerUsdAtEntry).toEqual(before.vndPerUsdAtEntry)
    expect(after.fxRateFetchedAt).toEqual(before.fxRateFetchedAt)
    expect(after.fxRateEffectiveAt).toEqual(before.fxRateEffectiveAt)
    expect(after.fxRateSource).toBe(before.fxRateSource)
  })
})

describe('deleteTransaction — a debt or loan owns its transactions (Q4)', () => {
  it.each([
    ['debt opening', 'debtOpening'],
    ['debt repayment', 'debtPayment'],
    ['loan disbursement', 'loanDisbursement'],
    ['loan instalment principal', 'loanPrincipal'],
    ['loan instalment interest', 'loanInterest'],
  ] as const)('refuses to delete a %s; the row and its link stay', async (_label, key) => {
    const s = await setup()
    const id = s.linked[key]
    const before = await transactionById(s, id)

    const caught = await captureRejection(deleteTransaction(s.userId, id))

    expect(caught).toBeInstanceOf(LinkedTransactionError)
    expect(await transactionById(s, id)).toEqual(before)
    expect((await findTransactionLinks(s.userId, [id])).has(id)).toBe(true)
  })

  it('still deletes an ordinary transaction, and the balance follows', async () => {
    const s = await setup()
    const balanceBefore = await balanceOf(s)

    await deleteTransaction(s.userId, s.ordinaryId)

    expect(await prisma.transaction.count({ where: { id: s.ordinaryId } })).toBe(0)
    expect(new Prisma.Decimal(await balanceOf(s)).minus(balanceBefore).toString()).toBe('120000')
  })

  it("is a NotFound, not a refusal, for another user's linked transaction", async () => {
    const owner = await setup()
    const intruder = await setup()

    const caught = await captureRejection(
      deleteTransaction(intruder.userId, owner.linked.loanPrincipal),
    )

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2025')
    expect(await prisma.transaction.count({ where: { id: owner.linked.loanPrincipal } })).toBe(1)
  })
})

/**
 * Every link kind, keyed as `setup()` names them.
 */
const LINK_KINDS = [
  ['debt opening', 'debtOpening'],
  ['debt repayment', 'debtPayment'],
  ['loan disbursement', 'loanDisbursement'],
  ['loan instalment principal', 'loanPrincipal'],
  ['loan instalment interest', 'loanInterest'],
] as const

/**
 * Counts the interactive transactions the next writes open, and the raw
 * statements sent inside them — the account and row locks are raw, and so was
 * the link lookup before it moved into the pre-read. Everything else is the
 * real client on the real transaction.
 */
function watchTransactions() {
  const original = prisma.$transaction.bind(prisma) as (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: unknown,
  ) => Promise<unknown>
  const seen = { transactions: 0, rawStatements: 0 }
  vi.spyOn(prisma, '$transaction').mockImplementation(((
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: unknown,
  ) => {
    seen.transactions += 1
    return original(
      (tx) =>
        callback(
          new Proxy(tx, {
            get(target, property) {
              const value = Reflect.get(target, property)
              if (property !== '$queryRaw' || typeof value !== 'function') return value
              return (...args: unknown[]) => {
                seen.rawStatements += 1
                return value.apply(target, args)
              }
            },
          }),
        ),
      options,
    )
  }) as never)
  return seen
}

/**
 * Final review F4: whether a debt or loan owns the row is read by the same
 * statement that reads the row before the transaction opens — not by an extra
 * statement inside it (~100 ms in production, while the locks are held). So a
 * linked row is refused before any rate lookup or lock, and an ordinary edit
 * or delete sends nothing inside its transaction but its two locks.
 */
describe('the debt/loan link is read with the row, before any transaction (F4)', () => {
  const failingProvider: ExchangeRateProvider = {
    getLatestRate: async () => {
      throw new Error('provider down')
    },
    getHistoricalRate: async () => null,
  }

  it.each(LINK_KINDS)(
    'refuses an economic edit of a %s before any rate lookup or transaction',
    async (_label, key) => {
      const s = await setup()
      const id = s.linked[key]
      const before = await transactionById(s, id)
      // An empty cache and a provider that is down: a rate lookup could only
      // end in FxUnavailableError.
      await clearFxCache()
      const seen = watchTransactions()

      const caught = await captureRejection(
        updateTransaction(
          s.userId,
          id,
          editOf(before, { amount: Number(before.amount) + 1 }),
          failingProvider,
        ),
      )

      expect(caught).toBeInstanceOf(LinkedTransactionError)
      expect(seen.transactions).toBe(0)
      expect(await transactionById(s, id)).toEqual(before)
    },
  )

  it.each(LINK_KINDS)(
    'refuses to delete a %s before any transaction opens',
    async (_label, key) => {
      const s = await setup()
      const id = s.linked[key]
      const seen = watchTransactions()

      const caught = await captureRejection(deleteTransaction(s.userId, id))

      expect(caught).toBeInstanceOf(LinkedTransactionError)
      expect(seen.transactions).toBe(0)
    },
  )

  it('carries the owning debt or loan from the pre-read, for delete as for edit', async () => {
    const s = await setup()

    const caught = await captureRejection(deleteTransaction(s.userId, s.linked.debtPayment))

    expect((caught as LinkedTransactionError).link).toEqual({
      kind: 'debt',
      debtId: s.debtId,
      person: 'Minh',
    })
  })

  it('sends only the two locks inside the transaction of an ordinary edit', async () => {
    const s = await setup()
    const before = await transactionById(s, s.ordinaryId)
    const seen = watchTransactions()

    await updateTransaction(
      s.userId,
      s.ordinaryId,
      editOf(before, { note: 'Lunch with Minh' }),
      fakeProvider().provider,
    )

    expect(seen).toEqual({ transactions: 1, rawStatements: 2 })
  })

  it('sends only the two locks inside the transaction of an ordinary delete', async () => {
    const s = await setup()
    const seen = watchTransactions()

    await deleteTransaction(s.userId, s.ordinaryId)

    expect(seen).toEqual({ transactions: 1, rawStatements: 2 })
    expect(await prisma.transaction.count({ where: { id: s.ordinaryId } })).toBe(0)
  })
})
