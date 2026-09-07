'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { budgetFormSchema, type BudgetFormInput } from '@/lib/validation/budget'
import { createBudgetAction } from '@/lib/server/actions/budget-actions'
import { BUDGET_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
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
}: {
  year: number
  month: number
  categories: Category[]
  overallExists: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
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
    try {
      // `year`/`month` are read here, from the props this render was given —
      // the month the user is looking at — never from form state.
      const result = await createBudgetAction({ ...values, year, month })
      if (!result.ok) {
        setError(BUDGET_ERROR_MESSAGES[result.error])
        return
      }
      // A reset back to the same month's defaults rather than a bare `reset()`,
      // so a second budget for the same month does not require re-navigating.
      reset(defaultValues(overallExists))
      router.refresh()
    } catch {
      console.error('BudgetForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as
          `TransactionForm`'s; `lib/ui/use-hydrated.ts` documents the defect.
          A live pre-fix probe reverted this form's scope 5/5 times and its
          amount 5/5 times when they were set before hydration finished. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">Budget details</legend>
        <div>
          {/* `defaultValue` (never `value` — that would make this controlled)
              so the server renders `selected` on whichever option the form
              state already holds; with an Overall budget already on this month
              that is CATEGORY, the *second* option. */}
          <select
            {...register('scope')}
            defaultValue={defaultScope(overallExists)}
            aria-label="Budget scope"
            className="rounded-md border p-2"
          >
            <option value="OVERALL">Overall</option>
            <option value="CATEGORY">Category</option>
          </select>
          {errors.scope && <p className="text-sm text-negative">{errors.scope.message}</p>}
        </div>
        {scope === 'CATEGORY' && (
          <div>
            <select
              {...register('categoryId', {
                // An emptied/untouched select's DOM value is `""` (the
                // placeholder option) — converting that to `undefined` here is
                // what lets the schema's own "Category is required" refine
                // message fire instead of a generic one.
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
              aria-label="Budget category"
              defaultValue=""
              className="rounded-md border p-2"
            >
              <option value="">Select a category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {errors.categoryId && (
              <p className="text-sm text-negative">{errors.categoryId.message}</p>
            )}
          </div>
        )}
        <div>
          <Input
            type="number"
            step="0.01"
            aria-label="Budget amount"
            placeholder="Amount"
            {...register('amount', { valueAsNumber: true })}
          />
          {errors.amount && <p className="text-sm text-negative">{errors.amount.message}</p>}
        </div>
        <div>
          <select
            {...register('currency')}
            aria-label="Budget currency"
            className="rounded-md border p-2"
          >
            <option value="VND">VND</option>
            <option value="USD">USD</option>
          </select>
          {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          Add budget
        </Button>
        {error && <p className="text-sm text-negative">{error}</p>}
      </fieldset>
    </form>
  )
}
