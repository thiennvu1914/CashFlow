import { z } from 'zod'
import { moneyAmountSchema } from '@/lib/validation/money'

export const createFinancialAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  accountTypeId: z.string().min(1, 'Choose an account type'),
  initialBalance: moneyAmountSchema,
  currency: z.enum(['VND', 'USD']),
  description: z.string().max(500).optional(),
})

export const updateFinancialAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).optional(),
  accountTypeId: z.string().min(1, 'Choose an account type').optional(),
  description: z.string().max(500).optional(),
  initialBalance: moneyAmountSchema.optional(),
  currency: z.enum(['VND', 'USD']).optional(),
})

export type CreateFinancialAccountInput = z.infer<typeof createFinancialAccountSchema>
export type UpdateFinancialAccountInput = z.infer<typeof updateFinancialAccountSchema>
