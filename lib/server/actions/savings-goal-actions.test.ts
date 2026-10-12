import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `savings-goal-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * `@/lib/auth/require-user` and `@/lib/server/services/savings-goal` are mocked
 * so this test needs neither Postgres nor a session — the same arrangement as
 * `budget-actions.test.ts`. `next/cache`'s real `revalidatePath` throws outside
 * a Next.js request/work store, so it is mocked too. The validation module is
 * deliberately NOT mocked: the actions parse with the real schemas, and "an
 * invalid input never reaches the service" is what the Zod cases below prove.
 * `account-lock` imports no Prisma client, so its `ArchivedAccountError` is
 * used as is.
 *
 * What is under test is only this layer's job: that `userId` (and the
 * timezone an opening contribution is dated in) comes from the session and
 * never from the caller, that each domain failure becomes its own code, that
 * an unmapped error still escapes, and that a *failed* write revalidates
 * nothing.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createSavingsGoalMock = vi.hoisted(() => vi.fn())
const updateSavingsGoalMock = vi.hoisted(() => vi.fn())
const updateSavingsGoalProgressMock = vi.hoisted(() => vi.fn())
const archiveSavingsGoalMock = vi.hoisted(() => vi.fn())
const addSavingsGoalEntryMock = vi.hoisted(() => vi.fn())
const updateSavingsGoalEntryMock = vi.hoisted(() => vi.fn())
const deleteSavingsGoalEntryMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

/** Mirrors of the service's domain errors: the service module is mocked away,
 *  and importing the real classes would drag the Prisma client in for nothing. */
class MockSavingsGoalArchivedError extends Error {
  constructor() {
    super('This goal is archived and can no longer be changed.')
    this.name = 'SavingsGoalArchivedError'
  }
}

class MockSavingsGoalLinkedError extends Error {
  constructor() {
    super("This goal follows a linked account's balance and takes no entries.")
    this.name = 'SavingsGoalLinkedError'
  }
}

class MockSavingsGoalCurrencyLockedError extends Error {
  constructor() {
    super('This goal already has entries in its currency.')
    this.name = 'SavingsGoalCurrencyLockedError'
  }
}

class MockSavingsGoalWithdrawalExceedsProgressError extends Error {
  constructor() {
    super("That would take this goal's progress below zero.")
    this.name = 'SavingsGoalWithdrawalExceedsProgressError'
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
  addSavingsGoalEntry: addSavingsGoalEntryMock,
  updateSavingsGoalEntry: updateSavingsGoalEntryMock,
  deleteSavingsGoalEntry: deleteSavingsGoalEntryMock,
  SavingsGoalArchivedError: MockSavingsGoalArchivedError,
  SavingsGoalCurrencyLockedError: MockSavingsGoalCurrencyLockedError,
  SavingsGoalLinkedError: MockSavingsGoalLinkedError,
  SavingsGoalWithdrawalExceedsProgressError: MockSavingsGoalWithdrawalExceedsProgressError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const {
  addSavingsGoalEntryAction,
  archiveSavingsGoalAction,
  createSavingsGoalAction,
  deleteSavingsGoalEntryAction,
  updateSavingsGoalAction,
  updateSavingsGoalEntryAction,
  updateSavingsGoalProgressAction,
} = await import('./savings-goal-actions')
const { ZodError } = await import('zod')
const { Prisma } = await import('@prisma/client')
const { ArchivedAccountError } = await import('@/lib/server/services/account-lock')

const FIXED_USER = {
  id: 'user_1',
  email: 'user@example.com',
  name: 'Test',
  baseCurrency: 'VND',
  locale: 'vi',
  theme: 'light',
  timezone: 'Asia/Bangkok',
}

/** What every create and progress write receives as its session context. */
const CONTEXT = { timezone: 'Asia/Bangkok' }

const validCreateInput = {
  name: 'MacBook',
  targetAmount: 50000000,
  currency: 'VND' as const,
  deadline: '2026-12-31',
  note: 'For work',
  initialContribution: 1000000,
}

const validUpdateInput = {
  name: 'MacBook Pro',
  targetAmount: 60000000,
  currency: 'VND' as const,
  deadline: undefined,
  note: undefined,
  linkedAccountId: 'account_1',
}

const validEntryInput = {
  kind: 'WITHDRAWAL' as const,
  amount: 250000,
  date: '2026-03-01',
  note: 'Repairs',
}

const validProgressInput = { progress: 2000000 }

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

/** The two pages a goal appears on, and nothing else. */
function expectGoalPagesRevalidated() {
  expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual(['/goals', '/dashboard'])
}

describe('createSavingsGoalAction', () => {
  it('calls the service with the session user id, the parsed input and the session zone', async () => {
    createSavingsGoalMock.mockResolvedValue(undefined)

    const result = await createSavingsGoalAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createSavingsGoalMock).toHaveBeenCalledTimes(1)
    expect(createSavingsGoalMock).toHaveBeenCalledWith(FIXED_USER.id, validCreateInput, CONTEXT)
    // A savings goal moves no money, so `/accounts` and `/transactions` have
    // nothing to re-render; revalidating them would claim otherwise.
    expectGoalPagesRevalidated()
  })

  it('refuses an invalid input before the service, and does not revalidate', async () => {
    const result = await createSavingsGoalAction({ ...validCreateInput, targetAmount: 0 })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createSavingsGoalMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps a new link to an archived account to ARCHIVED_ACCOUNT', async () => {
    createSavingsGoalMock.mockRejectedValue(new ArchivedAccountError())

    const result = await createSavingsGoalAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'ARCHIVED_ACCOUNT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createSavingsGoalMock.mockRejectedValue(notFoundError())

    expect(await createSavingsGoalAction(validCreateInput)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    })
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
  it('calls the service with the session user id, the goal id and the parsed input, then revalidates', async () => {
    updateSavingsGoalMock.mockResolvedValue(undefined)

    const result = await updateSavingsGoalAction('goal_1', validUpdateInput)

    expect(result).toEqual({ ok: true })
    expect(updateSavingsGoalMock).toHaveBeenCalledWith(FIXED_USER.id, 'goal_1', validUpdateInput)
    expectGoalPagesRevalidated()
  })

  it.each([
    [new MockSavingsGoalArchivedError(), 'ARCHIVED'],
    [new ArchivedAccountError(), 'ARCHIVED_ACCOUNT'],
    [new MockSavingsGoalCurrencyLockedError(), 'CURRENCY_LOCKED'],
    [new ZodError([]), 'INVALID_INPUT'],
    [notFoundError(), 'NOT_FOUND'],
  ])('maps %o to its code and does not revalidate', async (error, code) => {
    updateSavingsGoalMock.mockRejectedValue(error)

    expect(await updateSavingsGoalAction('goal_1', validUpdateInput)).toEqual({
      ok: false,
      error: code,
    })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    updateSavingsGoalMock.mockRejectedValue(new Error('boom'))

    await expect(updateSavingsGoalAction('goal_1', validUpdateInput)).rejects.toThrow('boom')
  })
})

describe('entry actions', () => {
  it('add: calls the service with the session user id, the goal id and the parsed entry', async () => {
    addSavingsGoalEntryMock.mockResolvedValue(undefined)

    const result = await addSavingsGoalEntryAction('goal_1', validEntryInput)

    expect(result).toEqual({ ok: true })
    expect(addSavingsGoalEntryMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'goal_1',
      validEntryInput,
      CONTEXT,
    )
    expectGoalPagesRevalidated()
  })

  it('update: calls the service with the session user id, the entry id and the parsed entry', async () => {
    updateSavingsGoalEntryMock.mockResolvedValue(undefined)

    const result = await updateSavingsGoalEntryAction('entry_1', validEntryInput)

    expect(result).toEqual({ ok: true })
    expect(updateSavingsGoalEntryMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'entry_1',
      validEntryInput,
      CONTEXT,
    )
    expectGoalPagesRevalidated()
  })

  it('delete: calls the service with the session user id and the entry id only', async () => {
    deleteSavingsGoalEntryMock.mockResolvedValue(undefined)

    const result = await deleteSavingsGoalEntryAction('entry_1')

    expect(result).toEqual({ ok: true })
    expect(deleteSavingsGoalEntryMock).toHaveBeenCalledWith(FIXED_USER.id, 'entry_1')
    expectGoalPagesRevalidated()
  })

  it('refuses an invalid entry before the service is reached', async () => {
    // Tomorrow in the session user's zone (ruling P11: no future entries).
    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString().slice(0, 10)
    for (const input of [
      { ...validEntryInput, amount: 0 },
      { ...validEntryInput, date: '2026-02-30' },
      { ...validEntryInput, date: tomorrow },
      { ...validEntryInput, kind: 'GIFT' as 'CONTRIBUTION' },
    ]) {
      expect(await addSavingsGoalEntryAction('goal_1', input)).toEqual({
        ok: false,
        error: 'INVALID_INPUT',
      })
      expect(await updateSavingsGoalEntryAction('entry_1', input)).toEqual({
        ok: false,
        error: 'INVALID_INPUT',
      })
    }
    expect(addSavingsGoalEntryMock).not.toHaveBeenCalled()
    expect(updateSavingsGoalEntryMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it.each([
    [new MockSavingsGoalLinkedError(), 'LINKED'],
    [new MockSavingsGoalWithdrawalExceedsProgressError(), 'WITHDRAWAL_EXCEEDS_PROGRESS'],
    [new MockSavingsGoalArchivedError(), 'ARCHIVED'],
    [notFoundError(), 'NOT_FOUND'],
  ])('maps %o to its code on all three, and revalidates nothing', async (error, code) => {
    addSavingsGoalEntryMock.mockRejectedValue(error)
    updateSavingsGoalEntryMock.mockRejectedValue(error)
    deleteSavingsGoalEntryMock.mockRejectedValue(error)

    const failure = { ok: false, error: code }
    expect(await addSavingsGoalEntryAction('goal_1', validEntryInput)).toEqual(failure)
    expect(await updateSavingsGoalEntryAction('entry_1', validEntryInput)).toEqual(failure)
    expect(await deleteSavingsGoalEntryAction('entry_1')).toEqual(failure)
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error', async () => {
    deleteSavingsGoalEntryMock.mockRejectedValue(new Error('boom'))

    await expect(deleteSavingsGoalEntryAction('entry_1')).rejects.toThrow('boom')
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValue(new Error('Not authenticated'))

    await expect(addSavingsGoalEntryAction('goal_1', validEntryInput)).rejects.toThrow(
      'Not authenticated',
    )
    await expect(updateSavingsGoalEntryAction('entry_1', validEntryInput)).rejects.toThrow(
      'Not authenticated',
    )
    await expect(deleteSavingsGoalEntryAction('entry_1')).rejects.toThrow('Not authenticated')
    expect(addSavingsGoalEntryMock).not.toHaveBeenCalled()
    expect(updateSavingsGoalEntryMock).not.toHaveBeenCalled()
    expect(deleteSavingsGoalEntryMock).not.toHaveBeenCalled()
  })
})

describe('updateSavingsGoalProgressAction (transitional)', () => {
  it('passes the figure and the session zone to the service, then revalidates', async () => {
    updateSavingsGoalProgressMock.mockResolvedValue(null)

    const result = await updateSavingsGoalProgressAction('goal_1', validProgressInput)

    expect(result).toEqual({ ok: true })
    expect(updateSavingsGoalProgressMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'goal_1',
      validProgressInput,
      CONTEXT,
    )
    expectGoalPagesRevalidated()
  })

  it.each([
    [new MockSavingsGoalArchivedError(), 'ARCHIVED'],
    [new MockSavingsGoalLinkedError(), 'LINKED'],
    [notFoundError(), 'NOT_FOUND'],
  ])('maps %o to its code and does not revalidate', async (error, code) => {
    updateSavingsGoalProgressMock.mockRejectedValue(error)

    expect(await updateSavingsGoalProgressAction('goal_1', validProgressInput)).toEqual({
      ok: false,
      error: code,
    })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('refuses a negative figure before the service is reached', async () => {
    expect(await updateSavingsGoalProgressAction('goal_1', { progress: -1 })).toEqual({
      ok: false,
      error: 'INVALID_INPUT',
    })
    expect(updateSavingsGoalProgressMock).not.toHaveBeenCalled()
  })
})

describe('archiveSavingsGoalAction', () => {
  it('calls the service with the session user id and the goal id only, then revalidates', async () => {
    archiveSavingsGoalMock.mockResolvedValue(undefined)

    const result = await archiveSavingsGoalAction('goal_1')

    expect(result).toEqual({ ok: true })
    expect(archiveSavingsGoalMock).toHaveBeenCalledWith(FIXED_USER.id, 'goal_1')
    expectGoalPagesRevalidated()
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    archiveSavingsGoalMock.mockRejectedValue(notFoundError())

    expect(await archiveSavingsGoalAction('goal_1')).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    archiveSavingsGoalMock.mockRejectedValue(new Error('boom'))

    await expect(archiveSavingsGoalAction('goal_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})
