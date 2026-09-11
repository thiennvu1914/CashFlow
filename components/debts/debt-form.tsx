'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { createDebtSchema, type CreateDebtInput } from '@/lib/validation/debt'
import { createDebtAction } from '@/lib/server/actions/debt-actions'
import { DEBT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { debtDirectionLabelKey } from '@/lib/ui/labels'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The create form for a debt.
 *
 * Takes no props but `onCreated`: a debt belongs to no month, no account and
 * no category, so there is nothing about the page's state it has to merge in
 * at submit (unlike `BudgetForm`, which carries the selected month).
 *
 * `direction` and `currency` get a `defaultValue`; `person` a default at all.
 * The money field is left without one on purpose: react-hook-form overwrites
 * the DOM with a JavaScript default when one exists and *reads* the DOM when it
 * does not (`lib/ui/use-hydrated.ts` documents the mechanism and the line
 * numbers), and an original amount pre-filled with `0` would be the one value
 * `createDebtSchema` always rejects.
 *
 * Direction and currency are asked here and never again: `updateDebtSchema`
 * does not contain them, because they define *which* debt a row is and
 * changing one after payments exist would re-interpret that history against
 * terms the debt never had. The wording of the two direction options
 * (`debtDirectionLabelKey`, `labels.debtDirection.*`) is therefore the only
 * place the user states it — and it is now the SAME wording the row itself
 * reads (a deliberate copy change: the pre-Phase-7 form read "Someone owes
 * me"/"I owe someone" while the row read "Owes you"/"You owe" — two sentences
 * for one fact).
 */
function defaultValues(): Partial<CreateDebtInput> {
  return { direction: 'RECEIVABLE', person: '', currency: 'VND' }
}

export function DebtForm({ onCreated }: { onCreated?: () => void } = {}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `debt-${name}-${uid}`
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateDebtInput>({
    resolver: zodResolver(createDebtSchema),
    defaultValues: defaultValues(),
  })

  async function onSubmit(values: CreateDebtInput) {
    await submit.run({
      tag: 'DebtForm: create failed',
      action: () => createDebtAction(values),
      errorKeys: DEBT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        reset(defaultValues())
        router.refresh()
        onCreated?.()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as `GoalForm`'s;
          `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">{t('debts.createTitle')}</legend>

        <FormField
          id={fieldId('direction')}
          label={t('debts.direction')}
          error={errors.direction?.message}
        >
          {(aria) => (
            // `defaultValue` (never `value` — that would make this
            // controlled). RECEIVABLE is already the first option, so
            // react-dom would land here anyway; it is passed so the server
            // HTML states the form's own default rather than relying on a
            // browser fallback, and so this select cannot silently disagree
            // with `useForm`'s default the way `/transactions`' Type select
            // once did.
            <select
              {...aria}
              {...register('direction')}
              defaultValue="RECEIVABLE"
              className={SELECT_CLASS}
            >
              <option value="RECEIVABLE">{t(debtDirectionLabelKey('RECEIVABLE'))}</option>
              <option value="PAYABLE">{t(debtDirectionLabelKey('PAYABLE'))}</option>
            </select>
          )}
        </FormField>

        <FormField
          id={fieldId('person')}
          label={t('debts.person')}
          helper={t('debts.personPlaceholder')}
          error={errors.person?.message}
        >
          {(aria) => <Input {...aria} {...register('person')} />}
        </FormField>

        <FormField
          id={fieldId('original-amount')}
          label={t('debts.originalAmount')}
          error={errors.originalAmount?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('originalAmount', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('currency')}
          label={t('debts.currency')}
          error={errors.currency?.message}
        >
          {(aria) => (
            <select {...aria} {...register('currency')} defaultValue="VND" className={SELECT_CLASS}>
              <option value="VND">VND</option>
              <option value="USD">USD</option>
            </select>
          )}
        </FormField>

        <FormField
          id={fieldId('due-date')}
          label={t('debts.dueDate')}
          error={errors.dueDate?.message}
        >
          {/* A calendar date as a string, never `valueAsDate`: the value that
              travels is `yyyy-MM-dd` and the carrier is built server-side by
              `calendarDateToUtcCarrier` (ruling R6-7). `valueAsDate` would hand
              over an instant the browser's zone had already coloured. */}
          {(aria) => <Input {...aria} type="date" {...register('dueDate')} />}
        </FormField>

        <FormField
          id={fieldId('description')}
          label={t('debts.descriptionField')}
          error={errors.description?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              {...register('description', {
                // `''` means "no description", so it is normalised to
                // `undefined` here and the service stores `null` — otherwise an
                // untouched field would write an empty string that reads back
                // as a value.
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <FormField id={fieldId('notes')} label={t('debts.notes')} error={errors.notes?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('notes', {
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <Button type="submit" className="self-start">
          {submit.pending ? t('debts.createPending') : t('debts.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
