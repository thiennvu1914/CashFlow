import { z } from 'zod'

export const createCategorySchema = z.object({
  name: z.string().min(1, 'Name is required').max(50),
  type: z.enum(['INCOME', 'EXPENSE']),
  icon: z.string().max(50).optional(),
})

export type CreateCategoryInput = z.infer<typeof createCategorySchema>
