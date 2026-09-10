import { z } from 'zod'

/**
 * `name`'s `max` carries copy rather than Zod's own "Too big: expected string
 * to have <=50 characters" (Task 17, owner item H3): the Categories page's add
 * field has no `maxLength`, so 51 characters really do land on this rule.
 *
 * Where it surfaces: this schema is parsed server-side (the page's inline
 * `'use server'` wrapper returns void, so `CategoryChipList` renders
 * `errors.generic` for any rejection), which is why a user typing 51
 * characters sees the generic message rather than this one — recorded as a
 * deferred finding in the Task 17 report, because making it specific means
 * changing an action's return shape, which Phase 7 forbids. The literal is
 * still the honest message for the rule, and it is what the rejection carries.
 *
 * `icon` has no form field anywhere in the product and is left as it is.
 */
export const createAccountTypeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(50, 'Keep the name under 50 characters'),
  icon: z.string().max(50).optional(),
})

export type CreateAccountTypeInput = z.infer<typeof createAccountTypeSchema>
