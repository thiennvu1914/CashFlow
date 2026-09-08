import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { createDebtSchema, recordDebtPaymentSchema, updateDebtSchema } from './debt'

/**
 * What this suite is for is the *copy*, as much as the rules.
 *
 * Every message these schemas produce is rendered verbatim under a form field
 * (Group 3's debt and payment forms), so a Zod default — "Invalid input:
 * expected string, received undefined", "Too small: expected string to have
 * >=1 characters" — reaching a user is a product bug, not a cosmetic one. The
 * `NO_RAW_ZOD_TEXT` case below walks every rejection this suite can provoke and
 * asserts none of them reads like that, which is what makes adding a field
 * without copy fail here rather than in front of a user.
 *
 * The other thing pinned here is the immutability ruling: `updateDebtSchema`
 * carries no `direction`, no `originalAmount` and no `currency`. Those three
 * define *which* debt a row is, and changing one after payments exist would
 * rewrite history rather than correct it.
 */

/** The shapes Zod's own messages take, none of which may reach a form. */
const RAW_ZOD_TEXT = /expected|Too small|Too big|Invalid input/i

const VALID_DEBT = {
  direction: 'RECEIVABLE' as const,
  person: 'Nguyen An',
  description: 'Lent for a motorbike repair',
  originalAmount: 5_000_000,
  currency: 'VND' as const,
  dueDate: '2026-06-30',
  notes: 'Paying back monthly',
}

const VALID_PAYMENT = {
  amount: 1_234.56,
  date: '2026-03-15',
  note: 'First instalment',
}

/** Every message a failed parse produced, flattened across fields. */
function messagesFor(schema: ZodType, input: unknown): string[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => issue.message)
}

describe('createDebtSchema', () => {
  it('accepts a fully specified debt', () => {
    expect(createDebtSchema.parse(VALID_DEBT)).toEqual(VALID_DEBT)
  })

  it('accepts a debt with no description, no due date and no notes', () => {
    // The three optional fields, all absent: the minimum a user can type.
    const parsed = createDebtSchema.parse({
      direction: 'PAYABLE',
      person: 'Binh',
      originalAmount: 200,
      currency: 'USD',
    })

    expect(parsed.description).toBeUndefined()
    expect(parsed.dueDate).toBeUndefined()
    expect(parsed.notes).toBeUndefined()
  })

  it('trims the person, so a space-only name is not a name', () => {
    expect(createDebtSchema.parse({ ...VALID_DEBT, person: '  An  ' }).person).toBe('An')
    expect(messagesFor(createDebtSchema, { ...VALID_DEBT, person: '   ' })).toEqual([
      'Enter a name',
    ])
  })

  it.each([
    [{ direction: undefined }, 'Choose who owes whom'],
    [{ direction: 'BORROWED' }, 'Choose who owes whom'],
    [{ person: '' }, 'Enter a name'],
    [{ person: undefined }, 'Enter a name'],
    [{ person: 'x'.repeat(101) }, 'Keep the name under 100 characters'],
    [{ description: 'x'.repeat(501) }, 'Keep the description under 500 characters'],
    [{ originalAmount: 0 }, 'Amount must be greater than zero'],
    [{ originalAmount: -1 }, 'Amount must be greater than zero'],
    [{ originalAmount: undefined }, 'Enter an amount'],
    // An emptied `<input type="number">` with `valueAsNumber` arrives as NaN.
    [{ originalAmount: Number.NaN }, 'Enter an amount'],
    [{ originalAmount: 10.001 }, 'Use at most 2 decimal places'],
    [{ originalAmount: 1e14 }, 'Amount is too large'],
    [{ currency: undefined }, 'Choose a currency'],
    [{ currency: 'EUR' }, 'Choose a currency'],
    [{ dueDate: '30/06/2026' }, 'Enter a date as yyyy-MM-dd'],
    [{ dueDate: '2026-02-30' }, 'Enter a real date'],
    [{ notes: 'x'.repeat(501) }, 'Keep the notes under 500 characters'],
  ])('rejects %o with product copy', (patch, message) => {
    expect(messagesFor(createDebtSchema, { ...VALID_DEBT, ...patch })).toContain(message)
  })

  it('treats an empty due date as no due date, not as a malformed one', () => {
    // The case `optionalCalendarDateSchema`'s normalisation exists for: an
    // untouched `<input type="date">` submits `''`, and telling the user to
    // "enter a date as yyyy-MM-dd" in a field they deliberately left blank is
    // wrong. A debt with no agreed deadline is entirely normal.
    expect(createDebtSchema.parse({ ...VALID_DEBT, dueDate: '' }).dueDate).toBeUndefined()
    expect(createDebtSchema.parse({ ...VALID_DEBT, dueDate: undefined }).dueDate).toBeUndefined()
  })

  it('strips a client-supplied status', () => {
    // ACTIVE / WRITTEN_OFF is not the create form's business: a debt is created
    // ACTIVE and only `writeOffDebt` changes that.
    const parsed = createDebtSchema.parse({
      ...VALID_DEBT,
      ...({ status: 'WRITTEN_OFF' } as object),
    })

    expect('status' in parsed).toBe(false)
  })
})

describe('updateDebtSchema', () => {
  it('accepts the four editable fields', () => {
    const parsed = updateDebtSchema.parse({
      person: 'Nguyen An',
      description: 'Corrected note',
      dueDate: '2026-09-30',
      notes: 'Agreed a later date',
    })

    expect(parsed).toEqual({
      person: 'Nguyen An',
      description: 'Corrected note',
      dueDate: '2026-09-30',
      notes: 'Agreed a later date',
    })
  })

  it('has no direction, originalAmount or currency field at all', () => {
    // The immutability ruling, asserted on the schema rather than trusted to
    // the service: those three define which debt this is, and an edit that
    // could change them after payments exist would rewrite history. Zod strips
    // them, so a crafted request cannot smuggle one through either.
    const parsed = updateDebtSchema.parse({
      person: 'An',
      ...({ direction: 'PAYABLE', originalAmount: 1, currency: 'USD' } as object),
    })

    expect(parsed).toEqual({ person: 'An' })
  })

  it('applies the same person, description, due date and notes rules as create', () => {
    expect(messagesFor(updateDebtSchema, { person: '' })).toEqual(['Enter a name'])
    expect(messagesFor(updateDebtSchema, { person: 'An', dueDate: '2026-02-30' })).toEqual([
      'Enter a real date',
    ])
    expect(messagesFor(updateDebtSchema, { person: 'An', notes: 'x'.repeat(501) })).toEqual([
      'Keep the notes under 500 characters',
    ])
  })
})

describe('recordDebtPaymentSchema', () => {
  it('accepts an amount, a calendar date and a note', () => {
    expect(recordDebtPaymentSchema.parse(VALID_PAYMENT)).toEqual(VALID_PAYMENT)
  })

  it('accepts a payment with no note', () => {
    expect(recordDebtPaymentSchema.parse({ amount: 100, date: '2026-03-15' }).note).toBeUndefined()
  })

  it.each([
    [{ amount: 0 }, 'Amount must be greater than zero'],
    [{ amount: -1 }, 'Amount must be greater than zero'],
    [{ amount: undefined }, 'Enter an amount'],
    [{ amount: Number.NaN }, 'Enter an amount'],
    [{ amount: 10.001 }, 'Use at most 2 decimal places'],
    [{ amount: 1e14 }, 'Amount is too large'],
    // A required date, so an empty or missing one gets copy about *this* field
    // rather than advice about a format the user never typed.
    [{ date: '' }, 'Enter a payment date'],
    [{ date: undefined }, 'Enter a payment date'],
    [{ date: null }, 'Enter a payment date'],
    [{ date: '15/03/2026' }, 'Enter a date as yyyy-MM-dd'],
    [{ date: '2026-02-30' }, 'Enter a real date'],
    [{ note: 'x'.repeat(501) }, 'Keep the note under 500 characters'],
  ])('rejects %o with product copy', (patch, message) => {
    expect(messagesFor(recordDebtPaymentSchema, { ...VALID_PAYMENT, ...patch })).toContain(message)
  })

  it('keeps the date as a string rather than coercing it to a Date', () => {
    // A payment date is a calendar date (ruling R6-7), and only
    // `calendarDateToUtcCarrier` in the service turns it into a stored
    // instant. `z.coerce.date()` here would make the *server's* timezone part
    // of what day a payment landed on.
    const parsed = recordDebtPaymentSchema.parse(VALID_PAYMENT)

    expect(parsed.date).toBe('2026-03-15')
    expect(typeof parsed.date).toBe('string')
  })
})

describe('no raw Zod text reaches a form', () => {
  it('answers every reachable rejection with product copy', () => {
    const cases: [ZodType, unknown][] = [
      [createDebtSchema, {}],
      [createDebtSchema, { ...VALID_DEBT, direction: 'BORROWED' }],
      [createDebtSchema, { ...VALID_DEBT, direction: null }],
      [createDebtSchema, { ...VALID_DEBT, person: 42 }],
      [createDebtSchema, { ...VALID_DEBT, person: '' }],
      [createDebtSchema, { ...VALID_DEBT, person: 'x'.repeat(101) }],
      [createDebtSchema, { ...VALID_DEBT, description: 7 }],
      [createDebtSchema, { ...VALID_DEBT, description: 'x'.repeat(501) }],
      [createDebtSchema, { ...VALID_DEBT, originalAmount: '5000000' }],
      [createDebtSchema, { ...VALID_DEBT, originalAmount: Number.NaN }],
      [createDebtSchema, { ...VALID_DEBT, originalAmount: 0 }],
      [createDebtSchema, { ...VALID_DEBT, originalAmount: 1.234 }],
      [createDebtSchema, { ...VALID_DEBT, currency: 'EUR' }],
      [createDebtSchema, { ...VALID_DEBT, currency: null }],
      [createDebtSchema, { ...VALID_DEBT, dueDate: null }],
      [createDebtSchema, { ...VALID_DEBT, dueDate: 20260630 }],
      [createDebtSchema, { ...VALID_DEBT, dueDate: ['2026-06-30'] }],
      [createDebtSchema, { ...VALID_DEBT, dueDate: '2026-02-30' }],
      [createDebtSchema, { ...VALID_DEBT, notes: false }],
      [createDebtSchema, { ...VALID_DEBT, notes: 'x'.repeat(501) }],
      [updateDebtSchema, {}],
      [updateDebtSchema, { person: '   ' }],
      [updateDebtSchema, { person: 'An', dueDate: '30/06/2026' }],
      [updateDebtSchema, { person: 'An', description: 99 }],
      [updateDebtSchema, { person: 'An', notes: 'x'.repeat(501) }],
      [recordDebtPaymentSchema, {}],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, amount: '100' }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, amount: Number.NaN }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, amount: 0 }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, amount: Number.POSITIVE_INFINITY }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, date: '' }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, date: null }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, date: 20260315 }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, date: ['2026-03-15'] }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, date: '2026-13-01' }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, note: 12 }],
      [recordDebtPaymentSchema, { ...VALID_PAYMENT, note: 'x'.repeat(501) }],
    ]

    for (const [schema, input] of cases) {
      const messages = messagesFor(schema, input)
      // Each case must actually fail — otherwise the loop would "pass" by
      // producing no messages at all.
      expect(messages.length).toBeGreaterThan(0)
      for (const message of messages) {
        expect(message).not.toMatch(RAW_ZOD_TEXT)
      }
    }
  })
})
