import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEST_DATABASE_URL,
  adminConnectionCandidates,
  assertCreatableDatabaseName,
  databaseNameOf,
  isSameDatabase,
  parseConnectionString,
  resolveTestDatabaseUrl,
} from './database-url'

const DEV = 'postgresql://cashflow:pw@localhost:5439/cashflow?schema=public'
const TEST = 'postgresql://cashflow:pw@localhost:5439/cashflow_test'

describe('resolveTestDatabaseUrl', () => {
  it('uses TEST_DATABASE_URL when set', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: TEST })).toBe(TEST)
  })

  it('falls back to the default when unset, empty or blank', () => {
    expect(resolveTestDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL)
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: '' })).toBe(DEFAULT_TEST_DATABASE_URL)
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: '   ' })).toBe(DEFAULT_TEST_DATABASE_URL)
  })

  it('trims surrounding whitespace', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: `  ${TEST}  ` })).toBe(TEST)
  })
})

describe('parseConnectionString', () => {
  it('names the variable and never echoes the value on a bad URL', () => {
    expect(() => parseConnectionString('not a url://%%', 'TEST_DATABASE_URL')).toThrow(
      'TEST_DATABASE_URL is not a valid connection string.',
    )
    try {
      parseConnectionString('postgresql://user:hunter2@@@/x', 'TEST_DATABASE_URL')
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2')
    }
  })
})

describe('databaseNameOf', () => {
  it('reads the database out of the path, ignoring query parameters', () => {
    expect(databaseNameOf(DEV, 'DATABASE_URL')).toBe('cashflow')
    expect(databaseNameOf(TEST, 'TEST_DATABASE_URL')).toBe('cashflow_test')
  })

  it('decodes a percent-escaped name', () => {
    expect(databaseNameOf('postgresql://h:5432/my%20db', 'TEST_DATABASE_URL')).toBe('my db')
  })
})

describe('assertCreatableDatabaseName', () => {
  it('accepts a plain identifier', () => {
    expect(assertCreatableDatabaseName('cashflow_test', 'TEST_DATABASE_URL')).toBe('cashflow_test')
  })

  it('refuses anything that would have to be quoted', () => {
    expect(() => assertCreatableDatabaseName('my db', 'TEST_DATABASE_URL')).toThrow(
      'TEST_DATABASE_URL must name a database',
    )
    expect(() =>
      assertCreatableDatabaseName('a"; DROP DATABASE b; --', 'TEST_DATABASE_URL'),
    ).toThrow('TEST_DATABASE_URL must name a database')
    expect(() => assertCreatableDatabaseName('', 'TEST_DATABASE_URL')).toThrow(
      'TEST_DATABASE_URL must name a database',
    )
  })
})

describe('isSameDatabase', () => {
  it('is true for identical URLs', () => {
    expect(isSameDatabase(DEV, DEV)).toBe(true)
  })

  it('is true when only the default schema is written out', () => {
    expect(
      isSameDatabase(
        'postgresql://cashflow:pw@localhost:5439/cashflow?schema=public',
        'postgresql://cashflow:pw@localhost:5439/cashflow',
      ),
    ).toBe(true)
  })

  it('is true when only the default port is written out', () => {
    expect(
      isSameDatabase(
        'postgresql://u:p@db.internal:5432/cashflow',
        'postgresql://u:p@db.internal/cashflow',
      ),
    ).toBe(true)
  })

  it('ignores credentials — a different role is still the same database', () => {
    expect(
      isSameDatabase(
        'postgresql://cashflow:pw@localhost:5439/cashflow',
        'postgresql://postgres:other@localhost:5439/cashflow',
      ),
    ).toBe(true)
  })

  it('treats every spelling of loopback as the same host', () => {
    // `localhost`, `127.0.0.1` and `::1` all reach the same Postgres, so a
    // dev URL written one way and a test URL written another must not slip
    // past the "am I about to wipe the development database?" guard.
    const spellings = [
      'postgresql://u:p@localhost:5439/cashflow',
      'postgresql://u:p@127.0.0.1:5439/cashflow',
      'postgresql://u:p@[::1]:5439/cashflow',
    ]
    for (const a of spellings) {
      for (const b of spellings) {
        expect(isSameDatabase(a, b)).toBe(true)
      }
    }
  })

  it('still separates loopback from a real host with the same database name', () => {
    expect(
      isSameDatabase(
        'postgresql://u:p@127.0.0.1:5439/cashflow',
        'postgresql://u:p@db.example.com:5439/cashflow',
      ),
    ).toBe(false)
  })

  it('is false for a different database name', () => {
    expect(isSameDatabase(DEV, TEST)).toBe(false)
  })

  it('is false for a different port', () => {
    expect(
      isSameDatabase(
        'postgresql://cashflow:pw@localhost:5439/cashflow',
        'postgresql://cashflow:pw@localhost:5432/cashflow',
      ),
    ).toBe(false)
  })

  it('is false for a different host', () => {
    expect(
      isSameDatabase(
        'postgresql://cashflow:pw@localhost:5439/cashflow',
        'postgresql://cashflow:pw@db.example.com:5439/cashflow',
      ),
    ).toBe(false)
  })

  it('is false for a different schema on the same database', () => {
    expect(
      isSameDatabase(
        'postgresql://cashflow:pw@localhost:5439/cashflow?schema=public',
        'postgresql://cashflow:pw@localhost:5439/cashflow?schema=test',
      ),
    ).toBe(false)
  })

  it('falls back to an exact comparison when a URL will not parse', () => {
    expect(isSameDatabase('nonsense', 'nonsense')).toBe(true)
    expect(isSameDatabase('nonsense', DEV)).toBe(false)
  })
})

describe('adminConnectionCandidates', () => {
  it('always tries the maintenance database on the TEST server first', () => {
    const [first] = adminConnectionCandidates(TEST, DEV)
    const url = new URL(first)
    expect(url.hostname).toBe('localhost')
    expect(url.port).toBe('5439')
    expect(url.pathname).toBe('/postgres')
    // Prisma's `?schema=` means nothing to a bare CREATE DATABASE connection.
    expect(url.search).toBe('')
  })

  it('offers the dev database as a second attempt on the same server', () => {
    expect(adminConnectionCandidates(TEST, DEV)).toHaveLength(2)
    expect(adminConnectionCandidates(TEST, DEV)[1]).toBe(DEV)
  })

  it('recognises a dev database on the same loopback server written a different way', () => {
    expect(
      adminConnectionCandidates(TEST, 'postgresql://cashflow:pw@127.0.0.1:5439/cashflow'),
    ).toHaveLength(2)
    expect(
      adminConnectionCandidates(TEST, 'postgresql://cashflow:pw@[::1]:5439/cashflow'),
    ).toHaveLength(2)
  })

  it('never reaches for a dev database on another server', () => {
    expect(
      adminConnectionCandidates(TEST, 'postgresql://cashflow:pw@db.example.com:5439/cashflow'),
    ).toHaveLength(1)
    expect(
      adminConnectionCandidates(TEST, 'postgresql://cashflow:pw@localhost:5432/cashflow'),
    ).toHaveLength(1)
  })

  it('works with no dev URL at all', () => {
    expect(adminConnectionCandidates(TEST, undefined)).toHaveLength(1)
  })
})
