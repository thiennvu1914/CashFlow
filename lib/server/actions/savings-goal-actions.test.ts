import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `savings-goal-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * `@/lib/auth/require-user` and `@/lib/server/services/savings-goal` are mocked
 * so this test needs neither Postgres nor a session — the same arrangement as
 * `budget-actions.test.ts`. `next/cache`'s real `revalidatePath` throws outside
 * a Next.js request/work store, so it is mocked too.
 *
 * What is under test is only this layer's job: that `userId` comes from the
 * session and never from the caller, that each domain failure becomes its own
 * code, that an unmapped error still escapes, and that a *failed* write
 * revalidates nothing.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createSavingsGoalMock = vi.hoisted(() => vi.fn())
const updateSavingsGoalMock = vi.hoisted(() => vi.fn())
const updateSavingsGoalProgressMock = vi.hoisted(() => vi.fn())
const archiveSavingsGoalMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

class MockSavingsGoalArchivedError extends Error {
  constructor() {
    super('This goal is archived and can no longer be changed.')
    this.name = 'SavingsGoalArchivedError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/savings-goal', () => ({
  createSavingsGoal: createSavingsGoalMock,
  updateSavingsGoal: updateSavingsGoalMock,
  updateSavingsGoalProgress: updateSavingsGoalProgressMock,
  archiveSavingsGoal: archiveSavingsGoalMock,
  SavingsGoalArchivedError: MockSavingsGoalArchivedError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const {
  createSavingsGoalAction,
  updateSavingsGoalAction,
  updateSavingsGoalProgressAction,
  archiveSavingsGoalAction,
} = await import('./savings-goal-actions')
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
  name: 'MacBook',
  targetAmount: 50000000,
  currency: 'VND' as const,
  deadline: '2026-12-31',
  note: 'For work',
}

const validUpdateInput = {
  name: 'MacBook Pro',
  targetAmount: 60000000,
  currency: 'VND' as const,
  deadline: undefined,
  note: undefined,
}

const validProgressInput = { currentProgress: 2000000 }

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  requireUserMock.mockReset()
  createSavingsGoalMock.mockReset()
  updateSavingsGoalMock.mockReset()
  updateSavingsGoalProgressMock.mockReset()
  archiveSavingsGoalMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createSavingsGoalAction', () => {
  it('calls the service with the session user id and the input only, then revalidates', async () => {
    createSavingsGoalMock.mockResolvedValue(undefined)

    const result = await createSavingsGoalAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createSavingsGoalMock).toHaveBeenCalledTimes(1)
    expect(createSavingsGoalMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/goals')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('revalidates only the two pages a goal appears on — no ledger page', async () => {
    createSavingsGoalMock.mockResolvedValue(undefined)

    await createSavingsGoalAction(validCreateInput)

    // A savings goal moves no money, so `/accounts` and `/transactions` have
    // nothing to re-render; revalidating them would claim otherwise.
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/goals', '/dashboard'])
  })

  it('maps a ZodError to INVALID_INPUT and does not revalidate', async () => {
    createSavingsGoalMock.mockRejectedValue(new ZodError([]))

    const result = await createSavingsGoalAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createSavingsGoalMock.mockRejectedValue(notFoundError())

    const result = await createSavingsGoalAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    createSavingsGoalMock.mockRejectedValue(new Error('boom'))

    await expect(createSavingsGoalAction(validCreateInput)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createSavingsGoalAction(validCreateInput)).rejects.toThrow('Not authenticated')
    expect(createSavingsGoalMock).not.toHaveBeenCalled()
  })
})

describe('updateSavingsGoalAction', () => {
  it('calls the service with the session user id, the goal id and the input only, then revalidates', async () => {
    updateSavingsGoalMock.mockResolvedValue(undefined)

    const result = await updateSavingsGoalAction('goal_1', validUpdateInput)

    expect(result).toEqual({ ok: true })
    expect(updateSavingsGoalMock).toHaveBeenCalledTimes(1)
    expect(updateSavingsGoalMock).toHaveBeenCalledWith(FIXED_USER.id, 'goal_1', validUpdateInput)
    expect(revalidatePathMock).toHaveBeenCalledWith('/goals')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('maps SavingsGoalArchivedError to ARCHIVED and does not revalidate', async () => {
    updateSavingsGoalMock.mockRejectedValue(new MockSavingsGoalArchivedError())

    const result = await updateSavingsGoalAction('goal_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'ARCHIVED' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    updateSavingsGoalMock.mockRejectedValue(new ZodError([]))

    const result = await updateSavingsGoalAction('goal_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    updateSavingsGoalMock.mockRejectedValue(notFoundError())

    const result = await updateSavingsGoalAction('goal_1', validUpdateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    updateSavingsGoalMock.mockRejectedValue(new Error('boom'))

    await expect(updateSavingsGoalAction('goal_1', validUpdateInput)).rejects.toThrow('boom')
  })
})

describe('updateSavingsGoalProgressAction', () => {
  it('calls the service with the session user id, the goal id and the input only, then revalidates', async () => {
    updateSavingsGoalProgressMock.mockResolvedValue(undefined)

    const result = await updateSavingsGoalProgressAction('goal_1', validProgressInput)

    expect(result).toEqual({ ok: true })
    expect(updateSavingsGoalProgressMock).toHaveBeenCalledTimes(1)
    expect(updateSavingsGoalProgressMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'goal_1',
      validProgressInput,
    )
    expect(revalidatePathMock).toHaveBeenCalledWith('/goals')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('maps SavingsGoalArchivedError to ARCHIVED', async () => {
    updateSavingsGoalProgressMock.mockRejectedValue(new MockSavingsGoalArchivedError())

    const result = await updateSavingsGoalProgressAction('goal_1', validProgressInput)

    expect(result).toEqual({ ok: false, error: 'ARCHIVED' })
  })

  it('maps a ZodError to INVALID_INPUT', async () => {
    updateSavingsGoalProgressMock.mockRejectedValue(new ZodError([]))

    const result = await updateSavingsGoalProgressAction('goal_1', validProgressInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    updateSavingsGoalProgressMock.mockRejectedValue(notFoundError())

    const result = await updateSavingsGoalProgressAction('goal_1', validProgressInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    updateSavingsGoalProgressMock.mockRejectedValue(new Error('boom'))

    await expect(updateSavingsGoalProgressAction('goal_1', validProgressInput)).rejects.toThrow(
      'boom',
    )
  })
})

describe('archiveSavingsGoalAction', () => {
  it('calls the service with the session user id and the goal id only, then revalidates', async () => {
    archiveSavingsGoalMock.mockResolvedValue(undefined)

    const result = await archiveSavingsGoalAction('goal_1')

    expect(result).toEqual({ ok: true })
    expect(archiveSavingsGoalMock).toHaveBeenCalledTimes(1)
    expect(archiveSavingsGoalMock).toHaveBeenCalledWith(FIXED_USER.id, 'goal_1')
    expect(revalidatePathMock).toHaveBeenCalledWith('/goals')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    archiveSavingsGoalMock.mockRejectedValue(notFoundError())

    const result = await archiveSavingsGoalAction('goal_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    archiveSavingsGoalMock.mockRejectedValue(new Error('boom'))

    await expect(archiveSavingsGoalAction('goal_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})
