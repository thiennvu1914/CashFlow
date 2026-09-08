import { describe, expect, it, vi } from 'vitest'

/**
 * Unit cases for the two pure functions the payment form derives its Total
 * with. Its own file rather than an addition to `loan-form.test.tsx`, for two
 * reasons: that file is a *markup* test for a different component and mocks a
 * different action (`createLoanAction`), so folding a second module's
 * pure-function cases into it would make its name a lie and its mock set a
 * superset of what it needs; and Group 3 keeps one test file per component
 * under test.
 *
 * `.ts`, not `.tsx`: nothing here renders. Only the module under test is a
 * component file, and importing it needs the same two mocks the markup tests
 * need — `useRouter` throws outside a mounted app router, and the action module
 * pulls in Prisma.
 *
 * What is pinned here is the one piece of novel arithmetic in this group — the
 * total is added in exact cents, so an instalment whose naive float sum would
 * be rejected as "more than 2 decimal places" is still submittable — and the
 * error shaping around it. The other half of the stale-error fix (`register`'s
 * `deps`) is react-hook-form behaviour inside a mounted form and cannot be
 * asserted without a DOM renderer this repo has no dependency for; it is
 * verified against the installed 7.87 source and documented on `DERIVED_FIELD`.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/loan-actions', () => ({
  closeLoanAction: vi.fn(),
  recordLoanPaymentAction: vi.fn(),
  updateLoanAction: vi.fn(),
}))

const { displayTotal, paymentResolver, totalFromParts } = await import('./loan-row-actions')

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

/** One resolver run for a given split. `totalAmount` is deliberately absent
 *  from the input: the form never registers it, and supplying it here would
 *  test a path the form cannot reach. */
function resolve(principalAmount: number, interestAmount: number) {
  return paymentResolver(
    { ...BASE, principalAmount, interestAmount } as never,
    undefined,
    RESOLVER_OPTIONS,
  )
}

describe('totalFromParts', () => {
  it('adds the split in exact cents', () => {
    expect(totalFromParts(3_500_000, 1_500_000)).toBe(5_000_000)
    expect(totalFromParts(0.29, 0.01)).toBe(0.3)
  })

  it('does not inherit the float error a naive sum carries', () => {
    // `1000000.1 + 0.2` is 1000000.2999999999 as a double — ten decimal places,
    // which `moneyAmountSchema` rejects outright ("Use at most 2 decimal
    // places"). Adding in cents is what keeps a real instalment submittable.
    expect(1_000_000.1 + 0.2).not.toBe(1_000_000.3)
    expect(totalFromParts(1_000_000.1, 0.2)).toBe(1_000_000.3)
  })

  it('accepts a zero part, and two zero parts', () => {
    // An interest-only instalment (ruling R6-6) and a final principal sweep are
    // both real; a total of 0 is refused by the schema, not by the arithmetic.
    expect(totalFromParts(0, 1_500_000)).toBe(1_500_000)
    expect(totalFromParts(3_500_000, 0)).toBe(3_500_000)
    expect(totalFromParts(0, 0)).toBe(0)
  })

  it('has no total at all while a part is missing', () => {
    // `valueAsNumber` on an emptied number field yields `NaN`. `null` is what
    // makes the read-only field show an em dash rather than a "0" nobody typed.
    expect(totalFromParts(3_500_000, Number.NaN)).toBeNull()
    expect(totalFromParts(Number.NaN, 1_500_000)).toBeNull()
    expect(totalFromParts(Number.NaN, Number.NaN)).toBeNull()
    expect(totalFromParts(Number.POSITIVE_INFINITY, 1)).toBeNull()
    expect(totalFromParts(1, Number.NEGATIVE_INFINITY)).toBeNull()
  })
})

describe('displayTotal', () => {
  it('shows the sum whenever both parts are valid numbers, including zero', () => {
    expect(displayTotal(3_500_000, 1_500_000)).toBe(5_000_000)
    expect(displayTotal(0, 0)).toBe(0)
  })

  it('treats a blank (NaN) part as zero for display — never a dash', () => {
    // `totalFromParts` would answer `null` for both of these; the read-only
    // Tổng field must still show a figure while the user is mid-edit.
    expect(displayTotal(Number.NaN, 500_000)).toBe(500_000)
    expect(displayTotal(Number.NaN, Number.NaN)).toBe(0)
  })
})

describe('paymentResolver', () => {
  it('submits the derived total, so the figure validated is the figure shown', async () => {
    const { values, errors } = await resolve(3_500_000, 1_500_000)

    expect(errors).toEqual({})
    // `handleSubmit` passes the resolver's `values` to `onValid`, so this is
    // literally the payload the action receives.
    expect(values).toEqual({
      ...BASE,
      principalAmount: 3_500_000,
      interestAmount: 1_500_000,
      totalAmount: 5_000_000,
    })
  })

  it('accepts an instalment whose naive float sum the schema would reject', async () => {
    const { values, errors } = await resolve(1_000_000.1, 0.2)

    expect(errors).toEqual({})
    expect(values.totalAmount).toBe(1_000_000.3)
  })

  it('accepts an interest-only instalment', async () => {
    const { values, errors } = await resolve(0, 1_500_000)

    expect(errors).toEqual({})
    expect(values.totalAmount).toBe(1_500_000)
  })

  it('never fires the split refine, whatever the two parts are', async () => {
    // The equality is arithmetic the form did, so the user can never be told
    // off for it. The refine stays layer one for every other caller — see the
    // three layers on `paymentResolver`.
    for (const [principal, interest] of [
      [3_500_000, 1_500_000],
      [0, 0.01],
      [0.01, 0],
      [1_000_000.1, 0.2],
      [999_999_999.99, 0.01],
    ]) {
      const { errors } = await resolve(principal, interest)
      expect(errors.totalAmount?.message).not.toBe('Total must equal principal plus interest')
    }
  })

  it('reports a zero instalment on the total, because both parts are legitimately zero', async () => {
    const { errors } = await resolve(0, 0)

    // Nothing is wrong with either part — 0 is valid on both — so this message
    // has nowhere else to go, and it is not a duplicate of anything.
    expect(errors.totalAmount?.message).toBe('Amount must be greater than zero')
    expect(errors.principalAmount).toBeUndefined()
    expect(errors.interestAmount).toBeUndefined()
  })

  it('drops the total error that is only an echo of a blank part', async () => {
    const { errors } = await resolve(Number.NaN, 1_500_000)

    // The blank field keeps its message; the read-only Total does not repeat it
    // under a field the user cannot type in.
    expect(errors.principalAmount?.message).toBe('Enter an amount')
    expect(errors.totalAmount).toBeUndefined()
  })

  it('drops it for a blank interest, and for both parts blank', async () => {
    const blankInterest = await resolve(3_500_000, Number.NaN)
    expect(blankInterest.errors.interestAmount?.message).toBe('Enter an amount')
    expect(blankInterest.errors.totalAmount).toBeUndefined()

    const blankBoth = await resolve(Number.NaN, Number.NaN)
    expect(blankBoth.errors.principalAmount?.message).toBe('Enter an amount')
    expect(blankBoth.errors.interestAmount?.message).toBe('Enter an amount')
    expect(blankBoth.errors.totalAmount).toBeUndefined()
  })

  it('never empties the error set by dropping the duplicate', async () => {
    // The guard that matters: `handleSubmit` calls `onValid` as soon as the
    // error set is empty, and `zodResolver`'s failure `values` is `{}` — so an
    // empty-by-subtraction error set would submit an empty instalment.
    for (const [principal, interest] of [
      [Number.NaN, 1_500_000],
      [3_500_000, Number.NaN],
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
    ]) {
      const { errors } = await resolve(principal, interest)
      expect(Object.keys(errors).length).toBeGreaterThan(0)
    }
  })

  it('leaves an error the user can act on where it belongs', async () => {
    // A negative principal is the part's own fault and is reported there, and
    // the total is `NaN`-free so nothing is dropped for the wrong reason.
    const { errors } = await resolve(-1, 1_500_000)

    expect(errors.principalAmount?.message).toBe('The principal cannot be negative')
  })
})
