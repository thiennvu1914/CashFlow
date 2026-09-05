import { z } from 'zod'

// Decimal(18, 2) can hold up to 16 integer digits; capping the magnitude well
// under that (1e15) keeps every accepted value representable without
// depending on Postgres to reject an overflow after the fact.
const MAX_MAGNITUDE = 1e15

/**
 * `Decimal(18, 2)` stores exactly 2 fractional digits, so a value with more
 * would silently be rounded by Postgres rather than rejected — the invariant
 * this project holds is that money is never rounded without the user asking
 * for it. `toFixed(10)` (rather than `v * 100`) is what makes the check
 * float-safe: multiplying by 100 first would introduce its own new rounding
 * error (e.g. `12.35 * 100` is `1234.9999999999998` in IEEE 754), whereas
 * `toFixed` renders the float's nearest decimal string directly, and a value
 * that was only ever assigned 2 (or fewer) decimal digits renders with zeros
 * for every digit beyond that position.
 */
function hasAtMostTwoDecimalPlaces(v: number): boolean {
  const fixed = v.toFixed(10)
  const dotIndex = fixed.indexOf('.')
  const fraction = dotIndex === -1 ? '' : fixed.slice(dotIndex + 1)
  return /^0*$/.test(fraction.slice(2))
}

const money = z.number().superRefine((v, ctx) => {
  if (!Number.isFinite(v)) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid amount' })
    return
  }
  if (Math.abs(v) >= MAX_MAGNITUDE) {
    ctx.addIssue({
      code: 'custom',
      message: `Amount must be less than ${MAX_MAGNITUDE.toLocaleString('en-US')}`,
    })
    return
  }
  if (!hasAtMostTwoDecimalPlaces(v)) {
    ctx.addIssue({ code: 'custom', message: 'Use at most 2 decimal places' })
  }
})

export const createFinancialAccountSchema = z.object({
  name: z.string().min(1).max(100),
  accountTypeId: z.string().min(1),
  initialBalance: money,
  currency: z.enum(['VND', 'USD']),
  description: z.string().max(500).optional(),
})

export const updateFinancialAccountSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  accountTypeId: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  initialBalance: money.optional(),
  currency: z.enum(['VND', 'USD']).optional(),
})

export type CreateFinancialAccountInput = z.infer<typeof createFinancialAccountSchema>
export type UpdateFinancialAccountInput = z.infer<typeof updateFinancialAccountSchema>
