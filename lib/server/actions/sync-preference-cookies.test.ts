import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Covers the second writer of the preference mirror cookies (the first is
 * `update-profile.ts`). Both go through `preferenceCookieOptions()`, so what
 * is pinned here is that this call site really does carry the shared
 * attributes — including `secure` in each of the two modes.
 *
 * `@/lib/auth/require-user` is mocked, so no session and no database.
 */
const requireUserMock = vi.hoisted(() => vi.fn())
const cookieSetMock = vi.hoisted(() => vi.fn())
const headerValues = vi.hoisted(() => ({ current: {} as Record<string, string> }))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: requireUserMock }))

vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSetMock }),
  headers: async () => new Headers(headerValues.current),
}))

const { syncPreferenceCookies } = await import('./sync-preference-cookies')

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365
const originalNodeEnv = process.env.NODE_ENV

function setNodeEnv(value: string | undefined) {
  if (value === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV
  else (process.env as Record<string, string | undefined>).NODE_ENV = value
}

beforeEach(() => {
  requireUserMock.mockReset()
  cookieSetMock.mockReset()
  headerValues.current = {}
  requireUserMock.mockResolvedValue({ id: 'user_1', locale: 'en', theme: 'dark' })
})

afterEach(() => {
  setNodeEnv(originalNodeEnv)
})

describe('syncPreferenceCookies', () => {
  it('writes plain (not Secure) cookies on a localhost HTTP development request', async () => {
    setNodeEnv('development')

    await syncPreferenceCookies()

    const expected = { path: '/', sameSite: 'lax', maxAge: ONE_YEAR_SECONDS, secure: false }
    expect(cookieSetMock).toHaveBeenCalledWith('NEXT_LOCALE', 'en', expected)
    expect(cookieSetMock).toHaveBeenCalledWith('cashflow-theme', 'dark', expected)
  })

  it('writes Secure cookies in production behind an HTTPS proxy, keeping lax/path/lifetime', async () => {
    setNodeEnv('production')
    headerValues.current = { 'x-forwarded-proto': 'https' }

    await syncPreferenceCookies()

    const expected = { path: '/', sameSite: 'lax', maxAge: ONE_YEAR_SECONDS, secure: true }
    expect(cookieSetMock).toHaveBeenCalledWith('NEXT_LOCALE', 'en', expected)
    expect(cookieSetMock).toHaveBeenCalledWith('cashflow-theme', 'dark', expected)
  })

  it('falls back to the defaults when the session user has no saved locale or theme', async () => {
    setNodeEnv('development')
    requireUserMock.mockResolvedValue({ id: 'user_1', locale: 'klingon', theme: 'neon' })

    await syncPreferenceCookies()

    expect(cookieSetMock).toHaveBeenCalledWith('NEXT_LOCALE', 'vi', expect.anything())
    expect(cookieSetMock).toHaveBeenCalledWith('cashflow-theme', 'light', expect.anything())
  })

  it('writes nothing when there is no session — requireUser() rejects first', async () => {
    requireUserMock.mockRejectedValue(new Error('Not authenticated'))

    await expect(syncPreferenceCookies()).rejects.toThrow('Not authenticated')
    expect(cookieSetMock).not.toHaveBeenCalled()
  })
})
