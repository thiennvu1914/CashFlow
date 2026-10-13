'use client'

import { useId, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import {
  savingsGoalEntrySchema,
  updateSavingsGoalSchema,
  type SavingsGoalEntryInput,
  type UpdateSavingsGoalInput,
} from '@/lib/validation/savings-goal'
import {
  addSavingsGoalEntryAction,
  archiveSavingsGoalAction,
  deleteSavingsGoalEntryAction,
  updateSavingsGoalAction,
  updateSavingsGoalEntryAction,
} from '@/lib/server/actions/savings-goal-actions'
import { SAVINGS_GOAL_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import type { SavingsGoalDto, SavingsGoalEntryDto } from '@/lib/ui/savings-goal-view-model'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
import { useRowError } from '@/components/common/row-error-context'
import { DebtAccountField } from '@/components/debts/debt-account-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Contribute / Withdraw / Edit / Archive for one goal row, and Edit / Delete
 * for one history entry — rendered by `GoalList` into different `PlanningRow`
 * slots:
 *
 *  - `GoalEntryButtons` — the row's inline action, passed as `inlineAction`,
 *    for a goal that records its own entries (spec 2026-10-12 §6.7). A goal
 *    that follows an account gets none: its progress is the account's balance.
 *    Self-contained (its own dialog state); it shares nothing with the menu.
 *  - `GoalRowMenu` — Edit/Archive, passed as `actions`. Its archive-failure
 *    error is reported through `useRowError` rather than a local `useState`:
 *    `GoalList` renders this into `actions` and a `RowErrorAlert` into
 *    `extra` (under the row), and only a shared Context can connect a menu
 *    click to an alert that renders elsewhere in the tree.
 *  - `GoalEntryActions` — Edit/Delete on a history line, the same two quiet
 *    ghost buttons the debt payment history uses; a delete failure is
 *    explained on the row like the archive's.
 *
 * None ever mounts on the Dashboard's compact list (no `renderActions` there)
 * or in the page's archived section (an archived goal refuses every write;
 * offering the actions would be a promise the service breaks).
 *
 * Each form mounts only while its `Dialog`/`ConfirmDialog` is open, so
 * `useForm` snapshots the *current* row as its defaults; there is no
 * stale-default problem to gate for, and no `useHydrated` here — a click
 * cannot happen before hydration.
 *
 * Nothing here moves account money: an entry is a record of what the user put
 * aside, and the server refuses one that would take the goal below zero.
 */
export function GoalEntryButtons({ goal, today }: { goal: SavingsGoalDto; today: string }) {
  const t = useTranslations()
  const [kind, setKind] = useState<SavingsGoalEntryInput['kind'] | null>(null)

  return (
    <>
      {/* Height only: `size="sm"`'s 36 px is a mouse target, and spec §8 wants
          44 px under a thumb — so these inline row actions are 44 px below the
          icon rail and the compact 36 px from `md` up. */}
      <span className="flex gap-1 max-sm:[&>button]:flex-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 md:h-9"
          aria-label={t('goals.contributeLabel', { name: goal.name })}
          onClick={() => setKind('CONTRIBUTION')}
        >
          {t('goals.contributeAction')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 md:h-9"
          aria-label={t('goals.withdrawLabel', { name: goal.name })}
          onClick={() => setKind('WITHDRAWAL')}
        >
          {t('goals.withdrawAction')}
        </Button>
      </span>

      <Dialog
        open={kind !== null}
        onOpenChange={(open) => {
          if (!open) setKind(null)
        }}
        title={t(kind === 'WITHDRAWAL' ? 'goals.withdrawLabel' : 'goals.contributeLabel', {
          name: goal.name,
        })}
        description={t('goals.description')}
        closeLabel={t('common.close')}
      >
        {kind !== null && (
          <GoalEntryForm goal={goal} kind={kind} today={today} onDone={() => setKind(null)} />
        )}
      </Dialog>
    </>
  )
}

export function GoalRowMenu({
  goal,
  accounts,
}: {
  goal: SavingsGoalDto
  accounts: ReadonlyArray<DebtAccountOption>
}) {
  const t = useTranslations()
  const [editOpen, setEditOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const { setError } = useRowError()
  const archiveSubmit = useActionSubmit(t)

  async function confirmArchive() {
    await archiveSubmit.run({
      tag: 'GoalRowMenu: archive failed',
      action: () => archiveSavingsGoalAction(goal.id),
      errorKeys: SAVINGS_GOAL_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      // Closes on BOTH outcomes: the row's message renders behind this
      // dialog's own scrim (`components/common/confirm-dialog.tsx`).
      onSettled: () => setArchiving(false),
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
        {editOpen && (
          <GoalEditForm goal={goal} accounts={accounts} onDone={() => setEditOpen(false)} />
        )}
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

/**
 * One contribution or withdrawal: amount, date (today unless the user says
 * otherwise, never later) and a note. `kind` is fixed by the button that opened
 * it (or by the entry being edited) — it is part of the posted value but not a
 * field. The schema is built from the page's `today`, so a future date is
 * refused on the date field; the server enforces the same against the user's
 * own zone.
 */
function GoalEntryForm({
  goal,
  kind,
  today,
  entry,
  onDone,
}: {
  goal: SavingsGoalDto
  kind: SavingsGoalEntryInput['kind']
  today: string
  /** Present when editing an existing entry. */
  entry?: SavingsGoalEntryDto
  onDone: () => void
}) {
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `goal-entry-${name}-${uid}`
  const schema = useMemo(() => savingsGoalEntrySchema(today), [today])
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SavingsGoalEntryInput>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind,
      amount: entry ? Number(entry.amountValue) : undefined,
      date: entry ? entry.date : today,
      note: entry && entry.note !== '' ? entry.note : undefined,
    },
  })

  async function onSubmit(values: SavingsGoalEntryInput) {
    await submit.run({
      tag: 'GoalEntryForm: save failed',
      action: () =>
        entry
          ? updateSavingsGoalEntryAction(entry.id, values)
          : addSavingsGoalEntryAction(goal.id, values),
      errorKeys: SAVINGS_GOAL_ERROR_KEYS,
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
          {t(kind === 'WITHDRAWAL' ? 'goals.withdrawAction' : 'goals.contributeAction')}
        </legend>

        <FormField
          id={fieldId('amount')}
          label={t('goals.entryAmount')}
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

        <FormField id={fieldId('date')} label={t('goals.entryDate')} error={errors.date?.message}>
          {/* A calendar date as a string, never `valueAsDate` (ruling R6-7);
              `max` mirrors the schema's "not later than today". */}
          {(aria) => <Input {...aria} type="date" max={today} {...register('date')} />}
        </FormField>

        <FormField id={fieldId('note')} label={t('goals.entryNote')} error={errors.note?.message}>
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
          <Button type="submit">
            {submit.pending ? t('goals.entryPending') : t('common.save')}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

/** Edit and Delete for one history line — see the module doc. Both labels carry
 *  the entry's kind, amount and date so a screen reader (and a test) can tell
 *  the lines apart. */
export function GoalEntryActions({
  goal,
  entry,
  today,
  dateLabel,
}: {
  goal: SavingsGoalDto
  entry: SavingsGoalEntryDto
  today: string
  /** The entry's date as the history prints it, for the accessible names. */
  dateLabel: string
}) {
  const t = useTranslations()
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { setError } = useRowError()
  const deleteSubmit = useActionSubmit(t)
  const labelArgs = {
    kind: t(entry.kind === 'WITHDRAWAL' ? 'goals.entryWithdrawal' : 'goals.entryContribution'),
    amount: entry.amount,
    date: dateLabel,
  }

  async function confirmDelete() {
    await deleteSubmit.run({
      tag: 'GoalEntryActions: delete failed',
      action: () => deleteSavingsGoalEntryAction(entry.id),
      errorKeys: SAVINGS_GOAL_ERROR_KEYS,
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
        aria-label={t('goals.entryEditLabel', labelArgs)}
        onClick={() => setEditOpen(true)}
      >
        {t('goals.entryEditAction')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-negative"
        aria-label={t('goals.entryDeleteLabel', labelArgs)}
        onClick={() => {
          setError(null)
          setDeleting(true)
        }}
      >
        {t('goals.entryDeleteAction')}
      </Button>

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t('goals.entryEditTitle', { name: goal.name })}
        closeLabel={t('common.close')}
      >
        {editOpen && (
          <GoalEntryForm
            goal={goal}
            kind={entry.kind}
            today={today}
            entry={entry}
            onDone={() => setEditOpen(false)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('goals.entryDeleteConfirmTitle')}
        description={t('goals.entryDeleteConfirmBody')}
        confirmLabel={t('goals.entryDeleteAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('goals.entryDeletePending')}
        onConfirm={confirmDelete}
      />
    </>
  )
}

/**
 * The account choices an edit offers: the active accounts, plus the goal's
 * current account even when it was archived since (kept selected and labelled,
 * so saving does not silently unlink), and — for a goal that already has
 * entries — only accounts in the goal's own currency, because its entries are
 * amounts in that currency and the service refuses to re-denominate them
 * (CURRENCY_LOCKED).
 */
function editAccountOptions(
  goal: SavingsGoalDto,
  accounts: ReadonlyArray<DebtAccountOption>,
): DebtAccountOption[] {
  const options =
    goal.entries.length > 0 ? accounts.filter((a) => a.currency === goal.currency) : [...accounts]
  const linked = goal.linkedAccount
  if (linked && !options.some((option) => option.id === linked.id)) {
    options.push({ id: linked.id, name: linked.name, currency: goal.currency, archived: true })
  }
  return options
}

/**
 * The goal's definition and its progress source (which account it follows, if
 * any) — everything `updateSavingsGoalSchema` takes. Progress itself is never
 * an input: it is the account's balance or the goal's entries. Prefilled from
 * the DTO's `editable`, which is already all strings: a `Prisma.Decimal`
 * cannot cross into this component.
 *
 * The picker starts on the goal's current account, because the service reads an
 * absent `linkedAccountId` as "unlink". While an account is chosen the
 * currency select is hidden and the account's currency is what is sent.
 */
function GoalEditForm({
  goal,
  accounts,
  onDone,
}: {
  goal: SavingsGoalDto
  accounts: ReadonlyArray<DebtAccountOption>
  onDone: () => void
}) {
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `goal-edit-${name}-${uid}`
  const options = useMemo(() => editAccountOptions(goal, accounts), [goal, accounts])
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<UpdateSavingsGoalInput>({
    resolver: zodResolver(updateSavingsGoalSchema),
    defaultValues: {
      name: goal.editable.name,
      targetAmount: Number(goal.editable.targetAmount),
      currency: goal.editable.currency,
      linkedAccountId:
        goal.editable.linkedAccountId === '' ? undefined : goal.editable.linkedAccountId,
      // `''` is what an empty date input holds, and what the schema reads back
      // as "no deadline" — so clearing the field really clears the deadline.
      deadline: goal.editable.deadline === '' ? undefined : goal.editable.deadline,
      note: goal.editable.note === '' ? undefined : goal.editable.note,
    },
  })

  const currencyLocked = goal.entries.length > 0
  const watchedAccountId = useWatch({ control, name: 'linkedAccountId' })
  const linkedAccount = options.find((a) => a.id === watchedAccountId)

  async function onSubmit(values: UpdateSavingsGoalInput) {
    const payload: UpdateSavingsGoalInput = linkedAccount
      ? { ...values, currency: linkedAccount.currency }
      : values
    await submit.run({
      tag: 'GoalEditForm: update failed',
      action: () => updateSavingsGoalAction(goal.id, payload),
      errorKeys: SAVINGS_GOAL_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        onDone()
      },
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

        <DebtAccountField
          id={fieldId('account')}
          accounts={options}
          defaultAccountId={goal.editable.linkedAccountId}
          label={t('goals.linkedAccount')}
          noneLabel={t('goals.linkedAccountNone')}
          helper={t('goals.linkedAccountHelper')}
          error={errors.linkedAccountId?.message}
          registration={register('linkedAccountId', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
        />

        {!linkedAccount && (
          <FormField
            id={fieldId('currency')}
            label={t('goals.currency')}
            helper={currencyLocked ? t('goals.currencyLocked') : undefined}
            error={errors.currency?.message}
          >
            {(aria) => (
              <div className="relative">
                {/* A goal with entries cannot change currency (CURRENCY_LOCKED):
                    its entries are amounts in it. The select is shown disabled
                    and NOT registered, so the form still posts the goal's own
                    currency from its defaults (a disabled registered field
                    would post nothing). */}
                <select
                  {...aria}
                  {...(currencyLocked ? {} : register('currency'))}
                  disabled={currencyLocked}
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
        )}

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
