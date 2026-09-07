import { z } from 'zod'
import { moneyAmountSchema } from '@/lib/validation/money'
import { LOCAL_DATE_TIME_RE, isRealLocalDateTime } from '@/lib/datetime/local-date-time'

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
 *  disagree about (an instant vs. the user's local date and time — see below). */
const transactionFields = {
  // Both halves of the message are the same product copy on purpose: a form
  // renders `errors.accountId.message` verbatim, so every way of arriving here
  // has to read as product copy rather than as validator internals. The `error`
  // param covers a missing or non-string value (a crafted request); `min(1)`
  // covers the `''` a `<select>` with no chosen option submits.
  accountId: z.string({ error: 'Choose an account' }).min(1, 'Choose an account'),
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
 * `date` stays the raw `yyyy-MM-ddTHH:mm` string the
 * `<input type="datetime-local">` produced.
 *
 * A local date-time is not an instant until someone supplies a timezone, and
 * the browser is the wrong place to pick one — the client's zone is not
 * necessarily the user's configured zone. So the string travels as a string,
 * and `createTransactionAction` converts it with `localDateTimeToInstant` in
 * the session user's IANA zone; see `lib/datetime/local-date-time.ts`.
 */
export const createTransactionFormSchema = z
  .object({
    ...transactionFields,
    date: z
      .string()
      .regex(LOCAL_DATE_TIME_RE, 'Enter a valid date and time')
      .refine(isRealLocalDateTime, 'Enter a valid date and time'),
  })
  .refine(categoryRequirement.check, categoryRequirement.options)

/** The parsed shape services work with (`date` is a real `Date`). */
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>

/** The shape a form submits and an action accepts (`date` is `yyyy-MM-ddTHH:mm`). */
export type CreateTransactionFormInput = z.infer<typeof createTransactionFormSchema>
