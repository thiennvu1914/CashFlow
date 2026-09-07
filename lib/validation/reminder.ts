import { z } from 'zod'
import { calendarDateStringSchema } from '@/lib/validation/calendar-date'
import { moneyAmountSchema } from '@/lib/validation/money'

/**
 * A recurring reminder's client-supplied fields (spec §4.7).
 *
 * No Prisma import, for the reason `lib/validation/budget.ts` gives: the reminder
 * form is a client component and imports this schema straight into its
 * `zodResolver`, so nothing here may drag the Prisma client into a browser
 * bundle. `currency`, `type` and `frequency` are therefore literal enums
 * mirroring the schema's own `Currency` / `ReminderType` /
 * `RecurrenceFrequency`, and the service's `create` call is type-checked against
 * the generated Prisma types, so a divergence fails `tsc` rather than reaching
 * the database.
 *
 * Every field carries product copy. A Zod default message ("Invalid input",
 * "Too big: expected number to be <=99") is a developer's sentence, and these
 * strings are rendered verbatim under a form field — `reminder.test.ts` asserts
 * that none of them can leak.
 *
 * `active` is deliberately absent: a reminder is created active and only
 * `setReminderActive` changes that, so a client that posts one is ignored rather
 * than obeyed. So is anything about occurrences — those are materialized from the
 * schedule on read and are never supplied by a client at all.
 */

/**
 * The two refines below both concern *which fields a frequency gives meaning
 * to*, and both reject rather than quietly drop.
 *
 * Dropping would be the friendlier-looking choice and the wrong one: a user who
 * typed "the 15th" and picked Weekly has told the form two contradictory things,
 * and silently keeping only one of them creates a reminder that fires on a day
 * they did not choose — a bill they then miss. Saying "not applicable for this
 * frequency" under the field they filled in is the honest answer, and it also
 * keeps the stored row unambiguous: `dayOfMonth` and `month` are NULL for WEEKLY
 * and ONE_TIME rows, which is what the `RecurringReminder_dayOfMonth_range` /
 * `_month_range` CHECKs and `lib/server/services/recurrence.ts` both assume.
 *
 * The messages are attached to the offending *field* rather than the object
 * root, so react-hook-form renders each under an input the user can correct — a
 * root-level error has nowhere to appear in the form. And they are separate
 * refines rather than one combined check so a submission that gets both wrong is
 * told about both at once, instead of surfacing the second only after the first
 * is fixed.
 */
const ANCHOR_FREQUENCIES = new Set(['MONTHLY', 'YEARLY'])

export const createReminderSchema = z
  .object({
    title: z
      .string({ error: 'Enter a title' })
      .trim()
      .min(1, 'Enter a title')
      .max(100, 'Keep the title under 100 characters'),
    /** INCOME or EXPENSE. A linked category has to match it, so this is also
     *  what "an INCOME category on an EXPENSE reminder" is checked against in
     *  `lib/server/services/reminder.ts`. */
    type: z.enum(['INCOME', 'EXPENSE'], { error: 'Choose income or expense' }),
    /** Strictly positive, matching `RecurringReminder_expectedAmount_positive`:
     *  a reminder for nothing is nothing to remind anyone of. It is what the
     *  user *expects* to pay or receive, not a recorded amount — no Transaction
     *  is ever created from it. */
    expectedAmount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
    currency: z.enum(['VND', 'USD'], { error: 'Choose a currency' }),
    /**
     * Optional on both: a reminder is useful with neither ("Renew passport fee"),
     * and the account is only where the user *expects* to pay from — a label, not
     * a link that debits anything.
     *
     * Fronted with `.min(1)` so an untouched `<select>` submitting `''` gets copy
     * about choosing, rather than being sent to the service as an id that cannot
     * exist. The service checks ownership, category type and account status; this
     * only checks that something was actually picked.
     */
    categoryId: z.string({ error: 'Choose a category' }).min(1, 'Choose a category').optional(),
    accountId: z.string({ error: 'Choose an account' }).min(1, 'Choose an account').optional(),
    frequency: z.enum(['ONE_TIME', 'WEEKLY', 'MONTHLY', 'YEARLY'], {
      error: 'Choose how often',
    }),
    /**
     * How many periods between occurrences — "every 2 weeks", "every 3 months".
     *
     * The 99 ceiling is a sanity bound rather than a product limit: nothing
     * personal recurs every hundred months, and a mistyped year (2026) in this
     * field would otherwise be stored as a schedule that never fires again.
     * `min(1)` matches `RecurringReminder_interval_min` and is what keeps
     * `computeDueDates` from being handed a non-terminating rule (it throws a
     * RangeError for the same value, as the third layer).
     */
    interval: z
      .number({ error: 'Enter how often it repeats' })
      .int('Whole numbers only')
      .min(1, 'At least every 1')
      .max(99, 'At most every 99'),
    /**
     * The anchor day for a MONTHLY or YEARLY reminder, and the service defaults
     * it from `startDate` when the user does not name one. 31 is accepted and
     * *means* "the 31st, or the last day of a shorter month" — the clamp lives
     * in `lib/datetime/add-months-clamped.ts`, so this field does not have to
     * refuse a day February lacks.
     */
    dayOfMonth: z
      .number({ error: 'Enter the day of the month' })
      .int('Whole numbers only')
      .min(1, 'Pick a day from 1 to 31')
      .max(31, 'Pick a day from 1 to 31')
      .optional(),
    /** The anchor month for a YEARLY reminder, **1–12** in the human numbering
     *  the column stores (not JavaScript's 0–11). Defaulted from `startDate` by
     *  the service when absent. */
    month: z
      .number({ error: 'Enter the month' })
      .int('Whole numbers only')
      .min(1, 'Pick a month from 1 to 12')
      .max(12, 'Pick a month from 1 to 12')
      .optional(),
    /**
     * The first day the reminder can fall on, as a calendar date (ruling R6-7):
     * the same day in every timezone, turned into the instant of *local* midnight
     * by the service alone.
     *
     * Fronted with its own `z.string().min(1)` rather than used bare, exactly as
     * `recordLoanPaymentSchema.paymentDate` is, so the two reachable empty cases
     * (a submitted-but-untouched date input, which sends `''`, and a missing key)
     * get copy about this field instead of advice about a format the user never
     * typed. A malformed or impossible value still gets
     * `calendarDateStringSchema`'s shared wording, so a start date and a payment
     * date never fail differently for the same typo (ruling R6-16).
     */
    startDate: z
      .string({ error: 'Enter a start date' })
      .min(1, 'Enter a start date')
      .pipe(calendarDateStringSchema),
    // The `max` message is the one a user can actually reach: the textarea
    // carries no `maxLength`, so a pasted 501 characters lands here. The `error`
    // param is what stops a non-string rendering Zod's own "Invalid input:
    // expected string, received number".
    note: z
      .string({ error: 'Enter the note as text' })
      .max(500, 'Keep the note under 500 characters')
      .optional(),
  })
  .refine((r) => r.dayOfMonth === undefined || ANCHOR_FREQUENCIES.has(r.frequency), {
    message: 'Not applicable for this frequency',
    path: ['dayOfMonth'],
  })
  .refine((r) => r.month === undefined || ANCHOR_FREQUENCIES.has(r.frequency), {
    message: 'Not applicable for this frequency',
    path: ['month'],
  })
  /**
   * A one-off reminder has no second occurrence for an interval to space out, so
   * "every 3" is meaningless on it. Refused rather than normalised to 1, for the
   * same reason as the anchors: the user typed something the schedule cannot
   * honour, and the honest answer is to say so.
   */
  .refine((r) => r.frequency !== 'ONE_TIME' || r.interval === 1, {
    message: 'A one-time reminder happens once — leave this at 1',
    path: ['interval'],
  })

export type CreateReminderInput = z.infer<typeof createReminderSchema>
