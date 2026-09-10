import { describe, it, expect, vi, beforeEach } from 'vitest'

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
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createLoanMock = vi.hoisted(() => vi.fn())
const updateLoanMock = vi.hoisted(() => vi.fn())
const recordLoanPaymentMock = vi.hoisted(() => vi.fn())
const closeLoanMock = vi.hoisted(() => vi.fn())
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

class MockLoanSplitMismatchError extends Error {
  constructor() {
    super('Total must equal principal plus interest.')
    this.name = 'LoanSplitMismatchError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/loan', () => ({
  createLoan: createLoanMock,
  updateLoan: updateLoanMock,
  recordLoanPayment: recordLoanPaymentMock,
  closeLoan: closeLoanMock,
  LoanOverpaymentError: MockLoanOverpaymentError,
  LoanNotActiveError: MockLoanNotActiveError,
  LoanSplitMismatchError: MockLoanSplitMismatchError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const { createLoanAction, updateLoanAction, recordLoanPaymentAction, closeLoanAction } =
  await import('./loan-actions')
const { LOAN_ERROR_KEYS } = await import('@/lib/ui/action-error-messages')
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
  closeLoanMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createLoanAction', () => {
  it('calls the service with the session user id and the parsed input only, then revalidates', async () => {
    createLoanMock.mockResolvedValue(undefined)

    const result = await createLoanAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createLoanMock).toHaveBeenCalledTimes(1)
    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/loans')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('revalidates only the two pages a loan appears on — no ledger page', async () => {
    createLoanMock.mockResolvedValue(undefined)

    await createLoanAction(validCreateInput)

    // A loan is tracking only: recording an instalment writes a `LoanPayment`
    // and moves the schedule, and nothing else, so `/accounts` and
    // `/transactions` have nothing to re-render and revalidating them would
    // claim otherwise.
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/loans', '/dashboard'])
  })

  it('passes the id from the session, never a userId the caller smuggled in', async () => {
    createLoanMock.mockResolvedValue(undefined)

    await createLoanAction({ ...validCreateInput, userId: 'user_2' } as never)

    // Zod strips the unknown key, so the service is handed the authenticated
    // user's id and an input that cannot carry a second one.
    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput)
  })

  it('strips a client-supplied status rather than obeying it', async () => {
    createLoanMock.mockResolvedValue(undefined)

    await createLoanAction({ ...validCreateInput, status: 'CLOSED' } as never)

    // A new loan is ACTIVE and only `closeLoan` changes that; `status` is in no
    // schema at all, so a crafted request cannot create a pre-closed loan.
    expect(createLoanMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput)
  })

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
  it('calls the service with the session user id, the loan id and the parsed input, then revalidates', async () => {
    recordLoanPaymentMock.mockResolvedValue(undefined)

    const result = await recordLoanPaymentAction('loan_1', validPaymentInput)

    expect(result).toEqual({ ok: true })
    expect(recordLoanPaymentMock).toHaveBeenCalledTimes(1)
    expect(recordLoanPaymentMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1', validPaymentInput)
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/loans', '/dashboard'])
  })

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
    expect(recordLoanPaymentMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1', interestOnly)
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

describe('closeLoanAction', () => {
  it('calls the service with the session user id and the loan id only, then revalidates', async () => {
    closeLoanMock.mockResolvedValue(undefined)

    const result = await closeLoanAction('loan_1')

    expect(result).toEqual({ ok: true })
    expect(closeLoanMock).toHaveBeenCalledTimes(1)
    expect(closeLoanMock).toHaveBeenCalledWith(FIXED_USER.id, 'loan_1')
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
      INVALID_INPUT: 'errors.loan.INVALID_INPUT',
      NOT_FOUND: 'errors.loan.NOT_FOUND',
    })
  })
})
