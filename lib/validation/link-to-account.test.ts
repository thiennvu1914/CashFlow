import { describe, expect, it } from 'vitest'
import { linkDebtToAccountSchema } from './debt'
import { linkToAccountFormSchema, unlinkFromAccountSchema } from './link-to-account'
import { linkLoanToAccountSchema } from './loan'

/**
 * The "Record in an account" dialog's own schema (spec 2026-10-12 §6.4): one
 * shape for a debt and a loan, with the date as `date`, which each dialog
 * renames to its action's `openedOn` / `disbursedOn`. It is built from the same
 * field schemas as `linkDebtToAccountSchema` and `linkLoanToAccountSchema`, so
 * the dialog cannot accept what its action refuses, or word a field
 * differently.
 */

const VALID = { accountId: 'acc_1', date: '2026-03-01', includePayments: true }

function messagesFor(input: unknown): string[] {
  const result = linkToAccountFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe('linkToAccountFormSchema', () => {
  it('accepts an account, a calendar date and the payments choice', () => {
    expect(linkToAccountFormSchema.parse(VALID)).toEqual(VALID)
  })

  it.each([
    [{ accountId: '' }, 'Choose an account'],
    [{ date: '' }, 'Enter the date the money moved'],
    [{ date: '2026-02-30' }, 'Enter a real date'],
    [{ includePayments: 'yes' }, 'Choose whether to record the existing payments'],
  ])('rejects %o with the same copy as the actions', (patch, message) => {
    expect(messagesFor({ ...VALID, ...patch })).toEqual([message])
  })

  it("agrees with the debt and the loan action's schema on every field", () => {
    for (const patch of [{}, { accountId: '' }, { date: '01/03/2026' }, { includePayments: 0 }]) {
      const { date, ...rest } = { ...VALID, ...patch }
      const form = linkToAccountFormSchema.safeParse({ ...rest, date })
      const debt = linkDebtToAccountSchema.safeParse({ ...rest, openedOn: date })
      const loan = linkLoanToAccountSchema.safeParse({ ...rest, disbursedOn: date })
      expect(debt.success).toBe(form.success)
      expect(loan.success).toBe(form.success)
    }
  })
})

describe('unlinkFromAccountSchema', () => {
  it('takes only the payments choice, and drops anything else', () => {
    expect(unlinkFromAccountSchema.parse({ includePayments: false, accountId: 'acc_1' })).toEqual({
      includePayments: false,
    })
  })

  it.each([[{}], [{ includePayments: 'yes' }]])('refuses %o with product copy', (input) => {
    const result = unlinkFromAccountSchema.safeParse(input)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Choose whether to remove the recorded payments too',
    ])
  })
})
