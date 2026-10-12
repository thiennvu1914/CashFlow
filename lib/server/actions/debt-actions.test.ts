import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `debt-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * `@/lib/auth/require-user` and `@/lib/server/services/debt` are mocked so this
 * test needs neither Postgres nor a session — the same arrangement as
 * `savings-goal-actions.test.ts`. `next/cache`'s real `revalidatePath` throws
 * outside a Next.js request/work store, so it is mocked too. The validation
 * module is deliberately NOT mocked: the actions parse with the real schemas,
 * and "an invalid input never reaches the service" is exactly what the Zod
 * cases below prove.
 *
 * What is under test is only this layer's job: that `userId` comes from the
 * session and never from the caller, that each domain failure becomes its own
 * code, that an unmapped error still escapes, and that a *failed* write
 * revalidates nothing.
 *
 * Money-source linking (spec 2026-10-12 §6.2) adds the session context the
 * money-capable writes need — the user's timezone and locale — and four codes
 * for the linked-transaction failures. The modules those errors live in
 * (`linked-transaction`, `transaction`, `current-rate-policy`) import the
 * Prisma client instance, so they are mocked with mirrors here exactly as
 * `transaction-actions.test.ts` mocks them; `account-lock` imports no client
 * and is used as is.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createDebtMock = vi.hoisted(() => vi.fn())
const updateDebtMock = vi.hoisted(() => vi.fn())
const recordDebtPaymentMock = vi.hoisted(() => vi.fn())
const writeOffDebtMock = vi.hoisted(() => vi.fn())
const updateDebtPaymentMock = vi.hoisted(() => vi.fn())
const deleteDebtPaymentMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

/**
 * Stand-ins for the service's two domain errors. Mirrors of the real classes
 * (including `DebtOverpaymentError`'s `outstanding`) rather than the classes
 * themselves, because the service module is mocked away — importing the real
 * ones would drag Prisma's client into this test for nothing.
 */
class MockDebtOverpaymentError extends Error {
  readonly outstanding: unknown

  constructor(outstanding: unknown) {
    super('Payment exceeds the amount still owed.')
    this.name = 'DebtOverpaymentError'
    this.outstanding = outstanding
  }
}

class MockDebtNotActiveError extends Error {
  constructor() {
    super('This debt has been written off and cannot receive payments.')
    this.name = 'DebtNotActiveError'
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

vi.mock('@/lib/server/services/debt', () => ({
  createDebt: createDebtMock,
  updateDebt: updateDebtMock,
  recordDebtPayment: recordDebtPaymentMock,
  writeOffDebt: writeOffDebtMock,
  updateDebtPayment: updateDebtPaymentMock,
  deleteDebtPayment: deleteDebtPaymentMock,
  DebtOverpaymentError: MockDebtOverpaymentError,
  DebtNotActiveError: MockDebtNotActiveError,
}))

vi.mock('@/lib/server/services/linked-transaction', () => ({
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
  createDebtAction,
  updateDebtAction,
  recordDebtPaymentAction,
  writeOffDebtAction,
  updateDebtPaymentAction,
  deleteDebtPaymentAction,
} = await import('./debt-actions')
const { DEBT_ERROR_KEYS } = await import('@/lib/ui/action-error-messages')
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
const MONEY_PAGES = ['/debts', '/accounts', '/transactions', '/dashboard']

/** Every optional field populated, so the schema's output is deep-equal to the
 *  input and the `toHaveBeenCalledWith` assertions below can name it directly. */
const validCreateInput = {
  direction: 'RECEIVABLE' as const,
  person: 'Minh',
  description: 'Lunch money',
  originalAmount: 1_000_000,
  currency: 'VND' as const,
  dueDate: '2026-05-01',
  notes: 'Pay back after payday',
}

const validUpdateInput = {
  person: 'Minh Nguyen',
  description: 'Lunch money',
  dueDate: '2026-06-01',
  notes: 'Renegotiated',
}

const validPaymentInput = {
  amount: 250_000,
  date: '2026-03-02',
  note: 'First instalment',
}

const linkedCreateInput = { ...validCreateInput, accountId: 'account_1', movedOn: '2026-03-01' }

const linkedPaymentInput = { ...validPaymentInput, accountId: 'account_1' }

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

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  requireUserMock.mockReset()
  createDebtMock.mockReset()
  updateDebtMock.mockReset()
  recordDebtPaymentMock.mockReset()
  writeOffDebtMock.mockReset()
  updateDebtPaymentMock.mockReset()
  deleteDebtPaymentMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createDebtAction', () => {
  it('calls the service with the session user id, the parsed input and the session context', async () => {
    createDebtMock.mockResolvedValue(undefined)

    const result = await createDebtAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createDebtMock).toHaveBeenCalledTimes(1)
    expect(createDebtMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, CONTEXT)
  })

  it('revalidates the ledger pages too, because a debt recorded in an account moves money', async () => {
    createDebtMock.mockResolvedValue(undefined)

    await createDebtAction(linkedCreateInput)

    expect(createDebtMock).toHaveBeenCalledWith(FIXED_USER.id, linkedCreateInput, CONTEXT)
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it('passes the id from the session, never a userId the caller smuggled in', async () => {
    createDebtMock.mockResolvedValue(undefined)

    await createDebtAction({ ...validCreateInput, userId: 'user_2' } as never)

    // Zod strips the unknown key, so the service is handed the authenticated
    // user's id and an input that cannot carry a second one.
    expect(createDebtMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, CONTEXT)
  })

  it("takes the timezone and locale from the session user, falling back to CashFlow's defaults", async () => {
    createDebtMock.mockResolvedValue(undefined)
    requireUserMock.mockResolvedValueOnce({ ...FIXED_USER, timezone: 'Not/AZone', locale: 'xx' })

    await createDebtAction(validCreateInput)

    // `resolveProfileDefaults` never lets an out-of-enum stored value through.
    expect(createDebtMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, {
      timezone: 'Asia/Ho_Chi_Minh',
      locale: 'vi',
    })
  })

  it('maps a missing money-moved date with an account to INVALID_INPUT without calling the service', async () => {
    const result = await createDebtAction({ ...linkedCreateInput, movedOn: undefined })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createDebtMock).not.toHaveBeenCalled()
  })

  it.each(LINKED_FAILURES)(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      createDebtMock.mockRejectedValue(error())

      const result = await createDebtAction(linkedCreateInput)

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('maps an invalid input to INVALID_INPUT without ever calling the service', async () => {
    const result = await createDebtAction({ ...validCreateInput, person: '' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    // The action parses first, so a rejected input costs no database work.
    expect(createDebtMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError raised by the service to INVALID_INPUT and does not revalidate', async () => {
    createDebtMock.mockRejectedValue(new ZodError([]))

    const result = await createDebtAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createDebtMock.mockRejectedValue(notFoundError())

    const result = await createDebtAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    createDebtMock.mockRejectedValue(new Error('boom'))

    await expect(createDebtAction(validCreateInput)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createDebtAction(validCreateInput)).rejects.toThrow('Not authenticated')
    expect(createDebtMock).not.toHaveBeenCalled()
  })
})

describe('updateDebtAction', () => {
  it('calls the service with the session user id, the debt id and the parsed input, then revalidates', async () => {
    updateDebtMock.mockResolvedValue(undefined)

    const result = await updateDebtAction('debt_1', validUpdateInput)

    expect(result).toEqual({ ok: true })
    expect(updateDebtMock).toHaveBeenCalledTimes(1)
    expect(updateDebtMock).toHaveBeenCalledWith(FIXED_USER.id, 'debt_1', validUpdateInput)
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/debts', '/dashboard'])
  })

  it('strips the three immutable fields rather than forwarding them', async () => {
    updateDebtMock.mockResolvedValue(undefined)

    await updateDebtAction('debt_1', {
      ...validUpdateInput,
      direction: 'PAYABLE',
      originalAmount: 999,
      currency: 'USD',
    } as never)

    // `updateDebtSchema` does not contain direction, amount or currency, so a
    // crafted request cannot re-interpret an existing payment history against
    // terms the debt never had.
    expect(updateDebtMock).toHaveBeenCalledWith(FIXED_USER.id, 'debt_1', validUpdateInput)
  })

  it('maps DebtNotActiveError to NOT_ACTIVE and does not revalidate', async () => {
    updateDebtMock.mockRejectedValue(new MockDebtNotActiveError())

    const result = await updateDebtAction('debt_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_ACTIVE' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps an invalid input to INVALID_INPUT without ever calling the service', async () => {
    const result = await updateDebtAction('debt_1', { ...validUpdateInput, person: '' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(updateDebtMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError raised by the service to INVALID_INPUT', async () => {
    updateDebtMock.mockRejectedValue(new ZodError([]))

    const result = await updateDebtAction('debt_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    updateDebtMock.mockRejectedValue(notFoundError())

    const result = await updateDebtAction('debt_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    updateDebtMock.mockRejectedValue(new Error('boom'))

    await expect(updateDebtAction('debt_1', validUpdateInput)).rejects.toThrow('boom')
  })
})

describe('recordDebtPaymentAction', () => {
  it('calls the service with the session user id, the debt id, the parsed input and the context, then revalidates', async () => {
    recordDebtPaymentMock.mockResolvedValue(undefined)

    const result = await recordDebtPaymentAction('debt_1', linkedPaymentInput)

    expect(result).toEqual({ ok: true })
    expect(recordDebtPaymentMock).toHaveBeenCalledTimes(1)
    expect(recordDebtPaymentMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'debt_1',
      linkedPaymentInput,
      CONTEXT,
    )
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it.each(LINKED_FAILURES)(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      recordDebtPaymentMock.mockRejectedValue(error())

      const result = await recordDebtPaymentAction('debt_1', linkedPaymentInput)

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('maps DebtOverpaymentError to OVERPAYMENT and does not revalidate', async () => {
    recordDebtPaymentMock.mockRejectedValue(new MockDebtOverpaymentError('150000'))

    const result = await recordDebtPaymentAction('debt_1', validPaymentInput)

    // The error carries the outstanding amount, but the action returns a code
    // only: the figure is a `Prisma.Decimal` on the real error and cannot cross
    // to a client component, and the page already shows what is outstanding.
    expect(result).toEqual({ ok: false, error: 'OVERPAYMENT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps DebtNotActiveError to NOT_ACTIVE and does not revalidate', async () => {
    recordDebtPaymentMock.mockRejectedValue(new MockDebtNotActiveError())

    const result = await recordDebtPaymentAction('debt_1', validPaymentInput)

    expect(result).toEqual({ ok: false, error: 'NOT_ACTIVE' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps an empty payment date to INVALID_INPUT without ever calling the service', async () => {
    // What a submitted-but-untouched `<input type="date">` sends. The schema
    // rejects it, so the request never reaches the row lock.
    const result = await recordDebtPaymentAction('debt_1', { ...validPaymentInput, date: '' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(recordDebtPaymentMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError raised by the service to INVALID_INPUT', async () => {
    recordDebtPaymentMock.mockRejectedValue(new ZodError([]))

    const result = await recordDebtPaymentAction('debt_1', validPaymentInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    recordDebtPaymentMock.mockRejectedValue(notFoundError())

    const result = await recordDebtPaymentAction('debt_1', validPaymentInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    recordDebtPaymentMock.mockRejectedValue(new Error('boom'))

    await expect(recordDebtPaymentAction('debt_1', validPaymentInput)).rejects.toThrow('boom')
  })
})

describe('writeOffDebtAction', () => {
  it('calls the service with the session user id and the debt id only, then revalidates', async () => {
    writeOffDebtMock.mockResolvedValue(undefined)

    const result = await writeOffDebtAction('debt_1')

    expect(result).toEqual({ ok: true })
    expect(writeOffDebtMock).toHaveBeenCalledTimes(1)
    expect(writeOffDebtMock).toHaveBeenCalledWith(FIXED_USER.id, 'debt_1')
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/debts', '/dashboard'])
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    writeOffDebtMock.mockRejectedValue(notFoundError())

    const result = await writeOffDebtAction('debt_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps DebtNotActiveError to NOT_ACTIVE, should the service ever raise it here', async () => {
    // `writeOffDebt` is idempotent today and returns the row instead of
    // throwing, so this pins the mapping rather than current behaviour: the
    // code must not fall through to a rethrow if that ever changes.
    writeOffDebtMock.mockRejectedValue(new MockDebtNotActiveError())

    const result = await writeOffDebtAction('debt_1')

    expect(result).toEqual({ ok: false, error: 'NOT_ACTIVE' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    writeOffDebtMock.mockRejectedValue(new Error('boom'))

    await expect(writeOffDebtAction('debt_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(writeOffDebtAction('debt_1')).rejects.toThrow('Not authenticated')
    expect(writeOffDebtMock).not.toHaveBeenCalled()
  })
})

describe('updateDebtPaymentAction', () => {
  it('calls the service with the session user id, the payment id, the parsed input and the context, then revalidates', async () => {
    updateDebtPaymentMock.mockResolvedValue(undefined)

    const result = await updateDebtPaymentAction('payment_1', linkedPaymentInput)

    expect(result).toEqual({ ok: true })
    expect(updateDebtPaymentMock).toHaveBeenCalledTimes(1)
    expect(updateDebtPaymentMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'payment_1',
      linkedPaymentInput,
      CONTEXT,
    )
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it('maps an invalid input to INVALID_INPUT without ever calling the service', async () => {
    const result = await updateDebtPaymentAction('payment_1', { ...validPaymentInput, amount: 0 })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(updateDebtPaymentMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it.each([
    ['DebtOverpaymentError', () => new MockDebtOverpaymentError('1'), 'OVERPAYMENT'],
    ['DebtNotActiveError', () => new MockDebtNotActiveError(), 'NOT_ACTIVE'],
    ['P2025', notFoundError, 'NOT_FOUND'],
    ...LINKED_FAILURES,
  ] as [string, () => Error, string][])(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      updateDebtPaymentMock.mockRejectedValue(error())

      const result = await updateDebtPaymentAction('payment_1', linkedPaymentInput)

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('rethrows an unmapped error', async () => {
    updateDebtPaymentMock.mockRejectedValue(new Error('boom'))

    await expect(updateDebtPaymentAction('payment_1', validPaymentInput)).rejects.toThrow('boom')
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(updateDebtPaymentAction('payment_1', validPaymentInput)).rejects.toThrow(
      'Not authenticated',
    )
    expect(updateDebtPaymentMock).not.toHaveBeenCalled()
  })
})

describe('deleteDebtPaymentAction', () => {
  it('calls the service with the session user id and the payment id only, then revalidates', async () => {
    deleteDebtPaymentMock.mockResolvedValue(undefined)

    const result = await deleteDebtPaymentAction('payment_1')

    expect(result).toEqual({ ok: true })
    expect(deleteDebtPaymentMock).toHaveBeenCalledTimes(1)
    expect(deleteDebtPaymentMock).toHaveBeenCalledWith(FIXED_USER.id, 'payment_1')
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(MONEY_PAGES)
  })

  it.each([
    ['DebtNotActiveError', () => new MockDebtNotActiveError(), 'NOT_ACTIVE'],
    ['P2025', notFoundError, 'NOT_FOUND'],
    ['ArchivedAccountError', () => new ArchivedAccountError(), 'ARCHIVED_ACCOUNT'],
    ['ConcurrentModificationError', () => new MockConcurrentModificationError(), 'CONFLICT'],
  ] as [string, () => Error, string][])(
    'maps %s to its own code and does not revalidate',
    async (_, error, code) => {
      deleteDebtPaymentMock.mockRejectedValue(error())

      const result = await deleteDebtPaymentAction('payment_1')

      expect(result).toEqual({ ok: false, error: code })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    },
  )

  it('rethrows an unmapped error, and never revalidates', async () => {
    deleteDebtPaymentMock.mockRejectedValue(new Error('boom'))

    await expect(deleteDebtPaymentAction('payment_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(deleteDebtPaymentAction('payment_1')).rejects.toThrow('Not authenticated')
    expect(deleteDebtPaymentMock).not.toHaveBeenCalled()
  })
})

describe('DEBT_ERROR_KEYS', () => {
  // The temporary English `DEBT_ERROR_MESSAGES` alias this test used to pin
  // (Phase 7, Tasks 2–13) is gone (Task 13): every code's copy now lives only
  // in `messages/{vi,en}/errors.json`, and `lib/i18n/messages.test.ts` already
  // proves the two locales carry the same key set with no empty value. What
  // is still this layer's job to prove is narrower: every `DebtActionError` a
  // component can receive maps to a key in the `errors.debt` namespace, typed
  // as `Record<DebtActionError, string>` so a new code is a compile error
  // until it has one.
  it('has a message key for every code an action can return', () => {
    expect(DEBT_ERROR_KEYS).toEqual({
      OVERPAYMENT: 'errors.debt.OVERPAYMENT',
      NOT_ACTIVE: 'errors.debt.NOT_ACTIVE',
      FX_UNAVAILABLE: 'errors.debt.FX_UNAVAILABLE',
      ARCHIVED_ACCOUNT: 'errors.debt.ARCHIVED_ACCOUNT',
      ACCOUNT_CURRENCY_MISMATCH: 'errors.debt.ACCOUNT_CURRENCY_MISMATCH',
      CONFLICT: 'errors.debt.CONFLICT',
      INVALID_INPUT: 'errors.debt.INVALID_INPUT',
      NOT_FOUND: 'errors.debt.NOT_FOUND',
    })
  })
})
