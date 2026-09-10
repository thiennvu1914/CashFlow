import { z } from 'zod'

export const createAccountTypeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(50),
  icon: z.string().max(50).optional(),
})

export type CreateAccountTypeInput = z.infer<typeof createAccountTypeSchema>
