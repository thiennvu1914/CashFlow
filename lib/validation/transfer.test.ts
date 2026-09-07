import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { createTransferFormSchema, createTransferSchema } from './transfer'

/**
 * The same concern as `transaction.test.ts`: a form renders
 * `errors.<field>.message` verbatim, so a transfer leg with no account chosen
 * must read as product copy, not as Zod's "Too small: expected string to have
 * >=1 characters". Each leg gets its own wording — "from" and "to" are not
 * interchangeable to a user staring at two identical-looking selects.
 */

/** Zod's own machine phrasing — never acceptable in a rendered message. */
const RAW_VALIDATION_TEXT = /expected string|>=1 characters|Too small|Invalid input/i

/** A complete, valid form submission (`date` is the raw `yyyy-MM-ddTHH:mm`). */
const validFormInput = {
  fromAccountId: 'account_1',
  toAccountId: 'account_2',
  fromAmount: 1000,
  toAmount: 1000,
  date: '2026-02-01T09:15',
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
  return issuesOf(createTransferFormSchema, input)
}

function messagesFor(issues: Issue[], path: string): string[] {
  return issues.filter((issue) => issue.path === path).map((issue) => issue.message)
}

describe('createTransferFormSchema account messages', () => {
  it('accepts a complete submission', () => {
    expect(createTransferFormSchema.safeParse(validFormInput).success).toBe(true)
  })

  it('reports an empty fromAccountId as "Choose the account to transfer from"', () => {
    const issues = formIssues({ ...validFormInput, fromAccountId: '' })

    expect(messagesFor(issues, 'fromAccountId')).toEqual(['Choose the account to transfer from'])
  })

  it('reports an empty toAccountId as "Choose the account to transfer to"', () => {
    const issues = formIssues({ ...validFormInput, toAccountId: '' })

    expect(messagesFor(issues, 'toAccountId')).toEqual(['Choose the account to transfer to'])
  })

  it('reports a missing leg with the same friendly message', () => {
    // Deleted rather than destructured away: both fields are absent, not empty,
    // which is the case `.min(1)` never sees and the `error` param covers.
    const crafted: Record<string, unknown> = { ...validFormInput }
    delete crafted.fromAccountId
    delete crafted.toAccountId
    const issues = formIssues(crafted)

    expect(messagesFor(issues, 'fromAccountId')).toEqual(['Choose the account to transfer from'])
    expect(messagesFor(issues, 'toAccountId')).toEqual(['Choose the account to transfer to'])
  })

  it.each([
    ['an empty from leg', { ...validFormInput, fromAccountId: '' }],
    ['an empty to leg', { ...validFormInput, toAccountId: '' }],
    ['two non-string legs', { ...validFormInput, fromAccountId: 1, toAccountId: 2 }],
  ])('renders no raw validator text for %s', (_label, input) => {
    const issues = formIssues(input)

    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(issue.message).not.toMatch(RAW_VALIDATION_TEXT)
    }
  })

  it('still rejects the same account on both legs with its own message', () => {
    const issues = formIssues({ ...validFormInput, toAccountId: validFormInput.fromAccountId })

    expect(messagesFor(issues, 'toAccountId')).toEqual(['Cannot transfer to the same account'])
  })
})

describe('createTransferSchema account messages', () => {
  /** The same payload the service parses — `date` is a real instant there. */
  const validServiceInput = {
    ...validFormInput,
    date: new Date('2026-02-01T02:15:00.000Z'),
  }

  // One leg at a time, deliberately: emptying *both* legs makes them equal, so
  // the object-level `distinctAccounts` refine fires as well and adds a second
  // (correct, and equally friendly) message under `toAccountId`. Parsing each
  // leg on its own keeps these assertions about the field message alone.
  it.each([
    ['fromAccountId', 'Choose the account to transfer from'],
    ['toAccountId', 'Choose the account to transfer to'],
  ])(
    'carries the friendly %s message server-side — the service parses this schema',
    (field, message) => {
      const issues = issuesOf(createTransferSchema, { ...validServiceInput, [field]: '' })

      expect(messagesFor(issues, field)).toEqual([message])
      for (const issue of issues) {
        expect(issue.message).not.toMatch(RAW_VALIDATION_TEXT)
      }
    },
  )

  it('accepts a complete submission', () => {
    expect(createTransferSchema.safeParse(validServiceInput).success).toBe(true)
  })
})
