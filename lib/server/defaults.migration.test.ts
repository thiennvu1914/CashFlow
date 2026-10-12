import { describe, expect, it } from 'vitest'
import { readMigrationSql, splitSqlStatements } from '@/lib/testing/migration-sql'
import {
  DEFAULT_ACCOUNT_TYPES,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  LOAN_INTEREST_CATEGORY_NAME,
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

  it('inserts every DEFAULT_EXPENSE_CATEGORIES name except the later loan-interest one', () => {
    const names = namesInSection('DEFAULT_EXPENSE_CATEGORIES')

    // `LOAN_INTEREST_CATEGORY_NAME` joined the defaults after this migration
    // shipped and is backfilled by its own `loan_interest_category` migration
    // (below); between them the two cover the whole list.
    expect(names).toHaveLength(10)
    expect(new Set(names).size).toBe(10)
    expect([...names, LOAN_INTEREST_CATEGORY_NAME].sort()).toEqual(
      [...DEFAULT_EXPENSE_CATEGORIES].sort(),
    )
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

/**
 * The backfill for the one default added since: the `"Loan Interest & Fees"`
 * EXPENSE category loan instalments file their interest under. Its effect on
 * real rows (one per user, idempotent) is exercised against the database in
 * `services/linked-transaction.test.ts`; this pins the SQL to the constant.
 */
describe('loan_interest_category migration', () => {
  const statements = splitSqlStatements(readMigrationSql('loan_interest_category'))

  it('is one guarded insert of LOAN_INTEREST_CATEGORY_NAME as an EXPENSE category', () => {
    expect(statements).toHaveLength(1)
    const [insert] = statements
    expect(insert.startsWith('INSERT INTO "Category"')).toBe(true)
    expect(insert.match(/WHERE NOT EXISTS/g)).toHaveLength(1)
    // Once as the inserted value and once in the guard — the same name both
    // times, so the guard really does find what an earlier run inserted.
    expect(insert.split(`'${LOAN_INTEREST_CATEGORY_NAME}'`)).toHaveLength(3)
    expect(insert.match(/'EXPENSE'::"CategoryType"/g)).toHaveLength(2)
  })
})
