import { z } from 'zod'
import { calendarDateStringSchema } from '@/lib/validation/calendar-date'
import { moneyAmountSchema } from '@/lib/validation/money'

/**
 * A loan's and a loan instalment's client-supplied fields (spec §4.10).
 *
 * No Prisma import, for the reason `lib/validation/budget.ts` gives: the loan
 * and instalment forms are client components and import these schemas straight
 * into their `zodResolver`, so nothing here may drag the Prisma client into a
 * browser bundle. `currency` and `paymentFrequency` are therefore literal enums
 * mirroring the schema's own `Currency` / `PaymentFrequency`, and the service's
 * calls are type-checked against the generated Prisma types, so a divergence
 * fails `tsc` rather than reaching the database.
 *
 * Every field carries product copy. A Zod default message ("Invalid input",
 * "Too big: expected number to be <=100") is a developer's sentence, and these
 * strings are rendered verbatim under a form field — `loan.test.ts` asserts that
 * none of them can leak.
 *
 * `status` is deliberately absent from every schema below: a loan is created
 * ACTIVE and only `closeLoan` ever changes that. So is `dueDayOfMonth`: the
 * schedule's anchor is *derived* from `nextDueDate` by the service (ruling
 * R6-6a), and letting a client post one would allow a loan whose stored anchor
 * and stored due date disagree. The derived states (PAID_OFF, OVERDUE) are not
 * stored at all.
 */

/**
 * `interestRate` is `Decimal(6, 3)` — exactly 3 fractional digits — so a fourth
 * would be silently rounded by Postgres rather than rejected. Same reasoning and
 * same technique as `hasAtMostTwoDecimalPlaces` in `lib/validation/money.ts`:
 * `String(value)` is JavaScript's shortest round-trip representation, which is
 * what the pg adapter actually serialises, so checking it is magnitude
 * independent and matches what gets written.
 *
 * A rate is not money, so it does not go through `moneyAmountSchema` — it has a
 * different precision (3 dp, not 2), a different range (0–100, not a magnitude
 * cap) and different copy.
 */
function hasAtMostThreeDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value)) return false
  const s = String(value)
  if (s.includes('e')) return false
  const frac = s.split('.')[1]
  return frac === undefined || frac.length <= 3
}

/**
 * A monetary value in exact cents.
 *
 * `moneyAmountSchema` has already refused anything with more than 2 decimal
 * places and anything at or above 1e13, so `v * 100` is an integer below
 * `Number.MAX_SAFE_INTEGER` and `Math.round` removes only the float
 * representation error (`0.29 * 100` is 28.999999999999996). Comparing cents is
 * therefore *exact* — which is why the split refine below needs no tolerance at
 * all, unlike the `< 0.01` epsilon this group's plan proposed: an epsilon is
 * both unnecessary here and dishonest, since it would accept a total that is
 * genuinely a fraction of a cent out.
 */
const cents = (value: number) => Math.round(value * 100)

/** Shared so the create form and the edit form cannot word the same field
 *  differently — the edit form is the create form minus the terms that define
 *  the loan. */
const editableLoanFields = {
  lender: z
    .string({ error: 'Enter the lender' })
    .trim()
    .min(1, 'Enter the lender')
    .max(100, 'Keep the lender under 100 characters'),
  /** Strictly positive, matching `Loan_scheduledPaymentAmount_positive`: an
   *  instalment plan of zero is not a plan. */
  scheduledPaymentAmount: moneyAmountSchema.refine(
    (v) => v > 0,
    'Amount must be greater than zero',
  ),
  // The `max` message is the one a user can actually reach: the textarea carries
  // no `maxLength`, so a pasted 501 characters lands here. The `error` param is
  // what stops a non-string rendering Zod's own "Invalid input: expected string,
  // received number".
  notes: z
    .string({ error: 'Enter the notes as text' })
    .max(500, 'Keep the notes under 500 characters')
    .optional(),
}

export const createLoanSchema = z.object({
  ...editableLoanFields,
  /** Strictly positive, matching `Loan_principal_positive`: a loan of zero is
   *  nothing to track. */
  principal: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  currency: z.enum(['VND', 'USD'], { error: 'Choose a currency' }),
  /**
   * Percent per year, informational only — nothing in this app computes
   * interest from it (the user reads their instalment off their own statement
   * and types the principal and interest parts in). It is stored so the loan's
   * terms are visible next to its history.
   *
   * 0 is allowed: an interest-free loan from family is one of the commonest
   * loans there is. 100 is the ceiling because the field is a *percentage*, and
   * a user who types their principal into it (100000000) should be told the
   * number is not a rate rather than have it stored.
   */
  interestRate: z
    .number({ error: 'Enter the interest rate' })
    .min(0, 'Rate cannot be negative')
    .max(100, 'Rate cannot exceed 100 %')
    .refine(hasAtMostThreeDecimalPlaces, 'Use at most 3 decimal places'),
  /** A calendar date (ruling R6-7): the day the loan started, which is the same
   *  day in every timezone. Only the service turns it into a carrier. */
  startDate: calendarDateStringSchema,
  /**
   * Whole months, 1–600 (fifty years). The cap is a sanity bound rather than a
   * product limit: no personal loan runs longer, and a mistyped 20260 would
   * otherwise be stored as a term.
   */
  termMonths: z
    .number({ error: 'Enter the term in months' })
    .int('Whole months only')
    .min(1, 'The term must be at least 1 month')
    .max(600, 'The term cannot exceed 600 months'),
  paymentFrequency: z.enum(['WEEKLY', 'MONTHLY', 'YEARLY'], {
    error: 'Choose a payment frequency',
  }),
  /**
   * The next instalment's due date, and the *source of the schedule's anchor*:
   * the service stores its day of the month as `dueDayOfMonth` and advances the
   * due date from that anchor after every payment, so a loan due on the 31st
   * goes Jan 31 → Feb 28 → Mar 31 rather than drifting.
   *
   * Required, and shares `calendarDateStringSchema`'s wording with `startDate`:
   * both are dates the user must supply, so the same typo must not fail
   * differently in the two fields.
   */
  nextDueDate: calendarDateStringSchema,
})

/**
 * An edit changes only what can be corrected or renegotiated: who the lender
 * is, what the scheduled instalment is now, and the notes.
 *
 * `principal`, `currency`, `interestRate`, `startDate`, `termMonths`,
 * `paymentFrequency` and `nextDueDate` are **immutable after creation** (ruling
 * for this group, documented on the model too). They define *which* loan a row
 * is and what its terms are: changing the principal or the rate once instalments
 * exist would re-interpret that history against terms the loan never had, and
 * changing the frequency or the due date would rewrite a schedule the recorded
 * payments already advanced. The honest correction for a wrong principal is a
 * new loan, so the fields are not in this schema at all and Zod strips them from
 * a crafted request.
 *
 * `scheduledPaymentAmount` is the exception, and is editable on purpose: a
 * floating-rate instalment really does change from one year to the next, and it
 * is not a term the recorded history depends on — nothing derived is computed
 * from it, so changing it re-interprets nothing.
 */
export const updateLoanSchema = z.object({ ...editableLoanFields })

export const recordLoanPaymentSchema = z
  .object({
    /** The whole instalment, strictly positive (`LoanPayment_total_positive`):
     *  a payment of nothing is not a payment. */
    totalAmount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
    /**
     * The part that reduces what is owed. **Zero is valid** (ruling R6-6): the
     * early months of many loans, and every grace period, are interest only —
     * refusing a 0 principal would make those instalments unrecordable, and a
     * user would either fake a principal part or not record the payment at all.
     */
    principalAmount: moneyAmountSchema.refine((v) => v >= 0, 'The principal cannot be negative'),
    /** The cost of the loan. It reduces nothing, and zero is valid — a 0 % loan,
     *  or the final sweep of what is left. */
    interestAmount: moneyAmountSchema.refine((v) => v >= 0, 'The interest cannot be negative'),
    /** Required, unlike anything optional on the loan itself — an instalment
     *  happened on a day, and which day it was is what the history is for. */
    paymentDate: calendarDateStringSchema,
    note: z
      .string({ error: 'Enter the note as text' })
      .max(500, 'Keep the note under 500 characters')
      .optional(),
  })
  /**
   * The split invariant, first of three layers (the service re-checks it in
   * `Prisma.Decimal` under the row lock, and `LoanPayment_total_matches_split`
   * is the CHECK a direct insert still has to answer to).
   *
   * Compared in exact cents, with no tolerance: see `cents` above. The message
   * is attached to `totalAmount` rather than the object root so react-hook-form
   * renders it under a field the user can correct — a root-level error has
   * nowhere to appear in the form.
   */
  .refine(
    (payment) =>
      cents(payment.totalAmount) === cents(payment.principalAmount) + cents(payment.interestAmount),
    { message: 'Total must equal principal plus interest', path: ['totalAmount'] },
  )

export type CreateLoanInput = z.infer<typeof createLoanSchema>
export type UpdateLoanInput = z.infer<typeof updateLoanSchema>
export type RecordLoanPaymentInput = z.infer<typeof recordLoanPaymentSchema>
