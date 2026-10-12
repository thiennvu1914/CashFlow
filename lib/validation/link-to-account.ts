import * as z from 'zod'
import { calendarDateStringSchema } from '@/lib/validation/calendar-date'

/**
 * "Record in an account" (spec 2026-10-12 §6.4): the fields a debt's and a
 * loan's link share, defined once so `linkDebtToAccountSchema`,
 * `linkLoanToAccountSchema` and the dialog's own `linkToAccountFormSchema`
 * cannot drift apart in rules or in copy.
 *
 * No Prisma import, for the reason `lib/validation/budget.ts` gives: the
 * dialog is a client component and imports the form schema into its
 * `zodResolver`.
 *
 * Both the account and the date are required, unlike on create: there is no
 * "don't record" to choose, because recording is the whole point of the
 * request.
 */
export const linkAccountIdSchema = z
  .string({ error: 'Choose an account' })
  .min(1, 'Choose an account')

/** The day the opening (debt) or disbursement (loan) moved money. Fronted with
 *  its own `min(1)` so an empty date input gets copy about this field, not
 *  advice about a format the user never typed. */
export const linkDateSchema = z
  .string({ error: 'Enter the date the money moved' })
  .min(1, 'Enter the date the money moved')
  .pipe(calendarDateStringSchema)

/** Also record every payment that has no transaction yet. */
export const includePaymentsSchema = z.boolean({
  error: 'Choose whether to record the existing payments',
})

/**
 * The dialog's shape, shared by the debt and the loan versions: the date is
 * plain `date` here, and each version renames it to its action's `openedOn` /
 * `disbursedOn` on submit.
 */
export const linkToAccountFormSchema = z.object({
  accountId: linkAccountIdSchema,
  date: linkDateSchema,
  includePayments: includePaymentsSchema,
})

export type LinkToAccountFormValues = z.infer<typeof linkToAccountFormSchema>
