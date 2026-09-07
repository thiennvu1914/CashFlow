'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createSavingsGoalSchema, type CreateSavingsGoalInput } from '@/lib/validation/savings-goal'
import { createSavingsGoalAction } from '@/lib/server/actions/savings-goal-actions'
import { GENERIC_ERROR_MESSAGE, SAVINGS_GOAL_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The create form for a savings goal.
 *
 * Takes no props: a goal belongs to no month, no account and no category, so
 * there is nothing about the page's state it has to merge in at submit (unlike
 * `BudgetForm`, which carries the selected month).
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

export function GoalForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateSavingsGoalInput>({
    resolver: zodResolver(createSavingsGoalSchema),
    defaultValues: defaultValues(),
  })

  async function onSubmit(values: CreateSavingsGoalInput) {
    setError(null)
    try {
      const result = await createSavingsGoalAction(values)
      if (!result.ok) {
        setError(SAVINGS_GOAL_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues())
      router.refresh()
    } catch {
      console.error('GoalForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as
          `BudgetForm`'s; `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">New savings goal</legend>
        <div>
          <Input
            aria-label="Goal name"
            placeholder="Goal name (e.g. MacBook)"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-negative">{errors.name.message}</p>}
        </div>
        <div>
          <Input
            type="number"
            step="0.01"
            aria-label="Target amount"
            placeholder="Target amount"
            {...register('targetAmount', { valueAsNumber: true })}
          />
          {errors.targetAmount && (
            <p className="text-sm text-negative">{errors.targetAmount.message}</p>
          )}
        </div>
        <div>
          <Input
            type="number"
            step="0.01"
            aria-label="Current amount"
            placeholder="Already saved (optional)"
            {...register('currentProgress', {
              // `setValueAs` rather than `valueAsNumber` (the two are mutually
              // exclusive in react-hook-form, and `valueAsNumber` wins): an
              // untouched optional field's DOM value is `''`, which
              // `valueAsNumber` would hand to Zod as `NaN` — "Enter an amount"
              // under a field the user is entitled to skip.
              setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
            })}
          />
          {errors.currentProgress && (
            <p className="text-sm text-negative">{errors.currentProgress.message}</p>
          )}
        </div>
        <div>
          {/* `defaultValue` (never `value` — that would make this controlled).
              VND is already the first option, so react-dom would land here
              anyway; it is passed for symmetry with the other planning forms,
              whose defaults are not first, and so the server HTML states the
              form's own default rather than relying on a browser fallback. */}
          <select
            {...register('currency')}
            defaultValue="VND"
            aria-label="Goal currency"
            className="rounded-md border p-2"
          >
            <option value="VND">VND</option>
            <option value="USD">USD</option>
          </select>
          {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
        </div>
        <div>
          {/* A calendar date as a string, never `valueAsDate`: the value that
              travels is `yyyy-MM-dd` and the carrier is built server-side by
              `calendarDateToUtcCarrier` (ruling R6-7). `valueAsDate` would
              hand over an instant the browser's zone had already coloured. */}
          <Input type="date" aria-label="Deadline" {...register('deadline')} />
          {errors.deadline && <p className="text-sm text-negative">{errors.deadline.message}</p>}
        </div>
        <div>
          <Input
            aria-label="Goal note"
            placeholder="Note (optional)"
            {...register('note', {
              // `''` means "no note", so it is normalised to `undefined` here
              // and the service stores `null` — otherwise an untouched field
              // would write an empty string that reads back as a note.
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
          />
          {errors.note && <p className="text-sm text-negative">{errors.note.message}</p>}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          Add goal
        </Button>
        {error && <p className="text-sm text-negative">{error}</p>}
      </fieldset>
    </form>
  )
}
