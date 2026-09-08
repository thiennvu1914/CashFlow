'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { updateBudgetSchema, type UpdateBudgetInput } from '@/lib/validation/budget'
import { deleteBudgetAction, updateBudgetAction } from '@/lib/server/actions/budget-actions'
import { BUDGET_ERROR_KEYS, GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import type { BudgetProgressDto } from '@/lib/ui/budget-view-model'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
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
  const t = useTranslations()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleteSubmit = useSubmitState()

  const name = budget.categoryName ?? t('labels.budgetScope.OVERALL')

  async function confirmDelete() {
    setError(null)
    await deleteSubmit.run(async () => {
      try {
        const result = await deleteBudgetAction(budget.id)
        if (!result.ok) {
          setConfirming(false)
          setError(t(BUDGET_ERROR_KEYS[result.error]))
          return
        }
        setConfirming(false)
        router.refresh()
      } catch {
        console.error('BudgetRowActions: delete failed')
        setConfirming(false)
        setError(t(GENERIC_ERROR_KEY))
      }
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

      {error && (
        <InlineAlert tone="negative" className="mt-2">
          {error}
        </InlineAlert>
      )}

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
  const submit = useSubmitState()
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
    setError(null)
    await submit.run(async () => {
      try {
        const result = await updateBudgetAction(budget.id, values)
        if (!result.ok) {
          setError(t(BUDGET_ERROR_KEYS[result.error]))
          return
        }
        router.refresh()
        onDone()
      } catch {
        console.error('BudgetEditForm: update failed')
        setError(t(GENERIC_ERROR_KEY))
      }
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
            <select {...aria} {...register('currency')} className={SELECT_CLASS}>
              <option value="VND">VND</option>
              <option value="USD">USD</option>
            </select>
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
