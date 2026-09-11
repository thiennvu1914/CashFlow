import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PLACEHOLDER_BETTER_AUTH_SECRET,
  MIN_BETTER_AUTH_SECRET_LENGTH,
  isProduction,
  isTestLikeEnvironment,
  isNextBuildPhase,
  loadServerEnv,
  resetServerEnvCache,
  validateServerEnv,
} from './env'

/**
 * The contract is exercised through plain `ProcessEnv` objects rather than by
 * importing the modules that call it at load time (`lib/prisma.ts`,
 * `lib/auth/auth.ts`, `lib/email/get-sender.ts`), which would need a database.
 * Those modules call `loadServerEnv()` with the real `process.env`, so what is
 * pinned here is exactly the production boot behaviour.
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

  it('is fail-closed about test-like environments', () => {
    expect(isTestLikeEnvironment(env({ NODE_ENV: 'test' }))).toBe(true)
    expect(isTestLikeEnvironment(env({ NODE_ENV: 'development' }))).toBe(true)
    expect(isTestLikeEnvironment(env({ NODE_ENV: 'production' }))).toBe(false)
    // Unset or unrecognised must not open a test-only bypass.
    expect(isTestLikeEnvironment(env({}))).toBe(false)
  })

  it('recognises the `next build` page-data pass', () => {
    expect(isNextBuildPhase(env({ NEXT_PHASE: 'phase-production-build' }))).toBe(true)
    expect(isNextBuildPhase(env({}))).toBe(false)
  })
})

describe('BETTER_AUTH_SECRET (D1)', () => {
  it('rejects a missing secret in production', () => {
    const problems = problemsFor({ ...PRODUCTION_BASE, BETTER_AUTH_SECRET: undefined })
    expect(problems.some((line) => line.startsWith('BETTER_AUTH_SECRET'))).toBe(true)
  })

  it('rejects a blank secret in production', () => {
    const problems = problemsFor({ ...PRODUCTION_BASE, BETTER_AUTH_SECRET: '    ' })
    expect(problems.some((line) => line.startsWith('BETTER_AUTH_SECRET'))).toBe(true)
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

  it('requires a valid SMTP_PORT once SMTP_HOST selects the SMTP sender', () => {
    expect(problemsFor({ ...PRODUCTION_BASE, SMTP_HOST: 'smtp.example.com' })[0]).toContain(
      'SMTP_PORT',
    )
    expect(
      problemsFor({ ...PRODUCTION_BASE, SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'abc' })[0],
    ).toContain('SMTP_PORT')
    expect(
      problemsFor({ ...PRODUCTION_BASE, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587' }),
    ).toEqual([])
  })

  it('does not require SMTP_HOST itself — getEmailSender() owns that refusal', () => {
    expect(problemsFor(PRODUCTION_BASE).some((line) => line.startsWith('SMTP_HOST'))).toBe(false)
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
          SMTP_PASSWORD: 'smtp-password-value',
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
    ]) {
      expect(message).toContain(name)
    }
    for (const value of [
      'short-secret-value',
      'smtp-password-value',
      'hunter2',
      'smtp.example.com',
      'postgresql://user:hunter2@db.internal:5432/cashflow',
    ]) {
      expect(message).not.toContain(value)
    }
  })

  it('does not throw during `next build`, which serves no requests', () => {
    expect(() =>
      loadServerEnv(env({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' })),
    ).not.toThrow()
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

  it('returns the parsed contract and caches the process environment', () => {
    const parsed = loadServerEnv(env({ ...PRODUCTION_BASE, SMTP_PORT: '587' }))
    expect(parsed.isProduction).toBe(true)
    expect(parsed.smtpPort).toBe(587)
    expect(parsed.trustedProxyCidrs).toEqual(['10.0.0.0/8'])

    // The no-argument form memoises: the second call returns the same object
    // even though it re-reads nothing.
    const first = loadServerEnv()
    expect(loadServerEnv()).toBe(first)
  })
})
