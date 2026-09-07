'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  recordLoanPaymentSchema,
  updateLoanSchema,
  type RecordLoanPaymentInput,
  type UpdateLoanInput,
} from '@/lib/validation/loan'
import {
  closeLoanAction,
  recordLoanPaymentAction,
  updateLoanAction,
} from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import { formatMoney } from '@/lib/ui/format-money'
import type { LoanDto } from '@/lib/ui/loan-view-model'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Record payment / Edit / Close loan for one loan row. Rendered only by the
 * Loans page, through `LoanList`'s `renderActions` slot — the Dashboard's
 * compact list passes no `renderActions`, so this never mounts there.
 *
 * Nothing here moves money. Recording an instalment writes a `LoanPayment` row
 * and advances the loan's `nextDueDate`, and nothing else: no Transaction, no
 * Transfer, no account balance. Whether the cash also left a tracked account is
 * a separate fact the user records separately, which is why the page says so in
 * its subtitle rather than leaving the reader to wonder.
 *
 * An instalment and an edit are two forms, not one, because they are two user
 * intents — "I paid the April instalment" and "the instalment changed after the
 * rate review" — and a single form would make either an accidental submission
 * of the other. Only one pane is open at a time.
 *
 * Both forms mount on click rather than staying mounted hidden, so `useForm`
 * snapshots the *current* row as its defaults; there is no stale-default
 * problem to gate for, and no `useHydrated` here (a click cannot happen before
 * hydration).
 *
 * Every field's `aria-label` names the lender, because the page renders one of
 * these per loan and "Principal" alone would be ambiguous across a dozen rows.
 */
type OpenPane = 'none' | 'payment' | 'edit'

export function LoanRowActions({ loan, today }: { loan: LoanDto; today: string }) {
  const router = useRouter()
  const [pane, setPane] = useState<OpenPane>('none')
  const [error, setError] = useState<string | null>(null)

  // A closed loan refuses every write (`LoanNotActiveError`), so it is offered
  // no buttons at all — showing them would be a promise the service breaks.
  // Guarded here as well as by the page (which renders the closed section
  // without a `renderActions` slot), because this component is the one that
  // knows what its buttons do. A PAID_OFF loan is *not* closed and keeps its
  // buttons: a final interest charge can still be recorded, and closing it is
  // how the user says they are finished with it.
  if (!loan.active) return null

  async function handleClose() {
    if (!window.confirm('Close this loan? Its payment history stays visible under Closed loans.')) {
      return
    }
    setError(null)
    try {
      const result = await closeLoanAction(loan.id)
      if (!result.ok) {
        setError(LOAN_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
    } catch {
      console.error('LoanRowActions: close failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  function toggle(next: Exclude<OpenPane, 'none'>) {
    setError(null)
    setPane((current) => (current === next ? 'none' : next))
  }

  return (
    <div className="flex w-full flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => toggle('payment')}>
          {pane === 'payment' ? 'Close' : 'Record payment'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => toggle('edit')}>
          {pane === 'edit' ? 'Close' : 'Edit'}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={handleClose}>
          Close loan
        </Button>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      {pane === 'payment' && (
        <LoanPaymentForm loan={loan} today={today} onDone={() => setPane('none')} />
      )}
      {pane === 'edit' && <LoanEditForm loan={loan} onDone={() => setPane('none')} />}
    </div>
  )
}

/**
 * A monetary value in exact cents — the same function, and the same reasoning,
 * as `lib/validation/loan.ts`'s: `0.29 * 100` is 28.999999999999996, so a
 * float comparison of a split would fail on values that are exactly right.
 * `Math.round` removes only that representation error.
 */
const cents = (value: number) => Math.round(value * 100)

/**
 * The instalment total, derived from its two parts rather than typed.
 *
 * `null` when either part is missing or not a number — an emptied number field
 * arrives as `NaN` through `valueAsNumber` — because a total of "0" for a form
 * the user has not filled in would state a figure nobody entered.
 *
 * Added in exact cents and divided back, so 3.500.000,01 + 1.499.999,99 is
 * 5.000.000 and not 5.000.000,0000001.
 */
function totalFromParts(principal: number, interest: number): number | null {
  if (!Number.isFinite(principal) || !Number.isFinite(interest)) return null
  return (cents(principal) + cents(interest)) / 100
}

const validatePayment = zodResolver(recordLoanPaymentSchema)

/**
 * `recordLoanPaymentSchema`, with the total supplied by the form instead of by
 * the user.
 *
 * The user types the split — what came off the principal and what the loan
 * cost — and the total is arithmetic, so asking for it as a third number would
 * be asking them to do a sum the form can do exactly. Deriving it here, in the
 * resolver, is what makes the figure shown read-only above the fields *the same
 * number* that is validated and then submitted: `handleSubmit` hands `onValid`
 * the resolver's output, not the raw form values
 * (`react-hook-form/dist/index.esm.mjs:3217-3219`, `fieldValues =
 * cloneObject(values)`), so there is one derivation and no second copy to drift.
 *
 * The split invariant's three layers all still stand, and none of them is
 * weakened by this:
 *
 * 1. **Zod** — the `.refine` in `recordLoanPaymentSchema` compares
 *    `cents(total)` with `cents(principal) + cents(interest)`. It runs on the
 *    derived value below and so cannot fire *from this form*, which is the
 *    point: the user is never told off for arithmetic the form did. It remains
 *    layer one for every other caller, and `loan-actions.ts` parses with the
 *    same schema before the service is reached.
 * 2. **The service** re-checks the equality in `Prisma.Decimal` inside the
 *    locked transaction, because float-derived integers are not what the
 *    database will check.
 * 3. **`LoanPayment_total_matches_split`**, the CHECK constraint, is the last
 *    line — it answers a direct insert that bypassed both layers above.
 */
const paymentResolver: Resolver<RecordLoanPaymentInput> = (values, context, options) =>
  validatePayment(
    {
      ...values,
      // `NaN` when a part is missing, which `moneyAmountSchema` rejects with
      // "Enter an amount" under the total — alongside the same message under
      // the part that is actually blank.
      totalAmount: totalFromParts(values.principalAmount, values.interestAmount) ?? NaN,
    },
    context,
    options,
  )

/**
 * "How much of this instalment paid the loan down, how much was interest, and
 * when?" — the only write that moves a loan's outstanding principal.
 *
 * The service refuses a principal payment above what is still outstanding,
 * under a row lock, so OVERPAYMENT is a genuinely reachable answer here (two
 * tabs, a double-click, or simply a typo) and it is shown inline under the form
 * rather than as a banner somewhere else on the page. The interest part is
 * never compared against anything: a repaid loan can still owe a final charge.
 */
function LoanPaymentForm({
  loan,
  today,
  onDone,
}: {
  loan: LoanDto
  /** The user's own calendar day, from `todayCalendarDateInZone` on the page —
   *  never `new Date()` in the browser, whose zone is not the profile's. */
  today: string
  onDone: () => void
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  // Two loans can be with the same lender, so a lender-only `aria-describedby`
  // target would be ambiguous between rows; `useId` makes the association per
  // row.
  const uid = useId()
  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RecordLoanPaymentInput>({
    resolver: paymentResolver,
    // No default for either amount: a pre-filled `0` would be written into the
    // DOM by react-hook-form (`lib/ui/use-hydrated.ts` documents the
    // mechanism), and `totalAmount > 0` means an instalment of nothing is
    // rejected — so the form would start on a value it cannot submit.
    defaultValues: { paymentDate: today },
  })

  // Watched rather than read on submit, so the total updates as the user types
  // and they can see the arithmetic agree with their own statement before
  // saving. `valueAsNumber` makes an emptied field `NaN`, which
  // `totalFromParts` reports as "no total yet".
  const principalAmount = useWatch({ control, name: 'principalAmount' })
  const interestAmount = useWatch({ control, name: 'interestAmount' })
  const total = totalFromParts(principalAmount, interestAmount)

  async function onSubmit(values: RecordLoanPaymentInput) {
    setError(null)
    try {
      // `values` is the resolver's output, so `values.totalAmount` is the
      // derived figure the read-only field showed — not a fourth number.
      const result = await recordLoanPaymentAction(loan.id, values)
      if (!result.ok) {
        setError(LOAN_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone()
    } catch {
      console.error('LoanPaymentForm: record failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex w-full max-w-xs flex-col gap-2 border-t border-border pt-2"
    >
      <div>
        <Input
          type="number"
          step="0.01"
          aria-label={`Principal for ${loan.lender}`}
          aria-describedby={errors.principalAmount ? `${uid}-principal-error` : undefined}
          placeholder={`Principal (${loan.currency})`}
          {...register('principalAmount', { valueAsNumber: true })}
        />
        {errors.principalAmount && (
          <p id={`${uid}-principal-error`} className="text-sm text-negative">
            {errors.principalAmount.message}
          </p>
        )}
      </div>
      <div>
        {/* Zero is valid on both parts: an interest-only instalment is what
            every grace period and the early months of many loans look like
            (ruling R6-6), and a final sweep of the principal carries no
            interest. */}
        <Input
          type="number"
          step="0.01"
          aria-label={`Interest for ${loan.lender}`}
          aria-describedby={errors.interestAmount ? `${uid}-interest-error` : undefined}
          placeholder={`Interest (${loan.currency})`}
          {...register('interestAmount', { valueAsNumber: true })}
        />
        {errors.interestAmount && (
          <p id={`${uid}-interest-error`} className="text-sm text-negative">
            {errors.interestAmount.message}
          </p>
        )}
      </div>
      <div>
        {/* Read-only and unregistered: the total is derived, not entered. See
            `paymentResolver` above for the derivation and for the three layers
            that still enforce the split. An em dash rather than "0" while a
            part is missing, so the field never states a figure nobody typed. */}
        <Input
          readOnly
          aria-label={`Total payment for ${loan.lender}`}
          aria-describedby={errors.totalAmount ? `${uid}-total-error` : undefined}
          value={total === null ? '—' : `${formatMoney(total, loan.currency)} ${loan.currency}`}
          className="tabular-nums"
        />
        {errors.totalAmount && (
          <p id={`${uid}-total-error`} className="text-sm text-negative">
            {errors.totalAmount.message}
          </p>
        )}
      </div>
      <div>
        {/* Defaulted to the user's today, and editable: an instalment is often
            recorded a day or two after it was paid, and which day it was is
            what the history is for. */}
        <Input
          type="date"
          aria-label={`Payment date for ${loan.lender}`}
          aria-describedby={errors.paymentDate ? `${uid}-date-error` : undefined}
          {...register('paymentDate')}
        />
        {errors.paymentDate && (
          <p id={`${uid}-date-error`} className="text-sm text-negative">
            {errors.paymentDate.message}
          </p>
        )}
      </div>
      <div>
        <Input
          aria-label={`Payment note for ${loan.lender}`}
          placeholder="Note (optional)"
          {...register('note', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
        />
        {errors.note && <p className="text-sm text-negative">{errors.note.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          Save
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {/* Where OVERPAYMENT and SPLIT_MISMATCH land: right under the figures the
          user typed, with the outstanding principal still on the row above. */}
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  )
}

/**
 * What can be corrected or renegotiated about a loan, matching
 * `updateLoanSchema` field for field: who the lender is, what the instalment is
 * now, and the notes.
 *
 * Everything that defines the loan — principal, currency, interest rate, start
 * date, term, frequency and next due date — is deliberately absent. Those are
 * immutable after creation, are not in the schema at all, and rendering them
 * would offer an edit the service strips: changing the principal or the rate
 * once instalments exist would re-interpret that history against terms the loan
 * never had, and changing the frequency or the due date would rewrite a
 * schedule the recorded payments already advanced. The scheduled payment is the
 * deliberate exception — a floating-rate instalment really does change, and
 * nothing derived is computed from it.
 *
 * Prefilled from the DTO's `editable`, which is already all strings: a
 * `Prisma.Decimal` cannot cross into this component.
 */
function LoanEditForm({ loan, onDone }: { loan: LoanDto; onDone: () => void }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const uid = useId()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateLoanInput>({
    resolver: zodResolver(updateLoanSchema),
    defaultValues: {
      lender: loan.editable.lender,
      // The DTO carries `toFixed(2)`, so this round-trips the stored scale.
      scheduledPaymentAmount: Number(loan.editable.scheduledPaymentAmount),
      // `''` is what an empty input holds, and what the schema reads back as
      // "no value" — so clearing the notes really clears them. Passed as
      // `undefined` here so react-hook-form reads the DOM rather than writing
      // an empty string over it.
      notes: loan.editable.notes === '' ? undefined : loan.editable.notes,
    },
  })

  async function onSubmit(values: UpdateLoanInput) {
    setError(null)
    try {
      const result = await updateLoanAction(loan.id, values)
      if (!result.ok) {
        setError(LOAN_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone()
    } catch {
      console.error('LoanEditForm: update failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex w-full max-w-xs flex-col gap-2 border-t border-border pt-2"
    >
      <div>
        <Input
          aria-label={`Edit lender for ${loan.lender}`}
          aria-describedby={errors.lender ? `${uid}-lender-error` : undefined}
          {...register('lender')}
        />
        {errors.lender && (
          <p id={`${uid}-lender-error`} className="text-sm text-negative">
            {errors.lender.message}
          </p>
        )}
      </div>
      <div>
        <Input
          type="number"
          step="0.01"
          aria-label={`Edit scheduled payment for ${loan.lender}`}
          aria-describedby={
            errors.scheduledPaymentAmount ? `${uid}-scheduled-payment-error` : undefined
          }
          placeholder={`Instalment (${loan.currency})`}
          {...register('scheduledPaymentAmount', { valueAsNumber: true })}
        />
        {errors.scheduledPaymentAmount && (
          <p id={`${uid}-scheduled-payment-error`} className="text-sm text-negative">
            {errors.scheduledPaymentAmount.message}
          </p>
        )}
      </div>
      <div>
        <Input
          aria-label={`Edit notes for ${loan.lender}`}
          placeholder="Notes (optional)"
          {...register('notes', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
        />
        {errors.notes && <p className="text-sm text-negative">{errors.notes.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          Save
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  )
}
