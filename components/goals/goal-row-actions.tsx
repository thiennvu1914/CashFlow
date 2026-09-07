'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  updateSavingsGoalProgressSchema,
  updateSavingsGoalSchema,
  type UpdateSavingsGoalInput,
  type UpdateSavingsGoalProgressInput,
} from '@/lib/validation/savings-goal'
import {
  archiveSavingsGoalAction,
  updateSavingsGoalAction,
  updateSavingsGoalProgressAction,
} from '@/lib/server/actions/savings-goal-actions'
import { GENERIC_ERROR_MESSAGE, SAVINGS_GOAL_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Update progress / Edit / Archive for one goal row. Rendered only by the
 * Savings page, through `GoalList`'s `renderActions` slot — the Dashboard's
 * compact list passes no `renderActions`, so this never mounts there, and the
 * page's archived section renders its rows without it (an archived goal
 * refuses every write; offering the buttons would be a promise the service
 * breaks).
 *
 * Progress and definition are two forms, not one, because they are two user
 * intents — "I saved another 2 million" and "I actually need 60 million" — and
 * a single form would make either an accidental overwrite of the other. Only
 * one pane is open at a time: they edit overlapping figures, so two open at
 * once would show two answers to "what is this goal now?".
 *
 * Both forms mount on click rather than staying mounted hidden, so `useForm`
 * snapshots the *current* row as its defaults; there is no stale-default
 * problem to gate for, and no `useHydrated` here (a click cannot happen before
 * hydration).
 */
type OpenPane = 'none' | 'progress' | 'edit'

export function GoalRowActions({ goal }: { goal: SavingsGoalDto }) {
  const router = useRouter()
  const [pane, setPane] = useState<OpenPane>('none')
  const [error, setError] = useState<string | null>(null)

  async function handleArchive() {
    if (!window.confirm('Archive this goal? Its history stays visible under Archived goals.')) {
      return
    }
    setError(null)
    try {
      const result = await archiveSavingsGoalAction(goal.id)
      if (!result.ok) {
        setError(SAVINGS_GOAL_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
    } catch {
      console.error('GoalRowActions: archive failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  function toggle(next: Exclude<OpenPane, 'none'>) {
    setError(null)
    setPane((current) => (current === next ? 'none' : next))
  }

  return (
    <div className="flex w-full flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => toggle('progress')}>
          {pane === 'progress' ? 'Close' : 'Update progress'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => toggle('edit')}>
          {pane === 'edit' ? 'Close' : 'Edit'}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={handleArchive}>
          Archive
        </Button>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      {pane === 'progress' && <GoalProgressForm goal={goal} onDone={() => setPane('none')} />}
      {pane === 'edit' && <GoalEditForm goal={goal} onDone={() => setPane('none')} />}
    </div>
  )
}

/** "How much have you put aside now?" — one field, and the only write that
 *  moves a goal's progress. */
function GoalProgressForm({ goal, onDone }: { goal: SavingsGoalDto; onDone: () => void }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  // Two goals can share a name, so a name-only `aria-describedby` target would
  // be ambiguous between rows; `useId` makes the association per row.
  const uid = useId()
  const errorId = `${uid}-progress-error`
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateSavingsGoalProgressInput>({
    resolver: zodResolver(updateSavingsGoalProgressSchema),
    defaultValues: { currentProgress: Number(goal.editable.currentProgress) },
  })

  async function onSubmit(values: UpdateSavingsGoalProgressInput) {
    setError(null)
    try {
      const result = await updateSavingsGoalProgressAction(goal.id, values)
      if (!result.ok) {
        setError(SAVINGS_GOAL_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone()
    } catch {
      console.error('GoalProgressForm: update failed')
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
          aria-label={`New amount for ${goal.name}`}
          aria-describedby={errors.currentProgress ? errorId : undefined}
          {...register('currentProgress', { valueAsNumber: true })}
        />
        {errors.currentProgress && (
          <p id={errorId} className="text-sm text-negative">
            {errors.currentProgress.message}
          </p>
        )}
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

/**
 * The goal's definition — everything except its progress, matching
 * `updateSavingsGoalSchema`. Prefilled from the DTO's `editable`, which is
 * already all strings: a `Prisma.Decimal` cannot cross into this component.
 */
function GoalEditForm({ goal, onDone }: { goal: SavingsGoalDto; onDone: () => void }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const uid = useId()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateSavingsGoalInput>({
    resolver: zodResolver(updateSavingsGoalSchema),
    defaultValues: {
      name: goal.editable.name,
      targetAmount: Number(goal.editable.targetAmount),
      currency: goal.editable.currency,
      // `''` is what an empty date input holds, and what the schema reads back
      // as "no deadline" — so clearing the field really clears the deadline.
      deadline: goal.editable.deadline === '' ? undefined : goal.editable.deadline,
      note: goal.editable.note === '' ? undefined : goal.editable.note,
    },
  })

  async function onSubmit(values: UpdateSavingsGoalInput) {
    setError(null)
    try {
      const result = await updateSavingsGoalAction(goal.id, values)
      if (!result.ok) {
        setError(SAVINGS_GOAL_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone()
    } catch {
      console.error('GoalEditForm: update failed')
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
          aria-label={`Edit name for ${goal.name}`}
          aria-describedby={errors.name ? `${uid}-name-error` : undefined}
          {...register('name')}
        />
        {errors.name && (
          <p id={`${uid}-name-error`} className="text-sm text-negative">
            {errors.name.message}
          </p>
        )}
      </div>
      <div>
        <Input
          type="number"
          step="0.01"
          aria-label={`Edit target for ${goal.name}`}
          aria-describedby={errors.targetAmount ? `${uid}-target-error` : undefined}
          {...register('targetAmount', { valueAsNumber: true })}
        />
        {errors.targetAmount && (
          <p id={`${uid}-target-error`} className="text-sm text-negative">
            {errors.targetAmount.message}
          </p>
        )}
      </div>
      <div>
        <select
          {...register('currency')}
          defaultValue={goal.editable.currency}
          aria-label={`Edit currency for ${goal.name}`}
          className="rounded-md border p-2"
        >
          <option value="VND">VND</option>
          <option value="USD">USD</option>
        </select>
        {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
      </div>
      <div>
        <Input
          type="date"
          aria-label={`Edit deadline for ${goal.name}`}
          aria-describedby={errors.deadline ? `${uid}-deadline-error` : undefined}
          {...register('deadline')}
        />
        {errors.deadline && (
          <p id={`${uid}-deadline-error`} className="text-sm text-negative">
            {errors.deadline.message}
          </p>
        )}
      </div>
      <div>
        <Input
          aria-label={`Edit note for ${goal.name}`}
          placeholder="Note (optional)"
          {...register('note', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
        />
        {errors.note && <p className="text-sm text-negative">{errors.note.message}</p>}
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
