import { describe, expect, it } from 'vitest'
import { displayPrincipal, paymentResolver, principalFromParts } from './loan-payment-math'

/**
 * Unit cases for the two pure functions the payment form derives its Gốc
 * (principal) with, and the resolver that wraps them. Its own file rather than
 * an addition to `loan-form.test.tsx`: that file is a *markup* test for a
 * different component and mocks a different action, so folding a second
 * module's pure-function cases into it would make its name a lie.
 *
 * `loan-payment-math.ts` has no React, navigation or action import, so this
 * file needs no mocks at all.
 *
 * What is pinned here is the one piece of novel arithmetic — the principal is
 * the total minus the interest, in exact cents, so an instalment whose naive
 * float difference would be rejected as "more than 2 decimal places" is still
 * submittable — and the error shaping around it. The other half of the
 * stale-error fix (`register`'s `deps`) is react-hook-form behaviour inside a
 * mounted form and cannot be asserted without a DOM renderer this repo has no
 * dependency for; it is verified against the installed source and documented on
 * `DERIVED_FIELD`.
 */

/** The fields the user actually types, with the two amounts left to each case. */
const BASE = {
  paymentDate: '2026-04-15',
  note: undefined,
}

/**
 * What react-hook-form hands a resolver. `fields` is only read by
 * `toNestErrors` to attach a `ref` to each error, so an empty map is enough
 * here; native validation is off, as it is in the form.
 */
const RESOLVER_OPTIONS = { fields: {}, shouldUseNativeValidation: false } as const

/** One resolver run for a given total and interest. `principalAmount` is
 *  deliberately absent from the input: the form never registers it, and
 *  supplying it here would test a path the form cannot reach. */
function resolve(totalAmount: number, interestAmount: number) {
  return paymentResolver(
    { ...BASE, totalAmount, interestAmount } as never,
    undefined,
    RESOLVER_OPTIONS,
  )
}

describe('principalFromParts', () => {
  it('subtracts the interest from the total in exact cents', () => {
    expect(principalFromParts(5_000_000, 1_500_000)).toBe(3_500_000)
    expect(principalFromParts(0.3, 0.01)).toBe(0.29)
  })

  it('does not inherit the float error a naive difference carries', () => {
    // `1000000.3 - 0.2` is 1000000.0999999999 as a double — ten decimal places,
    // which `moneyAmountSchema` rejects outright ("Use at most 2 decimal
    // places"). Subtracting in cents is what keeps a real instalment
    // submittable.
    expect(1_000_000.3 - 0.2).not.toBe(1_000_000.1)
    expect(principalFromParts(1_000_000.3, 0.2)).toBe(1_000_000.1)
  })

  it('is zero for an interest-only instalment and the whole total for a principal-only one', () => {
    // An interest-only instalment (ruling R6-6): the total IS the interest.
    expect(principalFromParts(1_500_000, 1_500_000)).toBe(0)
    expect(principalFromParts(3_500_000, 0)).toBe(3_500_000)
  })

  it('goes negative when the interest exceeds the total, so the form can say so', () => {
    expect(principalFromParts(1_000_000, 1_500_000)).toBe(-500_000)
  })

  it('has no principal at all while a part is missing', () => {
    // `valueAsNumber` on an emptied number field yields `NaN`.
    expect(principalFromParts(5_000_000, Number.NaN)).toBeNull()
    expect(principalFromParts(Number.NaN, 1_500_000)).toBeNull()
    expect(principalFromParts(Number.NaN, Number.NaN)).toBeNull()
    expect(principalFromParts(Number.POSITIVE_INFINITY, 1)).toBeNull()
    expect(principalFromParts(1, Number.NEGATIVE_INFINITY)).toBeNull()
  })
})

describe('displayPrincipal', () => {
  it('shows total minus interest whenever both are valid numbers, including zero', () => {
    expect(displayPrincipal(5_000_000, 1_500_000)).toBe(3_500_000)
    expect(displayPrincipal(1_500_000, 1_500_000)).toBe(0)
    expect(displayPrincipal(0, 0)).toBe(0)
  })

  it('shows a negative principal rather than hiding that the interest is too large', () => {
    expect(displayPrincipal(1_000_000, 1_500_000)).toBe(-500_000)
  })

  it('treats a blank (NaN) part as zero for display — never a dash', () => {
    // `principalFromParts` would answer `null` for these; the read-only Gốc
    // field must still show a figure while the user is mid-edit. The dialog
    // opens with the interest blank, so the principal starts as the whole total.
    expect(displayPrincipal(5_000_000, Number.NaN)).toBe(5_000_000)
    expect(displayPrincipal(Number.NaN, 500_000)).toBe(-500_000)
    expect(displayPrincipal(Number.NaN, Number.NaN)).toBe(0)
  })
})

describe('paymentResolver', () => {
  it('submits the derived principal, so the figure validated is the figure shown', async () => {
    const { values, errors } = await resolve(5_000_000, 1_500_000)

    expect(errors).toEqual({})
    // `handleSubmit` passes the resolver's `values` to `onValid`, so this is
    // literally the payload the action receives.
    expect(values).toEqual({
      ...BASE,
      totalAmount: 5_000_000,
      interestAmount: 1_500_000,
      principalAmount: 3_500_000,
    })
  })

  it('accepts an instalment whose naive float difference the schema would reject', async () => {
    const { values, errors } = await resolve(1_000_000.3, 0.2)

    expect(errors).toEqual({})
    expect(values.principalAmount).toBe(1_000_000.1)
  })

  it('accepts an interest-only instalment (principal 0, total = interest)', async () => {
    const { values, errors } = await resolve(1_500_000, 1_500_000)

    expect(errors).toEqual({})
    expect(values.principalAmount).toBe(0)
    expect(values.interestAmount).toBe(1_500_000)
  })

  it('accepts a zero-interest instalment', async () => {
    const { values, errors } = await resolve(900_000, 0)

    expect(errors).toEqual({})
    expect(values.principalAmount).toBe(900_000)
  })

  it('never fires the split refine, whatever the two parts are', async () => {
    // The equality is arithmetic the form did, so the user can never be told
    // off for it. The refine stays layer one for every other caller — see the
    // three layers on `paymentResolver`.
    for (const [total, interest] of [
      [5_000_000, 1_500_000],
      [0.01, 0],
      [0.01, 0.01],
      [1_000_000.3, 0.2],
      [999_999_999.99, 0.01],
    ]) {
      const { errors } = await resolve(total, interest)
      expect(errors.totalAmount?.message).not.toBe('Total must equal principal plus interest')
    }
  })

  it('reports interest above the total on the principal, the figure that went negative', async () => {
    const { errors } = await resolve(1_000_000, 1_500_000)

    expect(errors.principalAmount?.message).toBe('The principal cannot be negative')
  })

  it('reports a zero total on the total', async () => {
    const { errors } = await resolve(0, 0)

    expect(errors.totalAmount?.message).toBe('Amount must be greater than zero')
    expect(errors.interestAmount).toBeUndefined()
  })

  it('drops the principal error that is only an echo of a blank part', async () => {
    const blankTotal = await resolve(Number.NaN, 1_500_000)
    // The blank field keeps its message; the read-only Gốc does not repeat it
    // under a field the user cannot type in.
    expect(blankTotal.errors.totalAmount?.message).toBe('Enter an amount')
    expect(blankTotal.errors.principalAmount).toBeUndefined()

    const blankInterest = await resolve(5_000_000, Number.NaN)
    expect(blankInterest.errors.interestAmount?.message).toBe('Enter an amount')
    expect(blankInterest.errors.principalAmount).toBeUndefined()

    const blankBoth = await resolve(Number.NaN, Number.NaN)
    expect(blankBoth.errors.totalAmount?.message).toBe('Enter an amount')
    expect(blankBoth.errors.interestAmount?.message).toBe('Enter an amount')
    expect(blankBoth.errors.principalAmount).toBeUndefined()
  })

  it('never empties the error set by dropping the duplicate', async () => {
    // The guard that matters: `handleSubmit` calls `onValid` as soon as the
    // error set is empty, and `zodResolver`'s failure `values` is `{}` — so an
    // empty-by-subtraction error set would submit an empty instalment.
    for (const [total, interest] of [
      [Number.NaN, 1_500_000],
      [5_000_000, Number.NaN],
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
    ]) {
      const { errors } = await resolve(total, interest)
      expect(Object.keys(errors).length).toBeGreaterThan(0)
    }
  })
})
