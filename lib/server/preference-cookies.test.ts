import { describe, it, expect, vi } from 'vitest'
import {
  PREFERENCE_COOKIE_MAX_AGE,
  isSecureRequest,
  type PreferenceCookieOptions,
} from './preference-cookies'

/** A minimal stand-in for the `Headers` object `next/headers` returns. */
function headersWith(values: Record<string, string>): Pick<Headers, 'get'> {
  return { get: (name: string) => values[name.toLowerCase()] ?? null }
}

describe('isSecureRequest', () => {
  it('is false on a plain localhost HTTP request in development — a Secure cookie would be dropped', () => {
    expect(isSecureRequest(headersWith({}), { NODE_ENV: 'development' })).toBe(false)
    expect(
      isSecureRequest(headersWith({ 'x-forwarded-proto': 'http' }), { NODE_ENV: 'development' }),
    ).toBe(false)
  })

  it('is true when the proxy reports HTTPS, even outside production', () => {
    expect(
      isSecureRequest(headersWith({ 'x-forwarded-proto': 'https' }), { NODE_ENV: 'development' }),
    ).toBe(true)
  })

  it('reads the left-most entry of a proxy chain and ignores case and spacing', () => {
    expect(
      isSecureRequest(headersWith({ 'x-forwarded-proto': ' HTTPS , http' }), {
        NODE_ENV: 'development',
      }),
    ).toBe(true)
    // The client spoke HTTP to the outermost proxy: not secure.
    expect(
      isSecureRequest(headersWith({ 'x-forwarded-proto': 'http, https' }), {
        NODE_ENV: 'development',
      }),
    ).toBe(false)
  })

  it('is true in production with no forwarded protocol at all — fails closed', () => {
    expect(isSecureRequest(headersWith({}), { NODE_ENV: 'production' })).toBe(true)
  })

  it('is true in production even if a header claims plain HTTP', () => {
    expect(
      isSecureRequest(headersWith({ 'x-forwarded-proto': 'http' }), { NODE_ENV: 'production' }),
    ).toBe(true)
  })
})

describe('preferenceCookieOptions', () => {
  /**
   * `next/headers` is mocked per case rather than once at module scope so the
   * two modes can be exercised in one file. `vi.resetModules()` via a dynamic
   * import keeps each case on its own mock.
   */
  async function optionsFor(
    headerValues: Record<string, string>,
    nodeEnv: string,
  ): Promise<PreferenceCookieOptions> {
    vi.resetModules()
    vi.doMock('next/headers', () => ({ headers: async () => headersWith(headerValues) }))
    const originalNodeEnv = process.env.NODE_ENV
    ;(process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv
    try {
      const mod = await import('./preference-cookies')
      return await mod.preferenceCookieOptions()
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv
      vi.doUnmock('next/headers')
      vi.resetModules()
    }
  }

  it('development over localhost HTTP: lax, path /, one year, NOT secure', async () => {
    await expect(optionsFor({}, 'development')).resolves.toEqual({
      path: '/',
      sameSite: 'lax',
      maxAge: PREFERENCE_COOKIE_MAX_AGE,
      secure: false,
    })
  })

  it('production behind an HTTPS proxy: the same attributes plus secure', async () => {
    await expect(optionsFor({ 'x-forwarded-proto': 'https' }, 'production')).resolves.toEqual({
      path: '/',
      sameSite: 'lax',
      maxAge: PREFERENCE_COOKIE_MAX_AGE,
      secure: true,
    })
  })

  it('keeps the one-year lifetime the cookies had before this attribute existed', () => {
    expect(PREFERENCE_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 365)
  })
})
