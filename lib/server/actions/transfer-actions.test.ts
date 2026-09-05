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

/**
 * The session user carries a real IANA timezone: the action resolves the
 * submitted calendar day against it (ruling R-21b), so the zone is part of
 * what these tests pin down. `Asia/Ho_Chi_Minh` is UTC+7 year-round.
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

/** What the form submits: `date` is the plain `yyyy-MM-dd` the user picked. */
const validInput = {
  fromAccountId: 'account_1',
  toAccountId: 'account_2',
  fromAmount: 1000,
  toAmount: 1000,
  date: '2026-02-01',
}

/** What the service must receive: local midnight on that day in UTC+7. */
const expectedServiceInput = {
  fromAccountId: 'account_1',
  toAccountId: 'account_2',
  fromAmount: 1000,
  toAmount: 1000,
  date: new Date('2026-01-31T17:00:00.000Z'),
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
    expect(createTransferMock).toHaveBeenCalledWith(FIXED_USER.id, expectedServiceInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/transfers')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it("resolves the submitted calendar day to local midnight in the user's timezone", async () => {
    createTransferMock.mockResolvedValue(undefined)

    await createTransferAction(validInput)

    const [, serviceInput] = createTransferMock.mock.calls[0]
    expect(serviceInput.date).toBeInstanceOf(Date)
    expect(serviceInput.date.toISOString()).toBe('2026-01-31T17:00:00.000Z')
  })

  it('resolves the same calendar day differently for a user west of UTC', async () => {
    requireUserMock.mockResolvedValue({ ...FIXED_USER, timezone: 'America/New_York' })
    createTransferMock.mockResolvedValue(undefined)

    await createTransferAction(validInput)

    const [, serviceInput] = createTransferMock.mock.calls[0]
    expect(serviceInput.date.toISOString()).toBe('2026-02-01T05:00:00.000Z')
  })

  it('maps a malformed calendar date to INVALID_INPUT and never calls the service', async () => {
    const result = await createTransferAction({ ...validInput, date: '2026-2-1' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createTransferMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
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
