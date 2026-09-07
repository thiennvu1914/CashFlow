'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createDebtSchema, type CreateDebtInput } from '@/lib/validation/debt'
import { createDebtAction } from '@/lib/server/actions/debt-actions'
import { DEBT_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The create form for a debt.
 *
 * Takes no props: a debt belongs to no month, no account and no category, so
 * there is nothing about the page's state it has to merge in at submit (unlike
 * `BudgetForm`, which carries the selected month).
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
 * terms the debt never had. The wording of the two direction options is
 * therefore the only place the user states it.
 */
function defaultValues(): Partial<CreateDebtInput> {
  return { direction: 'RECEIVABLE', person: '', currency: 'VND' }
}

export function DebtForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateDebtInput>({
    resolver: zodResolver(createDebtSchema),
    defaultValues: defaultValues(),
  })

  async function onSubmit(values: CreateDebtInput) {
    setError(null)
    try {
      const result = await createDebtAction(values)
      if (!result.ok) {
        setError(DEBT_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues())
      router.refresh()
    } catch {
      console.error('DebtForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as `GoalForm`'s;
          `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">New debt</legend>
        <div>
          {/* `defaultValue` (never `value` — that would make this controlled).
              RECEIVABLE is already the first option, so react-dom would land
              here anyway; it is passed so the server HTML states the form's own
              default rather than relying on a browser fallback, and so this
              select cannot silently disagree with `useForm`'s default the way
              `/transactions`' Type select once did. */}
          <select
            {...register('direction')}
            defaultValue="RECEIVABLE"
            aria-label="Direction"
            className="rounded-md border p-2"
          >
            {/* The user's own words, not the enum: they are answering a question
                about their own situation. */}
            <option value="RECEIVABLE">Someone owes me</option>
            <option value="PAYABLE">I owe someone</option>
          </select>
          {errors.direction && <p className="text-sm text-negative">{errors.direction.message}</p>}
        </div>
        <div>
          <Input aria-label="Person" placeholder="Who (e.g. Minh)" {...register('person')} />
          {errors.person && <p className="text-sm text-negative">{errors.person.message}</p>}
        </div>
        <div>
          <Input
            type="number"
            step="0.01"
            aria-label="Original amount"
            placeholder="Amount"
            {...register('originalAmount', { valueAsNumber: true })}
          />
          {errors.originalAmount && (
            <p className="text-sm text-negative">{errors.originalAmount.message}</p>
          )}
        </div>
        <div>
          <select
            {...register('currency')}
            defaultValue="VND"
            aria-label="Debt currency"
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
              `calendarDateToUtcCarrier` (ruling R6-7). `valueAsDate` would hand
              over an instant the browser's zone had already coloured. */}
          <Input type="date" aria-label="Due date" {...register('dueDate')} />
          {errors.dueDate && <p className="text-sm text-negative">{errors.dueDate.message}</p>}
        </div>
        <div>
          <Input
            aria-label="Description"
            placeholder="What it was for (optional)"
            {...register('description', {
              // `''` means "no description", so it is normalised to `undefined`
              // here and the service stores `null` — otherwise an untouched
              // field would write an empty string that reads back as a value.
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
          />
          {errors.description && (
            <p className="text-sm text-negative">{errors.description.message}</p>
          )}
        </div>
        <div>
          <Input
            aria-label="Notes"
            placeholder="Notes (optional)"
            {...register('notes', {
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
          />
          {errors.notes && <p className="text-sm text-negative">{errors.notes.message}</p>}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          Add debt
        </Button>
        {error && <p className="text-sm text-negative">{error}</p>}
      </fieldset>
    </form>
  )
}
