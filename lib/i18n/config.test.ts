import { describe, it, expect, vi } from 'vitest'
import { resolveLocale } from './config'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getMock }),
}))

describe('resolveLocale', () => {
  it('falls back to vi when there is no NEXT_LOCALE cookie', async () => {
    getMock.mockReturnValue(undefined)
    expect(await resolveLocale()).toBe('vi')
  })

  it('returns en when NEXT_LOCALE=en', async () => {
    getMock.mockReturnValue({ value: 'en' })
    expect(await resolveLocale()).toBe('en')
  })

  it('falls back to vi when NEXT_LOCALE is an unsupported locale', async () => {
    getMock.mockReturnValue({ value: 'de' })
    expect(await resolveLocale()).toBe('vi')
  })
})
