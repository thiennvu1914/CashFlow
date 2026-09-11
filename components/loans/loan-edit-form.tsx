'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { updateLoanSchema, type UpdateLoanInput } from '@/lib/validation/loan'
import { updateLoanAction } from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { LoanDto } from '@/lib/ui/loan-view-model'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
 *
 * Mounted only while its `Dialog` is open (`LoanRowMenu` in
 * `loan-row-actions.tsx`), so `useForm` snapshots the *current* loan as its
 * defaults; there is no stale-default problem to gate for, and no
 * `useHydrated` here — a click cannot happen before hydration.
 */
export function LoanEditForm({ loan, onDone }: { loan: LoanDto; onDone: () => void }) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `loan-edit-${name}-${uid}`
  const {
    register,
    handleSubmit,
    formState: { errors },
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
    await submit.run({
      tag: 'LoanEditForm: update failed',
      action: () => updateLoanAction(loan.id, values),
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
        <legend className="sr-only">{t('loans.editAction')}</legend>

        <FormField id={fieldId('lender')} label={t('loans.lender')} error={errors.lender?.message}>
          {(aria) => <Input {...aria} {...register('lender')} />}
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

        <FormField id={fieldId('notes')} label={t('loans.notes')} error={errors.notes?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('notes', {
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit">{submit.pending ? t('common.saving') : t('common.save')}</Button>
        </div>
      </fieldset>
    </form>
  )
}
