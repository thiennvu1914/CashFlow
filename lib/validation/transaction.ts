import { z } from 'zod'
import { moneyAmountSchema } from '@/lib/validation/money'
import { CALENDAR_DATE_RE } from '@/lib/datetime/calendar-date'

export const transactionTypeSchema = z.enum([
  'INCOME',
  'EXPENSE',
  'CASH_IN',
  'CASH_OUT',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
])

/** The two types that hit the P&L and therefore need a matching category. */
const CATEGORY_REQUIRED_TYPES = new Set<z.infer<typeof transactionTypeSchema>>([
  'INCOME',
  'EXPENSE',
])

/**
 * A transaction's client-supplied fields.
 *
 * `currency` is deliberately absent: it is always a copy of the owning
 * account's currency, derived server-side in the service, so no request body
 * can put a transaction in a currency its account does not hold.
 *
 * `amount` reuses the shared money rule (at most 2 decimal places, magnitude
 * capped) and adds the strictly-positive constraint: the amount column is a
 * magnitude only — the direction of the movement is carried by `type` alone,
 * never by a sign.
 */
/** Everything except `date`, which is the only field the service and the form
 *  disagree about (an instant vs. the user's calendar day — see below). */
const transactionFields = {
  accountId: z.string().min(1),
  categoryId: z.string().min(1).optional(),
  type: transactionTypeSchema,
  amount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  note: z.string().max(500).optional(),
}

const categoryRequirement = {
  check: (data: { type: z.infer<typeof transactionTypeSchema>; categoryId?: string }) =>
    !CATEGORY_REQUIRED_TYPES.has(data.type) || !!data.categoryId,
  options: {
    message: 'Category is required for income and expense transactions',
    path: ['categoryId'],
  },
}

export const createTransactionSchema = z
  .object({
    ...transactionFields,
    // `z.coerce.date()` turns an unparseable string into an Invalid Date rather
    // than failing, so the refine is what actually rejects one.
    date: z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid date'),
  })
  .refine(categoryRequirement.check, categoryRequirement.options)

/**
 * What a *form* submits: identical to `createTransactionSchema` except that
 * `date` stays the raw `yyyy-MM-dd` string the `<input type="date">` produced.
 *
 * A calendar day is not an instant until someone supplies a timezone, and the
 * browser is the wrong place to pick one — the client's zone is not
 * necessarily the user's configured zone, and `new Date('2026-09-05')` is UTC
 * midnight, which is the previous day for everyone behind UTC. So the string
 * travels as a string, and `createTransactionAction` converts it with
 * `calendarDateToInstant` in the session user's IANA zone (ruling R-21b).
 */
export const createTransactionFormSchema = z
  .object({
    ...transactionFields,
    date: z.string().regex(CALENDAR_DATE_RE, 'Enter a valid date'),
  })
  .refine(categoryRequirement.check, categoryRequirement.options)

/** The parsed shape services work with (`date` is a real `Date`). */
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>

/** The shape a form submits and an action accepts (`date` is `yyyy-MM-dd`). */
export type CreateTransactionFormInput = z.infer<typeof createTransactionFormSchema>
