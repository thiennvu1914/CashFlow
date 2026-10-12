import * as z from 'zod'
import {
  calendarDateStringSchema,
  optionalCalendarDateSchema,
} from '@/lib/validation/calendar-date'
import {
  CALENDAR_DATE_RE,
  compareCalendarDates,
  isRealCalendarDate,
} from '@/lib/datetime/calendar-date'
import { moneyAmountSchema } from '@/lib/validation/money'

/**
 * A savings goal's and a goal entry's client-supplied fields (spec §4.8, as
 * amended by money-source linking, spec 2026-10-12 §6.7).
 *
 * No Prisma import, for the reason `lib/validation/budget.ts` gives: the goal
 * forms are client components and import these schemas straight into their
 * `zodResolver`, so nothing here may drag the Prisma client into a browser
 * bundle. `currency` and `kind` are therefore literal enums mirroring the
 * schema's own `Currency` / `SavingsGoalEntryKind`, and the service's calls are
 * type-checked against the generated Prisma types, so a divergence fails `tsc`
 * rather than reaching the database.
 *
 * Every field carries product copy. A Zod default message ("Invalid input",
 * "Too small: expected string to have >=1 characters") is a developer's
 * sentence, and these strings are rendered verbatim under a form field —
 * `savings-goal.test.ts` asserts that none of them can leak.
 *
 * `status` is deliberately absent from every schema: ACHIEVED is derived from
 * progress against target, and ARCHIVED is set only by `archiveSavingsGoal`. A
 * client that posts a status is ignored, not obeyed. Progress itself is not an
 * input at all any more: it is a linked account's balance or the sum of the
 * goal's entries.
 */

/** Shared so the create form and the edit form cannot word the same field
 *  differently. */
const savingsGoalFields = {
  name: z
    .string({ error: 'Enter a name' })
    .trim()
    .min(1, 'Enter a name')
    .max(100, 'Keep the name under 100 characters'),
  /** Strictly positive, matching `SavingsGoal_targetAmount_positive`: a goal of
   *  zero is already met and can never be progressed. */
  targetAmount: moneyAmountSchema.refine((v) => v > 0, 'Target must be greater than zero'),
  /** With a linked account, ignored by the service: the goal takes the
   *  account's currency (spec 2026-10-12 §6.7). */
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
  /**
   * The account whose derived balance IS this goal's progress; absent means
   * "not linked", and the goal's own entries are its progress. Same field and
   * copy as the debt and reminder forms' account: an id or nothing. Whether it
   * is the user's own, active account is decided by the service.
   */
  linkedAccountId: z.string({ error: 'Choose an account' }).min(1, 'Choose an account').optional(),
}

/**
 * Create takes the definition plus, optionally, what is already saved — which
 * the service records as the goal's first CONTRIBUTION, dated today, rather
 * than as an absolute figure. `>= 0` so a typed `0` reads as "nothing yet"
 * (the service records no entry for it).
 *
 * A linked goal's progress is its account's balance, so an opening amount there
 * would be a contribution the goal can never show — refused on the field
 * itself, so the form highlights it.
 */
export const createSavingsGoalSchema = z
  .object({
    ...savingsGoalFields,
    initialContribution: moneyAmountSchema
      .refine((v) => v >= 0, 'Progress cannot be negative')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.linkedAccountId !== undefined &&
      value.initialContribution !== undefined &&
      value.initialContribution > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['initialContribution'],
        message: 'A linked goal follows its account balance — leave this empty',
      })
    }
  })

/**
 * An edit changes the goal's definition — and which source its progress comes
 * from — but never the progress itself: that moves through entries (or the
 * linked account). Absent `linkedAccountId` unlinks, exactly as an absent
 * deadline clears the deadline: the edit form always posts the whole
 * definition. Switching keeps the goal's entries (spec §6.7).
 */
export const updateSavingsGoalSchema = z.object({ ...savingsGoalFields })

/**
 * One "+ contribution" or "− withdrawal" on an unlinked goal (spec §6.7).
 *
 * `amount` is strictly positive — the sign is `kind`, never the number, the way
 * a transaction's sign is its type — and the database's
 * `SavingsGoalEntry_amount_nonnegative` is the backstop. Whether a withdrawal
 * fits under what is saved is a cross-row question the service answers under
 * the goal's row lock.
 */
const savingsGoalEntryFields = z.object({
  kind: z.enum(['CONTRIBUTION', 'WITHDRAWAL'], { error: 'Choose contribute or withdraw' }),
  amount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  /**
   * Required: an entry happened on a day, and which day is what the history is
   * for. Fronted with its own `z.string().min(1)` so the reachable empty cases
   * (an untouched date input's `''`, a missing key) get copy about this field;
   * a malformed or impossible value gets `calendarDateStringSchema`'s shared
   * wording — the same shape as a debt payment's date.
   */
  date: z.string({ error: 'Enter a date' }).min(1, 'Enter a date').pipe(calendarDateStringSchema),
  note: z
    .string({ error: 'Enter the note as text' })
    .max(500, 'Keep the note under 500 characters')
    .optional(),
})

/**
 * The entry schema for a user whose calendar day is `today`
 * (`todayCalendarDateInZone(user.timezone)`): an entry may not be dated after
 * it (ruling P11). Money put aside tomorrow has not been put aside yet — a
 * linked goal's account balance counts nothing dated after now either, so the
 * two progress sources agree on what "saved" means.
 *
 * A factory rather than a constant because "today" belongs to the user's zone,
 * which neither this module nor a browser clock knows: the action builds it
 * from the session, the service from the context it is given, and a form from
 * the day its page was rendered for. The refinement sits on `date` so a form
 * highlights that field.
 *
 * Zod runs an object refinement even when a field already failed, so a date
 * that is not a real calendar date is left to the field's own message rather
 * than compared (and given a second, misleading one).
 */
export function savingsGoalEntrySchema(today: string) {
  return savingsGoalEntryFields.refine(
    (entry) => !isCalendarDate(entry.date) || compareCalendarDates(entry.date, today) <= 0,
    { message: 'The date cannot be later than today', path: ['date'] },
  )
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && CALENDAR_DATE_RE.test(value) && isRealCalendarDate(value)
}

/**
 * @deprecated Transitional (money-source linking Task 9 → Task 10): the
 * Savings page's "Cập nhật tiến độ / Update progress" dialog still posts an
 * absolute "current amount". The service records the difference as one entry
 * rather than overwriting anything. Removed with that dialog when the
 * contribute/withdraw UI lands.
 */
export const updateSavingsGoalProgressSchema = z.object({
  progress: moneyAmountSchema.refine((v) => v >= 0, 'Progress cannot be negative'),
})

export type CreateSavingsGoalInput = z.infer<typeof createSavingsGoalSchema>
export type UpdateSavingsGoalInput = z.infer<typeof updateSavingsGoalSchema>
export type SavingsGoalEntryInput = z.infer<typeof savingsGoalEntryFields>
/** @deprecated See `updateSavingsGoalProgressSchema`. */
export type UpdateSavingsGoalProgressInput = z.infer<typeof updateSavingsGoalProgressSchema>
