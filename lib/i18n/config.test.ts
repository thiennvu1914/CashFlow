import { describe, it, expect, vi } from 'vitest'
import { resolveLocale } from './config'

const { getMock, sessionMock } = vi.hoisted(() => ({ getMock: vi.fn(), sessionMock: vi.fn() }))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getMock }),
}))
vi.mock('@/lib/auth/require-user', () => ({ getOptionalSession: sessionMock }))

describe('resolveLocale', () => {
  it('falls back to vi when there is no NEXT_LOCALE cookie', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockReturnValue(undefined)
    expect(await resolveLocale()).toBe('vi')
  })

  it('returns en when NEXT_LOCALE=en', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockReturnValue({ value: 'en' })
    expect(await resolveLocale()).toBe('en')
  })

  it('falls back to vi when NEXT_LOCALE is an unsupported locale', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockReturnValue({ value: 'de' })
    expect(await resolveLocale()).toBe('vi')
  })

  it('prefers the signed-in user’s saved locale over the cookie', async () => {
    sessionMock.mockResolvedValue({ user: { locale: 'en' } })
    getMock.mockReturnValue({ value: 'vi' })
    expect(await resolveLocale()).toBe('en')
  })

  it('ignores an unsupported stored locale and falls through to the cookie', async () => {
    sessionMock.mockResolvedValue({ user: { locale: 'de' } })
    getMock.mockReturnValue({ value: 'en' })
    expect(await resolveLocale()).toBe('en')
  })

  it('falls back to vi with no session and no cookie', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockReturnValue(undefined)
    expect(await resolveLocale()).toBe('vi')
  })
})
