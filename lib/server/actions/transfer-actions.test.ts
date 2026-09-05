import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `transfer-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * Every module that would otherwise touch Postgres is mocked —
 * `@/lib/auth/require-user`, `@/lib/server/services/transfer` and
 * `@/lib/server/services/transaction` (for `ArchivedAccountError`) — so this
 * test needs no database. `next/cache`'s real `revalidatePath` throws outside
 * a Next.js request/work store, so it is mocked too.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createTransferMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

class MockArchivedAccountError extends Error {
  constructor() {
    super('This account is archived and cannot receive new activity.')
    this.name = 'ArchivedAccountError'
  }
}

class MockSameAccountTransferError extends Error {
  constructor() {
    super('Cannot transfer to the same account.')
    this.name = 'SameAccountTransferError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/transfer', () => ({
  createTransfer: createTransferMock,
  SameAccountTransferError: MockSameAccountTransferError,
}))

vi.mock('@/lib/server/services/transaction', () => ({
  ArchivedAccountError: MockArchivedAccountError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const { createTransferAction } = await import('./transfer-actions')
const { ZodError } = await import('zod')
const { Prisma } = await import('@prisma/client')

const FIXED_USER = { id: 'user_1', email: 'user@example.com' }

const validInput = {
  fromAccountId: 'account_1',
  toAccountId: 'account_2',
  fromAmount: 1000,
  toAmount: 1000,
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
  createTransferMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createTransferAction', () => {
  it('calls the service with the session user id and the input only', async () => {
    createTransferMock.mockResolvedValue(undefined)

    const result = await createTransferAction(validInput)

    expect(result).toEqual({ ok: true })
    expect(createTransferMock).toHaveBeenCalledTimes(1)
    expect(createTransferMock).toHaveBeenCalledWith(FIXED_USER.id, validInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/transfers')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it('maps ArchivedAccountError to ARCHIVED_ACCOUNT and does not revalidate', async () => {
    createTransferMock.mockRejectedValue(new MockArchivedAccountError())

    const result = await createTransferAction(validInput)

    expect(result).toEqual({ ok: false, error: 'ARCHIVED_ACCOUNT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps SameAccountTransferError to SAME_ACCOUNT', async () => {
    createTransferMock.mockRejectedValue(new MockSameAccountTransferError())

    const result = await createTransferAction(validInput)

    expect(result).toEqual({ ok: false, error: 'SAME_ACCOUNT' })
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    createTransferMock.mockRejectedValue(new ZodError([]))

    const result = await createTransferAction(validInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createTransferMock.mockRejectedValue(notFoundError())

    const result = await createTransferAction(validInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error', async () => {
    createTransferMock.mockRejectedValue(new Error('boom'))

    await expect(createTransferAction(validInput)).rejects.toThrow('boom')
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createTransferAction(validInput)).rejects.toThrow('Not authenticated')
    expect(createTransferMock).not.toHaveBeenCalled()
  })
})
