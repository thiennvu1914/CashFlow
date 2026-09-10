'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
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
import { GENERIC_ERROR_KEY, SAVINGS_GOAL_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
import { useRowError } from '@/components/common/row-error-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Update progress / Edit / Archive for one goal row — split into two
 * independent pieces (fix round 1, findings 4/5/6), rendered by `GoalList`
 * into two different `PlanningRow` slots:
 *
 *  - `GoalProgressButton` — the row's one inline primary action, passed as
 *    `inlineAction`. Fully self-contained (its own `progressOpen` state and
 *    `Dialog`); it never needs to share anything with the menu, so there is
 *    no reason for it to live in the same component.
 *  - `GoalRowMenu` — Edit/Archive, passed as `actions`. Its archive-failure
 *    error is reported through `useRowError` rather than a local `useState`:
 *    `GoalList` renders this into `actions` and a `RowErrorAlert` into
 *    `extra` (under the row), and only a shared Context can connect a menu
 *    click to an alert that renders elsewhere in the tree.
 *
 * Neither ever mounts on the Dashboard's compact list (no `renderActions`
 * there) or in the page's archived section (an archived goal refuses every
 * write; offering the actions would be a promise the service breaks).
 *
 * "Cập nhật tiến độ" opens a `Dialog` (one amount field, Save/Cancel — the
 * same overlay primitive every other inline action uses) rather than a
 * popover, which would be a fifth overlay behaviour in a product that
 * already has three and would not trap focus.
 *
 * Progress and definition are two forms, not one, because they are two user
 * intents — "I saved another 2 million" and "I actually need 60 million" —
 * and a single form would make either an accidental overwrite of the other.
 *
 * All three forms mount only while their `Dialog`/`ConfirmDialog` is open, so
 * `useForm` snapshots the *current* row as its defaults; there is no
 * stale-default problem to gate for, and no `useHydrated` here — a click
 * cannot happen before hydration.
 */
export function GoalProgressButton({ goal }: { goal: SavingsGoalDto }) {
  const t = useTranslations()
  const [progressOpen, setProgressOpen] = useState(false)

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        // Height only: `size="sm"`'s 36 px is a mouse target, and spec §8
        // wants 44 px under a thumb — so this inline row action is 44 px
        // below the icon rail and the compact 36 px from `md` up.
        className="h-11 md:h-9"
        onClick={() => setProgressOpen(true)}
      >
        {t('goals.progressAction')}
      </Button>

      <Dialog
        open={progressOpen}
        onOpenChange={setProgressOpen}
        title={t('goals.progressTitle', { name: goal.name })}
        // The same "nothing here moves money" copy the page's subtitle
        // carries, repeated at the point of action: saving this field records
        // a number the user typed, never an account balance or a transfer.
        description={t('goals.description')}
        closeLabel={t('common.close')}
      >
        {progressOpen && <GoalProgressForm goal={goal} onDone={() => setProgressOpen(false)} />}
      </Dialog>
    </>
  )
}

export function GoalRowMenu({ goal }: { goal: SavingsGoalDto }) {
  const router = useRouter()
  const t = useTranslations()
  const [editOpen, setEditOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const { setError } = useRowError()
  const archiveSubmit = useSubmitState()

  async function confirmArchive() {
    setError(null)
    await archiveSubmit.run(async () => {
      try {
        const result = await archiveSavingsGoalAction(goal.id)
        if (!result.ok) {
          setArchiving(false)
          setError(t(SAVINGS_GOAL_ERROR_KEYS[result.error]))
          return
        }
        setArchiving(false)
        router.refresh()
      } catch {
        console.error('GoalRowMenu: archive failed')
        setArchiving(false)
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <>
      <RowActionsMenu
        label={t('common.rowActions', { name: goal.name })}
        actions={[
          { id: 'edit', label: t('goals.editAction'), onSelect: () => setEditOpen(true) },
          {
            id: 'archive',
            label: t('goals.archiveAction'),
            tone: 'negative',
            onSelect: () => {
              setError(null)
              setArchiving(true)
            },
          },
        ]}
      />

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t('goals.editTitle', { name: goal.name })}
        closeLabel={t('common.close')}
      >
        {editOpen && <GoalEditForm goal={goal} onDone={() => setEditOpen(false)} />}
      </Dialog>

      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t('goals.archiveConfirmTitle', { name: goal.name })}
        description={t('goals.archiveConfirmBody')}
        confirmLabel={t('goals.archiveAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('goals.archivePending')}
        onConfirm={confirmArchive}
      />
    </>
  )
}

/** "How much have you put aside now?" — one field, and the only write that
 *  moves a goal's progress. Its own copy makes clear that saving it moves no
 *  account money: it only records what the user says they now have. */
function GoalProgressForm({ goal, onDone }: { goal: SavingsGoalDto; onDone: () => void }) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useSubmitState()
  const uid = useId().replace(/:/g, '')
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UpdateSavingsGoalProgressInput>({
    resolver: zodResolver(updateSavingsGoalProgressSchema),
    defaultValues: { currentProgress: Number(goal.editable.currentProgress) },
  })

  async function onSubmit(values: UpdateSavingsGoalProgressInput) {
    setError(null)
    await submit.run(async () => {
      try {
        const result = await updateSavingsGoalProgressAction(goal.id, values)
        if (!result.ok) {
          setError(t(SAVINGS_GOAL_ERROR_KEYS[result.error]))
          return
        }
        router.refresh()
        onDone()
      } catch {
        console.error('GoalProgressForm: update failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">{t('goals.progressAction')}</legend>

        <FormField
          id={`goal-progress-${uid}`}
          label={t('goals.progressField')}
          error={errors.currentProgress?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('currentProgress', { valueAsNumber: true })}
            />
          )}
        </FormField>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit">
            {submit.pending ? t('goals.progressPending') : t('common.save')}
          </Button>
        </div>
      </fieldset>
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
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useSubmitState()
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `goal-edit-${name}-${uid}`
  const {
    register,
    handleSubmit,
    formState: { errors },
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
    await submit.run(async () => {
      try {
        const result = await updateSavingsGoalAction(goal.id, values)
        if (!result.ok) {
          setError(t(SAVINGS_GOAL_ERROR_KEYS[result.error]))
          return
        }
        router.refresh()
        onDone()
      } catch {
        console.error('GoalEditForm: update failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">{t('goals.editAction')}</legend>

        <FormField id={fieldId('name')} label={t('goals.name')} error={errors.name?.message}>
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
          id={fieldId('currency')}
          label={t('goals.currency')}
          error={errors.currency?.message}
        >
          {(aria) => (
            <div className="relative">
              <select
                {...aria}
                {...register('currency')}
                defaultValue={goal.editable.currency}
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
          {(aria) => <Input {...aria} type="date" {...register('deadline')} />}
        </FormField>

        <FormField id={fieldId('note')} label={t('goals.note')} error={errors.note?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('note', {
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
