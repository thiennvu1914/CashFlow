'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { createLoanSchema, type CreateLoanInput } from '@/lib/validation/loan'
import { createLoanAction } from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { paymentFrequencyLabelKey } from '@/lib/ui/labels'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The create form for a loan.
 *
 * Takes `today` — the user's own calendar day, from `todayCalendarDateInZone`
 * on the page — because the next due date is pre-filled with it. Never
 * `new Date()` in the browser: the visitor's zone is not the profile's, so a
 * user in `Asia/Ho_Chi_Minh` reading the page on a UTC machine would be handed
 * yesterday.
 *
 * Every term is asked here and most are asked *only* here: `updateLoanSchema`
 * contains just the lender, the scheduled payment and the notes, because the
 * principal, currency, rate, start date, term, frequency and first due date
 * define which loan a row is and what its terms are — changing one after
 * instalments exist would re-interpret that history against terms the loan
 * never had, or rewrite a schedule the recorded payments already advanced.
 *
 * Both selects carry a `defaultValue`, and the frequency one is why this form
 * has a test of its own: MONTHLY is the *second* option, so without the
 * explicit marker the server HTML would select WEEKLY (a `<select>`'s browser
 * fallback) while `useForm` held MONTHLY, and a submission before hydration
 * would file a monthly loan as weekly. `lib/ui/use-hydrated.ts` documents the
 * mechanism, the line numbers and the defect it was found as.
 *
 * The four numeric fields are left without a default on purpose:
 * react-hook-form overwrites the DOM with a JavaScript default when one exists
 * and *reads* the DOM when it does not (same file), and a principal or
 * scheduled payment pre-filled with `0` would be the one value
 * `createLoanSchema` always rejects. A rate of 0 is legitimate — the
 * interest-free loan from family — but pre-filling it would state a term the
 * user never gave.
 */
function defaultValues(today: string): Partial<CreateLoanInput> {
  return { lender: '', currency: 'VND', paymentFrequency: 'MONTHLY', nextDueDate: today }
}

export function LoanForm({ today, onCreated }: { today: string; onCreated?: () => void }) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `loan-${name}-${uid}`
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateLoanInput>({
    resolver: zodResolver(createLoanSchema),
    defaultValues: defaultValues(today),
  })

  async function onSubmit(values: CreateLoanInput) {
    await submit.run({
      tag: 'LoanForm: create failed',
      action: () => createLoanAction(values),
      errorKeys: LOAN_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        reset(defaultValues(today))
        router.refresh()
        onCreated?.()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as `DebtForm`'s;
          `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">{t('loans.createTitle')}</legend>

        <FormField
          id={fieldId('lender')}
          label={t('loans.lender')}
          helper={t('loans.lenderPlaceholder')}
          error={errors.lender?.message}
        >
          {(aria) => <Input {...aria} {...register('lender')} />}
        </FormField>

        <FormField
          id={fieldId('principal')}
          label={t('loans.principal')}
          error={errors.principal?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('principal', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('currency')}
          label={t('loans.currency')}
          error={errors.currency?.message}
        >
          {/* `defaultValue` (never `value` — that would make this
              controlled). VND is already the first option, so react-dom would
              land here anyway; it is passed so the server HTML states the
              form's own default rather than relying on a browser fallback. */}
          {(aria) => (
            <select {...aria} {...register('currency')} defaultValue="VND" className={SELECT_CLASS}>
              <option value="VND">VND</option>
              <option value="USD">USD</option>
            </select>
          )}
        </FormField>

        <FormField
          id={fieldId('interest-rate')}
          label={t('loans.interestRate')}
          error={errors.interestRate?.message}
        >
          {/* `step="0.001"`, matching `Decimal(6, 3)` and the schema's
              three-decimal refine, so the browser's own stepper cannot produce
              a value the schema then rejects. */}
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.001"
              {...register('interestRate', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('start-date')}
          label={t('loans.startDate')}
          error={errors.startDate?.message}
        >
          {/* A calendar date as a string, never `valueAsDate`: the value that
              travels is `yyyy-MM-dd` and the carrier is built server-side by
              `calendarDateToUtcCarrier` (ruling R6-7). `valueAsDate` would hand
              over an instant the browser's zone had already coloured. */}
          {(aria) => <Input {...aria} type="date" {...register('startDate')} />}
        </FormField>

        <FormField
          id={fieldId('term-months')}
          label={t('loans.termMonths')}
          error={errors.termMonths?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="1"
              {...register('termMonths', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('payment-frequency')}
          label={t('loans.paymentFrequency')}
          error={errors.paymentFrequency?.message}
        >
          {/* The options are in the Prisma enum's own order, which puts the
              default *second* — hence the explicit `defaultValue`. See the
              module comment. */}
          {(aria) => (
            <select
              {...aria}
              {...register('paymentFrequency')}
              defaultValue="MONTHLY"
              className={SELECT_CLASS}
            >
              <option value="WEEKLY">{t(paymentFrequencyLabelKey('WEEKLY'))}</option>
              <option value="MONTHLY">{t(paymentFrequencyLabelKey('MONTHLY'))}</option>
              <option value="YEARLY">{t(paymentFrequencyLabelKey('YEARLY'))}</option>
            </select>
          )}
        </FormField>

        <FormField
          id={fieldId('scheduled-payment')}
          label={t('loans.scheduledPayment')}
          error={errors.scheduledPaymentAmount?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('scheduledPaymentAmount', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('next-due-date')}
          label={t('loans.nextDueDate')}
          error={errors.nextDueDate?.message}
        >
          {/* Pre-filled with the user's own today, and the source of the
              schedule's anchor: the service reads this date's day of the month
              into `dueDayOfMonth` and advances from that anchor after every
              payment, so a loan due on the 31st goes Jan 31 → Feb 28 → Mar 31
              rather than drifting (ruling R6-6a). */}
          {(aria) => (
            <Input {...aria} type="date" {...register('nextDueDate')} defaultValue={today} />
          )}
        </FormField>

        <FormField id={fieldId('notes')} label={t('loans.notes')} error={errors.notes?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('notes', {
                // `''` means "no notes", so it is normalised to `undefined`
                // here and the service stores `null` — otherwise an untouched
                // field would write an empty string that reads back as a
                // value.
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <Button type="submit" className="self-start">
          {submit.pending ? t('loans.createPending') : t('loans.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
