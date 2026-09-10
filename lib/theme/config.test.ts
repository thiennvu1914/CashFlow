import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getMock, sessionMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  sessionMock: vi.fn(),
}))

vi.mock('next/headers', () => ({ cookies: async () => ({ get: getMock }) }))
vi.mock('@/lib/auth/require-user', () => ({ getOptionalSession: sessionMock }))

import { resolveTheme, THEME_COOKIE } from './config'

describe('resolveTheme', () => {
  beforeEach(() => {
    getMock.mockReset()
    sessionMock.mockReset()
  })

  it('prefers the signed-in user’s saved theme over the cookie', async () => {
    sessionMock.mockResolvedValue({ user: { theme: 'dark' } })
    getMock.mockReturnValue({ value: 'light' })
    expect(await resolveTheme()).toBe('dark')
  })

  it('falls back to the cookie on a pre-auth page', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockImplementation((name: string) =>
      name === THEME_COOKIE ? { value: 'dark' } : undefined,
    )
    expect(await resolveTheme()).toBe('dark')
  })

  it('falls back to light when neither says anything', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockReturnValue(undefined)
    expect(await resolveTheme()).toBe('light')
  })

  it('ignores a stored value that is not one of the two themes', async () => {
    sessionMock.mockResolvedValue({ user: { theme: 'solarized' } })
    getMock.mockReturnValue({ value: 'midnight' })
    expect(await resolveTheme()).toBe('light')
  })
})
