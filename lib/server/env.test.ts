import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PLACEHOLDER_BETTER_AUTH_SECRET,
  MIN_BETTER_AUTH_SECRET_LENGTH,
  isProduction,
  isNonProductionEnvironment,
  isNextBuildPhase,
  loadServerEnv,
  resetServerEnvCache,
  validateServerEnv,
} from './env'

/**
 * The contract is exercised through plain `ProcessEnv` objects rather than by
 * importing the modules that call it (`lib/prisma.ts`, `lib/auth/auth.ts`,
 * `lib/email/get-sender.ts`), which would need a database. Those modules call
 * `loadServerEnv()` with the real `process.env`, so what is pinned here is
 * exactly the production boot behaviour.
 */
function env(values: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv
}

const VALID_SECRET = 'w3Ky8Q1nZs6tVb2LpX0fJr7HgD4aMcEu'
const PRODUCTION_BASE: Partial<NodeJS.ProcessEnv> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pw@db.internal:5432/cashflow',
  BETTER_AUTH_SECRET: VALID_SECRET,
  BETTER_AUTH_URL: 'https://app.example.com',
  TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  EMAIL_FROM: 'CashFlow <no-reply@example.com>',
  TZ: 'UTC',
}

function problemsFor(values: Partial<NodeJS.ProcessEnv>): string[] {
  return validateServerEnv(env(values)).problems
}

afterEach(() => {
  resetServerEnvCache()
  vi.restoreAllMocks()
})

describe('environment predicates', () => {
  it('only calls a real production process production', () => {
    expect(isProduction(env({ NODE_ENV: 'production' }))).toBe(true)
    expect(isProduction(env({ NODE_ENV: 'development' }))).toBe(false)
    expect(isProduction(env({}))).toBe(false)
  })

  it('is fail-closed about non-production environments, which include development', () => {
    expect(isNonProductionEnvironment(env({ NODE_ENV: 'development' }))).toBe(true)
    expect(isNonProductionEnvironment(env({ NODE_ENV: 'test' }))).toBe(true)
    expect(isNonProductionEnvironment(env({ NODE_ENV: 'production' }))).toBe(false)
    // Unset or unrecognised must not open a test-only bypass.
    expect(isNonProductionEnvironment(env({}))).toBe(false)
    expect(isNonProductionEnvironment(env({ NODE_ENV: 'staging' as never }))).toBe(false)
  })

  it('recognises the `next build` page-data pass', () => {
    expect(isNextBuildPhase(env({ NEXT_PHASE: 'phase-production-build' }))).toBe(true)
    expect(isNextBuildPhase(env({}))).toBe(false)
  })
})

describe('BETTER_AUTH_SECRET (D1)', () => {
  it('rejects a missing secret in production', () => {
    const problems = problemsFor({ ...PRODUCTION_BASE, BETTER_AUTH_SECRET: undefined })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('BETTER_AUTH_SECRET')
  })

  it('rejects a blank secret in production', () => {
    const problems = problemsFor({ ...PRODUCTION_BASE, BETTER_AUTH_SECRET: '    ' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('BETTER_AUTH_SECRET')
  })

  it('rejects the .env.example placeholder, which is long enough to pass a length check', () => {
    expect(PLACEHOLDER_BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(
      MIN_BETTER_AUTH_SECRET_LENGTH,
    )
    const problems = problemsFor({
      ...PRODUCTION_BASE,
      BETTER_AUTH_SECRET: PLACEHOLDER_BETTER_AUTH_SECRET,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('known placeholder')
  })

  it("rejects Better Auth's own fallback secret", () => {
    const problems = problemsFor({
      ...PRODUCTION_BASE,
      BETTER_AUTH_SECRET: 'better-auth-secret-12345678901234567890',
    })
    expect(problems[0]).toContain('known placeholder')
  })

  it('rejects a secret shorter than the 32-character floor', () => {
    const problems = problemsFor({ ...PRODUCTION_BASE, BETTER_AUTH_SECRET: 'a'.repeat(31) })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(String(MIN_BETTER_AUTH_SECRET_LENGTH))
  })

  it('accepts a 32-character secret', () => {
    expect(problemsFor({ ...PRODUCTION_BASE, BETTER_AUTH_SECRET: 'b'.repeat(32) })).toEqual([])
  })

  it('does not check the secret outside production', () => {
    expect(
      problemsFor({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://localhost:5439/cashflow',
        BETTER_AUTH_SECRET: PLACEHOLDER_BETTER_AUTH_SECRET,
      }),
    ).toEqual([])
  })
})

describe('the production contract (D2)', () => {
  it('accepts a fully configured production environment', () => {
    const { problems, warnings } = validateServerEnv(env(PRODUCTION_BASE))
    expect(problems).toEqual([])
    expect(warnings).toEqual([])
  })

  it.each([
    ['DATABASE_URL'],
    ['BETTER_AUTH_URL'],
    ['TRUSTED_PROXY_CIDRS'],
    ['EMAIL_FROM'],
    ['SMTP_HOST'],
  ] as const)('rejects a production environment missing %s', (name) => {
    const problems = problemsFor({ ...PRODUCTION_BASE, [name]: undefined })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(name)
  })

  it('treats a CIDR list of only separators as unset', () => {
    expect(problemsFor({ ...PRODUCTION_BASE, TRUSTED_PROXY_CIDRS: '  , ,' })[0]).toContain(
      'TRUSTED_PROXY_CIDRS',
    )
  })

  it('rejects a BETTER_AUTH_URL that is not an absolute http(s) origin', () => {
    expect(problemsFor({ ...PRODUCTION_BASE, BETTER_AUTH_URL: 'app.example.com' })[0]).toContain(
      'BETTER_AUTH_URL',
    )
  })

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(problemsFor({ ...PRODUCTION_BASE, DATABASE_URL: 'mysql://db/cashflow' })[0]).toContain(
      'DATABASE_URL',
    )
  })

  it('requires SMTP_HOST in production because SMTP is the only transport it accepts', () => {
    const problems = problemsFor({ ...PRODUCTION_BASE, SMTP_HOST: undefined, SMTP_PORT: undefined })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('SMTP_HOST')
  })

  it('requires a strictly numeric SMTP_PORT whenever SMTP_HOST is set', () => {
    expect(problemsFor({ ...PRODUCTION_BASE, SMTP_PORT: undefined })[0]).toContain('SMTP_PORT')
    for (const bad of ['abc', '587abc', '0', '70000', '58.7', ' 587 x']) {
      const problems = problemsFor({ ...PRODUCTION_BASE, SMTP_PORT: bad })
      expect(problems.some((line) => line.startsWith('SMTP_PORT'))).toBe(true)
    }
    expect(problemsFor({ ...PRODUCTION_BASE, SMTP_PORT: '465' })).toEqual([])
  })

  it('allows an anonymous relay but refuses half-configured SMTP authentication', () => {
    expect(problemsFor({ ...PRODUCTION_BASE, SMTP_USER: undefined })).toEqual([])
    const problems = problemsFor({ ...PRODUCTION_BASE, SMTP_USER: 'mailer' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('SMTP_PASSWORD')
    expect(problemsFor({ ...PRODUCTION_BASE, SMTP_USER: 'mailer', SMTP_PASSWORD: 'pw' })).toEqual(
      [],
    )
  })

  it('applies the SMTP completeness rules outside production too, once SMTP_HOST is set', () => {
    const problems = problemsFor({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost:5439/cashflow',
      SMTP_HOST: 'smtp.example.com',
    })
    expect(problems).toEqual(['SMTP_PORT: required when SMTP_HOST is set'])
  })

  it('requires DATABASE_URL in every environment', () => {
    expect(problemsFor({ NODE_ENV: 'development' })).toEqual(['DATABASE_URL: required but not set'])
  })

  it('warns (never fails) about test-only variables, a stray outbox and a non-UTC TZ in production', () => {
    const { problems, warnings } = validateServerEnv(
      env({
        ...PRODUCTION_BASE,
        TZ: 'Asia/Ho_Chi_Minh',
        EMAIL_OUTBOX_FILE: '/tmp/outbox.jsonl',
        TEST_DATABASE_URL: 'postgresql://localhost:5439/cashflow_test',
        E2E_DATABASE_URL: 'postgresql://localhost:5439/cashflow_e2e',
        CASHFLOW_E2E_DISABLE_RATE_LIMIT: '1',
      }),
    )
    expect(problems).toEqual([])
    expect(warnings.map((line) => line.split(':')[0])).toEqual([
      'EMAIL_OUTBOX_FILE',
      'TEST_DATABASE_URL',
      'E2E_DATABASE_URL',
      'CASHFLOW_E2E_DISABLE_RATE_LIMIT',
      'TZ',
    ])
  })
})

describe('loadServerEnv', () => {
  it('throws one aggregated error naming every offending variable, with no values in it', () => {
    let error: unknown
    try {
      loadServerEnv(
        env({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://user:hunter2@db.internal:5432/cashflow',
          BETTER_AUTH_SECRET: 'short-secret-value',
          TRUSTED_PROXY_CIDRS: '',
          SMTP_HOST: 'smtp.example.com',
          SMTP_USER: 'mailer-account',
        }),
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    for (const name of [
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_URL',
      'TRUSTED_PROXY_CIDRS',
      'EMAIL_FROM',
      'SMTP_PORT',
      'SMTP_PASSWORD',
    ]) {
      expect(message).toContain(name)
    }
    for (const value of [
      'short-secret-value',
      'mailer-account',
      'hunter2',
      'smtp.example.com',
      'postgresql://user:hunter2@db.internal:5432/cashflow',
    ]) {
      expect(message).not.toContain(value)
    }
  })

  it('logs production warnings by name — they must be visible, not only collected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      loadServerEnv(
        env({
          ...PRODUCTION_BASE,
          TZ: 'Asia/Ho_Chi_Minh',
          EMAIL_OUTBOX_FILE: '/srv/outbox.jsonl',
          CASHFLOW_E2E_DISABLE_RATE_LIMIT: '1',
        }),
      ),
    ).not.toThrow()

    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    for (const name of ['EMAIL_OUTBOX_FILE', 'CASHFLOW_E2E_DISABLE_RATE_LIMIT', 'TZ']) {
      expect(logged).toContain(name)
    }
    for (const value of ['/srv/outbox.jsonl', 'Asia/Ho_Chi_Minh', VALID_SECRET, 'db.internal']) {
      expect(logged).not.toContain(value)
    }
  })

  it('still logs the warnings when the same production environment is fatal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      loadServerEnv(
        env({
          ...PRODUCTION_BASE,
          BETTER_AUTH_SECRET: undefined,
          EMAIL_OUTBOX_FILE: '/srv/outbox.jsonl',
        }),
      ),
    ).toThrowError(/BETTER_AUTH_SECRET/)

    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('EMAIL_OUTBOX_FILE')
    // The thrown problems are not also logged — they are about to be thrown.
    expect(logged).not.toContain('BETTER_AUTH_SECRET')
  })

  it('does not throw during `next build`, which serves no requests', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      loadServerEnv(env({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' })),
    ).not.toThrow()
    // Still reported, by name, so a build log shows what a deployment will need.
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('DATABASE_URL')
  })

  it('still throws for a production runtime, which leaves NEXT_PHASE unset', () => {
    expect(() => loadServerEnv(env({ NODE_ENV: 'production' }))).toThrowError(/BETTER_AUTH_SECRET/)
  })

  it('warns by name and continues in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      loadServerEnv(env({ NODE_ENV: 'development', BETTER_AUTH_SECRET: 'x' })),
    ).not.toThrow()
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('DATABASE_URL')
    expect(logged).not.toContain("'x'")
  })

  it('stays silent in test environments', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => loadServerEnv(env({ NODE_ENV: 'test' }))).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns only the values callers consume, and caches the process environment', () => {
    const parsed = loadServerEnv(env(PRODUCTION_BASE))
    expect(parsed.isProduction).toBe(true)
    expect(parsed.trustedProxyCidrs).toEqual(['10.0.0.0/8'])
    // No SMTP credential, EMAIL_FROM, outbox path or TZ is carried on the
    // cached object — they are validated, not retained.
    expect(Object.keys(parsed).sort()).toEqual([
      'betterAuthSecret',
      'databaseUrl',
      'isBuildPhase',
      'isProduction',
      'nodeEnv',
      'trustedProxyCidrs',
    ])

    // The no-argument form memoises: the second call returns the same object.
    const first = loadServerEnv()
    expect(loadServerEnv()).toBe(first)
  })
})
