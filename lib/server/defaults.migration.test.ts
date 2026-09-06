import { describe, expect, it } from 'vitest'
import { readMigrationSql } from '@/lib/testing/migration-sql'
import {
  DEFAULT_ACCOUNT_TYPES,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
} from './defaults'

/**
 * Pure test, no database.
 *
 * The backfill migration cannot import TypeScript, so the default names appear
 * both in `defaults.ts` (the runtime seed) and in the migration's VALUES lists.
 * This test is what keeps that from becoming two sources of truth: it parses
 * the shipped SQL and asserts the two lists are the same set, so adding or
 * renaming a default in only one place is a red suite, not a silent drift.
 *
 * A migration that has already been applied must never be edited, so if the
 * defaults change the fix is a NEW backfill migration plus an update here — not
 * a rewrite of the old file.
 */
const sql = readMigrationSql('backfill_default_taxonomy')

/** Reads the single-quoted names out of one `-- BEGIN X` / `-- END X` block. */
function namesInSection(section: string): string[] {
  const block = new RegExp(`-- BEGIN ${section}\\n([\\s\\S]*?)\\n-- END ${section}`).exec(sql)
  if (!block) throw new Error(`Migration SQL has no "${section}" section`)
  const values = /VALUES\n([\s\S]*?)\n\) AS v\(name\)/.exec(block[1])
  if (!values) throw new Error(`Section "${section}" has no VALUES list`)
  return [...values[1].matchAll(/\('([^']*)'\)/g)].map((match) => match[1])
}

describe('backfill_default_taxonomy migration', () => {
  it('inserts exactly the account type names from DEFAULT_ACCOUNT_TYPES', () => {
    const names = namesInSection('DEFAULT_ACCOUNT_TYPES')

    expect(names).toHaveLength(5)
    expect(new Set(names).size).toBe(5)
    expect([...names].sort()).toEqual([...DEFAULT_ACCOUNT_TYPES].sort())
  })

  it('inserts exactly the expense category names from DEFAULT_EXPENSE_CATEGORIES', () => {
    const names = namesInSection('DEFAULT_EXPENSE_CATEGORIES')

    expect(names).toHaveLength(10)
    expect(new Set(names).size).toBe(10)
    expect([...names].sort()).toEqual([...DEFAULT_EXPENSE_CATEGORIES].sort())
  })

  it('inserts exactly the income category names from DEFAULT_INCOME_CATEGORIES', () => {
    const names = namesInSection('DEFAULT_INCOME_CATEGORIES')

    expect(names).toHaveLength(6)
    expect(new Set(names).size).toBe(6)
    expect([...names].sort()).toEqual([...DEFAULT_INCOME_CATEGORIES].sort())
  })

  it('casts each category section to the matching CategoryType', () => {
    expect(sql).toContain(`'EXPENSE'::"CategoryType"`)
    expect(sql).toContain(`'INCOME'::"CategoryType"`)
  })

  it('guards every insert with a per-user NOT EXISTS so it can be re-run', () => {
    // Three inserts, three guards: without one of them a second run would
    // duplicate that section for every user.
    expect(sql.match(/INSERT INTO/g)).toHaveLength(3)
    expect(sql.match(/WHERE NOT EXISTS/g)).toHaveLength(3)
  })
})
