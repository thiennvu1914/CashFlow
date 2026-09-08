'use client'

import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { budgetFormSchema, type BudgetFormInput } from '@/lib/validation/budget'
import { createBudgetAction } from '@/lib/server/actions/budget-actions'
import { BUDGET_ERROR_KEYS, GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Category = { id: string; name: string }

/**
 * `overallExists` decides the default scope, not just a starting value the
 * user could pick either way: an OVERALL budget already on this month means a
 * second one would only ever fail as `DUPLICATE_BUDGET`, so the friendlier
 * default is CATEGORY.
 *
 * Shared with the scope `<select>`'s `defaultValue` below rather than repeated:
 * when this resolves to CATEGORY it is *not* the first option, so the server
 * HTML would otherwise show "Overall" while the form state already said
 * CATEGORY.
 */
function defaultScope(overallExists: boolean): BudgetFormInput['scope'] {
  return overallExists ? 'CATEGORY' : 'OVERALL'
}

/** `year`/`month` are absent on purpose — see the note on `BudgetForm` below. */
function defaultValues(overallExists: boolean): BudgetFormInput {
  return {
    scope: defaultScope(overallExists),
    categoryId: undefined,
    amount: 0,
    currency: 'VND',
  }
}

/**
 * The create form for the month the page is currently showing.
 *
 * `year`/`month` are never form state. `useForm` snapshots `defaultValues` at
 * mount and never re-reads them, and Next's App Router deliberately preserves
 * client state across a search-param-only navigation — so a month held in the
 * form would keep submitting the month that was on screen when the component
 * mounted, even after `MonthNav` moved the page elsewhere. Instead the form
 * resolves against `budgetFormSchema` (the four fields the user types) and the
 * *current* props are merged in at submit, which no reconciliation behaviour
 * can make stale. The page additionally keys this component on the selected
 * month, so the other per-month defaults (scope, category) reset too.
 */
export function BudgetForm({
  year,
  month,
  categories,
  overallExists,
  onCreated,
}: {
  year: number
  month: number
  categories: Category[]
  overallExists: boolean
  /** The create sheet closes itself on success. */
  onCreated?: () => void
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const submit = useSubmitState()
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `budget-${name}-${uid}`
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<BudgetFormInput>({
    resolver: zodResolver(budgetFormSchema),
    defaultValues: defaultValues(overallExists),
  })

  const scope = useWatch({ control, name: 'scope' })

  useEffect(() => {
    if (scope !== 'CATEGORY') setValue('categoryId', undefined)
  }, [scope, setValue])

  async function onSubmit(values: BudgetFormInput) {
    setError(null)
    await submit.run(async () => {
      try {
        // `year`/`month` are read here, from the props this render was given —
        // the month the user is looking at — never from form state.
        const result = await createBudgetAction({ ...values, year, month })
        if (!result.ok) {
          setError(t(BUDGET_ERROR_KEYS[result.error]))
          return
        }
        // A reset back to the same month's defaults rather than a bare `reset()`,
        // so a second budget for the same month does not require re-navigating.
        reset(defaultValues(overallExists))
        router.refresh()
        onCreated?.()
      } catch {
        console.error('BudgetForm: create failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as
          `TransactionForm`'s; `lib/ui/use-hydrated.ts` documents the defect.
          A live pre-fix probe reverted this form's scope 5/5 times and its
          amount 5/5 times when they were set before hydration finished. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">{t('budgets.createTitle')}</legend>

        <FormField id={fieldId('scope')} label={t('budgets.scope')} error={errors.scope?.message}>
          {(aria) => (
            // `defaultValue` (never `value` — that would make this controlled)
            // so the server renders `selected` on whichever option the form
            // state already holds; with an Overall budget already on this
            // month that is CATEGORY, the *second* option.
            <div className="relative">
              <select
                {...aria}
                {...register('scope')}
                defaultValue={defaultScope(overallExists)}
                className={SELECT_CLASS}
              >
                <option value="OVERALL">{t('labels.budgetScope.OVERALL')}</option>
                <option value="CATEGORY">{t('labels.budgetScope.CATEGORY')}</option>
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          )}
        </FormField>

        {scope === 'CATEGORY' && (
          <FormField
            id={fieldId('category')}
            label={t('budgets.category')}
            error={errors.categoryId?.message}
          >
            {(aria) => (
              <div className="relative">
                <select
                  {...aria}
                  {...register('categoryId', {
                    // An emptied/untouched select's DOM value is `""` (the
                    // placeholder option) — converting that to `undefined`
                    // here is what lets the schema's own "Category is
                    // required" refine message fire instead of a generic one.
                    setValueAs: (v: string) => (v === '' ? undefined : v),
                  })}
                  defaultValue=""
                  className={SELECT_CLASS}
                >
                  <option value="">{t('budgets.categoryPlaceholder')}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            )}
          </FormField>
        )}

        <FormField
          id={fieldId('amount')}
          label={t('budgets.amount')}
          error={errors.amount?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('amount', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('currency')}
          label={t('budgets.currency')}
          error={errors.currency?.message}
        >
          {(aria) => (
            <div className="relative">
              <select {...aria} {...register('currency')} className={SELECT_CLASS}>
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

        <Button type="submit" className="self-start">
          {submit.pending ? t('budgets.createPending') : t('budgets.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
