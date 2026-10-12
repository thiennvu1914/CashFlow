import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateTransactionFormInput } from '@/lib/validation/transaction'

/**
 * `transaction-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * Every module that would otherwise touch Postgres or the live FX provider is
 * mocked — `@/lib/auth/require-user`, `@/lib/server/services/transaction` and
 * `@/lib/currency/current-rate-policy` — so this test needs neither Postgres
 * nor a network call. `next/cache`'s real `revalidatePath` throws outside a
 * Next.js request/work store, so it is mocked too.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createTransactionMock = vi.hoisted(() => vi.fn())
const updateTransactionMock = vi.hoisted(() => vi.fn())
const deleteTransactionMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

class MockArchivedAccountError extends Error {
  constructor() {
    super('This account is archived and cannot receive new activity.')
    this.name = 'ArchivedAccountError'
  }
}

class MockInvalidCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid category: ${reason}`)
    this.name = 'InvalidCategoryError'
  }
}

class MockCurrencyMismatchError extends Error {
  constructor() {
    super('Move the transaction to an account in the same currency, or delete and re-enter it.')
    this.name = 'CurrencyMismatchError'
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

class MockLinkedTransactionError extends Error {
  constructor() {
    super('This transaction belongs to a debt or loan. Change it from there.')
    this.name = 'LinkedTransactionError'
  }
}

class MockOccurrenceNotPendingError extends Error {
  constructor() {
    super('This reminder has already been answered.')
    this.name = 'OccurrenceNotPendingError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/transaction', () => ({
  createTransaction: createTransactionMock,
  updateTransaction: updateTransactionMock,
  deleteTransaction: deleteTransactionMock,
  ArchivedAccountError: MockArchivedAccountError,
  CurrencyMismatchError: MockCurrencyMismatchError,
  InvalidCategoryError: MockInvalidCategoryError,
  ConcurrentModificationError: MockConcurrentModificationError,
  LinkedTransactionError: MockLinkedTransactionError,
  OccurrenceNotPendingError: MockOccurrenceNotPendingError,
}))

vi.mock('@/lib/currency/current-rate-policy', () => ({
  isFxUnavailableError: (e: unknown) => e instanceof MockFxUnavailableError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const { createTransactionAction, updateTransactionAction, deleteTransactionAction } =
  await import('./transaction-actions')
const { TRANSACTION_ERROR_KEYS } = await import('@/lib/ui/action-error-messages')
const { loadMessages } = await import('@/lib/i18n/messages')
const { ZodError } = await import('zod')
const { Prisma } = await import('@prisma/client')

/**
 * The session user carries a real IANA timezone: the action resolves the
 * submitted local date and time against it, so the zone is part of what these
 * tests pin down. `Asia/Ho_Chi_Minh` is UTC+7 year-round, which makes the
 * expected instant unambiguous.
 */
const FIXED_USER = {
  id: 'user_1',
  email: 'user@example.com',
  name: 'Test',
  baseCurrency: 'VND',
  locale: 'vi',
  theme: 'light',
  timezone: 'Asia/Ho_Chi_Minh',
}

/** What the form submits: `date` is the plain `yyyy-MM-ddTHH:mm` the user entered. */
const validInput = {
  accountId: 'account_1',
  type: 'CASH_IN' as const,
  amount: 1000,
  date: '2026-02-01T09:15',
}

/** 09:15 on 2026-02-01 in Asia/Ho_Chi_Minh (UTC+7). */
const EXPECTED_INSTANT = new Date('2026-02-01T02:15:00.000Z')

/** What the service must receive: the same fields, with `date` as that instant. */
const expectedServiceInput = {
  accountId: 'account_1',
  type: 'CASH_IN' as const,
  amount: 1000,
  date: EXPECTED_INSTANT,
}

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  requireUserMock.mockReset()
  createTransactionMock.mockReset()
  updateTransactionMock.mockReset()
  deleteTransactionMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createTransactionAction', () => {
  it('calls the service with the session user id and the input only — no provider override', async () => {
    createTransactionMock.mockResolvedValue(undefined)

    const result = await createTransactionAction(validInput)

    expect(result).toEqual({ ok: true })
    expect(createTransactionMock).toHaveBeenCalledTimes(1)
    expect(createTransactionMock).toHaveBeenCalledWith(FIXED_USER.id, expectedServiceInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/transactions')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it("resolves the submitted local date and time in the user's timezone", async () => {
    createTransactionMock.mockResolvedValue(undefined)

    await createTransactionAction(validInput)

    const [, serviceInput] = createTransactionMock.mock.calls[0]
    expect(serviceInput.date).toBeInstanceOf(Date)
    // Not 09:15 UTC — that instant is 16:15 in Ho Chi Minh City, and for a zone
    // behind UTC the equivalent mistake can land the row on another day.
    expect(serviceInput.date.toISOString()).toBe('2026-02-01T02:15:00.000Z')
  })

  it('preserves the time of day: a later entry on the same local day is a later instant', async () => {
    createTransactionMock.mockResolvedValue(undefined)

    await createTransactionAction({ ...validInput, date: '2026-02-01T18:45' })

    const [, serviceInput] = createTransactionMock.mock.calls[0]
    expect(serviceInput.date.toISOString()).toBe('2026-02-01T11:45:00.000Z')
  })

  it('resolves the same local date and time differently for a user west of UTC', async () => {
    requireUserMock.mockResolvedValue({ ...FIXED_USER, timezone: 'America/New_York' })
    createTransactionMock.mockResolvedValue(undefined)

    await createTransactionAction(validInput)

    const [, serviceInput] = createTransactionMock.mock.calls[0]
    // 09:15 on 2026-02-01 in New York is EST (UTC-5).
    expect(serviceInput.date.toISOString()).toBe('2026-02-01T14:15:00.000Z')
  })

  it('maps a malformed date-time to INVALID_INPUT and never calls the service', async () => {
    const result = await createTransactionAction({ ...validInput, date: '01/02/2026 09:15' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createTransactionMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps a date with no time to INVALID_INPUT — a transaction carries both', async () => {
    const result = await createTransactionAction({ ...validInput, date: '2026-02-01' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createTransactionMock).not.toHaveBeenCalled()
  })

  /**
   * The Transactions page now hides the form entirely when the user has no
   * active account, but the server stays the authority: these two cases are
   * requests the UI can no longer produce, and they must still be refused here,
   * before the service, with a code the form renders as a fixed message — never
   * as an `Error#message` or a Zod string.
   */
  it('maps an empty accountId to INVALID_INPUT and never calls the service', async () => {
    const result = await createTransactionAction({ ...validInput, accountId: '' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createTransactionMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps a missing accountId to INVALID_INPUT and never calls the service', async () => {
    const crafted: Record<string, unknown> = { ...validInput }
    delete crafted.accountId
    // The cast is the point: `CreateTransactionFormInput` requires `accountId`,
    // so only a crafted (non-TypeScript) caller can send this — and it is
    // exactly such a caller the server has to refuse.
    const result = await createTransactionAction(crafted as unknown as CreateTransactionFormInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createTransactionMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps FxUnavailableError to FX_UNAVAILABLE and does not revalidate', async () => {
    createTransactionMock.mockRejectedValue(new MockFxUnavailableError())

    const result = await createTransactionAction(validInput)

    expect(result).toEqual({ ok: false, error: 'FX_UNAVAILABLE' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps ArchivedAccountError to ARCHIVED_ACCOUNT', async () => {
    createTransactionMock.mockRejectedValue(new MockArchivedAccountError())

    const result = await createTransactionAction(validInput)

    expect(result).toEqual({ ok: false, error: 'ARCHIVED_ACCOUNT' })
  })

  it('maps InvalidCategoryError to INVALID_CATEGORY', async () => {
    createTransactionMock.mockRejectedValue(
      new MockInvalidCategoryError('EXPENSE requires a category'),
    )

    const result = await createTransactionAction(validInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_CATEGORY' })
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    const zodError = new ZodError([])
    createTransactionMock.mockRejectedValue(zodError)

    const result = await createTransactionAction(validInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createTransactionMock.mockRejectedValue(notFoundError())

    const result = await createTransactionAction(validInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error', async () => {
    createTransactionMock.mockRejectedValue(new Error('boom'))

    await expect(createTransactionAction(validInput)).rejects.toThrow('boom')
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createTransactionAction(validInput)).rejects.toThrow('Not authenticated')
    expect(createTransactionMock).not.toHaveBeenCalled()
  })
})

describe('createTransactionAction — saved from a reminder’s Paid', () => {
  it('passes the occurrence id through, and revalidates the reminder pages too', async () => {
    createTransactionMock.mockResolvedValue(undefined)

    const result = await createTransactionAction({ ...validInput, occurrenceId: 'occ_1' })

    expect(result).toEqual({ ok: true })
    expect(createTransactionMock).toHaveBeenCalledWith(FIXED_USER.id, {
      ...expectedServiceInput,
      occurrenceId: 'occ_1',
    })
    // The occurrence left the due list, and the dashboard widget shows it.
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual([
      '/transactions',
      '/accounts',
      '/reminders',
      '/dashboard',
    ])
  })

  it('revalidates only the ledger pages for an ordinary create', async () => {
    createTransactionMock.mockResolvedValue(undefined)

    await createTransactionAction(validInput)

    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual([
      '/transactions',
      '/accounts',
    ])
  })

  it('maps OccurrenceNotPendingError to OCCURRENCE_NOT_PENDING and does not revalidate', async () => {
    createTransactionMock.mockRejectedValue(new MockOccurrenceNotPendingError())

    const result = await createTransactionAction({ ...validInput, occurrenceId: 'occ_1' })

    expect(result).toEqual({ ok: false, error: 'OCCURRENCE_NOT_PENDING' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps an empty occurrence id to INVALID_INPUT and never calls the service', async () => {
    const result = await createTransactionAction({ ...validInput, occurrenceId: '' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createTransactionMock).not.toHaveBeenCalled()
  })
})

describe('deleteTransactionAction', () => {
  it('calls the service with the session user id and the transaction id only', async () => {
    deleteTransactionMock.mockResolvedValue(undefined)

    const result = await deleteTransactionAction('tx_1')

    expect(result).toEqual({ ok: true })
    expect(deleteTransactionMock).toHaveBeenCalledTimes(1)
    expect(deleteTransactionMock).toHaveBeenCalledWith(FIXED_USER.id, 'tx_1')
    expect(revalidatePathMock).toHaveBeenCalledWith('/transactions')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    deleteTransactionMock.mockRejectedValue(notFoundError())

    const result = await deleteTransactionAction('tx_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('maps ArchivedAccountError to ARCHIVED_ACCOUNT', async () => {
    deleteTransactionMock.mockRejectedValue(new MockArchivedAccountError())

    const result = await deleteTransactionAction('tx_1')

    expect(result).toEqual({ ok: false, error: 'ARCHIVED_ACCOUNT' })
  })

  it('maps ConcurrentModificationError to CONFLICT — a delete can lose the race too', async () => {
    deleteTransactionMock.mockRejectedValue(new MockConcurrentModificationError())

    const result = await deleteTransactionAction('tx_1')

    expect(result).toEqual({ ok: false, error: 'CONFLICT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    deleteTransactionMock.mockRejectedValue(new Error('boom'))

    await expect(deleteTransactionAction('tx_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})

describe('updateTransactionAction', () => {
  it("calls the service with the session user id, the row id and the input in the user's zone — no provider override", async () => {
    updateTransactionMock.mockResolvedValue(undefined)

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: true })
    expect(updateTransactionMock).toHaveBeenCalledTimes(1)
    expect(updateTransactionMock).toHaveBeenCalledWith(FIXED_USER.id, 'tx_1', expectedServiceInput)
  })

  it('revalidates the ledger, the account balances and the dashboard', async () => {
    updateTransactionMock.mockResolvedValue(undefined)

    await updateTransactionAction('tx_1', validInput)

    expect(revalidatePathMock).toHaveBeenCalledWith('/transactions')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('maps a malformed date-time to INVALID_INPUT and never calls the service', async () => {
    const result = await updateTransactionAction('tx_1', { ...validInput, date: '2026-02-01' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(updateTransactionMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps LinkedTransactionError to LINKED_TRANSACTION and does not revalidate', async () => {
    updateTransactionMock.mockRejectedValue(new MockLinkedTransactionError())

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: false, error: 'LINKED_TRANSACTION' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it.each([
    ['FxUnavailableError', 'FX_UNAVAILABLE', () => new MockFxUnavailableError()],
    ['ArchivedAccountError', 'ARCHIVED_ACCOUNT', () => new MockArchivedAccountError()],
    ['CurrencyMismatchError', 'CURRENCY_MISMATCH', () => new MockCurrencyMismatchError()],
    ['InvalidCategoryError', 'INVALID_CATEGORY', () => new MockInvalidCategoryError('archived')],
    ['ConcurrentModificationError', 'CONFLICT', () => new MockConcurrentModificationError()],
    ["Prisma's P2025", 'NOT_FOUND', notFoundError],
  ] as const)('maps %s to %s', async (_label, code, makeError) => {
    updateTransactionMock.mockRejectedValue(makeError())

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: false, error: code })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    updateTransactionMock.mockRejectedValue(new Error('boom'))

    await expect(updateTransactionAction('tx_1', validInput)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(updateTransactionAction('tx_1', validInput)).rejects.toThrow('Not authenticated')
    expect(updateTransactionMock).not.toHaveBeenCalled()
  })
})

describe('deleteTransactionAction — linked transactions', () => {
  it('maps LinkedTransactionError to LINKED_TRANSACTION and does not revalidate', async () => {
    deleteTransactionMock.mockRejectedValue(new MockLinkedTransactionError())

    const result = await deleteTransactionAction('tx_1')

    expect(result).toEqual({ ok: false, error: 'LINKED_TRANSACTION' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})

describe('TRANSACTION_ERROR_KEYS', () => {
  it('has a message key for every code an action can return', () => {
    expect(TRANSACTION_ERROR_KEYS).toEqual({
      FX_UNAVAILABLE: 'errors.transaction.FX_UNAVAILABLE',
      ARCHIVED_ACCOUNT: 'errors.transaction.ARCHIVED_ACCOUNT',
      CURRENCY_MISMATCH: 'errors.transaction.CURRENCY_MISMATCH',
      INVALID_CATEGORY: 'errors.transaction.INVALID_CATEGORY',
      CONFLICT: 'errors.transaction.CONFLICT',
      LINKED_TRANSACTION: 'errors.transaction.LINKED_TRANSACTION',
      OCCURRENCE_NOT_PENDING: 'errors.transaction.OCCURRENCE_NOT_PENDING',
      INVALID_INPUT: 'errors.transaction.INVALID_INPUT',
      NOT_FOUND: 'errors.transaction.NOT_FOUND',
    })
  })

  it.each(['vi', 'en'] as const)(
    'resolves every key to real %s copy, and LINKED_TRANSACTION sends the user to the debt or loan',
    async (locale) => {
      const messages = await loadMessages(locale)
      const at = (key: string) =>
        key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages)
      for (const key of Object.values(TRANSACTION_ERROR_KEYS)) {
        expect(typeof at(key), key).toBe('string')
      }
      expect(at(TRANSACTION_ERROR_KEYS.LINKED_TRANSACTION)).toMatch(
        locale === 'vi' ? /khoản nợ.*khoản vay/ : /debt or loan/,
      )
    },
  )
})
