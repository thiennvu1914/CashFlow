import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { createLoanSchema, recordLoanPaymentSchema, updateLoanSchema } from './loan'

/**
 * What this suite is for is the *copy* and the *split*, in that order.
 *
 * Every message these schemas produce is rendered verbatim under a form field
 * (Group 5's loan and instalment forms), so a Zod default — "Invalid input:
 * expected number, received NaN", "Too big: expected number to be <=100" —
 * reaching a user is a product bug, not a cosmetic one. The `NO_RAW_ZOD_TEXT`
 * case below walks every rejection this suite can provoke and asserts none of
 * them reads like that.
 *
 * The split (`totalAmount = principalAmount + interestAmount`) is checked here
 * in exact cents rather than with a float tolerance, and the cases below are
 * the two a tolerance gets wrong: `0.03 = 0.01 + 0.02`, which fails a naive
 * `===` because the doubles sum to 0.030000000000000002, and a large-magnitude
 * total where the same addition loses its last cent.
 *
 * The other thing pinned here is the immutability ruling: `updateLoanSchema`
 * carries only `lender`, `scheduledPaymentAmount` and `notes`.
 */

/** The shapes Zod's own messages take, none of which may reach a form. */
const RAW_ZOD_TEXT = /expected|Too small|Too big|Invalid input/i

const VALID_LOAN = {
  lender: 'Vietcombank',
  principal: 100_000_000,
  currency: 'VND' as const,
  interestRate: 8.5,
  startDate: '2026-01-01',
  termMonths: 24,
  paymentFrequency: 'MONTHLY' as const,
  scheduledPaymentAmount: 4_600_000,
  nextDueDate: '2026-02-01',
  notes: 'Home improvement loan',
}

const VALID_PAYMENT = {
  totalAmount: 90_000,
  principalAmount: 80_000,
  interestAmount: 10_000,
  paymentDate: '2026-03-15',
  note: 'February instalment',
}

/** Every message a failed parse produced, flattened across fields. */
function messagesFor(schema: ZodType, input: unknown): string[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => issue.message)
}

describe('createLoanSchema', () => {
  it('accepts a fully specified loan', () => {
    expect(createLoanSchema.parse(VALID_LOAN)).toEqual(VALID_LOAN)
  })

  it('accepts a loan with no notes — the minimum a user can type', () => {
    const parsed = createLoanSchema.parse({
      lender: 'Family',
      principal: 2_000,
      currency: 'USD',
      interestRate: 0,
      startDate: '2026-01-01',
      termMonths: 6,
      paymentFrequency: 'WEEKLY',
      scheduledPaymentAmount: 100,
      nextDueDate: '2026-02-01',
    })

    expect(parsed.notes).toBeUndefined()
  })

  it('accepts a zero interest rate and a rate with three decimals', () => {
    // An interest-free family loan is real, and Vietnamese bank rates are quoted
    // to three decimals (7.125 %), which is exactly what `Decimal(6, 3)` holds.
    expect(createLoanSchema.parse({ ...VALID_LOAN, interestRate: 0 }).interestRate).toBe(0)
    expect(createLoanSchema.parse({ ...VALID_LOAN, interestRate: 7.125 }).interestRate).toBe(7.125)
    expect(createLoanSchema.parse({ ...VALID_LOAN, interestRate: 100 }).interestRate).toBe(100)
  })

  it('trims the lender, so a space-only name is not a lender', () => {
    expect(createLoanSchema.parse({ ...VALID_LOAN, lender: '  BIDV  ' }).lender).toBe('BIDV')
    expect(messagesFor(createLoanSchema, { ...VALID_LOAN, lender: '   ' })).toEqual([
      'Enter the lender',
    ])
  })

  it.each([
    [{ lender: '' }, 'Enter the lender'],
    [{ lender: undefined }, 'Enter the lender'],
    [{ lender: 'x'.repeat(101) }, 'Keep the lender under 100 characters'],
    [{ principal: 0 }, 'Amount must be greater than zero'],
    [{ principal: -1 }, 'Amount must be greater than zero'],
    [{ principal: undefined }, 'Enter an amount'],
    // An emptied `<input type="number">` with `valueAsNumber` arrives as NaN.
    [{ principal: Number.NaN }, 'Enter an amount'],
    [{ principal: 10.001 }, 'Use at most 2 decimal places'],
    [{ principal: 1e14 }, 'Amount is too large'],
    [{ currency: undefined }, 'Choose a currency'],
    [{ currency: 'EUR' }, 'Choose a currency'],
    [{ interestRate: undefined }, 'Enter the interest rate'],
    [{ interestRate: Number.NaN }, 'Enter the interest rate'],
    [{ interestRate: '8.5' }, 'Enter the interest rate'],
    [{ interestRate: -0.5 }, 'Rate cannot be negative'],
    [{ interestRate: 100.5 }, 'Rate cannot exceed 100 %'],
    // `Decimal(6, 3)` would round a fourth decimal away silently.
    [{ interestRate: 8.1234 }, 'Use at most 3 decimal places'],
    [{ startDate: '01/01/2026' }, 'Enter a date as yyyy-MM-dd'],
    [{ startDate: '2026-02-30' }, 'Enter a real date'],
    [{ startDate: undefined }, 'Enter a date as yyyy-MM-dd'],
    [{ termMonths: undefined }, 'Enter the term in months'],
    [{ termMonths: Number.NaN }, 'Enter the term in months'],
    [{ termMonths: 12.5 }, 'Whole months only'],
    [{ termMonths: 0 }, 'The term must be at least 1 month'],
    [{ termMonths: -12 }, 'The term must be at least 1 month'],
    [{ termMonths: 601 }, 'The term cannot exceed 600 months'],
    [{ paymentFrequency: undefined }, 'Choose a payment frequency'],
    [{ paymentFrequency: 'DAILY' }, 'Choose a payment frequency'],
    [{ scheduledPaymentAmount: 0 }, 'Amount must be greater than zero'],
    [{ scheduledPaymentAmount: undefined }, 'Enter an amount'],
    [{ scheduledPaymentAmount: 1.005 }, 'Use at most 2 decimal places'],
    [{ nextDueDate: '2026-13-01' }, 'Enter a real date'],
    [{ nextDueDate: '' }, 'Enter a date as yyyy-MM-dd'],
    [{ notes: 'x'.repeat(501) }, 'Keep the notes under 500 characters'],
  ])('rejects %o with product copy', (patch, message) => {
    expect(messagesFor(createLoanSchema, { ...VALID_LOAN, ...patch })).toContain(message)
  })

  it('strips a client-supplied status and due day', () => {
    // Neither is the form's business: a loan is created ACTIVE, only `closeLoan`
    // changes that, and `dueDayOfMonth` is the anchor the service derives from
    // `nextDueDate` — a crafted request must not be able to set a schedule the
    // dates do not agree with.
    const parsed = createLoanSchema.parse({
      ...VALID_LOAN,
      ...({ status: 'CLOSED', dueDayOfMonth: 5 } as object),
    })

    expect('status' in parsed).toBe(false)
    expect('dueDayOfMonth' in parsed).toBe(false)
  })

  it('keeps both dates as strings rather than coercing them to Dates', () => {
    // A start date and a due date are calendar dates (ruling R6-7), and only
    // `calendarDateToUtcCarrier` in the service turns one into a stored instant.
    // `z.coerce.date()` here would make the *server's* timezone part of which
    // day a loan started on.
    const parsed = createLoanSchema.parse(VALID_LOAN)

    expect(parsed.startDate).toBe('2026-01-01')
    expect(parsed.nextDueDate).toBe('2026-02-01')
    expect(typeof parsed.startDate).toBe('string')
    expect(typeof parsed.nextDueDate).toBe('string')
  })
})

describe('updateLoanSchema', () => {
  it('accepts the three editable fields', () => {
    const parsed = updateLoanSchema.parse({
      lender: 'Vietcombank (refinanced)',
      scheduledPaymentAmount: 4_800_000,
      notes: 'Instalment went up',
    })

    expect(parsed).toEqual({
      lender: 'Vietcombank (refinanced)',
      scheduledPaymentAmount: 4_800_000,
      notes: 'Instalment went up',
    })
  })

  it('has none of the loan-defining fields at all', () => {
    // The immutability ruling, asserted on the schema rather than trusted to the
    // service: these define the loan's terms, and an edit that could change one
    // after instalments exist would re-interpret that history against terms the
    // loan never had. Zod strips them, so a crafted request cannot smuggle one
    // through either.
    const parsed = updateLoanSchema.parse({
      lender: 'Vietcombank',
      scheduledPaymentAmount: 4_600_000,
      ...({
        principal: 1,
        currency: 'USD',
        interestRate: 0,
        startDate: '2020-01-01',
        termMonths: 1,
        paymentFrequency: 'WEEKLY',
        nextDueDate: '2020-01-01',
        dueDayOfMonth: 1,
        status: 'CLOSED',
      } as object),
    })

    expect(parsed).toEqual({ lender: 'Vietcombank', scheduledPaymentAmount: 4_600_000 })
  })

  it('applies the same lender, amount and notes rules as create', () => {
    expect(messagesFor(updateLoanSchema, { lender: '', scheduledPaymentAmount: 1 })).toEqual([
      'Enter the lender',
    ])
    expect(messagesFor(updateLoanSchema, { lender: 'A', scheduledPaymentAmount: 0 })).toEqual([
      'Amount must be greater than zero',
    ])
    expect(
      messagesFor(updateLoanSchema, {
        lender: 'A',
        scheduledPaymentAmount: 1,
        notes: 'x'.repeat(501),
      }),
    ).toEqual(['Keep the notes under 500 characters'])
  })
})

describe('recordLoanPaymentSchema', () => {
  it('accepts an instalment split into principal and interest', () => {
    expect(recordLoanPaymentSchema.parse(VALID_PAYMENT)).toEqual(VALID_PAYMENT)
  })

  it('accepts an instalment with no note', () => {
    const parsed = recordLoanPaymentSchema.parse({
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-03-15',
    })

    expect(parsed.note).toBeUndefined()
  })

  it('accepts an interest-only instalment', () => {
    // Ruling R6-6: the early months of many loans, and every grace period, are
    // interest only. A zero principal part is a real instalment, not an error.
    const parsed = recordLoanPaymentSchema.parse({
      ...VALID_PAYMENT,
      totalAmount: 5_000,
      principalAmount: 0,
      interestAmount: 5_000,
    })

    expect(parsed.principalAmount).toBe(0)
    expect(parsed.interestAmount).toBe(5_000)
  })

  it('accepts a principal-only instalment', () => {
    // The mirror case: a 0 % loan, or the final sweep of what is left.
    const parsed = recordLoanPaymentSchema.parse({
      ...VALID_PAYMENT,
      totalAmount: 80_000,
      principalAmount: 80_000,
      interestAmount: 0,
    })

    expect(parsed.interestAmount).toBe(0)
  })

  it('rejects a total that is not the principal plus the interest, on the total field', () => {
    const result = recordLoanPaymentSchema.safeParse({
      ...VALID_PAYMENT,
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 9_999.99,
    })

    expect(result.success).toBe(false)
    const issues = result.success ? [] : result.error.issues
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toBe('Total must equal principal plus interest')
    // On `totalAmount` rather than at the object root, so the form shows the
    // error under a field the user can actually correct.
    expect(issues[0].path).toEqual(['totalAmount'])
  })

  it('compares the split in exact cents rather than in floats', () => {
    // 0.01 + 0.02 as doubles is 0.030000000000000002, so a plain `===` would
    // reject this perfectly valid instalment.
    expect(
      recordLoanPaymentSchema.safeParse({
        ...VALID_PAYMENT,
        totalAmount: 0.03,
        principalAmount: 0.01,
        interestAmount: 0.02,
      }).success,
    ).toBe(true)
    // And at a magnitude where the same addition loses its last cent.
    expect(
      recordLoanPaymentSchema.safeParse({
        ...VALID_PAYMENT,
        totalAmount: 99_999_999_999.99,
        principalAmount: 99_999_999_999.98,
        interestAmount: 0.01,
      }).success,
    ).toBe(true)
    // A single cent out is still a rejection: there is no tolerance at all.
    expect(
      recordLoanPaymentSchema.safeParse({
        ...VALID_PAYMENT,
        totalAmount: 0.04,
        principalAmount: 0.01,
        interestAmount: 0.02,
      }).success,
    ).toBe(false)
  })

  it.each([
    [{ totalAmount: 0, principalAmount: 0, interestAmount: 0 }, 'Amount must be greater than zero'],
    [{ totalAmount: -1 }, 'Amount must be greater than zero'],
    [{ totalAmount: undefined }, 'Enter an amount'],
    [{ totalAmount: Number.NaN }, 'Enter an amount'],
    [{ totalAmount: 90_000.001 }, 'Use at most 2 decimal places'],
    [{ principalAmount: -1 }, 'The principal cannot be negative'],
    [{ principalAmount: undefined }, 'Enter an amount'],
    [{ principalAmount: Number.NaN }, 'Enter an amount'],
    [{ interestAmount: -1 }, 'The interest cannot be negative'],
    [{ interestAmount: undefined }, 'Enter an amount'],
    // A required date, so an empty or missing one gets copy about *this* field
    // rather than advice about a format the user never typed — the same wording
    // `recordDebtPaymentSchema.date` uses, because the same gesture on the two
    // payment forms must not produce two different messages (ruling R6-16).
    [{ paymentDate: '' }, 'Enter a payment date'],
    [{ paymentDate: undefined }, 'Enter a payment date'],
    [{ paymentDate: null }, 'Enter a payment date'],
    // A malformed or impossible value still gets the shared calendar-date
    // wording, so an instalment date and a due date fail identically for the
    // same typo.
    [{ paymentDate: '15/03/2026' }, 'Enter a date as yyyy-MM-dd'],
    [{ paymentDate: '2026-02-30' }, 'Enter a real date'],
    [{ note: 'x'.repeat(501) }, 'Keep the note under 500 characters'],
  ])('rejects %o with product copy', (patch, message) => {
    expect(messagesFor(recordLoanPaymentSchema, { ...VALID_PAYMENT, ...patch })).toContain(message)
  })

  it('keeps the payment date as a string rather than coercing it to a Date', () => {
    const parsed = recordLoanPaymentSchema.parse(VALID_PAYMENT)

    expect(parsed.paymentDate).toBe('2026-03-15')
    expect(typeof parsed.paymentDate).toBe('string')
  })
})

describe('no raw Zod text reaches a form', () => {
  it('answers every reachable rejection with product copy', () => {
    const cases: [ZodType, unknown][] = [
      [createLoanSchema, {}],
      [createLoanSchema, { ...VALID_LOAN, lender: 42 }],
      [createLoanSchema, { ...VALID_LOAN, lender: '' }],
      [createLoanSchema, { ...VALID_LOAN, lender: 'x'.repeat(101) }],
      [createLoanSchema, { ...VALID_LOAN, principal: '100000000' }],
      [createLoanSchema, { ...VALID_LOAN, principal: Number.NaN }],
      [createLoanSchema, { ...VALID_LOAN, principal: 0 }],
      [createLoanSchema, { ...VALID_LOAN, principal: 1.234 }],
      [createLoanSchema, { ...VALID_LOAN, currency: 'EUR' }],
      [createLoanSchema, { ...VALID_LOAN, currency: null }],
      [createLoanSchema, { ...VALID_LOAN, interestRate: null }],
      [createLoanSchema, { ...VALID_LOAN, interestRate: Number.NaN }],
      [createLoanSchema, { ...VALID_LOAN, interestRate: -1 }],
      [createLoanSchema, { ...VALID_LOAN, interestRate: 101 }],
      [createLoanSchema, { ...VALID_LOAN, interestRate: 1.2345 }],
      [createLoanSchema, { ...VALID_LOAN, interestRate: Number.POSITIVE_INFINITY }],
      [createLoanSchema, { ...VALID_LOAN, startDate: null }],
      [createLoanSchema, { ...VALID_LOAN, startDate: 20260101 }],
      [createLoanSchema, { ...VALID_LOAN, startDate: ['2026-01-01'] }],
      [createLoanSchema, { ...VALID_LOAN, startDate: '2026-02-30' }],
      [createLoanSchema, { ...VALID_LOAN, termMonths: null }],
      [createLoanSchema, { ...VALID_LOAN, termMonths: Number.NaN }],
      [createLoanSchema, { ...VALID_LOAN, termMonths: 0 }],
      [createLoanSchema, { ...VALID_LOAN, termMonths: 12.5 }],
      [createLoanSchema, { ...VALID_LOAN, termMonths: 601 }],
      [createLoanSchema, { ...VALID_LOAN, paymentFrequency: 'DAILY' }],
      [createLoanSchema, { ...VALID_LOAN, paymentFrequency: null }],
      [createLoanSchema, { ...VALID_LOAN, scheduledPaymentAmount: 0 }],
      [createLoanSchema, { ...VALID_LOAN, scheduledPaymentAmount: Number.NaN }],
      [createLoanSchema, { ...VALID_LOAN, nextDueDate: '' }],
      [createLoanSchema, { ...VALID_LOAN, nextDueDate: '2026-13-01' }],
      [createLoanSchema, { ...VALID_LOAN, notes: false }],
      [createLoanSchema, { ...VALID_LOAN, notes: 'x'.repeat(501) }],
      [updateLoanSchema, {}],
      [updateLoanSchema, { lender: '   ', scheduledPaymentAmount: 1 }],
      [updateLoanSchema, { lender: 'A', scheduledPaymentAmount: '1' }],
      [updateLoanSchema, { lender: 'A', scheduledPaymentAmount: 1, notes: 99 }],
      [recordLoanPaymentSchema, {}],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, totalAmount: '90000' }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, totalAmount: Number.NaN }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, totalAmount: 100_000 }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, principalAmount: -1 }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, principalAmount: null }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, interestAmount: -1 }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, interestAmount: 1e14 }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, paymentDate: '' }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, paymentDate: null }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, paymentDate: 20260315 }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, paymentDate: ['2026-03-15'] }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, note: 12 }],
      [recordLoanPaymentSchema, { ...VALID_PAYMENT, note: 'x'.repeat(501) }],
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
