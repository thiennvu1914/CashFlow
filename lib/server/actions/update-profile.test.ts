import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `update-profile.ts` starts with `'use server'`; Vitest ignores server-action
 * directives entirely and imports it as a plain module, so no special
 * handling is needed here.
 *
 * `@/lib/auth/require-user` and `@/lib/prisma` are mocked so this test needs
 * neither Postgres nor a real session — and never imports the real
 * `lib/prisma.ts` or `lib/auth/auth.ts`.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const updateMock = vi.hoisted(() => vi.fn())
const cookieSetMock = vi.hoisted(() => vi.fn())

class MockUnauthorizedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'UnauthorizedError'
  }
}

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: requireUserMock,
  UnauthorizedError: MockUnauthorizedError,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { update: updateMock } },
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSetMock }),
}))

const { updateProfile } = await import('./update-profile')

const FIXED_USER = { id: 'user_1', email: 'user@example.com' }

const validInput = {
  name: 'Pham Thi D',
  baseCurrency: 'USD' as const,
  locale: 'en' as const,
  theme: 'dark' as const,
  timezone: 'America/New_York',
}

const expectedData = {
  name: 'Pham Thi D',
  baseCurrency: 'USD',
  locale: 'en',
  theme: 'dark',
  timezone: 'America/New_York',
}

beforeEach(() => {
  requireUserMock.mockReset()
  updateMock.mockReset()
  cookieSetMock.mockReset()
  requireUserMock.mockResolvedValue(FIXED_USER)
  updateMock.mockResolvedValue(undefined)
})

describe('updateProfile', () => {
  it('updates exactly the five allowed fields, scoped to the session user id', async () => {
    const result = await updateProfile(validInput)

    expect(result).toEqual({ ok: true })
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: expectedData,
    })
  })

  it('mirrors the parsed locale and theme into their cookies', async () => {
    await updateProfile(validInput)

    expect(cookieSetMock).toHaveBeenCalledWith(
      'NEXT_LOCALE',
      'en',
      expect.objectContaining({ path: '/', sameSite: 'lax' }),
    )
    expect(cookieSetMock).toHaveBeenCalledWith(
      'cashflow-theme',
      'dark',
      expect.objectContaining({ path: '/', sameSite: 'lax' }),
    )
  })

  it('never lets an injected isDemo or userId reach prisma, and the where.id comes only from requireUser()', async () => {
    const result = await updateProfile({
      ...validInput,
      isDemo: true,
      userId: 'attacker',
    } as unknown as Parameters<typeof updateProfile>[0])

    expect(result).toEqual({ ok: true })
    expect(updateMock).toHaveBeenCalledTimes(1)
    const call = updateMock.mock.calls[0][0] as { where: { id: string }; data: object }
    expect(call.where).toEqual({ id: 'user_1' })
    expect(call.data).toEqual(expectedData)
    expect(call.data).not.toHaveProperty('isDemo')
    expect(call.data).not.toHaveProperty('userId')
  })

  it('returns { ok: false, error: INVALID_INPUT } for a bad enum value and never calls update', async () => {
    const result = await updateProfile({
      ...validInput,
      baseCurrency: 'EUR',
    } as unknown as Parameters<typeof updateProfile>[0])

    expect(result).toEqual({ ok: false, error: 'INVALID_INPUT' })
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('rejects when requireUser() rejects with UnauthorizedError, and never calls update', async () => {
    requireUserMock.mockRejectedValueOnce(new MockUnauthorizedError())

    await expect(updateProfile(validInput)).rejects.toThrow('Not authenticated')
    expect(updateMock).not.toHaveBeenCalled()
  })
})
