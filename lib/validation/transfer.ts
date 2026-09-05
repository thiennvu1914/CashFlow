import { z } from 'zod'
import { moneyAmountSchema } from '@/lib/validation/money'

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
export const createTransferSchema = z
  .object({
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    fromAmount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
    toAmount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
    // `z.coerce.date()` turns an unparseable string into an Invalid Date rather
    // than failing, so the refine is what actually rejects one.
    date: z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid date'),
    note: z.string().max(500).optional(),
  })
  .refine((data) => data.fromAccountId !== data.toAccountId, {
    message: 'Cannot transfer to the same account',
    path: ['toAccountId'],
  })

/** The parsed shape services work with (`date` is a real `Date`). */
export type CreateTransferInput = z.infer<typeof createTransferSchema>

/**
 * The shape a form may submit, before coercion — `date` here is still whatever
 * `z.coerce.date()` accepts (an `<input type="date">` string, typically).
 */
export type CreateTransferFormInput = z.input<typeof createTransferSchema>
