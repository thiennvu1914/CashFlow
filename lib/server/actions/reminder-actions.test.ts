import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `reminder-actions.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module.
 *
 * `@/lib/auth/require-user` and `@/lib/server/services/reminder` are mocked so
 * this test needs neither Postgres nor a session — the same arrangement as
 * `loan-actions.test.ts`. `next/cache`'s real `revalidatePath` throws outside a
 * Next.js request/work store, so it is mocked too. The validation module is
 * deliberately NOT mocked: the actions parse with the real schema, and "an
 * invalid input never reaches the service" is exactly what the Zod cases below
 * prove.
 *
 * What is under test is only this layer's job: that `userId` and the *timezone*
 * both come from the session and never from the caller, that each domain
 * failure becomes its own code, that an unmapped error still escapes, and that
 * a *failed* write revalidates nothing.
 *
 * The timezone is this file's own concern, and the one thing no other action
 * layer has to thread: `startDate` becomes an instant of LOCAL midnight in the
 * user's zone, so a create that reached the service without it — or with the
 * server's — would store a reminder that starts on a day the user never picked.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const createReminderMock = vi.hoisted(() => vi.fn())
const setReminderActiveMock = vi.hoisted(() => vi.fn())
const acknowledgeOccurrenceMock = vi.hoisted(() => vi.fn())
const dismissOccurrenceMock = vi.hoisted(() => vi.fn())
const revalidatePathMock = vi.hoisted(() => vi.fn())

/**
 * Stand-ins for the service's two domain errors — mirrors of the real classes
 * rather than the classes themselves, because the service module is mocked
 * away and importing the real ones would drag Prisma's client into this test
 * for nothing.
 */
class MockInvalidReminderCategoryError extends Error {
  constructor(reason = 'category not found') {
    super(`Invalid reminder category: ${reason}`)
    this.name = 'InvalidReminderCategoryError'
  }
}

class MockInvalidReminderAccountError extends Error {
  constructor(reason = 'account not found') {
    super(`Invalid reminder account: ${reason}`)
    this.name = 'InvalidReminderAccountError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
}))

vi.mock('@/lib/server/services/reminder', () => ({
  createReminder: createReminderMock,
  setReminderActive: setReminderActiveMock,
  acknowledgeOccurrence: acknowledgeOccurrenceMock,
  dismissOccurrence: dismissOccurrenceMock,
  InvalidReminderCategoryError: MockInvalidReminderCategoryError,
  InvalidReminderAccountError: MockInvalidReminderAccountError,
}))

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

const {
  createReminderAction,
  setReminderActiveAction,
  acknowledgeOccurrenceAction,
  dismissOccurrenceAction,
} = await import('./reminder-actions')
const { REMINDER_ERROR_KEYS } = await import('@/lib/ui/action-error-messages')
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

/** Every optional field the schema accepts is populated, so the schema's output
 *  is deep-equal to the input and the `toHaveBeenCalledWith` assertions below
 *  can name it directly. */
const validCreateInput = {
  title: 'Internet bill',
  type: 'EXPENSE' as const,
  expectedAmount: 350_000,
  currency: 'VND' as const,
  categoryId: 'cat_1',
  accountId: 'acc_1',
  frequency: 'MONTHLY' as const,
  interval: 1,
  dayOfMonth: 15,
  startDate: '2026-04-15',
  note: 'Autopay is off',
}

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError('Not found', {
    code: 'P2025',
    clientVersion: '7.10.0',
  })
}

beforeEach(() => {
  requireUserMock.mockReset()
  createReminderMock.mockReset()
  setReminderActiveMock.mockReset()
  acknowledgeOccurrenceMock.mockReset()
  dismissOccurrenceMock.mockReset()
  revalidatePathMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
})

describe('createReminderAction', () => {
  it("calls the service with the session user id, the user's timezone and the parsed input, then revalidates", async () => {
    createReminderMock.mockResolvedValue(undefined)

    const result = await createReminderAction(validCreateInput)

    expect(result).toEqual({ ok: true })
    expect(createReminderMock).toHaveBeenCalledTimes(1)
    expect(createReminderMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'Asia/Ho_Chi_Minh',
      validCreateInput,
    )
    expect(revalidatePathMock).toHaveBeenCalledWith('/reminders')
    expect(revalidatePathMock).toHaveBeenCalledWith('/dashboard')
  })

  it('resolves the timezone through the profile, so a bad stored value cannot reach the service', async () => {
    createReminderMock.mockResolvedValue(undefined)
    requireUserMock.mockResolvedValue({ ...FIXED_USER, timezone: 'Mars/Olympus_Mons' })

    await createReminderAction(validCreateInput)

    // `resolveProfileDefaults` falls back to CashFlow's default rather than
    // handing `date-fns-tz` a zone it will throw a `RangeError` on — which
    // would escape as an unmapped error from a page the user can reach.
    expect(createReminderMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'Asia/Ho_Chi_Minh',
      validCreateInput,
    )
  })

  it('never takes the timezone from the caller', async () => {
    createReminderMock.mockResolvedValue(undefined)

    await createReminderAction({ ...validCreateInput, timezone: 'UTC' } as never)

    // A start date is an instant of local midnight, so a client-chosen zone
    // would move the day the reminder starts on. Zod strips the unknown key and
    // the session's zone is the only one that reaches the service.
    expect(createReminderMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'Asia/Ho_Chi_Minh',
      validCreateInput,
    )
  })

  it('revalidates only the two pages a reminder appears on — no ledger page', async () => {
    createReminderMock.mockResolvedValue(undefined)

    await createReminderAction(validCreateInput)

    // A reminder is not a Transaction: nothing here writes a Transaction, a
    // Transfer or an account, so `/accounts` and `/transactions` have nothing
    // to re-render and revalidating them would claim otherwise.
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual([
      '/reminders',
      '/dashboard',
    ])
  })

  it('passes the id from the session, never a userId the caller smuggled in', async () => {
    createReminderMock.mockResolvedValue(undefined)

    await createReminderAction({ ...validCreateInput, userId: 'user_2' } as never)

    expect(createReminderMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'Asia/Ho_Chi_Minh',
      validCreateInput,
    )
  })

  it('strips a client-supplied active flag rather than obeying it', async () => {
    createReminderMock.mockResolvedValue(undefined)

    await createReminderAction({ ...validCreateInput, active: false } as never)

    // A new reminder is created active and only `setReminderActive` changes
    // that; `active` is in no schema at all, so a crafted request cannot create
    // a pre-paused reminder.
    expect(createReminderMock).toHaveBeenCalledWith(
      FIXED_USER.id,
      'Asia/Ho_Chi_Minh',
      validCreateInput,
    )
  })

  it('maps InvalidReminderCategoryError to INVALID_CATEGORY and does not revalidate', async () => {
    createReminderMock.mockRejectedValue(new MockInvalidReminderCategoryError('type mismatch'))

    const result = await createReminderAction(validCreateInput)

    // One code for all of "no such category", "not your category", "wrong type"
    // and "archived": the class is what the action maps, never the reason,
    // which would otherwise become an oracle for which category ids exist.
    expect(result).toEqual({ ok: false, error: 'INVALID_CATEGORY' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps InvalidReminderAccountError to INVALID_ACCOUNT and does not revalidate', async () => {
    createReminderMock.mockRejectedValue(new MockInvalidReminderAccountError('account archived'))

    const result = await createReminderAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_ACCOUNT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('maps an invalid input to INVALID_INPUT without ever calling the service', async () => {
    const result = await createReminderAction({ ...validCreateInput, title: '' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    // The action parses first, so a rejected input costs no database work.
    expect(createReminderMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('refuses a month on a MONTHLY reminder at the schema (ruling R6-18)', async () => {
    const result = await createReminderAction({
      ...validCreateInput,
      frequency: 'MONTHLY',
      month: 4,
    })

    // A monthly reminder recurs in every month, so it has no anchor month to
    // name — and the service would normalise it to NULL, silently accepting a
    // value nothing acts on. Refused before the write.
    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createReminderMock).not.toHaveBeenCalled()
  })

  it('refuses an interval above 1 on a ONE_TIME reminder at the schema', async () => {
    const result = await createReminderAction({
      ...validCreateInput,
      frequency: 'ONE_TIME',
      interval: 3,
      dayOfMonth: undefined,
    })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createReminderMock).not.toHaveBeenCalled()
  })

  it('maps an unreal calendar date to INVALID_INPUT rather than letting a RangeError escape', async () => {
    // `2026-02-30` has the right shape and no such day. The service would turn
    // it into a carrier with `calendarDateToUtcCarrier`, which raises a bare
    // `RangeError` — an unmapped error, and so a rethrow — unless the action
    // parses first.
    const result = await createReminderAction({ ...validCreateInput, startDate: '2026-02-30' })

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(createReminderMock).not.toHaveBeenCalled()
  })

  it('maps a ZodError raised by the service to INVALID_INPUT and does not revalidate', async () => {
    createReminderMock.mockRejectedValue(new ZodError([]))

    const result = await createReminderAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND", async () => {
    createReminderMock.mockRejectedValue(notFoundError())

    const result = await createReminderAction(validCreateInput)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    createReminderMock.mockRejectedValue(new Error('boom'))

    await expect(createReminderAction(validCreateInput)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(createReminderAction(validCreateInput)).rejects.toThrow('Not authenticated')
    expect(createReminderMock).not.toHaveBeenCalled()
  })
})

describe('setReminderActiveAction', () => {
  it('pauses a reminder with the session user id and the id only, then revalidates', async () => {
    setReminderActiveMock.mockResolvedValue(undefined)

    const result = await setReminderActiveAction('rem_1', false)

    expect(result).toEqual({ ok: true })
    expect(setReminderActiveMock).toHaveBeenCalledTimes(1)
    expect(setReminderActiveMock).toHaveBeenCalledWith(FIXED_USER.id, 'rem_1', false)
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual([
      '/reminders',
      '/dashboard',
    ])
  })

  it('resumes a reminder with the same call shape', async () => {
    setReminderActiveMock.mockResolvedValue(undefined)

    const result = await setReminderActiveAction('rem_1', true)

    expect(result).toEqual({ ok: true })
    expect(setReminderActiveMock).toHaveBeenCalledWith(FIXED_USER.id, 'rem_1', true)
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    // Another user's reminder id resolves to nothing through the composite
    // `userId_id` key, so a cross-tenant attempt reads as "no longer exists".
    setReminderActiveMock.mockRejectedValue(notFoundError())

    const result = await setReminderActiveAction('rem_1', false)

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    setReminderActiveMock.mockRejectedValue(new Error('boom'))

    await expect(setReminderActiveAction('rem_1', false)).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(setReminderActiveAction('rem_1', false)).rejects.toThrow('Not authenticated')
    expect(setReminderActiveMock).not.toHaveBeenCalled()
  })
})

describe('acknowledgeOccurrenceAction', () => {
  it('calls the service with the session user id and the occurrence id only, then revalidates', async () => {
    acknowledgeOccurrenceMock.mockResolvedValue(undefined)

    const result = await acknowledgeOccurrenceAction('occ_1')

    expect(result).toEqual({ ok: true })
    expect(acknowledgeOccurrenceMock).toHaveBeenCalledTimes(1)
    // No `now` argument: `actionedAt` is when the *server* recorded the answer,
    // and a client-supplied clock would let a stale tab backdate it.
    expect(acknowledgeOccurrenceMock).toHaveBeenCalledWith(FIXED_USER.id, 'occ_1')
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual([
      '/reminders',
      '/dashboard',
    ])
  })

  it('reports ok for an already-answered occurrence, because the service is idempotent', async () => {
    // A double-clicked button or a stale tab produces the same request as the
    // one that succeeded; the service returns the row untouched, so this layer
    // has nothing to report as a failure.
    acknowledgeOccurrenceMock.mockResolvedValue(undefined)

    await expect(acknowledgeOccurrenceAction('occ_1')).resolves.toEqual({ ok: true })
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    acknowledgeOccurrenceMock.mockRejectedValue(notFoundError())

    const result = await acknowledgeOccurrenceAction('occ_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    acknowledgeOccurrenceMock.mockRejectedValue(new Error('boom'))

    await expect(acknowledgeOccurrenceAction('occ_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(acknowledgeOccurrenceAction('occ_1')).rejects.toThrow('Not authenticated')
    expect(acknowledgeOccurrenceMock).not.toHaveBeenCalled()
  })
})

describe('dismissOccurrenceAction', () => {
  it('calls the service with the session user id and the occurrence id only, then revalidates', async () => {
    dismissOccurrenceMock.mockResolvedValue(undefined)

    const result = await dismissOccurrenceAction('occ_1')

    expect(result).toEqual({ ok: true })
    expect(dismissOccurrenceMock).toHaveBeenCalledTimes(1)
    expect(dismissOccurrenceMock).toHaveBeenCalledWith(FIXED_USER.id, 'occ_1')
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual([
      '/reminders',
      '/dashboard',
    ])
  })

  it('never touches acknowledge: the two answers mean different things', async () => {
    dismissOccurrenceMock.mockResolvedValue(undefined)

    await dismissOccurrenceAction('occ_1')

    // A history that conflated them would tell the user they paid something
    // they did not.
    expect(acknowledgeOccurrenceMock).not.toHaveBeenCalled()
  })

  it("maps Prisma's P2025 not-found error to NOT_FOUND, and does not revalidate", async () => {
    dismissOccurrenceMock.mockRejectedValue(notFoundError())

    const result = await dismissOccurrenceAction('occ_1')

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rethrows an unmapped error, and never revalidates', async () => {
    dismissOccurrenceMock.mockRejectedValue(new Error('boom'))

    await expect(dismissOccurrenceAction('occ_1')).rejects.toThrow('boom')
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects, and never calls the service', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('Not authenticated'))

    await expect(dismissOccurrenceAction('occ_1')).rejects.toThrow('Not authenticated')
    expect(dismissOccurrenceMock).not.toHaveBeenCalled()
  })
})

describe('REMINDER_ERROR_KEYS', () => {
  // The temporary English `REMINDER_ERROR_MESSAGES` alias this test used to
  // pin (Phase 7, Tasks 2–13) is gone (Task 13): every code's copy now lives
  // only in `messages/{vi,en}/errors.json`, and `lib/i18n/messages.test.ts`
  // already proves the two locales carry the same key set with no empty
  // value. What is still this layer's job to prove is narrower: every
  // `ReminderActionError` a component can receive maps to a key in the
  // `errors.reminder` namespace, typed as `Record<ReminderActionError,
  // string>` so a new code is a compile error until it has one.
  it('has a message key for every code an action can return', () => {
    expect(REMINDER_ERROR_KEYS).toEqual({
      INVALID_CATEGORY: 'errors.reminder.INVALID_CATEGORY',
      INVALID_ACCOUNT: 'errors.reminder.INVALID_ACCOUNT',
      INVALID_INPUT: 'errors.reminder.INVALID_INPUT',
      NOT_FOUND: 'errors.reminder.NOT_FOUND',
    })
  })
})
