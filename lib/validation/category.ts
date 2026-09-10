import { z } from 'zod'

/**
 * Same as `account-type.ts`, including where the message surfaces (Task 17,
 * owner item H3): the add field has no `maxLength`, so `name`'s `max` is
 * genuinely reachable and now carries copy instead of Zod's own "Too big: …" —
 * though the Categories page shows `errors.generic` for it, since its inline
 * server-action wrapper returns void. `icon` has no form field and is
 * unchanged.
 */
export const createCategorySchema = z.object({
  name: z.string().min(1, 'Name is required').max(50, 'Keep the name under 50 characters'),
  type: z.enum(['INCOME', 'EXPENSE']),
  icon: z.string().max(50).optional(),
})

export type CreateCategoryInput = z.infer<typeof createCategorySchema>
