import { z } from 'zod'
import { moneyAmountSchema } from '@/lib/validation/money'

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
export const createTransactionSchema = z
  .object({
    accountId: z.string().min(1),
    categoryId: z.string().min(1).optional(),
    type: transactionTypeSchema,
    amount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
    // `z.coerce.date()` turns an unparseable string into an Invalid Date rather
    // than failing, so the refine is what actually rejects one.
    date: z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid date'),
    note: z.string().max(500).optional(),
  })
  .refine((data) => !CATEGORY_REQUIRED_TYPES.has(data.type) || !!data.categoryId, {
    message: 'Category is required for income and expense transactions',
    path: ['categoryId'],
  })

/** The parsed shape services work with (`date` is a real `Date`). */
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>

/**
 * The shape a form may submit, before coercion — `date` here is still whatever
 * `z.coerce.date()` accepts (an `<input type="date">` string, typically). The
 * UI layer can type its resolver against this instead of pre-converting; the
 * service always works with the parsed `CreateTransactionInput`.
 */
export type CreateTransactionFormInput = z.input<typeof createTransactionSchema>
