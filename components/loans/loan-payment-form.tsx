'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import { type RecordLoanPaymentInput } from '@/lib/validation/loan'
import { recordLoanPaymentAction } from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatMoney } from '@/lib/ui/format-money'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { LoanDto } from '@/lib/ui/loan-view-model'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DERIVED_FIELD, displayTotal, paymentResolver } from './loan-payment-math'

/**
 * "How much of this instalment paid the loan down, how much was interest, and
 * when?" — the only write that moves a loan's outstanding principal.
 *
 * States the current outstanding principal above the fields (owner
 * requirement G4, mirroring `DebtPaymentForm`'s outstanding line) so the
 * OVERPAYMENT refusal below is predictable — the figure the service is about
 * to compare the Gốc field against is right there while the user types.
 *
 * Three visible fields, Gốc / Lãi / Tổng, in that order (spec §6.6): the user
 * types the split and Tổng is read-only, computed live from `displayTotal` and
 * bound to the two inputs via `aria-describedby` on a note explaining it is
 * computed. Tổng NEVER shows an em dash for a valid number, including two
 * zeros — see `displayTotal`'s own doc comment. `locale` (threaded from the
 * page) is what keeps Tổng's digit grouping in the reader's own language
 * (fix round 1, finding 1) — `formatMoney`'s locale parameter defaults to
 * `vi` when omitted, which is exactly the bug this closes: an English-locale
 * reader was shown Vietnamese grouping inside an otherwise English dialog.
 *
 * The service refuses a principal payment above what is still outstanding,
 * under a row lock, so OVERPAYMENT is a genuinely reachable answer here (two
 * tabs, a double-click, or simply a typo) and it is shown inline under the
 * form's fields. The interest part is never compared against anything: a
 * repaid loan can still owe a final charge.
 *
 * Mounted only while its `Dialog` is open (`LoanPaymentButton` in
 * `loan-row-actions.tsx`), so `useForm` snapshots the *current* loan as its
 * defaults; there is no stale-default problem to gate for, and no
 * `useHydrated` here — a click cannot happen before hydration.
 */
export function LoanPaymentForm({
  loan,
  today,
  locale,
  onDone,
}: {
  loan: LoanDto
  /** The user's own calendar day, from `todayCalendarDateInZone` on the page —
   *  never `new Date()` in the browser, whose zone is not the profile's. */
  today: string
  locale: Locale
  onDone: () => void
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `loan-payment-${name}-${uid}`
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
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
  // saving. `valueAsNumber` makes an emptied field `NaN`, which `displayTotal`
  // treats as zero for THIS read-only field — never an em dash.
  const principalAmount = useWatch({ control, name: 'principalAmount' })
  const interestAmount = useWatch({ control, name: 'interestAmount' })
  const total = displayTotal(principalAmount, interestAmount)

  async function onSubmit(values: RecordLoanPaymentInput) {
    await submit.run({
      tag: 'LoanPaymentForm: record failed',
      // `values` is the resolver's output, so `values.totalAmount` is the
      // derived figure the read-only field showed — not a fourth number.
      action: () => recordLoanPaymentAction(loan.id, values),
      errorKeys: LOAN_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        router.refresh()
        onDone()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">{t('loans.paymentAction')}</legend>

        <p className="text-sm text-muted-foreground">
          {t('loans.paymentOutstanding', {
            amount: loan.outstandingPrincipal,
            currency: loan.currency,
          })}
        </p>

        <FormField
          id={fieldId('principal')}
          label={t('loans.paymentPrincipal')}
          error={errors.principalAmount?.message}
        >
          {/* Zero is valid: a final principal-only sweep, with the interest
              already settled separately, is a real instalment. The currency
              suffix matches the debt payment form's amount field (fix round
              1, finding 8: the three amount fields in these two dialogs — the
              debt's, Gốc and Lãi — either all show the code or none do). */}
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="pr-14"
                {...register('principalAmount', { valueAsNumber: true, deps: DERIVED_FIELD })}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                {loan.currency}
              </span>
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('interest')}
          label={t('loans.paymentInterest')}
          error={errors.interestAmount?.message}
        >
          {/* Zero is valid on both parts: an interest-only instalment is what
              every grace period and the early months of many loans look like
              (ruling R6-6), and a final sweep of the principal carries no
              interest. */}
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="pr-14"
                {...register('interestAmount', { valueAsNumber: true, deps: DERIVED_FIELD })}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                {loan.currency}
              </span>
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('total')}
          label={t('loans.paymentTotal')}
          helper={t('loans.paymentTotalNote')}
          error={errors.totalAmount?.message}
        >
          {/* Read-only and unregistered: the total is derived, not entered. See
              `paymentResolver` (`loan-payment-math.ts`) for what is SUBMITTED
              and `displayTotal` for what is SHOWN — the two differ on purpose
              while a part is blank, and this field must never read "—" for a
              valid number, including zero. `FormField`'s own
              `aria-describedby` already points at the helper note above
              (`loans.paymentTotalNote`) — this is the binding the spec asks
              for between the two input fields and the note explaining Tổng is
              computed. `bg-muted text-muted-foreground` (fix round 1, finding
              8) is the visual cue that this field cannot be typed into, on top
              of the `readOnly`/`aria-readonly` that already say so to
              assistive tech. */}
          {(aria) => (
            <Input
              {...aria}
              readOnly
              aria-readonly="true"
              value={`${formatMoney(total, loan.currency, locale)} ${loan.currency}`}
              className="bg-muted tabular-nums text-muted-foreground"
            />
          )}
        </FormField>

        <FormField
          id={fieldId('date')}
          label={t('loans.paymentDate')}
          error={errors.paymentDate?.message}
        >
          {/* Defaulted to the user's today, and editable: an instalment is
              often recorded a day or two after it was paid, and which day it
              was is what the history is for. */}
          {(aria) => <Input {...aria} type="date" {...register('paymentDate')} />}
        </FormField>

        <FormField id={fieldId('note')} label={t('loans.paymentNote')} error={errors.note?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('note', {
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        {/* Where OVERPAYMENT and SPLIT_MISMATCH land: right under the fields
            the user typed, with the outstanding principal still visible on the
            row behind the dialog. */}
        {error && <InlineAlert tone="negative">{error}</InlineAlert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit">
            {submit.pending ? t('loans.paymentPending') : t('common.save')}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
