'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { createSavingsGoalSchema, type CreateSavingsGoalInput } from '@/lib/validation/savings-goal'
import { createSavingsGoalAction } from '@/lib/server/actions/savings-goal-actions'
import { SAVINGS_GOAL_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The create form for a savings goal.
 *
 * Takes no props but `onCreated`: a goal belongs to no month, no account and
 * no category, so there is nothing about the page's state it has to merge in
 * at submit (unlike `BudgetForm`, which carries the selected month).
 *
 * Only `currency` gets a `defaultValue` and `name` a default at all. Every
 * money field is left without one on purpose: react-hook-form overwrites the
 * DOM with a JavaScript default when one exists and *reads* the DOM when one
 * does not (`lib/ui/use-hydrated.ts` documents the mechanism and the line
 * numbers), and a target pre-filled with `0` would be the one value
 * `createSavingsGoalSchema` always rejects.
 */
function defaultValues(): Partial<CreateSavingsGoalInput> {
  return { name: '', currency: 'VND' }
}

export function GoalForm({ onCreated }: { onCreated?: () => void } = {}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `goal-${name}-${uid}`
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateSavingsGoalInput>({
    resolver: zodResolver(createSavingsGoalSchema),
    defaultValues: defaultValues(),
  })

  async function onSubmit(values: CreateSavingsGoalInput) {
    await submit.run({
      tag: 'GoalForm: create failed',
      action: () => createSavingsGoalAction(values),
      errorKeys: SAVINGS_GOAL_ERROR_KEYS,
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
      {/* The hydration gate — same mechanism, same reasoning, as
          `BudgetForm`'s; `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">{t('goals.createTitle')}</legend>

        <FormField
          id={fieldId('name')}
          label={t('goals.name')}
          helper={t('goals.namePlaceholder')}
          error={errors.name?.message}
        >
          {(aria) => <Input {...aria} {...register('name')} />}
        </FormField>

        <FormField
          id={fieldId('target')}
          label={t('goals.target')}
          error={errors.targetAmount?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('targetAmount', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('current')}
          label={t('goals.current')}
          error={errors.currentProgress?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('currentProgress', {
                // `setValueAs` rather than `valueAsNumber` (the two are
                // mutually exclusive in react-hook-form, and `valueAsNumber`
                // wins): an untouched optional field's DOM value is `''`,
                // which `valueAsNumber` would hand to Zod as `NaN` — "Enter an
                // amount" under a field the user is entitled to skip.
                setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
              })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('currency')}
          label={t('goals.currency')}
          error={errors.currency?.message}
        >
          {(aria) => (
            // `defaultValue` (never `value` — that would make this
            // controlled). VND is already the first option, so react-dom
            // would land here anyway; it is passed for symmetry with the
            // other planning forms, whose defaults are not first, so the
            // server HTML states the form's own default rather than relying
            // on a browser fallback.
            <div className="relative">
              <select
                {...aria}
                {...register('currency')}
                defaultValue="VND"
                className={SELECT_CLASS}
              >
                <option value="VND">VND</option>
                <option value="USD">USD</option>
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('deadline')}
          label={t('goals.deadline')}
          error={errors.deadline?.message}
        >
          {(aria) => (
            // A calendar date as a string, never `valueAsDate`: the value that
            // travels is `yyyy-MM-dd` and the carrier is built server-side by
            // `calendarDateToUtcCarrier` (ruling R6-7). `valueAsDate` would
            // hand over an instant the browser's zone had already coloured.
            <Input {...aria} type="date" {...register('deadline')} />
          )}
        </FormField>

        <FormField id={fieldId('note')} label={t('goals.note')} error={errors.note?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('note', {
                // `''` means "no note", so it is normalised to `undefined`
                // here and the service stores `null` — otherwise an untouched
                // field would write an empty string that reads back as a note.
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <Button type="submit" className="self-start">
          {submit.pending ? t('goals.createPending') : t('goals.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
