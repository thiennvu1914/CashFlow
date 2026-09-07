import { describe, expect, it } from 'vitest'
import { MAX_MONEY_MAGNITUDE, moneyAmountSchema } from './money'

/**
 * `moneyAmountSchema` is exercised end-to-end here (not just its
 * `hasAtMostTwoDecimalPlaces` helper in isolation) because the accept/reject
 * split for a couple of these values only makes sense combined with the
 * magnitude cap — e.g. `1e15` has no fractional digits at all once rendered
 * as a plain decimal string, so it is the magnitude check, not the
 * decimal-place check, that has to reject it.
 *
 * The cap itself is `1e13`, just under the point (~9e13) where a double stops
 * being able to represent every 2-decimal value exactly.
 */
describe('moneyAmountSchema', () => {
  describe('accepts', () => {
    it.each([0.29, 12.34, 0.1, -5.5, 10000000.45, 999999999999.99, 1234567890123.45, 0, 100])(
      '%s',
      (value) => {
        expect(moneyAmountSchema.safeParse(value).success).toBe(true)
      },
    )

    it('accepts 9e12, just under the cap', () => {
      expect(moneyAmountSchema.safeParse(9e12).success).toBe(true)
      expect(moneyAmountSchema.safeParse(9_000_000_000_000.99).success).toBe(true)
    })
  })

  describe('rejects', () => {
    it.each([12.345, 1.005, 1e-7, 1e15, NaN, Infinity])('%s', (value) => {
      expect(moneyAmountSchema.safeParse(value).success).toBe(false)
    })

    it('rejects exactly the cap, 1e13', () => {
      expect(moneyAmountSchema.safeParse(1e13).success).toBe(false)
      expect(moneyAmountSchema.safeParse(-1e13).success).toBe(false)
    })
  })

  it('caps the magnitude at 1e13', () => {
    expect(MAX_MONEY_MAGNITUDE).toBe(1e13)
  })

  /**
   * The message, not just the rejection. Clearing an amount input is the most
   * reachable failure in the app — `valueAsNumber` turns an emptied number
   * field into `NaN` — and Zod 4's base number check absorbs `NaN`,
   * `±Infinity`, `undefined` and non-numbers before `.finite()` or either
   * refine is reached, so the base check's own text is what a form would
   * render. `RAW_VALIDATION_TEXT` is asserted over *every* issue of the failed
   * parse, so no other check can start leaking machine phrasing either.
   */
  describe('message', () => {
    /** Zod's own machine phrasing — never acceptable in a rendered message. */
    const RAW_VALIDATION_TEXT = /expected number|received NaN|Invalid input|Too small|Too big/i

    it.each([
      ['NaN — a cleared number input', NaN],
      ['undefined — a missing field', undefined],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['a string', 'abc'],
    ])('reads "Enter an amount" for %s', (_label, value) => {
      const result = moneyAmountSchema.safeParse(value)

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((issue) => issue.message)).toEqual(['Enter an amount'])
      for (const issue of result.error.issues) {
        expect(issue.message).not.toMatch(RAW_VALIDATION_TEXT)
      }
    })

    it("keeps each refine's own message — the base error param does not swallow them", () => {
      const tooLarge = moneyAmountSchema.safeParse(1e13)
      const tooPrecise = moneyAmountSchema.safeParse(12.345)

      expect(tooLarge.success).toBe(false)
      expect(tooPrecise.success).toBe(false)
      if (tooLarge.success || tooPrecise.success) return
      expect(tooLarge.error.issues.map((i) => i.message)).toEqual(['Amount is too large'])
      expect(tooPrecise.error.issues.map((i) => i.message)).toEqual([
        'Use at most 2 decimal places',
      ])
    })
  })
})
