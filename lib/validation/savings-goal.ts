import { z } from 'zod'
import { optionalCalendarDateSchema } from '@/lib/validation/calendar-date'
import { moneyAmountSchema } from '@/lib/validation/money'

/**
 * A savings goal's client-supplied fields (spec §4.8).
 *
 * No Prisma import, for the reason `lib/validation/budget.ts` gives: the goal
 * forms are client components and import these schemas straight into their
 * `zodResolver`, so nothing here may drag the Prisma client into a browser
 * bundle. `currency` is therefore a literal enum mirroring the schema's own
 * `Currency`, and the service's `create`/`update` calls are type-checked
 * against the generated Prisma types, so a divergence fails `tsc` rather than
 * reaching the database.
 *
 * Every field carries product copy. A Zod default message ("Invalid input",
 * "Too small: expected string to have >=1 characters") is a developer's
 * sentence, and these strings are rendered verbatim under a form field —
 * `savings-goal.test.ts` asserts that none of them can leak.
 *
 * `status` is deliberately absent from all three schemas: ACHIEVED is derived
 * from progress against target on every write, and ARCHIVED is set only by
 * `archiveSavingsGoal`. A client that posts a status is ignored, not obeyed.
 */

/** Shared so the create form and the edit form cannot word the same field
 *  differently — the edit form is the create form minus `currentProgress`. */
const savingsGoalFields = {
  name: z
    .string({ error: 'Enter a name' })
    .trim()
    .min(1, 'Enter a name')
    .max(100, 'Keep the name under 100 characters'),
  /** Strictly positive, matching `SavingsGoal_targetAmount_positive`: a goal of
   *  zero is already met and can never be progressed. */
  targetAmount: moneyAmountSchema.refine((v) => v > 0, 'Target must be greater than zero'),
  currency: z.enum(['VND', 'USD'], { error: 'Choose a currency' }),
  deadline: optionalCalendarDateSchema,
  // The `max` message is the one a user can actually reach: the textarea
  // carries no `maxLength`, so a pasted 501 characters lands here (same field
  // and same reasoning as `transaction.ts` / `transfer.ts`). The `error` param
  // is the one addition on top of those two — without it a non-string `note`
  // renders Zod's own "Invalid input: expected string, received number", which
  // the "no raw Zod text" case in this module's test forbids.
  note: z
    .string({ error: 'Enter the note as text' })
    .max(500, 'Keep the note under 500 characters')
    .optional(),
}

/**
 * `>= 0`, not `> 0`, and with no upper bound against the target:
 * `SavingsGoal_currentProgress_nonnegative` is the database's half of the same
 * rule, and over-saving is a real thing a user does — the progress *bar* is
 * clamped in the view model, the stored figure never is.
 */
const currentProgressField = moneyAmountSchema.refine((v) => v >= 0, 'Progress cannot be negative')

export const createSavingsGoalSchema = z.object({
  ...savingsGoalFields,
  // Optional on create, and defaulted to 0 by the service rather than by Zod:
  // "how much do you already have set aside?" is a question the user may
  // reasonably skip, and 0 is not a value they should have to type.
  currentProgress: currentProgressField.optional(),
})

/**
 * An edit changes the goal's definition, never its progress. The two are
 * separate actions because they are separate user intents — "I actually need
 * 60 million, not 50" and "I have saved another 2 million" — and mixing them
 * into one form would make either one an accidental overwrite of the other.
 */
export const updateSavingsGoalSchema = createSavingsGoalSchema.omit({ currentProgress: true })

export const updateSavingsGoalProgressSchema = z.object({
  currentProgress: currentProgressField,
})

export type CreateSavingsGoalInput = z.infer<typeof createSavingsGoalSchema>
export type UpdateSavingsGoalInput = z.infer<typeof updateSavingsGoalSchema>
export type UpdateSavingsGoalProgressInput = z.infer<typeof updateSavingsGoalProgressSchema>
