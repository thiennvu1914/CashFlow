'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { updateBudgetSchema, type UpdateBudgetInput } from '@/lib/validation/budget'
import { deleteBudgetAction, updateBudgetAction } from '@/lib/server/actions/budget-actions'
import { BUDGET_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { BudgetProgressDto } from '@/lib/ui/budget-view-model'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
import { useRowError } from '@/components/common/row-error-context'
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
 *
 * The delete failure's error is reported through `useRowError` (fix round 1,
 * finding 6), not a local `useState`: `BudgetProgressList` renders this
 * component into `PlanningRow`'s `actions` cell and `RowErrorAlert` into its
 * `extra` slot (under the row), and only a shared Context can connect the
 * two.
 */
export function BudgetRowActions({ budget }: { budget: BudgetProgressDto }) {
  const router = useRouter()
  const t = useTranslations()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { setError } = useRowError()
  const deleteSubmit = useActionSubmit(t)

  const name = budget.categoryName ?? t('labels.budgetScope.OVERALL')

  async function confirmDelete() {
    await deleteSubmit.run({
      tag: 'BudgetRowActions: delete failed',
      action: () => deleteBudgetAction(budget.id),
      errorKeys: BUDGET_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      // Closes on BOTH outcomes: the row's message renders behind this
      // dialog's own scrim (`components/common/confirm-dialog.tsx`).
      onSettled: () => setConfirming(false),
      onSuccess: () => router.refresh(),
    })
  }

  return (
    <>
      <RowActionsMenu
        label={t('common.rowActions', { name })}
        actions={[
          { id: 'edit', label: t('budgets.editAction'), onSelect: () => setEditing(true) },
          {
            id: 'delete',
            label: t('budgets.deleteAction'),
            tone: 'negative',
            onSelect: () => {
              setError(null)
              setConfirming(true)
            },
          },
        ]}
      />

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={t('budgets.editTitle', { name })}
        closeLabel={t('common.close')}
      >
        {/* Mounted only while the dialog is open — this is what removes the
            form's SSR-defaults problem (spec §9): with no server render to
            disagree with, there is nothing for a hydration gate to guard. */}
        {editing && <BudgetEditForm budget={budget} onDone={() => setEditing(false)} />}
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('budgets.deleteConfirmTitle', { name })}
        description={t('budgets.deleteConfirmBody')}
        confirmLabel={t('budgets.deleteAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('budgets.deletePending')}
        onConfirm={confirmDelete}
      />
    </>
  )
}

function BudgetEditForm({ budget, onDone }: { budget: BudgetProgressDto; onDone: () => void }) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `budget-edit-${name}-${uid}`
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UpdateBudgetInput>({
    resolver: zodResolver(updateBudgetSchema),
    defaultValues: {
      amount: Number(budget.editable.amount),
      currency: budget.editable.currency,
    },
  })

  async function onSubmit(values: UpdateBudgetInput) {
    await submit.run({
      tag: 'BudgetEditForm: update failed',
      action: () => updateBudgetAction(budget.id, values),
      errorKeys: BUDGET_ERROR_KEYS,
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
        <legend className="sr-only">{t('budgets.editAction')}</legend>

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
