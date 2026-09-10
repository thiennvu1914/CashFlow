import { describe, expect, it } from 'vitest'
import {
  E2E_DATABASE_URL_VARIABLE,
  assertE2eDatabaseUrl,
  decideE2eDatabaseUrl,
} from './e2e-database-url'

const APP = 'postgresql://cashflow:pw@localhost:5439/cashflow?schema=public'
const E2E = 'postgresql://cashflow:pw@localhost:5439/cashflow_e2e'

describe('decideE2eDatabaseUrl', () => {
  describe('missing', () => {
    it('refuses when the variable is unset, empty or blank', () => {
      for (const env of [
        { DATABASE_URL: APP },
        { DATABASE_URL: APP, E2E_DATABASE_URL: '' },
        { DATABASE_URL: APP, E2E_DATABASE_URL: '   ' },
      ]) {
        const decision = decideE2eDatabaseUrl(env)
        expect(decision.ok).toBe(false)
        expect(decision.ok === false && decision.reason).toBe('missing')
      }
    })

    it('refuses even when DATABASE_URL is unset too — there is no default to fall back to', () => {
      const decision = decideE2eDatabaseUrl({})
      expect(decision.ok === false && decision.reason).toBe('missing')
    })

    it('names the variable and says what to do', () => {
      const decision = decideE2eDatabaseUrl({ DATABASE_URL: APP })
      expect(decision.ok === false && decision.message).toContain(E2E_DATABASE_URL_VARIABLE)
      expect(decision.ok === false && decision.message).toContain('.env.example')
    })
  })

  describe('same as the application database', () => {
    it('refuses an exact copy of DATABASE_URL', () => {
      const decision = decideE2eDatabaseUrl({ DATABASE_URL: APP, E2E_DATABASE_URL: APP })
      expect(decision.ok === false && decision.reason).toBe('same-as-app')
    })

    it('refuses the same database written differently — host spelling, default port, schema', () => {
      const decision = decideE2eDatabaseUrl({
        DATABASE_URL: APP,
        E2E_DATABASE_URL: 'postgresql://other:other@127.0.0.1:5439/cashflow',
      })
      expect(decision.ok === false && decision.reason).toBe('same-as-app')

      const implicitPort = decideE2eDatabaseUrl({
        DATABASE_URL: 'postgresql://cashflow:pw@localhost/cashflow',
        E2E_DATABASE_URL: 'postgresql://cashflow:pw@localhost:5432/cashflow?schema=public',
      })
      expect(implicitPort.ok === false && implicitPort.reason).toBe('same-as-app')
    })

    it('names the database but never echoes the connection string', () => {
      const decision = decideE2eDatabaseUrl({ DATABASE_URL: APP, E2E_DATABASE_URL: APP })
      expect(decision.ok === false && decision.message).toContain('"cashflow"')
      expect(decision.ok === false && decision.message).not.toContain('pw@')
    })

    it('does not fire when DATABASE_URL is unset', () => {
      expect(decideE2eDatabaseUrl({ E2E_DATABASE_URL: E2E }).ok).toBe(true)
    })
  })

  describe('unsafe by policy', () => {
    it('refuses a database name that carries no test marker', () => {
      for (const name of ['cashflow', 'cashflow_prod', 'latest', 'contest', 'e2etest']) {
        const decision = decideE2eDatabaseUrl({
          // No DATABASE_URL, so the same-database check cannot be what refuses
          // these: a production URL on another host is exactly the case the
          // marker rule exists for.
          E2E_DATABASE_URL: `postgresql://cashflow:pw@db.example.com:5432/${name}`,
        })
        expect(decision.ok === false && decision.reason, name).toBe('unsafe')
      }
    })

    it('refuses a name that would have to be quoted in CREATE DATABASE', () => {
      const decision = decideE2eDatabaseUrl({
        E2E_DATABASE_URL: 'postgresql://cashflow:pw@localhost:5439/cashflow-e2e";DROP',
      })
      expect(decision.ok === false && decision.reason).toBe('unsafe')
    })

    it('refuses a connection string that will not parse, without echoing it', () => {
      const decision = decideE2eDatabaseUrl({ E2E_DATABASE_URL: 'postgres//:hunter2@nope' })
      expect(decision.ok === false && decision.reason).toBe('unsafe')
      expect(decision.ok === false && decision.message).not.toContain('hunter2')
    })
  })

  describe('safe', () => {
    it('accepts a dedicated e2e database beside the application one', () => {
      const decision = decideE2eDatabaseUrl({ DATABASE_URL: APP, E2E_DATABASE_URL: E2E })
      expect(decision).toEqual({ ok: true, databaseUrl: E2E, databaseName: 'cashflow_e2e' })
    })

    it('trims surrounding whitespace', () => {
      const decision = decideE2eDatabaseUrl({ DATABASE_URL: APP, E2E_DATABASE_URL: `  ${E2E}  ` })
      expect(decision.ok === true && decision.databaseUrl).toBe(E2E)
    })

    it('accepts either marker, as a word', () => {
      for (const name of ['cashflow_e2e', 'cashflow_test', 'e2e', 'test', 'e2e_cashflow']) {
        const decision = decideE2eDatabaseUrl({
          E2E_DATABASE_URL: `postgresql://cashflow:pw@localhost:5439/${name}`,
        })
        expect(decision.ok, name).toBe(true)
      }
    })
  })
})

describe('assertE2eDatabaseUrl', () => {
  it('returns the URL when the decision is safe', () => {
    expect(assertE2eDatabaseUrl({ DATABASE_URL: APP, E2E_DATABASE_URL: E2E })).toBe(E2E)
  })

  it('throws the refusal message when it is not', () => {
    expect(() => assertE2eDatabaseUrl({ DATABASE_URL: APP, E2E_DATABASE_URL: APP })).toThrow(
      /address the same database/,
    )
  })
})
