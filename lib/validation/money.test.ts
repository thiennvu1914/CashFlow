import { describe, expect, it } from 'vitest'
import { moneyAmountSchema } from './money'

/**
 * `moneyAmountSchema` is exercised end-to-end here (not just its
 * `hasAtMostTwoDecimalPlaces` helper in isolation) because the accept/reject
 * split for a couple of these values only makes sense combined with the
 * magnitude cap — e.g. `1e15` has no fractional digits at all once rendered
 * as a plain decimal string, so it is the magnitude check, not the
 * decimal-place check, that has to reject it.
 */
describe('moneyAmountSchema', () => {
  describe('accepts', () => {
    it.each([0.29, 12.34, 0.1, -5.5, 10000000.45, 999999999999.99, 1234567890123.45, 0, 100])(
      '%s',
      (value) => {
        expect(moneyAmountSchema.safeParse(value).success).toBe(true)
      },
    )
  })

  describe('rejects', () => {
    it.each([12.345, 1.005, 1e-7, 1e15, NaN, Infinity])('%s', (value) => {
      expect(moneyAmountSchema.safeParse(value).success).toBe(false)
    })
  })
})
