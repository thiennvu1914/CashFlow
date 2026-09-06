import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `budget-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * `@/lib/auth/require-user` and `@/lib/server/services/budget` are mocked so
 * this test needs neither Postgres nor a session. `next/cache`'s real
 * `revalidatePath` throws outside a Next.js request/work store, so it is
 * mocked too.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createBudgetMock = vi.hoisted(() => vi.fn())
const updateBudgetMock = vi.hoisted(() => vi.fn())
const deleteBudgetMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

class MockDuplicateBudgetError extends Error {
  constructor() {
    super('A budget for this month already exists.')
    this.name = 'DuplicateBudgetError'
  }
}

class MockInvalidBudgetCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid budget category: ${reason}`)
    this.name = 'InvalidBudgetCategoryError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/budget', () => ({
  createBudget: createBudgetMock,
  updateBudget: updateBudgetMock,
  deleteBudget: deleteBudgetMock,
  DuplicateBudgetError: MockDuplicateBudgetError,
  InvalidBudgetCategoryError: MockInvalidBudgetCategoryError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const { createBudgetAction, updateBudgetAction, deleteBudgetAction } =
  await import('./budget-actions')
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

const validCreateInput = {
  year: 2026,
  month: 3,
  scope: 'OVERALL' as const,
  amount: 1000,
  currency: 'VND' as const,
}

const validUpdateInput = {
  amount: 2000,
  currency: 'VND' as const,
}

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  requireUserMock.mockReset()
  createBudgetMock.mockReset()
  updateBudgetMock.mockReset()
  deleteBudgetMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createBudgetAction', () => {
  it('calls the service with the session user id and the input only, then revalidates', async () => {
    createBudgetMock.mockResolvedValue(undefined)

    const result = await createBudgetAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createBudgetMock).toHaveBeenCalledTimes(1)
    expect(createBudgetMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/budgets')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('maps DuplicateBudgetError to DUPLICATE_BUDGET and does not revalidate', async () => {
    createBudgetMock.mockRejectedValue(new MockDuplicateBudgetError())

    const result = await createBudgetAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'DUPLICATE_BUDGET' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps InvalidBudgetCategoryError to INVALID_CATEGORY', async () => {
    createBudgetMock.mockRejectedValue(new MockInvalidBudgetCategoryError('category is archived'))

    const result = await createBudgetAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_CATEGORY' })
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    createBudgetMock.mockRejectedValue(new ZodError([]))

    const result = await createBudgetAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createBudgetMock.mockRejectedValue(notFoundError())

    const result = await createBudgetAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    createBudgetMock.mockRejectedValue(new Error('boom'))

    await expect(createBudgetAction(validCreateInput)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createBudgetAction(validCreateInput)).rejects.toThrow('Not authenticated')
    expect(createBudgetMock).not.toHaveBeenCalled()
  })
})

describe('updateBudgetAction', () => {
  it('calls the service with the session user id, the budget id and the input only, then revalidates', async () => {
    updateBudgetMock.mockResolvedValue(undefined)

    const result = await updateBudgetAction('budget_1', validUpdateInput)

    expect(result).toEqual({ ok: true })
    expect(updateBudgetMock).toHaveBeenCalledTimes(1)
    expect(updateBudgetMock).toHaveBeenCalledWith(FIXED_USER.id, 'budget_1', validUpdateInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/budgets')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('maps DuplicateBudgetError to DUPLICATE_BUDGET', async () => {
    updateBudgetMock.mockRejectedValue(new MockDuplicateBudgetError())

    const result = await updateBudgetAction('budget_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'DUPLICATE_BUDGET' })
  })

  it('maps InvalidBudgetCategoryError to INVALID_CATEGORY', async () => {
    updateBudgetMock.mockRejectedValue(new MockInvalidBudgetCategoryError('bad category'))

    const result = await updateBudgetAction('budget_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_CATEGORY' })
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    updateBudgetMock.mockRejectedValue(new ZodError([]))

    const result = await updateBudgetAction('budget_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    updateBudgetMock.mockRejectedValue(notFoundError())

    const result = await updateBudgetAction('budget_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    updateBudgetMock.mockRejectedValue(new Error('boom'))

    await expect(updateBudgetAction('budget_1', validUpdateInput)).rejects.toThrow('boom')
  })
})

describe('deleteBudgetAction', () => {
  it('calls the service with the session user id and the budget id only, then revalidates', async () => {
    deleteBudgetMock.mockResolvedValue(undefined)

    const result = await deleteBudgetAction('budget_1')

    expect(result).toEqual({ ok: true })
    expect(deleteBudgetMock).toHaveBeenCalledTimes(1)
    expect(deleteBudgetMock).toHaveBeenCalledWith(FIXED_USER.id, 'budget_1')
    expect(revalidatePathMock).toHaveBeenCalledWith('/budgets')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    deleteBudgetMock.mockRejectedValue(notFoundError())

    const result = await deleteBudgetAction('budget_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    deleteBudgetMock.mockRejectedValue(new Error('boom'))

    await expect(deleteBudgetAction('budget_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})
