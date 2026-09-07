import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { createTransactionFormSchema, createTransactionSchema } from './transaction'

/**
 * These tests are about the *text* a rejection carries, not about accept/reject
 * — `lib/server/services/transaction.test.ts` already pins the accept/reject
 * boundaries of `createTransactionSchema` (amounts, dates, types).
 *
 * A form renders `errors.<field>.message` verbatim, so whatever the schema says
 * is what the user reads. A missing `accountId` used to surface Zod's own
 * "Too small: expected string to have >=1 characters" under the Account field,
 * which is internal validator text, not product copy — hence
 * `RAW_VALIDATION_TEXT` below, asserted against *every* issue of a failed parse
 * rather than only the one under test: it is the guard that keeps the next edit
 * to these schemas from reintroducing machine text somewhere else.
 */

/** Zod's own machine phrasing — never acceptable in a rendered message. */
const RAW_VALIDATION_TEXT = /expected string|>=1 characters|Too small|Invalid input/i

/** A complete, valid form submission (`date` is the raw `yyyy-MM-ddTHH:mm`). */
const validFormInput = {
  accountId: 'account_1',
  type: 'CASH_IN' as const,
  amount: 1000,
  date: '2026-02-01T09:15',
}

/** The same submission as the service sees it (`date` is a real instant). */
const validServiceInput = {
  accountId: 'account_1',
  type: 'CASH_IN' as const,
  amount: 1000,
  date: new Date('2026-02-01T02:15:00.000Z'),
}

type Issue = { path: string; message: string }

function issuesOf(schema: ZodType, input: unknown): Issue[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

function formIssues(input: unknown): Issue[] {
  return issuesOf(createTransactionFormSchema, input)
}

function messagesFor(issues: Issue[], path: string): string[] {
  return issues.filter((issue) => issue.path === path).map((issue) => issue.message)
}

describe('createTransactionFormSchema account messages', () => {
  it('accepts a complete submission', () => {
    expect(createTransactionFormSchema.safeParse(validFormInput).success).toBe(true)
  })

  it('reports an empty accountId as "Choose an account"', () => {
    const issues = formIssues({ ...validFormInput, accountId: '' })

    expect(messagesFor(issues, 'accountId')).toEqual(['Choose an account'])
  })

  it('reports a missing accountId as "Choose an account"', () => {
    // Deleted rather than destructured away: the field is absent, not empty,
    // which is the case `.min(1)` never sees and the `error` param covers.
    const crafted: Record<string, unknown> = { ...validFormInput }
    delete crafted.accountId

    expect(messagesFor(formIssues(crafted), 'accountId')).toEqual(['Choose an account'])
  })

  it('reports a non-string accountId as "Choose an account"', () => {
    // A crafted request, not something the form can produce — the Zod 4
    // `error` param covers the wrong-type case that `.min(1)` never reaches.
    const issues = formIssues({ ...validFormInput, accountId: 123 })

    expect(messagesFor(issues, 'accountId')).toEqual(['Choose an account'])
  })

  it.each([
    ['empty', { ...validFormInput, accountId: '' }],
    ['non-string', { ...validFormInput, accountId: 123 }],
    ['missing', { type: 'CASH_IN', amount: 1000, date: '2026-02-01T09:15' }],
  ])('renders no raw validator text for a %s accountId', (_label, input) => {
    const issues = formIssues(input)

    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(issue.message).not.toMatch(RAW_VALIDATION_TEXT)
    }
  })

  it('reports an over-long note as "Keep the note under 500 characters"', () => {
    // The `max` mirror of the `min` above — the Note input carries no
    // `maxLength`, so a pasted 501 characters reaches the schema and its
    // message reaches the user ("Too big: expected string to have <=500
    // characters" before this).
    const issues = formIssues({ ...validFormInput, note: 'x'.repeat(501) })

    expect(messagesFor(issues, 'note')).toEqual(['Keep the note under 500 characters'])
    for (const issue of issues) {
      expect(issue.message).not.toMatch(RAW_VALIDATION_TEXT)
    }
  })
})

describe('createTransactionSchema account messages', () => {
  it('accepts a complete submission', () => {
    expect(createTransactionSchema.safeParse(validServiceInput).success).toBe(true)
  })

  it('carries the same friendly message server-side — the service parses this schema', () => {
    const issues = issuesOf(createTransactionSchema, { ...validServiceInput, accountId: '' })

    expect(messagesFor(issues, 'accountId')).toEqual(['Choose an account'])
    for (const issue of issues) {
      expect(issue.message).not.toMatch(RAW_VALIDATION_TEXT)
    }
  })
})
