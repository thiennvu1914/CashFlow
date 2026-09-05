import { describe, it, expect, vi, beforeEach } from 'vitest'

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

class MockFxUnavailableError extends Error {
  constructor() {
    super('Unable to retrieve an exchange rate.')
    this.name = 'FxUnavailableError'
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
  InvalidCategoryError: MockInvalidCategoryError,
}))

vi.mock('@/lib/currency/current-rate-policy', () => ({
  isFxUnavailableError: (e: unknown) => e instanceof MockFxUnavailableError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const { createTransactionAction, updateTransactionAction, deleteTransactionAction } =
  await import('./transaction-actions')
const { ZodError } = await import('zod')
const { Prisma } = await import('@prisma/client')

const FIXED_USER = { id: 'user_1', email: 'user@example.com' }

const validInput = {
  accountId: 'account_1',
  type: 'CASH_IN' as const,
  amount: 1000,
  date: new Date('2026-02-01'),
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
    expect(createTransactionMock).toHaveBeenCalledWith(FIXED_USER.id, validInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/transactions')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
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

describe('updateTransactionAction', () => {
  it('calls the service with the session user id, the transaction id and the input only', async () => {
    updateTransactionMock.mockResolvedValue(undefined)

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: true })
    expect(updateTransactionMock).toHaveBeenCalledTimes(1)
    expect(updateTransactionMock).toHaveBeenCalledWith(FIXED_USER.id, 'tx_1', validInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/transactions')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it('maps FxUnavailableError to FX_UNAVAILABLE', async () => {
    updateTransactionMock.mockRejectedValue(new MockFxUnavailableError())

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: false, error: 'FX_UNAVAILABLE' })
  })

  it('maps ArchivedAccountError to ARCHIVED_ACCOUNT', async () => {
    updateTransactionMock.mockRejectedValue(new MockArchivedAccountError())

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: false, error: 'ARCHIVED_ACCOUNT' })
  })

  it('maps InvalidCategoryError to INVALID_CATEGORY', async () => {
    updateTransactionMock.mockRejectedValue(new MockInvalidCategoryError('bad category'))

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_CATEGORY' })
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    updateTransactionMock.mockRejectedValue(new ZodError([]))

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    updateTransactionMock.mockRejectedValue(notFoundError())

    const result = await updateTransactionAction('tx_1', validInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error', async () => {
    updateTransactionMock.mockRejectedValue(new Error('boom'))

    await expect(updateTransactionAction('tx_1', validInput)).rejects.toThrow('boom')
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

  it('rethrows an unmapped error, and never revalidates', async () => {
    deleteTransactionMock.mockRejectedValue(new Error('boom'))

    await expect(deleteTransactionAction('tx_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})
