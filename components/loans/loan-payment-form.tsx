'use client'

import { useId, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import { type RecordLoanPaymentInput } from '@/lib/validation/loan'
import { recordLoanPaymentAction, updateLoanPaymentAction } from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { defaultPaymentAccountId, type DebtAccountOption } from '@/lib/ui/debt-accounts'
import { formatMoney } from '@/lib/ui/format-money'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { LoanDto, LoanPaymentDto } from '@/lib/ui/loan-view-model'
import { DebtAccountField } from '@/components/debts/debt-account-field'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DERIVED_FIELD, displayPrincipal, paymentResolverAsOf } from './loan-payment-math'

/**
 * "How much did I pay, how much of it was interest, and when?" — the only write
 * that moves a loan's outstanding principal. Records a new instalment, or (with
 * `payment`) corrects a recorded one.
 *
 * The user types the instalment's TOTAL — pre-filled with the loan's scheduled
 * amount, so the usual instalment is one field to fill — and the INTEREST part;
 * Gốc (principal) is what is left, computed live and read-only (spec §6.3). It
 * is a subtraction the form can do exactly (`displayPrincipal`), so the user is
 * never asked for a third number that must agree with the other two. An
 * interest-only instalment is simply total = interest, principal 0.
 *
 * States the current outstanding principal above the fields for a new
 * instalment (owner requirement G4, mirroring `DebtPaymentForm`) so the
 * OVERPAYMENT refusal below is predictable. A correction does not state it: the
 * comparison is against what is outstanding without this instalment, a number
 * this form does not have. `locale` (threaded from the page) keeps Gốc's digit
 * grouping in the reader's own language.
 *
 * Money-source linking (spec 2026-10-12 §6.3): an optional account the
 * instalment was paid from — the principal leaves it as one transaction and the
 * interest as another ("Loan Interest & Fees"). Only accounts in the loan's
 * currency are listed. A new instalment starts on the account the loan was
 * received into, else the most recently used one (when the picker lists it);
 * a correction starts on what the instalment actually used — never a fresh
 * pre-selection, or saving a note fix would silently link a plain instalment —
 * and an account archived since stays in the list, labelled, rather than the
 * picker falling back to "don't record" (which would unlink the instalment and
 * delete its transactions on save).
 *
 * The service refuses a principal payment above what is still outstanding,
 * under a row lock, so OVERPAYMENT is a genuinely reachable answer here (two
 * tabs, a double-click, or simply a typo) and it is shown inline under the
 * form's fields. The interest part is never compared against anything: a
 * repaid loan can still owe a final charge.
 *
 * Mounted only while its `Dialog` is open (`LoanPaymentButton` /
 * `LoanPaymentActions` in `loan-row-actions.tsx`), so `useForm` snapshots the
 * *current* loan as its defaults; there is no stale-default problem to gate
 * for, and no `useHydrated` here — a click cannot happen before hydration.
 */
export function LoanPaymentForm({
  loan,
  today,
  locale,
  accounts,
  mostRecentAccountId,
  payment,
  onDone,
}: {
  loan: LoanDto
  /** The user's own calendar day, from `todayCalendarDateInZone` on the page —
   *  never `new Date()` in the browser, whose zone is not the profile's. */
  today: string
  locale: Locale
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  /** Present when correcting a recorded instalment rather than recording one. */
  payment?: LoanPaymentDto
  onDone: () => void
}) {
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `loan-payment-${name}-${uid}`
  // A loan moves money only in its own currency, so the picker lists no other.
  const activeOptions = accounts.filter((account) => account.currency === loan.currency)
  const options: DebtAccountOption[] =
    payment?.accountId && payment.accountArchived
      ? [
          ...activeOptions,
          {
            id: payment.accountId,
            name: payment.accountName ?? '',
            currency: loan.currency,
            archived: true,
          },
        ]
      : activeOptions
  const initialAccountId = payment
    ? options.some((option) => option.id === payment.accountId)
      ? payment.accountId!
      : ''
    : defaultPaymentAccountId(options, loan.disbursementAccountId, mostRecentAccountId)
  // The total starts on the scheduled instalment and the interest on 0 (a
  // correction: on what was recorded), so a 0 % loan needs no extra input and
  // Gốc starts as the whole total; the user types the interest off their
  // statement when there is some. (This form mounts only after hydration, so
  // pre-filled numbers cannot hit the create forms' DOM-default hazard.)
  const initialTotal = Number(payment ? payment.totalInput : loan.scheduledPaymentInput)
  // Built for the page's `today` (profile zone): an instalment paid from an
  // account cannot be dated later (Ruling P12).
  const resolver = useMemo(() => paymentResolverAsOf(today), [today])
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RecordLoanPaymentInput>({
    resolver,
    defaultValues: {
      paymentDate: payment ? payment.date : today,
      totalAmount: initialTotal,
      interestAmount: payment ? Number(payment.interestInput) : 0,
      ...(payment ? { note: payment.note ?? undefined } : {}),
      accountId: initialAccountId === '' ? undefined : initialAccountId,
    },
  })

  // Watched rather than read on submit, so Gốc updates as the user types and
  // they can see the arithmetic agree with their own statement before saving.
  // `valueAsNumber` makes an emptied field `NaN`, which `displayPrincipal`
  // treats as zero for THIS read-only field — never an em dash.
  const totalAmount = useWatch({ control, name: 'totalAmount' })
  const interestAmount = useWatch({ control, name: 'interestAmount' })
  const principal = displayPrincipal(totalAmount, interestAmount)

  async function onSubmit(values: RecordLoanPaymentInput) {
    await submit.run({
      tag: payment ? 'LoanPaymentForm: edit failed' : 'LoanPaymentForm: record failed',
      // `values` is the resolver's output, so `values.principalAmount` is the
      // derived figure the read-only field showed — not a third number.
      action: () =>
        payment
          ? updateLoanPaymentAction(payment.id, values)
          : recordLoanPaymentAction(loan.id, values),
      errorKeys: LOAN_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        onDone()
      },
    })
  }

  const currencySuffix = (
    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
      {loan.currency}
    </span>
  )

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">
          {payment ? t('loans.paymentEditAction') : t('loans.paymentAction')}
        </legend>

        {!payment && (
          <p className="text-sm text-muted-foreground">
            {t('loans.paymentOutstanding', {
              amount: loan.outstandingPrincipal,
              currency: loan.currency,
            })}
          </p>
        )}

        <FormField
          id={fieldId('total')}
          label={t('loans.paymentTotal')}
          error={errors.totalAmount?.message}
        >
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="pr-14"
                defaultValue={initialTotal}
                {...register('totalAmount', { valueAsNumber: true, deps: DERIVED_FIELD })}
              />
              {currencySuffix}
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('interest')}
          label={t('loans.paymentInterest')}
          error={errors.interestAmount?.message}
        >
          {/* Zero is valid: a 0 % loan, and the final sweep of what is left,
              carry no interest — and an interest-only instalment (a grace
              period, the early months of many loans; ruling R6-6) is the
              total entered here in full. */}
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="pr-14"
                defaultValue={payment ? payment.interestInput : 0}
                {...register('interestAmount', { valueAsNumber: true, deps: DERIVED_FIELD })}
              />
              {currencySuffix}
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('principal')}
          label={t('loans.paymentPrincipal')}
          helper={t('loans.paymentPrincipalNote')}
          error={errors.principalAmount?.message}
        >
          {/* Read-only and unregistered: the principal is derived, not
              entered. See `paymentResolverAsOf` (`loan-payment-math.ts`) for what
              is SUBMITTED and `displayPrincipal` for what is SHOWN — the two
              differ on purpose while a part is blank, and this field must never
              read "—" for a valid number, including zero. `FormField`'s own
              `aria-describedby` points at the helper note above, which says it
              is computed. `bg-muted text-muted-foreground` is the visual cue
              that this field cannot be typed into, on top of the
              `readOnly`/`aria-readonly` that already say so to assistive
              tech. */}
          {(aria) => (
            <Input
              {...aria}
              readOnly
              aria-readonly="true"
              value={`${formatMoney(principal, loan.currency, locale)} ${loan.currency}`}
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

        <DebtAccountField
          id={fieldId('account')}
          label={t('loans.paymentAccount')}
          accounts={options}
          defaultAccountId={initialAccountId}
          registration={register('accountId', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
          error={errors.accountId?.message}
          helper={payment?.accountId ? t('loans.paymentEditLinkedNote') : undefined}
        />

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

        {/* Where OVERPAYMENT and the other refusals land: right under the
            fields the user typed, with the outstanding principal still visible
            on the row behind the dialog. */}
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
