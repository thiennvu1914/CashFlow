import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  calendarDateToUtcCarrier,
  formatCalendarDate,
  todayCalendarDateInZone,
} from '@/lib/datetime/calendar-date'

/**
 * `loan-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * `@/lib/auth/require-user` and `@/lib/server/services/loan` are mocked so this
 * test needs neither Postgres nor a session — the same arrangement as
 * `debt-actions.test.ts`. `next/cache`'s real `revalidatePath` throws outside a
 * Next.js request/work store, so it is mocked too. The validation module is
 * deliberately NOT mocked: the actions parse with the real schemas, and "an
 * invalid input never reaches the service" is exactly what the Zod cases below
 * prove.
 *
 * What is under test is only this layer's job: that `userId` comes from the
 * session and never from the caller, that each domain failure becomes its own
 * code, that an unmapped error still escapes, and that a *failed* write
 * revalidates nothing.
 *
 * Money-source linking (spec 2026-10-12 §6.3) adds the session context the
 * money-capable writes need — the user's timezone and locale — two payment
 * actions (edit and delete), and four codes for the linked-transaction
 * failures. The modules those errors live in (`linked-transaction`,
 * `transaction`, `current-rate-policy`) import the Prisma client instance, so
 * they are mocked with mirrors here exactly as `debt-actions.test.ts` mocks
 * them; `account-lock` imports no client and is used as is.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createLoanMock = vi.hoisted(() => vi.fn())
const updateLoanMock = vi.hoisted(() => vi.fn())
const recordLoanPaymentMock = vi.hoisted(() => vi.fn())
const updateLoanPaymentMock = vi.hoisted(() => vi.fn())
const deleteLoanPaymentMock = vi.hoisted(() => vi.fn())
const closeLoanMock = vi.hoisted(() => vi.fn())
const linkLoanToAccountMock = vi.hoisted(() => vi.fn())
const unlinkLoanFromAccountMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

/**
 * Stand-ins for the service's three domain errors. Mirrors of the real classes
 * (including `LoanOverpaymentError`'s `outstandingPrincipal`) rather than the
 * classes themselves, because the service module is mocked away — importing the
 * real ones would drag Prisma's client into this test for nothing.
 */
class MockLoanOverpaymentError extends Error {
  readonly outstandingPrincipal: unknown

  constructor(outstandingPrincipal: unknown) {
    super('Principal payment exceeds the outstanding principal.')
    this.name = 'LoanOverpaymentError'
    this.outstandingPrincipal = outstandingPrincipal
  }
}

class MockLoanNotActiveError extends Error {
  constructor() {
    super('This loan is closed and cannot receive payments.')
    this.name = 'LoanNotActiveError'
  }
}

class MockLoanAlreadyLinkedError extends Error {
  constructor() {
    super('This loan is already recorded in an account.')
    this.name = 'LoanAlreadyLinkedError'
  }
}

class MockFutureLinkedPaymentError extends Error {
  constructor() {
    super('A payment dated later than today cannot be recorded in an account yet.')
    this.name = 'FutureLinkedPaymentError'
  }
}

class MockLoanNotLinkedError extends Error {
  constructor() {
    super('This loan is not recorded in an account.')
    this.name = 'LoanNotLinkedError'
  }
}

class MockLoanSplitMismatchError extends Error {
  constructor() {
    super('Total must equal principal plus interest.')
    this.name = 'LoanSplitMismatchError'
  }
}

class MockLinkedAccountCurrencyMismatchError extends Error {
  constructor() {
    super('Choose an account in the same currency as this record.')
    this.name = 'LinkedAccountCurrencyMismatchError'
  }
}

class MockConcurrentModificationError extends Error {
  constructor() {
    super('This transaction changed after it was read.')
    this.name = 'ConcurrentModificationError'
  }
}

class MockFxUnavailableError extends Error {
  constructor() {
    super('Unable to retrieve an exchange rate.')
    this.name = 'FxUnavailableError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/loan', () => ({
  createLoan: createLoanMock,
  updateLoan: updateLoanMock,
  recordLoanPayment: recordLoanPaymentMock,
  updateLoanPayment: updateLoanPaymentMock,
  deleteLoanPayment: deleteLoanPaymentMock,
  closeLoan: closeLoanMock,
  linkLoanToAccount: linkLoanToAccountMock,
  unlinkLoanFromAccount: unlinkLoanFromAccountMock,
  LoanOverpaymentError: MockLoanOverpaymentError,
  LoanNotActiveError: MockLoanNotActiveError,
  LoanSplitMismatchError: MockLoanSplitMismatchError,
  LoanAlreadyLinkedError: MockLoanAlreadyLinkedError,
  LoanNotLinkedError: MockLoanNotLinkedError,
}))

vi.mock('@/lib/server/services/linked-transaction', () => ({
  FutureLinkedPaymentError: MockFutureLinkedPaymentError,
  LinkedAccountCurrencyMismatchError: MockLinkedAccountCurrencyMismatchError,
}))

vi.mock('@/lib/server/services/transaction', () => ({
  ConcurrentModificationError: MockConcurrentModificationError,
}))

vi.mock('@/lib/currency/current-rate-policy', () => ({
  isFxUnavailableError: (e: unknown) => e instanceof MockFxUnavailableError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const {
  createLoanAction,
  updateLoanAction,
  recordLoanPaymentAction,
  updateLoanPaymentAction,
  deleteLoanPaymentAction,
  closeLoanAction,
  linkLoanToAccountAction,
  unlinkLoanFromAccountAction,
} = await import('./loan-actions')
const { LOAN_ERROR_KEYS } = await import('@/lib/ui/action-error-messages')
const { ArchivedAccountError } = await import('@/lib/server/services/account-lock')
const { ZodError } = await import('zod')
const { Prisma } = await import('@prisma/client')

const FIXED_USER = {
  id: 'user_1',
  email: 'user@example.com',
  name: 'Test',
  baseCurrency: 'VND',
  locale: 'vi',
  theme: 'light',
  timezone: 'Asia/Ho_Chi_Minh',
}

/** What every money-capable write receives from the session user, through
 *  `resolveProfileDefaults` — never from the request. */
const CONTEXT = { timezone: 'Asia/Ho_Chi_Minh', locale: 'vi' }

/** Every page a write that can move money re-renders, in the order revalidated. */
const MONEY_PAGES = ['/loans', '/accounts', '/transactions', '/dashboard']

/** Every optional field populated, so the schema's output is deep-equal to the
 *  input and the `toHaveBeenCalledWith` assertions below can name it directly. */
const validCreateInput = {
  lender: 'Vietcombank',
  principal: 240_000_000,
  currency: 'VND' as const,
  interestRate: 8.5,
  startDate: '2026-01-15',
  termMonths: 60,
  paymentFrequency: 'MONTHLY' as const,
  scheduledPaymentAmount: 5_000_000,
  nextDueDate: '2026-04-15',
  notes: 'Home loan',
}

const validUpdateInput = {
  lender: 'Vietcombank Retail',
  scheduledPaymentAmount: 5_200_000,
  notes: 'Instalment reset after the rate review',
}

const validPaymentInput = {
  totalAmount: 5_000_000,
  principalAmount: 3_500_000,
  interestAmount: 1_500_000,
  paymentDate: '2026-04-15',
  note: 'April instalment',
}

const linkedCreateInput = { ...validCreateInput, accountId: 'account_1' }

const linkedPaymentInput = { ...validPaymentInput, accountId: 'account_1' }

const linkInput = { accountId: 'account_1', disbursedOn: '2026-01-15', includePayments: true }

/**
 * The four linked-transaction failures and the codes they must become — the
 * same table for every action that can write a linked transaction.
 */
const LINKED_FAILURES: [string, () => Error, string][] = [
  ['FxUnavailableError', () => new MockFxUnavailableError(), 'FX_UNAVAILABLE'],
  ['ArchivedAccountError', () => new ArchivedAccountError(), 'ARCHIVED_ACCOUNT'],
  [
    'LinkedAccountCurrencyMismatchError',
    () => new MockLinkedAccountCurrencyMismatchError(),
    'ACCOUNT_CURRENCY_MISMATCH',
  ],
  ['ConcurrentModificationError', () => new MockConcurrentModificationError(), 'CONFLICT'],
]

/** What Prisma raises when an interactive transaction outlives its timeout —
 *  on the query that finds it expired, or on its commit (both observed: a
 *  `PrismaClientKnownRequestError` with code P2028). */
function transactionTimeoutError() {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction API error: A commit cannot be executed on an expired transaction.',
    { code: 'P2028', clientVersion: '7.10.0' },
  )
}

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  requireUserMock.mockReset()
  createLoanMock.mockReset()
  updateLoanMock.mockReset()
  recordLoanPaymentMock.mockReset()
  updateLoanPaymentMock.mockReset()
  deleteLoanPaymentMock.mockReset()
  closeLoanMock.mockReset()
  linkLoanToAccountMock.mockReset()
  unlinkLoanFromAccountMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createLoanAction', () => {
  it('calls the service with the session user id, the parsed input and the session context', async () => {
    createLoanMock.mockResolvedValue(undefined)

    const result = await createLoanAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createLoanMock).toHaveBeenCalledTimes(1)
    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, CONTEXT)
  })

  it('revalidates the ledger pages too, because a loan received into an account moves money', async () => {
    createLoanMock.mockResolvedValue(undefined)

    await createLoanAction(linkedCreateInput)

    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, linkedCreateInput, CONTEXT)
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it('passes the id from the session, never a userId the caller smuggled in', async () => {
    createLoanMock.mockResolvedValue(undefined)

    await createLoanAction({ ...validCreateInput, userId: 'user_2' } as never)

    // Zod strips the unknown key, so the service is handed the authenticated
    // user's id and an input that cannot carry a second one.
    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, CONTEXT)
  })

  it("takes the timezone and locale from the session user, falling back to CashFlow's defaults", async () => {
    createLoanMock.mockResolvedValue(undefined)
    requireUserMock.mockResolvedValueOnce({ ...FIXED_USER, timezone: 'Not/AZone', locale: 'xx' })

    await createLoanAction(validCreateInput)

    // `resolveProfileDefaults` never lets an out-of-enum stored value through.
    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, {
      timezone: 'Asia/Ho_Chi_Minh',
      locale: 'vi',
    })
  })

  it('strips a client-supplied status rather than obeying it', async () => {
    createLoanMock.mockResolvedValue(undefined)

    await createLoanAction({ ...validCreateInput, status: 'CLOSED' } as never)

    // A new loan is ACTIVE and only `closeLoan` changes that; `status` is in no
    // schema at all, so a crafted request cannot create a pre-closed loan.
    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, CONTEXT)
  })

  it.each(LINKED_FAILURES)(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      createLoanMock.mockRejectedValue(error())

      const result = await createLoanAction(linkedCreateInput)

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('maps an invalid input to INVALID_INPUT without ever calling the service', async () => {
    const result = await createLoanAction({ ...validCreateInput, lender: '' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    // The action parses first, so a rejected input costs no database work.
    expect(createLoanMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps an unreal calendar date to INVALID_INPUT rather than letting a RangeError escape', async () => {
    // `2026-02-30` has the right shape and no such day. The service would turn
    // it into a carrier with `calendarDateToUtcCarrier`, which raises a bare
    // `RangeError` — an unmapped error, and so a rethrow — unless the action
    // parses first.
    const result = await createLoanAction({ ...validCreateInput, startDate: '2026-02-30' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createLoanMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError raised by the service to INVALID_INPUT and does not revalidate', async () => {
    createLoanMock.mockRejectedValue(new ZodError([]))

    const result = await createLoanAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createLoanMock.mockRejectedValue(notFoundError())

    const result = await createLoanAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    createLoanMock.mockRejectedValue(new Error('boom'))

    await expect(createLoanAction(validCreateInput)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createLoanAction(validCreateInput)).rejects.toThrow('Not authenticated')
    expect(createLoanMock).not.toHaveBeenCalled()
  })
})

describe('updateLoanAction', () => {
  it('calls the service with the session user id, the loan id and the parsed input, then revalidates', async () => {
    updateLoanMock.mockResolvedValue(undefined)

    const result = await updateLoanAction('loan_1', validUpdateInput)

    expect(result).toEqual({ ok: true })
    expect(updateLoanMock).toHaveBeenCalledTimes(1)
    expect(updateLoanMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1', validUpdateInput)
    // Editing a loan's terms moves no money, so no ledger page is revalidated.
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/loans', '/dashboard'])
  })

  it('strips every immutable term rather than forwarding it', async () => {
    updateLoanMock.mockResolvedValue(undefined)

    await updateLoanAction('loan_1', {
      ...validUpdateInput,
      principal: 999,
      currency: 'USD',
      interestRate: 0,
      startDate: '2020-01-01',
      termMonths: 1,
      paymentFrequency: 'WEEKLY',
      nextDueDate: '2030-01-01',
    } as never)

    // `updateLoanSchema` holds only lender, scheduled payment and notes, so a
    // crafted request cannot re-interpret an existing instalment history
    // against terms the loan never had, nor rewrite a schedule the recorded
    // payments already advanced.
    expect(updateLoanMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1', validUpdateInput)
  })

  it('maps LoanNotActiveError to NOT_ACTIVE and does not revalidate', async () => {
    updateLoanMock.mockRejectedValue(new MockLoanNotActiveError())

    const result = await updateLoanAction('loan_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_ACTIVE' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps an invalid input to INVALID_INPUT without ever calling the service', async () => {
    const result = await updateLoanAction('loan_1', {
      ...validUpdateInput,
      scheduledPaymentAmount: 0,
    })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(updateLoanMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError raised by the service to INVALID_INPUT', async () => {
    updateLoanMock.mockRejectedValue(new ZodError([]))

    const result = await updateLoanAction('loan_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    updateLoanMock.mockRejectedValue(notFoundError())

    const result = await updateLoanAction('loan_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    updateLoanMock.mockRejectedValue(new Error('boom'))

    await expect(updateLoanAction('loan_1', validUpdateInput)).rejects.toThrow('boom')
  })
})

describe('recordLoanPaymentAction', () => {
  it('calls the service with the session user id, the loan id, the parsed input and the context, then revalidates', async () => {
    recordLoanPaymentMock.mockResolvedValue(undefined)

    const result = await recordLoanPaymentAction('loan_1', linkedPaymentInput)

    expect(result).toEqual({ ok: true })
    expect(recordLoanPaymentMock).toHaveBeenCalledTimes(1)
    expect(recordLoanPaymentMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'loan_1',
      linkedPaymentInput,
      CONTEXT,
    )
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it.each(LINKED_FAILURES)(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      recordLoanPaymentMock.mockRejectedValue(error())

      const result = await recordLoanPaymentAction('loan_1', linkedPaymentInput)

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('maps LoanOverpaymentError to OVERPAYMENT and does not revalidate', async () => {
    recordLoanPaymentMock.mockRejectedValue(new MockLoanOverpaymentError('1500000'))

    const result = await recordLoanPaymentAction('loan_1', validPaymentInput)

    // The error carries the outstanding principal, but the action returns a
    // code only: the figure is a `Prisma.Decimal` on the real error and cannot
    // cross to a client component, and the page already shows what is
    // outstanding.
    expect(result).toEqual({ ok: false, error: 'OVERPAYMENT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps LoanNotActiveError to NOT_ACTIVE and does not revalidate', async () => {
    recordLoanPaymentMock.mockRejectedValue(new MockLoanNotActiveError())

    const result = await recordLoanPaymentAction('loan_1', validPaymentInput)

    expect(result).toEqual({ ok: false, error: 'NOT_ACTIVE' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps LoanSplitMismatchError to SPLIT_MISMATCH and does not revalidate', async () => {
    // The service's own `Prisma.Decimal` re-check under the row lock — layer
    // two of the split invariant's three. Unreachable through a form today
    // (Zod's refine rejects the same input first, see the case below), which is
    // exactly why the mapping needs pinning: it must not fall through to a
    // rethrow if a future caller ever reaches it.
    recordLoanPaymentMock.mockRejectedValue(new MockLoanSplitMismatchError())

    const result = await recordLoanPaymentAction('loan_1', validPaymentInput)

    expect(result).toEqual({ ok: false, error: 'SPLIT_MISMATCH' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects a mismatched split at the schema, before the row lock is ever taken', async () => {
    const result = await recordLoanPaymentAction('loan_1', {
      ...validPaymentInput,
      // 3.500.000 + 1.500.000 is 5.000.000, not 4.000.000.
      totalAmount: 4_000_000,
    })

    // Layer one of three. The request never opens the interactive transaction,
    // so no lock is held for an input that was always going to be refused.
    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(recordLoanPaymentMock).not.toHaveBeenCalled()
  })

  it('accepts an interest-only instalment, principal 0 (ruling R6-6)', async () => {
    recordLoanPaymentMock.mockResolvedValue(undefined)

    const interestOnly = {
      ...validPaymentInput,
      totalAmount: 1_500_000,
      principalAmount: 0,
      interestAmount: 1_500_000,
    }
    const result = await recordLoanPaymentAction('loan_1', interestOnly)

    // Every grace period and the early months of many loans are interest only;
    // refusing a 0 principal would make those instalments unrecordable.
    expect(result).toEqual({ ok: true })
    expect(recordLoanPaymentMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'loan_1',
      interestOnly,
      CONTEXT,
    )
  })

  it('maps an empty payment date to INVALID_INPUT without ever calling the service', async () => {
    // What a submitted-but-untouched `<input type="date">` sends. The schema
    // rejects it, so the request never reaches the row lock — and the
    // `RangeError` `calendarDateToUtcCarrier` would raise for it never happens.
    const result = await recordLoanPaymentAction('loan_1', {
      ...validPaymentInput,
      paymentDate: '',
    })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(recordLoanPaymentMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError raised by the service to INVALID_INPUT', async () => {
    recordLoanPaymentMock.mockRejectedValue(new ZodError([]))

    const result = await recordLoanPaymentAction('loan_1', validPaymentInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    recordLoanPaymentMock.mockRejectedValue(notFoundError())

    const result = await recordLoanPaymentAction('loan_1', validPaymentInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    recordLoanPaymentMock.mockRejectedValue(new Error('boom'))

    await expect(recordLoanPaymentAction('loan_1', validPaymentInput)).rejects.toThrow('boom')
  })
})

describe('updateLoanPaymentAction', () => {
  it('calls the service with the session user id, the payment id, the parsed input and the context, then revalidates', async () => {
    updateLoanPaymentMock.mockResolvedValue(undefined)

    const result = await updateLoanPaymentAction('payment_1', linkedPaymentInput)

    expect(result).toEqual({ ok: true })
    expect(updateLoanPaymentMock).toHaveBeenCalledTimes(1)
    expect(updateLoanPaymentMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'payment_1',
      linkedPaymentInput,
      CONTEXT,
    )
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it('maps an invalid input to INVALID_INPUT without ever calling the service', async () => {
    // A mismatched split: rejected at the schema, before any lock is taken.
    const result = await updateLoanPaymentAction('payment_1', {
      ...validPaymentInput,
      totalAmount: 4_000_000,
    })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(updateLoanPaymentMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it.each([
    ['LoanOverpaymentError', () => new MockLoanOverpaymentError('1'), 'OVERPAYMENT'],
    ['LoanNotActiveError', () => new MockLoanNotActiveError(), 'NOT_ACTIVE'],
    ['LoanSplitMismatchError', () => new MockLoanSplitMismatchError(), 'SPLIT_MISMATCH'],
    ['P2025', notFoundError, 'NOT_FOUND'],
    ...LINKED_FAILURES,
  ] as [string, () => Error, string][])(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      updateLoanPaymentMock.mockRejectedValue(error())

      const result = await updateLoanPaymentAction('payment_1', linkedPaymentInput)

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('rethrows an unmapped error', async () => {
    updateLoanPaymentMock.mockRejectedValue(new Error('boom'))

    await expect(updateLoanPaymentAction('payment_1', validPaymentInput)).rejects.toThrow('boom')
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(updateLoanPaymentAction('payment_1', validPaymentInput)).rejects.toThrow(
      'Not authenticated',
    )
    expect(updateLoanPaymentMock).not.toHaveBeenCalled()
  })
})

describe('deleteLoanPaymentAction', () => {
  it('calls the service with the session user id and the payment id only, then revalidates', async () => {
    deleteLoanPaymentMock.mockResolvedValue(undefined)

    const result = await deleteLoanPaymentAction('payment_1')

    expect(result).toEqual({ ok: true })
    expect(deleteLoanPaymentMock).toHaveBeenCalledTimes(1)
    expect(deleteLoanPaymentMock).toHaveBeenCalledWith(FIXED_USER.id, 'payment_1')
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it.each([
    ['LoanNotActiveError', () => new MockLoanNotActiveError(), 'NOT_ACTIVE'],
    ['P2025', notFoundError, 'NOT_FOUND'],
    ['ArchivedAccountError', () => new ArchivedAccountError(), 'ARCHIVED_ACCOUNT'],
    ['ConcurrentModificationError', () => new MockConcurrentModificationError(), 'CONFLICT'],
  ] as [string, () => Error, string][])(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      deleteLoanPaymentMock.mockRejectedValue(error())

      const result = await deleteLoanPaymentAction('payment_1')

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('rethrows an unmapped error, and never revalidates', async () => {
    deleteLoanPaymentMock.mockRejectedValue(new Error('boom'))

    await expect(deleteLoanPaymentAction('payment_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(deleteLoanPaymentAction('payment_1')).rejects.toThrow('Not authenticated')
    expect(deleteLoanPaymentMock).not.toHaveBeenCalled()
  })
})

describe('closeLoanAction', () => {
  it('calls the service with the session user id and the loan id only, then revalidates', async () => {
    closeLoanMock.mockResolvedValue(undefined)

    const result = await closeLoanAction('loan_1')

    expect(result).toEqual({ ok: true })
    expect(closeLoanMock).toHaveBeenCalledTimes(1)
    expect(closeLoanMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1')
    // Closing a loan moves no money, so no ledger page is revalidated.
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/loans', '/dashboard'])
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    closeLoanMock.mockRejectedValue(notFoundError())

    const result = await closeLoanAction('loan_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps LoanNotActiveError to NOT_ACTIVE, should the service ever raise it here', async () => {
    // `closeLoan` is idempotent today and returns the row instead of throwing,
    // so this pins the mapping rather than current behaviour: the code must not
    // fall through to a rethrow if that ever changes.
    closeLoanMock.mockRejectedValue(new MockLoanNotActiveError())

    const result = await closeLoanAction('loan_1')

    expect(result).toEqual({ ok: false, error: 'NOT_ACTIVE' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    closeLoanMock.mockRejectedValue(new Error('boom'))

    await expect(closeLoanAction('loan_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(closeLoanAction('loan_1')).rejects.toThrow('Not authenticated')
    expect(closeLoanMock).not.toHaveBeenCalled()
  })
})

describe('linkLoanToAccountAction', () => {
  it('calls the service with the session user id, the loan id, the parsed input and the context, then revalidates every money page', async () => {
    linkLoanToAccountMock.mockResolvedValue(undefined)

    const result = await linkLoanToAccountAction('loan_1', linkInput)

    expect(result).toEqual({ ok: true })
    expect(linkLoanToAccountMock).toHaveBeenCalledTimes(1)
    expect(linkLoanToAccountMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1', linkInput, CONTEXT)
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it.each([
    [{ ...linkInput, accountId: '' }],
    [{ ...linkInput, disbursedOn: '2026-02-30' }],
    [{ accountId: 'account_1', disbursedOn: '2026-01-15' }],
  ])(
    'maps an invalid input %o to INVALID_INPUT without ever calling the service',
    async (input) => {
      const result = await linkLoanToAccountAction('loan_1', input as typeof linkInput)

      expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
      expect(linkLoanToAccountMock).not.toHaveBeenCalled()
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['LoanAlreadyLinkedError', () => new MockLoanAlreadyLinkedError(), 'ALREADY_LINKED'],
    ['P2028 (transaction timed out)', transactionTimeoutError, 'TIMEOUT'],
    ['P2025', notFoundError, 'NOT_FOUND'],
    ['ZodError', () => new ZodError([]), 'INVALID_INPUT'],
    ...LINKED_FAILURES,
  ] as [string, () => Error, string][])(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      linkLoanToAccountMock.mockRejectedValue(error())

      const result = await linkLoanToAccountAction('loan_1', linkInput)

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('rethrows an unmapped error, and never revalidates', async () => {
    linkLoanToAccountMock.mockRejectedValue(new Error('boom'))

    await expect(linkLoanToAccountAction('loan_1', linkInput)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(linkLoanToAccountAction('loan_1', linkInput)).rejects.toThrow('Not authenticated')
    expect(linkLoanToAccountMock).not.toHaveBeenCalled()
  })
})

describe('unlinkLoanFromAccountAction', () => {
  it('calls the service with the session user id, the loan id and the parsed input, then revalidates every money page', async () => {
    unlinkLoanFromAccountMock.mockResolvedValue(undefined)

    const result = await unlinkLoanFromAccountAction('loan_1', { includePayments: true })

    expect(result).toEqual({ ok: true })
    expect(unlinkLoanFromAccountMock).toHaveBeenCalledTimes(1)
    expect(unlinkLoanFromAccountMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1', {
      includePayments: true,
    })
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it('maps an input without the payments choice to INVALID_INPUT without ever calling the service', async () => {
    const result = await unlinkLoanFromAccountAction(
      'loan_1',
      {} as unknown as { includePayments: boolean },
    )

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(unlinkLoanFromAccountMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it.each([
    ['LoanNotLinkedError', () => new MockLoanNotLinkedError(), 'NOT_LINKED'],
    ['ArchivedAccountError', () => new ArchivedAccountError(), 'ARCHIVED_ACCOUNT'],
    ['ConcurrentModificationError', () => new MockConcurrentModificationError(), 'CONFLICT'],
    ['P2028 (transaction timed out)', transactionTimeoutError, 'TIMEOUT'],
    ['P2025', notFoundError, 'NOT_FOUND'],
  ] as [string, () => Error, string][])(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      unlinkLoanFromAccountMock.mockRejectedValue(error())

      const result = await unlinkLoanFromAccountAction('loan_1', { includePayments: false })

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('rethrows an unmapped error, and never revalidates', async () => {
    unlinkLoanFromAccountMock.mockRejectedValue(new Error('boom'))

    await expect(unlinkLoanFromAccountAction('loan_1', { includePayments: false })).rejects.toThrow(
      'boom',
    )
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(unlinkLoanFromAccountAction('loan_1', { includePayments: false })).rejects.toThrow(
      'Not authenticated',
    )
    expect(unlinkLoanFromAccountMock).not.toHaveBeenCalled()
  })
})

/**
 * Ruling P12 (final review F8): each money-capable action parses against the
 * session user's today, so a write recorded in an account on a later day is
 * refused at the edge. Two days ahead, clear of a run that crosses midnight in
 * the user's zone.
 */
describe('no future-dated money movement in an account (P12)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const LATER = formatCalendarDate(
    new Date(
      calendarDateToUtcCarrier(todayCalendarDateInZone(FIXED_USER.timezone)).getTime() + 2 * DAY_MS,
    ),
  )

  it.each([
    ['createLoanAction', () => createLoanAction({ ...linkedCreateInput, startDate: LATER })],
    [
      'recordLoanPaymentAction',
      () => recordLoanPaymentAction('loan_1', { ...linkedPaymentInput, paymentDate: LATER }),
    ],
    [
      'updateLoanPaymentAction',
      () => updateLoanPaymentAction('payment_1', { ...linkedPaymentInput, paymentDate: LATER }),
    ],
    [
      'linkLoanToAccountAction',
      () => linkLoanToAccountAction('loan_1', { ...linkInput, disbursedOn: LATER }),
    ],
  ] as const)('%s refuses a later day in an account as INVALID_INPUT', async (_name, act) => {
    expect(await act()).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createLoanMock).not.toHaveBeenCalled()
    expect(recordLoanPaymentMock).not.toHaveBeenCalled()
    expect(updateLoanPaymentMock).not.toHaveBeenCalled()
    expect(linkLoanToAccountMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('still creates a loan that starts later when it is received into no account', async () => {
    createLoanMock.mockResolvedValue(undefined)

    const result = await createLoanAction({ ...validCreateInput, startDate: LATER })

    expect(result).toEqual({ ok: true })
    expect(createLoanMock).toHaveBeenCalledTimes(1)
  })

  it('maps a later-dated instalment that "Record in an account" would record to FUTURE_PAYMENT', async () => {
    linkLoanToAccountMock.mockRejectedValue(new MockFutureLinkedPaymentError())

    const result = await linkLoanToAccountAction('loan_1', linkInput)

    expect(result).toEqual({ ok: false, error: 'FUTURE_PAYMENT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})

describe('LOAN_ERROR_KEYS', () => {
  // The temporary English `LOAN_ERROR_MESSAGES` alias this test used to pin
  // (Phase 7, Tasks 2–13) is gone (Task 13): every code's copy now lives only
  // in `messages/{vi,en}/errors.json`, and `lib/i18n/messages.test.ts` already
  // proves the two locales carry the same key set with no empty value. What
  // is still this layer's job to prove is narrower: every `LoanActionError` a
  // component can receive maps to a key in the `errors.loan` namespace, typed
  // as `Record<LoanActionError, string>` so a new code is a compile error
  // until it has one.
  it('has a message key for every code an action can return', () => {
    expect(LOAN_ERROR_KEYS).toEqual({
      OVERPAYMENT: 'errors.loan.OVERPAYMENT',
      NOT_ACTIVE: 'errors.loan.NOT_ACTIVE',
      SPLIT_MISMATCH: 'errors.loan.SPLIT_MISMATCH',
      FX_UNAVAILABLE: 'errors.loan.FX_UNAVAILABLE',
      ARCHIVED_ACCOUNT: 'errors.loan.ARCHIVED_ACCOUNT',
      ACCOUNT_CURRENCY_MISMATCH: 'errors.loan.ACCOUNT_CURRENCY_MISMATCH',
      CONFLICT: 'errors.loan.CONFLICT',
      ALREADY_LINKED: 'errors.loan.ALREADY_LINKED',
      NOT_LINKED: 'errors.loan.NOT_LINKED',
      FUTURE_PAYMENT: 'errors.loan.FUTURE_PAYMENT',
      TIMEOUT: 'errors.loan.TIMEOUT',
      INVALID_INPUT: 'errors.loan.INVALID_INPUT',
      NOT_FOUND: 'errors.loan.NOT_FOUND',
    })
  })
})
