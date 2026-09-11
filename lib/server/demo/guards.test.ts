import { describe, expect, it } from 'vitest'
import { DEMO_EMAIL } from './constants'
import {
  assertApplicationDatabase,
  assertDemoUserRow,
  assertNotProduction,
  DEMO_PRODUCTION_OVERRIDE,
  DemoGuardError,
} from './guards'

/**
 * The three refusals, exercised on their own.
 *
 * Every case passes an explicit environment object rather than mutating
 * `process.env`: these guards are the only thing standing between a mistyped
 * command and a production ledger, so they must be provable without a process
 * to corrupt — and a suite that edited `process.env.NODE_ENV` would change
 * what every other file in the run sees.
 *
 * The connection strings below carry a password on purpose. Two cases assert
 * it never reaches a message: a refusal is exactly the moment a value ends up
 * in a terminal scrollback or a CI log.
 */

const APP_URL = 'postgresql://cashflow:s3cr3t-password@localhost:5439/cashflow?schema=public'
const TEST_URL = 'postgresql://cashflow:s3cr3t-password@localhost:5439/cashflow_test'
const E2E_URL = 'postgresql://cashflow:s3cr3t-password@localhost:5439/cashflow_e2e'
const PASSWORD = 's3cr3t-password'

describe('assertNotProduction', () => {
  it('refuses a production process with no override', () => {
    expect(() => assertNotProduction({ NODE_ENV: 'production' })).toThrow(DemoGuardError)
    expect(() => assertNotProduction({ NODE_ENV: 'production' })).toThrow(/NODE_ENV is production/)
  })

  it('proceeds in production when the override is exactly "true"', () => {
    expect(() =>
      assertNotProduction({ NODE_ENV: 'production', [DEMO_PRODUCTION_OVERRIDE]: 'true' }),
    ).not.toThrow()
  })

  it.each(['false', '1', 'yes', 'TRUE', '', '  '])(
    'still refuses production when the override is %o',
    (value) => {
      expect(() =>
        assertNotProduction({ NODE_ENV: 'production', [DEMO_PRODUCTION_OVERRIDE]: value }),
      ).toThrow(DemoGuardError)
    },
  )

  it.each(['development', 'test', undefined])('proceeds when NODE_ENV is %o', (nodeEnv) => {
    expect(() => assertNotProduction({ NODE_ENV: nodeEnv })).not.toThrow()
  })
})

describe('assertApplicationDatabase', () => {
  it('accepts the application database and returns its name', () => {
    expect(assertApplicationDatabase({ DATABASE_URL: APP_URL })).toBe('cashflow')
  })

  it('refuses when DATABASE_URL is not set', () => {
    expect(() => assertApplicationDatabase({})).toThrow(/DATABASE_URL is not set/)
  })

  it.each([
    ['cashflow_test', TEST_URL],
    ['cashflow_e2e', E2E_URL],
    ['e2e', 'postgresql://cashflow:pw@localhost:5439/e2e'],
    ['test_ledger', 'postgresql://cashflow:pw@localhost:5439/test_ledger'],
  ])('refuses the database named %s', (name, url) => {
    expect(() => assertApplicationDatabase({ DATABASE_URL: url })).toThrow(DemoGuardError)
    expect(() => assertApplicationDatabase({ DATABASE_URL: url })).toThrow(
      new RegExp(`"${name}"[\\s\\S]*disposable test database`),
    )
  })

  it('accepts a name that merely contains "test" inside a word', () => {
    // `latest` is the case the marker regex exists to let through — the rule is
    // `test` as a word, not as a substring.
    expect(
      assertApplicationDatabase({ DATABASE_URL: 'postgresql://u:pw@localhost:5439/latest' }),
    ).toBe('latest')
  })

  it.each(['TEST_DATABASE_URL', 'E2E_DATABASE_URL'] as const)(
    'refuses when it addresses the same database as %s written differently',
    (variable) => {
      // Same database, two spellings: `127.0.0.1` vs `localhost`, and an
      // explicit `?schema=public` vs none. A string compare would miss both.
      const env = {
        DATABASE_URL: 'postgresql://cashflow:pw@127.0.0.1:5439/ledger',
        [variable]: 'postgresql://cashflow:pw@localhost:5439/ledger?schema=public',
      }
      expect(() => assertApplicationDatabase(env)).toThrow(
        new RegExp(`DATABASE_URL and ${variable} address the same database`),
      )
    },
  )

  it('refuses an unparseable connection string', () => {
    expect(() => assertApplicationDatabase({ DATABASE_URL: 'not-a-url' })).toThrow(DemoGuardError)
  })

  it('never puts the connection string or its password in a refusal', () => {
    const refusals = [
      () => assertApplicationDatabase({ DATABASE_URL: TEST_URL }),
      () => assertApplicationDatabase({ DATABASE_URL: APP_URL, TEST_DATABASE_URL: APP_URL }),
    ]
    for (const refusal of refusals) {
      expect(refusal).toThrow()
      try {
        refusal()
      } catch (error) {
        const message = (error as Error).message
        expect(message).not.toContain(PASSWORD)
        expect(message).not.toContain('postgresql://')
      }
    }
  })
})

describe('assertDemoUserRow', () => {
  const demoRow = { id: 'user_1', email: DEMO_EMAIL, isDemo: true }

  it('accepts the demo user', () => {
    expect(() => assertDemoUserRow(demoRow)).not.toThrow()
  })

  it('aborts when there is no such row', () => {
    expect(() => assertDemoUserRow(null)).toThrow(/no user with the demo email/)
  })

  it('aborts when the row carries a different email', () => {
    expect(() => assertDemoUserRow({ ...demoRow, email: 'real.person@example.com' })).toThrow(
      /does not carry the demo email/,
    )
  })

  it('aborts when the row is not flagged isDemo', () => {
    expect(() => assertDemoUserRow({ ...demoRow, isDemo: false })).toThrow(
      /not flagged isDemo[\s\S]*nothing was deleted/,
    )
  })
})
