import { describe, it, expect } from 'vitest'
import { assertProductionAuthConfig } from './production-config'

/**
 * The guard is exercised through a plain `ProcessEnv` object rather than by
 * importing `lib/auth/auth.ts`, which would pull in `lib/prisma.ts` and need a
 * database. `lib/auth/auth.ts` calls this function with `process.env` at module
 * load, so what is pinned here is exactly the production boot behaviour.
 */
/**
 * `NodeJS.ProcessEnv` (as augmented by `@types/node` + Next) types `NODE_ENV`
 * as a literal union and requires it, so test fixtures are built through this
 * helper rather than as bare object literals.
 */
function env(values: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv
}

describe('assertProductionAuthConfig', () => {
  it('does nothing outside production even with nothing configured', () => {
    expect(() => assertProductionAuthConfig(env({ NODE_ENV: 'development' }))).not.toThrow()
    expect(() => assertProductionAuthConfig(env({ NODE_ENV: 'test' }))).not.toThrow()
    expect(() => assertProductionAuthConfig(env({}))).not.toThrow()
  })

  it('throws in production when TRUSTED_PROXY_CIDRS is missing or empty', () => {
    const base: Partial<NodeJS.ProcessEnv> = {
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'https://app.example.com',
    }

    expect(() => assertProductionAuthConfig(env(base))).toThrowError(/TRUSTED_PROXY_CIDRS/)
    expect(() =>
      assertProductionAuthConfig(env({ ...base, TRUSTED_PROXY_CIDRS: '  , ,' })),
    ).toThrowError(/TRUSTED_PROXY_CIDRS/)
  })

  it('throws in production when BETTER_AUTH_URL is missing or empty', () => {
    const base: Partial<NodeJS.ProcessEnv> = {
      NODE_ENV: 'production',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    }

    expect(() => assertProductionAuthConfig(env(base))).toThrowError(/BETTER_AUTH_URL/)
    expect(() => assertProductionAuthConfig(env({ ...base, BETTER_AUTH_URL: '   ' }))).toThrowError(
      /BETTER_AUTH_URL/,
    )
  })

  it('names both variables when both are missing, and leaks no value', () => {
    let error: unknown
    try {
      assertProductionAuthConfig(
        env({
          NODE_ENV: 'production',
          BETTER_AUTH_SECRET: 'super-secret-value',
        }),
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('BETTER_AUTH_URL')
    expect(message).toContain('TRUSTED_PROXY_CIDRS')
    expect(message).not.toContain('super-secret-value')
  })

  it('does not fire during `next build`, which sets NODE_ENV=production but serves nothing', () => {
    expect(() =>
      assertProductionAuthConfig(
        env({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }),
      ),
    ).not.toThrow()
  })

  it('still fires for a production runtime, which leaves NEXT_PHASE unset', () => {
    expect(() => assertProductionAuthConfig(env({ NODE_ENV: 'production' }))).toThrowError(
      /BETTER_AUTH_URL/,
    )
  })

  it('passes in production once both are set', () => {
    expect(() =>
      assertProductionAuthConfig(
        env({
          NODE_ENV: 'production',
          BETTER_AUTH_URL: 'https://app.example.com',
          TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
        }),
      ),
    ).not.toThrow()
  })
})
