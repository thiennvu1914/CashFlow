'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import {
  recordDebtPaymentSchema,
  updateDebtSchema,
  type RecordDebtPaymentInput,
  type UpdateDebtInput,
} from '@/lib/validation/debt'
import {
  recordDebtPaymentAction,
  updateDebtAction,
  writeOffDebtAction,
} from '@/lib/server/actions/debt-actions'
import { DEBT_ERROR_KEYS, GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import type { DebtDto } from '@/lib/ui/debt-view-model'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Record payment / Edit / Write off for one debt row. Rendered only by the
 * Debts page, through `DebtList`'s `renderActions` slot — the Dashboard's
 * compact list passes no `renderActions`, so this never mounts there.
 *
 * Nothing here moves money. Recording a repayment writes a `DebtPayment` row
 * and nothing else: no Transaction, no Transfer, no account balance. Whether
 * the cash also passed through a tracked account is a separate fact the user
 * records separately, which is why the page says so in its subtitle rather
 * than leaving the reader to wonder.
 *
 * "Ghi nhận thanh toán" is the row's one INLINE primary action — it opens a
 * `Dialog` (spec §6.6), not a right-aligned panel. Edit and Write off live in
 * the row's `…` menu: they are less frequent, and write-off is destructive and
 * terminal, so it is confirmed through a `ConfirmDialog` rather than a native
 * `window.confirm`.
 *
 * A payment and an edit are two forms, not one, because they are two user
 * intents — "Minh paid me 250.000 on the 2nd" and "the name was wrong" — and a
 * single form would make either an accidental submission of the other.
 *
 * Both forms mount only while their `Dialog` is open, so `useForm` snapshots
 * the *current* row as its defaults; there is no stale-default problem to gate
 * for, and no `useHydrated` here — a click cannot happen before hydration.
 */
export function DebtRowActions({ debt, today }: { debt: DebtDto; today: string }) {
  const router = useRouter()
  const t = useTranslations()
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [writingOff, setWritingOff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writeOffSubmit = useSubmitState()

  // A written-off debt refuses every write (`DebtNotActiveError`), so it is
  // offered no buttons at all — showing them would be a promise the service
  // breaks. Guarded here as well as by the page (which renders the written-off
  // section without a `renderActions` slot), because this component is the one
  // that knows what its buttons do.
  if (!debt.active) return null

  async function confirmWriteOff() {
    setError(null)
    await writeOffSubmit.run(async () => {
      try {
        const result = await writeOffDebtAction(debt.id)
        if (!result.ok) {
          setWritingOff(false)
          setError(t(DEBT_ERROR_KEYS[result.error]))
          return
        }
        setWritingOff(false)
        router.refresh()
      } catch {
        console.error('DebtRowActions: write-off failed')
        setWritingOff(false)
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <>
      <div className="flex w-full flex-col gap-2 min-[480px]:w-auto min-[480px]:flex-row min-[480px]:items-center">
        <Button
          type="button"
          size="sm"
          className="w-full min-[480px]:w-auto"
          aria-label={`${t('debts.paymentAction')} · ${debt.person}`}
          onClick={() => setPaymentOpen(true)}
        >
          {t('debts.paymentAction')}
        </Button>
        <RowActionsMenu
          label={t('common.rowActions', { name: debt.person })}
          actions={[
            { id: 'edit', label: t('debts.editAction'), onSelect: () => setEditOpen(true) },
            {
              id: 'writeOff',
              label: t('debts.writeOffAction'),
              tone: 'negative',
              onSelect: () => {
                setError(null)
                setWritingOff(true)
              },
            },
          ]}
        />
      </div>

      {error && (
        <InlineAlert tone="negative" className="mt-2">
          {error}
        </InlineAlert>
      )}

      <Dialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        title={t('debts.paymentTitle', { name: debt.person })}
        // The same "nothing here moves money" copy the page's subtitle
        // carries, repeated at the point of action.
        description={t('debts.description')}
        closeLabel={t('common.close')}
      >
        {paymentOpen && (
          <DebtPaymentForm debt={debt} today={today} onDone={() => setPaymentOpen(false)} />
        )}
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t('debts.editTitle', { name: debt.person })}
        closeLabel={t('common.close')}
      >
        {editOpen && <DebtEditForm debt={debt} onDone={() => setEditOpen(false)} />}
      </Dialog>

      <ConfirmDialog
        open={writingOff}
        onOpenChange={setWritingOff}
        title={t('debts.writeOffConfirmTitle', { name: debt.person })}
        description={t('debts.writeOffConfirmBody')}
        confirmLabel={t('debts.writeOffAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('debts.writeOffPending')}
        onConfirm={confirmWriteOff}
      />
    </>
  )
}

/**
 * "How much came back, and when?" — the only write that moves a debt's
 * outstanding amount.
 *
 * The service refuses a payment above what is still owed, under a row lock, so
 * OVERPAYMENT is a genuinely reachable answer here (two tabs, a double-click,
 * or simply a typo) and it is shown inline under the form's fields, with the
 * outstanding figure still visible on the row behind the dialog.
 */
function DebtPaymentForm({
  debt,
  today,
  onDone,
}: {
  debt: DebtDto
  /** The user's own calendar day, from `todayCalendarDateInZone` on the page —
   *  never `new Date()` in the browser, whose zone is not the profile's. */
  today: string
  onDone: () => void
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useSubmitState()
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `debt-payment-${name}-${uid}`
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RecordDebtPaymentInput>({
    resolver: zodResolver(recordDebtPaymentSchema),
    // No default for `amount`: a pre-filled `0` is the one value the schema
    // always rejects, and react-hook-form would write it into the DOM.
    defaultValues: { date: today },
  })

  async function onSubmit(values: RecordDebtPaymentInput) {
    setError(null)
    await submit.run(async () => {
      try {
        const result = await recordDebtPaymentAction(debt.id, values)
        if (!result.ok) {
          setError(t(DEBT_ERROR_KEYS[result.error]))
          return
        }
        router.refresh()
        onDone()
      } catch {
        console.error('DebtPaymentForm: record failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">{t('debts.paymentAction')}</legend>

        <FormField
          id={fieldId('amount')}
          label={t('debts.paymentAmount')}
          error={errors.amount?.message}
        >
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="pr-14"
                {...register('amount', { valueAsNumber: true })}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                {debt.currency}
              </span>
            </div>
          )}
        </FormField>

        <FormField id={fieldId('date')} label={t('debts.paymentDate')} error={errors.date?.message}>
          {/* Defaulted to the user's today, and editable: a repayment is often
              recorded a day or two after it happened, and which day it was is
              what the history is for. */}
          {(aria) => <Input {...aria} type="date" {...register('date')} />}
        </FormField>

        <FormField id={fieldId('note')} label={t('debts.paymentNote')} error={errors.note?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('note', {
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        {/* Where OVERPAYMENT lands: "That payment is more than what is still
            owed." right under the fields the user typed. */}
        {error && <InlineAlert tone="negative">{error}</InlineAlert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit">
            {submit.pending ? t('debts.paymentPending') : t('common.save')}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

/**
 * What can be corrected or renegotiated about a debt, matching
 * `updateDebtSchema` field for field: who it is with, what it was for, when it
 * is due, and the notes.
 *
 * `direction`, `originalAmount` and `currency` are deliberately absent — they
 * are immutable after creation, are not in the schema at all, and rendering
 * them would offer an edit the service strips. Prefilled from the DTO's
 * `editable`, which is already all strings: a `Prisma.Decimal` cannot cross
 * into this component.
 */
function DebtEditForm({ debt, onDone }: { debt: DebtDto; onDone: () => void }) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useSubmitState()
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `debt-edit-${name}-${uid}`
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UpdateDebtInput>({
    resolver: zodResolver(updateDebtSchema),
    defaultValues: {
      person: debt.editable.person,
      // `''` is what an empty input holds, and what the schema reads back as
      // "no value" — so clearing a field really clears it. Passed as
      // `undefined` here so react-hook-form reads the DOM rather than writing
      // an empty string over it.
      description: debt.editable.description === '' ? undefined : debt.editable.description,
      dueDate: debt.editable.dueDate === '' ? undefined : debt.editable.dueDate,
      notes: debt.editable.notes === '' ? undefined : debt.editable.notes,
    },
  })

  async function onSubmit(values: UpdateDebtInput) {
    setError(null)
    await submit.run(async () => {
      try {
        const result = await updateDebtAction(debt.id, values)
        if (!result.ok) {
          setError(t(DEBT_ERROR_KEYS[result.error]))
          return
        }
        router.refresh()
        onDone()
      } catch {
        console.error('DebtEditForm: update failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">{t('debts.editAction')}</legend>

        <FormField id={fieldId('person')} label={t('debts.person')} error={errors.person?.message}>
          {(aria) => <Input {...aria} {...register('person')} />}
        </FormField>

        <FormField
          id={fieldId('description')}
          label={t('debts.descriptionField')}
          error={errors.description?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              {...register('description', {
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('due-date')}
          label={t('debts.dueDate')}
          error={errors.dueDate?.message}
        >
          {(aria) => <Input {...aria} type="date" {...register('dueDate')} />}
        </FormField>

        <FormField id={fieldId('notes')} label={t('debts.notes')} error={errors.notes?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('notes', {
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
