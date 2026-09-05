import { z } from 'zod'

// Decimal(18, 2) can hold up to 16 integer digits; capping the magnitude well
// under that (1e15) keeps every accepted value representable without
// depending on Postgres to reject an overflow after the fact.
const MAX_MAGNITUDE = 1e15

const money = z
  .number()
  .finite()
  .refine((v) => Math.abs(v) < MAX_MAGNITUDE, {
    message: `Magnitude must be less than ${MAX_MAGNITUDE}`,
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
