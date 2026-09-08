import { z } from 'zod'
import {
  calendarDateStringSchema,
  optionalCalendarDateSchema,
} from '@/lib/validation/calendar-date'
import { moneyAmountSchema } from '@/lib/validation/money'

/**
 * A debt's and a debt payment's client-supplied fields (spec §4.9).
 *
 * No Prisma import, for the reason `lib/validation/budget.ts` gives: the debt
 * and payment forms are client components and import these schemas straight
 * into their `zodResolver`, so nothing here may drag the Prisma client into a
 * browser bundle. `direction` and `currency` are therefore literal enums
 * mirroring the schema's own `DebtDirection` / `Currency`, and the service's
 * calls are type-checked against the generated Prisma types, so a divergence
 * fails `tsc` rather than reaching the database.
 *
 * Every field carries product copy. A Zod default message ("Invalid input",
 * "Too small: expected string to have >=1 characters") is a developer's
 * sentence, and these strings are rendered verbatim under a form field —
 * `debt.test.ts` asserts that none of them can leak.
 *
 * `status` is deliberately absent from every schema below: a debt is created
 * ACTIVE and only `writeOffDebt` ever changes that, so a client that posts a
 * status is ignored rather than obeyed. The derived states (OPEN,
 * PARTIALLY_PAID, PAID, OVERDUE) are not stored at all.
 */

/** Shared so the create form and the edit form cannot word the same field
 *  differently — the edit form is the create form minus the three fields that
 *  define the debt. */
const editableDebtFields = {
  person: z
    .string({ error: 'Enter a name' })
    .trim()
    .min(1, 'Enter a name')
    .max(100, 'Keep the name under 100 characters'),
  // The `max` message is the one a user can actually reach: the textarea
  // carries no `maxLength`, so a pasted 501 characters lands here (same field
  // and same reasoning as `transaction.ts` / `savings-goal.ts`). The `error`
  // param is what stops a non-string rendering Zod's own "Invalid input:
  // expected string, received number", which the "no raw Zod text" case in
  // this module's test forbids.
  description: z
    .string({ error: 'Enter the description as text' })
    .max(500, 'Keep the description under 500 characters')
    .optional(),
  dueDate: optionalCalendarDateSchema,
  notes: z
    .string({ error: 'Enter the notes as text' })
    .max(500, 'Keep the notes under 500 characters')
    .optional(),
}

export const createDebtSchema = z.object({
  // "Who owes whom" rather than "direction": the user is answering a question
  // about their own situation, not picking an enum.
  direction: z.enum(['RECEIVABLE', 'PAYABLE'], { error: 'Choose who owes whom' }),
  ...editableDebtFields,
  /** Strictly positive, matching `Debt_originalAmount_positive`: a debt of zero
   *  is already settled and can never receive a payment. */
  originalAmount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  currency: z.enum(['VND', 'USD'], { error: 'Choose a currency' }),
})

/**
 * An edit changes only what can be corrected or renegotiated: who the debt is
 * with, what it was for, when it is due, and any notes.
 *
 * `direction`, `originalAmount` and `currency` are **immutable after creation**
 * (ruling for this group, documented on the model too). They define *which*
 * debt a row is: flipping a RECEIVABLE into a PAYABLE, or changing the amount
 * or currency once payments exist, would silently rewrite history — the
 * existing payments would be re-interpreted against a debt that never had those
 * terms, and a derived outstanding could go negative or become meaningless. The
 * honest correction for a wrong amount is a new debt, so the fields are not in
 * this schema at all and Zod strips them from a crafted request.
 */
export const updateDebtSchema = z.object({ ...editableDebtFields })

export const recordDebtPaymentSchema = z.object({
  amount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  /**
   * Required, unlike a debt's due date — a repayment happened on a day, and
   * which day it was is what the history is for.
   *
   * Fronted with its own `z.string().min(1)` rather than used bare so the two
   * *reachable empty* cases (a submitted-but-untouched date input, which sends
   * `''`, and a missing key) get copy about this field instead of advice about
   * a format the user never typed. A malformed or impossible value still gets
   * `calendarDateStringSchema`'s shared wording, so a payment date and a due
   * date never fail differently for the same typo.
   */
  date: z
    .string({ error: 'Enter a payment date' })
    .min(1, 'Enter a payment date')
    .pipe(calendarDateStringSchema),
  note: z
    .string({ error: 'Enter the note as text' })
    .max(500, 'Keep the note under 500 characters')
    .optional(),
})

export type CreateDebtInput = z.infer<typeof createDebtSchema>
export type UpdateDebtInput = z.infer<typeof updateDebtSchema>
export type RecordDebtPaymentInput = z.infer<typeof recordDebtPaymentSchema>
