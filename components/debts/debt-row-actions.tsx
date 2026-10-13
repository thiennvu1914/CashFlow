'use client'

import { useId, useState } from 'react'
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
  deleteDebtPaymentAction,
  recordDebtPaymentAction,
  updateDebtAction,
  updateDebtPaymentAction,
  writeOffDebtAction,
} from '@/lib/server/actions/debt-actions'
import { DEBT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { defaultPaymentAccountId, type DebtAccountOption } from '@/lib/ui/debt-accounts'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { DebtDto, DebtPaymentDto } from '@/lib/ui/debt-view-model'
import { DebtAccountField } from '@/components/debts/debt-account-field'
import { DebtLinkForm } from '@/components/debts/debt-link-form'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { RowActionsMenu, type RowAction } from '@/components/common/row-actions-menu'
import { useRowError } from '@/components/common/row-error-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Record payment / Edit / Write off for one debt row — split into two
 * independent pieces (fix round 1, findings 4/5/6/7), rendered by `DebtList`
 * into two different `PlanningRow` slots:
 *
 *  - `DebtPaymentButton` — the row's one inline action, passed as
 *    `inlineAction`. `variant="outline"` (not filled): the header's "Thêm
 *    công nợ" is the page's one primary action, and a filled button on every
 *    row competed with it (fix round 1, finding 4 — the same treatment
 *    the goal row's inline action got). Hidden entirely once the debt is PAID
 *    (`outstanding` is zero): the service refuses any further payment as
 *    OVERPAYMENT regardless of amount, so the button would offer nothing but
 *    a guaranteed refusal (fix round 1, finding 5).
 *  - `DebtRowMenu` — Edit / Record in an account / Write off, passed as
 *    `actions`. Its write-off failure is reported through `useRowError`
 *    rather than a local `useState`: `DebtList` renders this into `actions`
 *    and a `RowErrorAlert` into `extra` (under the row), and only a shared
 *    Context can connect a menu click to an alert that renders elsewhere in
 *    the tree.
 *
 * Neither ever mounts on the Dashboard's compact list (no `renderActions`
 * there). In the page's written-off section only the menu mounts, and only
 * for a debt whose opening moved no money yet: a written-off debt refuses
 * every write except "Record in an account" (spec 2026-10-12 §6.4) — writing
 * it off did not undo the money that moved.
 *
 * Money-source linking (spec 2026-10-12 §6.2): a repayment can be recorded in
 * an account, and then the server writes the `DebtPayment` and its linked
 * Transaction together. The payment form's picker starts on the debt's opening
 * account, else the user's most recently used one, and offers only accounts in
 * the debt's currency; "don't record in an account" keeps the old
 * tracking-only behaviour. `DebtPaymentActions` edits or deletes a recorded
 * payment, which changes or removes the linked transaction with it.
 *
 * A payment and an edit are two forms, not one, because they are two user
 * intents — "Minh paid me 250.000 on the 2nd" and "the name was wrong" — and a
 * single form would make either an accidental submission of the other. (A
 * payment *correction* is the payment form again, prefilled: same fields, same
 * rules.)
 *
 * Both forms mount only while their `Dialog` is open, so `useForm` snapshots
 * the *current* row as its defaults; there is no stale-default problem to gate
 * for, and no `useHydrated` here — a click cannot happen before hydration.
 */
export function DebtPaymentButton({
  debt,
  today,
  accounts,
  mostRecentAccountId,
}: {
  debt: DebtDto
  today: string
  /** Every active account; the form keeps the ones in the debt's currency. */
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
}) {
  const t = useTranslations()
  const [paymentOpen, setPaymentOpen] = useState(false)

  // A written-off debt refuses every write (`DebtNotActiveError`); guarded
  // here as well as by the page (which renders the written-off section
  // without a `renderActions` slot), because this component is the one that
  // knows what its button does. A fully PAID debt keeps its menu (Edit stays
  // useful) but drops this button: `outstanding` is zero, and the service
  // rejects any further payment as OVERPAYMENT no matter what is typed.
  if (!debt.active || debt.status === 'PAID') return null

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
        aria-label={`${t('debts.paymentAction')} · ${debt.person}`}
        onClick={() => setPaymentOpen(true)}
      >
        {t('debts.paymentAction')}
      </Button>

      <Dialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        title={t('debts.paymentTitle', { name: debt.person })}
        // The page subtitle's copy about accounts, repeated at the point of
        // action.
        description={t('debts.description')}
        closeLabel={t('common.close')}
      >
        {paymentOpen && (
          <DebtPaymentForm
            debt={debt}
            today={today}
            accounts={accounts}
            mostRecentAccountId={mostRecentAccountId}
            onDone={() => setPaymentOpen(false)}
          />
        )}
      </Dialog>
    </>
  )
}

export function DebtRowMenu({
  debt,
  accounts,
  mostRecentAccountId,
}: {
  debt: DebtDto
  /** Every active account; "Record in an account" keeps the ones in the
   *  debt's currency. */
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
}) {
  const t = useTranslations()
  const [editOpen, setEditOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [writingOff, setWritingOff] = useState(false)
  const { setError } = useRowError()
  const writeOffSubmit = useActionSubmit(t)

  // Offered while the opening moved no money (spec §6.4), and gone once it
  // has: the page re-renders with `openingAccountId` set after the action.
  const canLink = debt.openingAccountId === null
  if (!debt.active && !canLink) return null

  const actions: RowAction[] = []
  if (debt.active) {
    actions.push({ id: 'edit', label: t('debts.editAction'), onSelect: () => setEditOpen(true) })
  }
  if (canLink) {
    actions.push({
      id: 'link',
      label: t('debts.linkAction'),
      onSelect: () => {
        setError(null)
        setLinkOpen(true)
      },
    })
  }
  if (debt.active) {
    actions.push({
      id: 'writeOff',
      label: t('debts.writeOffAction'),
      tone: 'negative',
      onSelect: () => {
        setError(null)
        setWritingOff(true)
      },
    })
  }

  async function confirmWriteOff() {
    await writeOffSubmit.run({
      tag: 'DebtRowMenu: write-off failed',
      action: () => writeOffDebtAction(debt.id),
      errorKeys: DEBT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      // Closes on BOTH outcomes: the row's message renders behind this
      // dialog's own scrim (`components/common/confirm-dialog.tsx`).
      onSettled: () => setWritingOff(false),
    })
  }

  return (
    <>
      <RowActionsMenu label={t('common.rowActions', { name: debt.person })} actions={actions} />

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t('debts.editTitle', { name: debt.person })}
        closeLabel={t('common.close')}
      >
        {editOpen && <DebtEditForm debt={debt} onDone={() => setEditOpen(false)} />}
      </Dialog>

      <Dialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        title={t('debts.linkTitle', { name: debt.person })}
        description={t('debts.linkDescription')}
        closeLabel={t('common.close')}
      >
        {linkOpen && (
          <DebtLinkForm
            debt={debt}
            accounts={accounts}
            mostRecentAccountId={mostRecentAccountId}
            onDone={() => setLinkOpen(false)}
          />
        )}
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
 * States the current outstanding above the amount field (owner requirement
 * G4: "current outstanding, payment amount, payment date, optional note") so
 * the OVERPAYMENT refusal below is predictable rather than a surprise — the
 * figure the service is about to compare against is right there while the
 * user types.
 *
 * The service refuses a payment above what is still owed, under a row lock, so
 * OVERPAYMENT is a genuinely reachable answer here (two tabs, a double-click,
 * or simply a typo) and it is shown inline under the form's fields, with the
 * outstanding figure still visible on the row behind the dialog.
 */
export function DebtPaymentForm({
  debt,
  today,
  accounts,
  mostRecentAccountId,
  payment,
  onDone,
}: {
  debt: DebtDto
  /** The user's own calendar day, from `todayCalendarDateInZone` on the page —
   *  never `new Date()` in the browser, whose zone is not the profile's. */
  today: string
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  /** Present when correcting a recorded payment: the same form, prefilled. */
  payment?: DebtPaymentDto
  onDone: () => void
}) {
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `debt-payment-${name}-${uid}`
  // A debt moves money only in its own currency, so the picker lists no other.
  const activeOptions = accounts.filter((account) => account.currency === debt.currency)
  // The account a correction started on may have been archived since; it stays
  // in the list, labelled, rather than the picker falling back to "don't
  // record" (which would unlink the payment and delete its transaction on save).
  const options: DebtAccountOption[] =
    payment?.accountId && payment.accountArchived
      ? [
          ...activeOptions,
          {
            id: payment.accountId,
            name: payment.accountName ?? '',
            currency: debt.currency,
            archived: true,
          },
        ]
      : activeOptions
  // A new payment starts on the debt's opening account, else the most recently
  // used one. A correction starts on what the payment actually used — never a
  // pre-selection of its own, or saving a note fix would silently link the
  // payment.
  const initialAccountId = payment
    ? options.some((option) => option.id === payment.accountId)
      ? payment.accountId!
      : ''
    : defaultPaymentAccountId(options, debt.openingAccountId, mostRecentAccountId)
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RecordDebtPaymentInput>({
    resolver: zodResolver(recordDebtPaymentSchema),
    // No default for a new payment's `amount`: a pre-filled `0` is the one
    // value the schema always rejects, and react-hook-form would write it into
    // the DOM.
    defaultValues: payment
      ? {
          amount: Number(payment.amountInput),
          date: payment.date,
          note: payment.note ?? undefined,
          accountId: initialAccountId === '' ? undefined : initialAccountId,
        }
      : { date: today, accountId: initialAccountId === '' ? undefined : initialAccountId },
  })

  async function onSubmit(values: RecordDebtPaymentInput) {
    await submit.run({
      tag: payment ? 'DebtPaymentForm: edit failed' : 'DebtPaymentForm: record failed',
      action: () =>
        payment
          ? updateDebtPaymentAction(payment.id, values)
          : recordDebtPaymentAction(debt.id, values),
      errorKeys: DEBT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        onDone()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">
          {payment ? t('debts.paymentEditAction') : t('debts.paymentAction')}
        </legend>

        {/* The outstanding figure is what a NEW payment is checked against; for
            a correction the comparison is against what is owed without this
            payment, a number this form does not have, so it is not stated. */}
        {!payment && (
          <p className="text-sm text-muted-foreground">
            {t('debts.paymentOutstanding', { amount: debt.outstanding, currency: debt.currency })}
          </p>
        )}

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

        <DebtAccountField
          id={fieldId('account')}
          accounts={options}
          defaultAccountId={initialAccountId}
          registration={register('accountId', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
          error={errors.accountId?.message}
          helper={payment?.accountId ? t('debts.paymentEditLinkedNote') : undefined}
        />

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
 * Edit and Delete for one recorded payment, in the history under the row.
 *
 * Two quiet ghost buttons rather than a `…` menu: the history is a compact list
 * of lines and each line has exactly these two actions. Both labels carry the
 * payment's date and amount, so a screen reader (and a test) can tell the lines
 * apart. Delete asks first, in the one `ConfirmDialog` this product uses, and
 * says whether a linked transaction goes with the payment; a failure closes the
 * dialog and is explained on the row, like the write-off's.
 */
export function DebtPaymentActions({
  debt,
  payment,
  today,
  accounts,
  mostRecentAccountId,
  dateLabel,
}: {
  debt: DebtDto
  payment: DebtPaymentDto
  today: string
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  /** The payment's date as the history prints it, for the accessible names. */
  dateLabel: string
}) {
  const t = useTranslations()
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { setError } = useRowError()
  const deleteSubmit = useActionSubmit(t)
  const labelArgs = { date: dateLabel, amount: payment.amount }

  async function confirmDelete() {
    await deleteSubmit.run({
      tag: 'DebtPaymentActions: delete failed',
      action: () => deleteDebtPaymentAction(payment.id),
      errorKeys: DEBT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSettled: () => setDeleting(false),
    })
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        aria-label={t('debts.paymentEditLabel', labelArgs)}
        onClick={() => setEditOpen(true)}
      >
        {t('debts.paymentEditAction')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-negative"
        aria-label={t('debts.paymentDeleteLabel', labelArgs)}
        onClick={() => {
          setError(null)
          setDeleting(true)
        }}
      >
        {t('debts.paymentDeleteAction')}
      </Button>

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t('debts.paymentEditTitle', { name: debt.person })}
        closeLabel={t('common.close')}
      >
        {editOpen && (
          <DebtPaymentForm
            debt={debt}
            today={today}
            accounts={accounts}
            mostRecentAccountId={mostRecentAccountId}
            payment={payment}
            onDone={() => setEditOpen(false)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('debts.paymentDeleteConfirmTitle')}
        description={
          payment.accountId
            ? t('debts.paymentDeleteConfirmLinked')
            : t('debts.paymentDeleteConfirmPlain')
        }
        confirmLabel={t('debts.paymentDeleteAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('debts.paymentDeletePending')}
        onConfirm={confirmDelete}
      />
    </>
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
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
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
    await submit.run({
      tag: 'DebtEditForm: update failed',
      action: () => updateDebtAction(debt.id, values),
      errorKeys: DEBT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        onDone()
      },
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
