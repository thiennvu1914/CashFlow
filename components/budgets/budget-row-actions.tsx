'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { updateBudgetSchema, type UpdateBudgetInput } from '@/lib/validation/budget'
import { deleteBudgetAction, updateBudgetAction } from '@/lib/server/actions/budget-actions'
import { BUDGET_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import type { BudgetProgressDto } from '@/lib/ui/budget-view-model'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Edit/Delete for one budget row. Rendered only by the Budgets page, through
 * `BudgetProgressList`'s `renderActions` slot — the Dashboard's compact list
 * passes no `renderActions`, so this component never mounts there.
 *
 * `year`/`month`/`scope`/`categoryId` are a budget's identity (see
 * `updateBudget` in `lib/server/services/budget.ts`) and are never editable
 * here — only amount and currency, matching `updateBudgetSchema`.
 */
export function BudgetRowActions({ budget }: { budget: BudgetProgressDto }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    if (!window.confirm('Delete this budget? Spending history is not affected.')) return
    setError(null)
    try {
      const result = await deleteBudgetAction(budget.id)
      if (!result.ok) {
        setError(BUDGET_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
    } catch {
      console.error('BudgetRowActions: delete failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <div className="flex w-full flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : 'Edit'}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={handleDelete}>
          Delete
        </Button>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      {editing && <BudgetEditForm budget={budget} onDone={() => setEditing(false)} />}
    </div>
  )
}

function BudgetEditForm({ budget, onDone }: { budget: BudgetProgressDto; onDone: () => void }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateBudgetInput>({
    resolver: zodResolver(updateBudgetSchema),
    defaultValues: {
      amount: Number(budget.editable.amount),
      currency: budget.editable.currency,
    },
  })

  async function onSubmit(values: UpdateBudgetInput) {
    setError(null)
    try {
      const result = await updateBudgetAction(budget.id, values)
      if (!result.ok) {
        setError(BUDGET_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone()
    } catch {
      console.error('BudgetEditForm: update failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex w-full max-w-xs flex-col gap-2 border-t border-border pt-2"
    >
      <div>
        <Input
          type="number"
          step="0.01"
          aria-label="Edit budget amount"
          {...register('amount', { valueAsNumber: true })}
        />
        {errors.amount && <p className="text-sm text-negative">{errors.amount.message}</p>}
      </div>
      <div>
        <select
          {...register('currency')}
          aria-label="Edit budget currency"
          className="rounded-md border p-2"
        >
          <option value="VND">VND</option>
          <option value="USD">USD</option>
        </select>
        {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          Save
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  )
}
