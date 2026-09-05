import { z } from 'zod'
import { moneyAmountSchema } from '@/lib/validation/money'
import { CALENDAR_DATE_RE } from '@/lib/datetime/calendar-date'

/**
 * An internal transfer's client-supplied fields (spec §4.5).
 *
 * `toAmount` is required, but it is only *believed* for a cross-currency
 * transfer: when both accounts hold the same currency the service derives
 * `toAmount` from `fromAmount` and ignores whatever arrived here, so a crafted
 * request cannot move 100 out of one account and materialise 500 in another.
 * Validating it all the same keeps the cross-currency path honest and keeps
 * one shape for the form to submit.
 *
 * Both amounts reuse the shared money rule (at most 2 decimal places,
 * magnitude capped) and add the strictly-positive constraint: a zero or
 * negative leg is not a transfer. The database repeats both as CHECK
 * constraints, so neither depends on this schema being reached.
 */
/** Everything except `date`, which is the only field the service and the form
 *  disagree about (an instant vs. the user's calendar day — see below). */
const transferFields = {
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  fromAmount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  toAmount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  note: z.string().max(500).optional(),
}

const distinctAccounts = {
  check: (data: { fromAccountId: string; toAccountId: string }) =>
    data.fromAccountId !== data.toAccountId,
  options: {
    message: 'Cannot transfer to the same account',
    path: ['toAccountId'],
  },
}

export const createTransferSchema = z
  .object({
    ...transferFields,
    // `z.coerce.date()` turns an unparseable string into an Invalid Date rather
    // than failing, so the refine is what actually rejects one.
    date: z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid date'),
  })
  .refine(distinctAccounts.check, distinctAccounts.options)

/**
 * What a *form* submits: identical to `createTransferSchema` except that
 * `date` stays the raw `yyyy-MM-dd` string the `<input type="date">`
 * produced. `createTransferAction` converts it to an instant with
 * `calendarDateToInstant` in the session user's IANA zone (ruling R-21b) —
 * see the longer rationale in `lib/datetime/calendar-date.ts`.
 */
export const createTransferFormSchema = z
  .object({
    ...transferFields,
    date: z.string().regex(CALENDAR_DATE_RE, 'Enter a valid date'),
  })
  .refine(distinctAccounts.check, distinctAccounts.options)

/** The parsed shape services work with (`date` is a real `Date`). */
export type CreateTransferInput = z.infer<typeof createTransferSchema>

/** The shape a form submits and an action accepts (`date` is `yyyy-MM-dd`). */
export type CreateTransferFormInput = z.infer<typeof createTransferFormSchema>
