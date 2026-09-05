import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `financial-account-actions.ts` starts with `'use server'`; Vitest ignores
 * server-action directives entirely and imports it as a plain module.
 *
 * Every module that would otherwise touch Postgres is mocked —
 * `@/lib/auth/require-user`, `@/lib/server/services/financial-account` and
 * `@/lib/server/services/balance` (for `AccountNotFoundError`) — so this test
 * needs no database. `next/cache`'s real `revalidatePath` throws outside a
 * Next.js request/work store, so it is mocked too.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createFinancialAccountMock = vi.hoisted(() => vi.fn())
const updateFinancialAccountMock = vi.hoisted(() => vi.fn())
const archiveFinancialAccountMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

class MockAccountHasNonZeroBalanceError extends Error {
  constructor() {
    super(
      'This account must have a zero balance before it can be archived. Transfer or adjust the balance first.',
    )
    this.name = 'AccountHasNonZeroBalanceError'
  }
}

class MockAccountLockedError extends Error {
  constructor() {
    super('Currency and opening balance cannot be changed once the account has activity.')
    this.name = 'AccountLockedError'
  }
}

class MockInvalidAccountTypeError extends Error {
  constructor() {
    super('Account type does not belong to the user or is not active')
    this.name = 'InvalidAccountTypeError'
  }
}

class MockAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Financial account ${accountId} was not found for this user`)
    this.name = 'AccountNotFoundError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/financial-account', () => ({
  createFinancialAccount: createFinancialAccountMock,
  updateFinancialAccount: updateFinancialAccountMock,
  archiveFinancialAccount: archiveFinancialAccountMock,
  AccountHasNonZeroBalanceError: MockAccountHasNonZeroBalanceError,
  AccountLockedError: MockAccountLockedError,
  InvalidAccountTypeError: MockInvalidAccountTypeError,
}))

vi.mock('@/lib/server/services/balance', () => ({
  AccountNotFoundError: MockAccountNotFoundError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const {
  createFinancialAccountAction,
  updateFinancialAccountAction,
  archiveFinancialAccountAction,
} = await import('./financial-account-actions')
const { ZodError } = await import('zod')
const { Prisma } = await import('@prisma/client')

const FIXED_USER = { id: 'user_1', email: 'user@example.com' }

const validCreateInput = {
  name: 'Main Cash',
  accountTypeId: 'account_type_1',
  initialBalance: 100,
  currency: 'VND' as const,
}

const validUpdateInput = { name: 'Renamed' }

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  requireUserMock.mockReset()
  createFinancialAccountMock.mockReset()
  updateFinancialAccountMock.mockReset()
  archiveFinancialAccountMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createFinancialAccountAction', () => {
  it('calls the service with the session user id and the input only', async () => {
    createFinancialAccountMock.mockResolvedValue(undefined)

    const result = await createFinancialAccountAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createFinancialAccountMock).toHaveBeenCalledTimes(1)
    expect(createFinancialAccountMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it('maps InvalidAccountTypeError to INVALID_ACCOUNT_TYPE and does not revalidate', async () => {
    createFinancialAccountMock.mockRejectedValue(new MockInvalidAccountTypeError())

    const result = await createFinancialAccountAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_ACCOUNT_TYPE' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    createFinancialAccountMock.mockRejectedValue(new ZodError([]))

    const result = await createFinancialAccountAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createFinancialAccountMock.mockRejectedValue(notFoundError())

    const result = await createFinancialAccountAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('maps AccountNotFoundError to NOT_FOUND', async () => {
    createFinancialAccountMock.mockRejectedValue(new MockAccountNotFoundError('acc_1'))

    const result = await createFinancialAccountAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error', async () => {
    createFinancialAccountMock.mockRejectedValue(new Error('boom'))

    await expect(createFinancialAccountAction(validCreateInput)).rejects.toThrow('boom')
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createFinancialAccountAction(validCreateInput)).rejects.toThrow(
      'Not authenticated',
    )
    expect(createFinancialAccountMock).not.toHaveBeenCalled()
  })
})

describe('updateFinancialAccountAction', () => {
  it('calls the service with the session user id, the account id and the input only', async () => {
    updateFinancialAccountMock.mockResolvedValue(undefined)

    const result = await updateFinancialAccountAction('account_1', validUpdateInput)

    expect(result).toEqual({ ok: true })
    expect(updateFinancialAccountMock).toHaveBeenCalledTimes(1)
    expect(updateFinancialAccountMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'account_1',
      validUpdateInput,
    )
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it('maps AccountLockedError to ACCOUNT_LOCKED and does not revalidate', async () => {
    updateFinancialAccountMock.mockRejectedValue(new MockAccountLockedError())

    const result = await updateFinancialAccountAction('account_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'ACCOUNT_LOCKED' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps InvalidAccountTypeError to INVALID_ACCOUNT_TYPE', async () => {
    updateFinancialAccountMock.mockRejectedValue(new MockInvalidAccountTypeError())

    const result = await updateFinancialAccountAction('account_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_ACCOUNT_TYPE' })
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    updateFinancialAccountMock.mockRejectedValue(new ZodError([]))

    const result = await updateFinancialAccountAction('account_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    updateFinancialAccountMock.mockRejectedValue(notFoundError())

    const result = await updateFinancialAccountAction('account_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('maps AccountNotFoundError to NOT_FOUND', async () => {
    updateFinancialAccountMock.mockRejectedValue(new MockAccountNotFoundError('account_1'))

    const result = await updateFinancialAccountAction('account_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error', async () => {
    updateFinancialAccountMock.mockRejectedValue(new Error('boom'))

    await expect(updateFinancialAccountAction('account_1', validUpdateInput)).rejects.toThrow(
      'boom',
    )
  })
})

describe('archiveFinancialAccountAction', () => {
  it('calls the service with the session user id and the account id only', async () => {
    archiveFinancialAccountMock.mockResolvedValue(undefined)

    const result = await archiveFinancialAccountAction('account_1')

    expect(result).toEqual({ ok: true })
    expect(archiveFinancialAccountMock).toHaveBeenCalledTimes(1)
    expect(archiveFinancialAccountMock).toHaveBeenCalledWith(FIXED_USER.id, 'account_1')
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts')
  })

  it('maps AccountHasNonZeroBalanceError to NON_ZERO_BALANCE and does not revalidate', async () => {
    archiveFinancialAccountMock.mockRejectedValue(new MockAccountHasNonZeroBalanceError())

    const result = await archiveFinancialAccountAction('account_1')

    expect(result).toEqual({ ok: false, error: 'NON_ZERO_BALANCE' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps AccountNotFoundError to NOT_FOUND', async () => {
    archiveFinancialAccountMock.mockRejectedValue(new MockAccountNotFoundError('account_1'))

    const result = await archiveFinancialAccountAction('account_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    archiveFinancialAccountMock.mockRejectedValue(notFoundError())

    const result = await archiveFinancialAccountAction('account_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    archiveFinancialAccountMock.mockRejectedValue(new Error('boom'))

    await expect(archiveFinancialAccountAction('account_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(archiveFinancialAccountAction('account_1')).rejects.toThrow('Not authenticated')
    expect(archiveFinancialAccountMock).not.toHaveBeenCalled()
  })
})
