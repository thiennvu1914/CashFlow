import { z } from 'zod'
import { moneyAmountSchema } from '@/lib/validation/money'

/**
 * The two `max` messages are ones a user can actually reach (Task 17, owner
 * item H3): neither the name field nor the description carries a `maxLength`,
 * so 101 characters of name or a pasted 501 of description lands on these
 * rules and their message goes straight to the field. Left bare, Zod's own
 * "Too big: expected string to have <=100 characters" was what appeared —
 * validator internals, in English, under a Vietnamese form. The RULES are
 * unchanged; only the copy is new.
 */
export const createFinancialAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Keep the name under 100 characters'),
  accountTypeId: z.string().min(1, 'Choose an account type'),
  initialBalance: moneyAmountSchema,
  currency: z.enum(['VND', 'USD']),
  description: z.string().max(500, 'Keep the description under 500 characters').optional(),
})

export const updateFinancialAccountSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Keep the name under 100 characters')
    .optional(),
  accountTypeId: z.string().min(1, 'Choose an account type').optional(),
  description: z.string().max(500, 'Keep the description under 500 characters').optional(),
  initialBalance: moneyAmountSchema.optional(),
  currency: z.enum(['VND', 'USD']).optional(),
})

export type CreateFinancialAccountInput = z.infer<typeof createFinancialAccountSchema>
export type UpdateFinancialAccountInput = z.infer<typeof updateFinancialAccountSchema>
