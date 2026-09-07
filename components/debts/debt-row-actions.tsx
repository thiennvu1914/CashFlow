'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
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
import { DEBT_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import type { DebtDto } from '@/lib/ui/debt-view-model'
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
 * A payment and an edit are two forms, not one, because they are two user
 * intents — "Minh paid me 250.000 on the 2nd" and "the name was wrong" — and a
 * single form would make either an accidental submission of the other. Only one
 * pane is open at a time.
 *
 * Both forms mount on click rather than staying mounted hidden, so `useForm`
 * snapshots the *current* row as its defaults; there is no stale-default
 * problem to gate for, and no `useHydrated` here (a click cannot happen before
 * hydration).
 */
type OpenPane = 'none' | 'payment' | 'edit'

export function DebtRowActions({ debt, today }: { debt: DebtDto; today: string }) {
  const router = useRouter()
  const [pane, setPane] = useState<OpenPane>('none')
  const [error, setError] = useState<string | null>(null)

  // A written-off debt refuses every write (`DebtNotActiveError`), so it is
  // offered no buttons at all — showing them would be a promise the service
  // breaks. Guarded here as well as by the page (which renders the written-off
  // section without a `renderActions` slot), because this component is the one
  // that knows what its buttons do.
  if (!debt.active) return null

  async function handleWriteOff() {
    if (!window.confirm('Write off this debt? Payments already recorded stay in the history.')) {
      return
    }
    setError(null)
    try {
      const result = await writeOffDebtAction(debt.id)
      if (!result.ok) {
        setError(DEBT_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
    } catch {
      console.error('DebtRowActions: write-off failed')
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
        <Button type="button" variant="outline" size="sm" onClick={() => toggle('payment')}>
          {pane === 'payment' ? 'Close' : 'Record payment'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => toggle('edit')}>
          {pane === 'edit' ? 'Close' : 'Edit'}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={handleWriteOff}>
          Write off
        </Button>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      {pane === 'payment' && (
        <DebtPaymentForm debt={debt} today={today} onDone={() => setPane('none')} />
      )}
      {pane === 'edit' && <DebtEditForm debt={debt} onDone={() => setPane('none')} />}
    </div>
  )
}

/**
 * "How much came back, and when?" — the only write that moves a debt's
 * outstanding amount.
 *
 * The service refuses a payment above what is still owed, under a row lock, so
 * OVERPAYMENT is a genuinely reachable answer here (two tabs, a double-click,
 * or simply a typo) and it is shown inline under the form rather than as a
 * banner somewhere else on the page.
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
  const [error, setError] = useState<string | null>(null)
  // Two debts can be with the same person, so a person-only `aria-describedby`
  // target would be ambiguous between rows; `useId` makes the association per
  // row.
  const uid = useId()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RecordDebtPaymentInput>({
    resolver: zodResolver(recordDebtPaymentSchema),
    // No default for `amount`: a pre-filled `0` is the one value the schema
    // always rejects, and react-hook-form would write it into the DOM.
    defaultValues: { date: today },
  })

  async function onSubmit(values: RecordDebtPaymentInput) {
    setError(null)
    try {
      const result = await recordDebtPaymentAction(debt.id, values)
      if (!result.ok) {
        setError(DEBT_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone()
    } catch {
      console.error('DebtPaymentForm: record failed')
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
          aria-label={`Payment amount for ${debt.person}`}
          aria-describedby={errors.amount ? `${uid}-amount-error` : undefined}
          placeholder={`Amount (${debt.currency})`}
          {...register('amount', { valueAsNumber: true })}
        />
        {errors.amount && (
          <p id={`${uid}-amount-error`} className="text-sm text-negative">
            {errors.amount.message}
          </p>
        )}
      </div>
      <div>
        {/* Defaulted to the user's today, and editable: a repayment is often
            recorded a day or two after it happened, and which day it was is
            what the history is for. */}
        <Input
          type="date"
          aria-label={`Payment date for ${debt.person}`}
          aria-describedby={errors.date ? `${uid}-date-error` : undefined}
          {...register('date')}
        />
        {errors.date && (
          <p id={`${uid}-date-error`} className="text-sm text-negative">
            {errors.date.message}
          </p>
        )}
      </div>
      <div>
        <Input
          aria-label={`Payment note for ${debt.person}`}
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
      {/* Where OVERPAYMENT lands: "That payment is more than what is still
          owed." right under the amount the user typed, with the outstanding
          figure still on the row above it. */}
      {error && <p className="text-sm text-negative">{error}</p>}
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
  const [error, setError] = useState<string | null>(null)
  const uid = useId()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
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
    try {
      const result = await updateDebtAction(debt.id, values)
      if (!result.ok) {
        setError(DEBT_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone()
    } catch {
      console.error('DebtEditForm: update failed')
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
          aria-label={`Edit person for ${debt.person}`}
          aria-describedby={errors.person ? `${uid}-person-error` : undefined}
          {...register('person')}
        />
        {errors.person && (
          <p id={`${uid}-person-error`} className="text-sm text-negative">
            {errors.person.message}
          </p>
        )}
      </div>
      <div>
        <Input
          aria-label={`Edit description for ${debt.person}`}
          aria-describedby={errors.description ? `${uid}-description-error` : undefined}
          placeholder="What it was for (optional)"
          {...register('description', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
        />
        {errors.description && (
          <p id={`${uid}-description-error`} className="text-sm text-negative">
            {errors.description.message}
          </p>
        )}
      </div>
      <div>
        <Input
          type="date"
          aria-label={`Edit due date for ${debt.person}`}
          aria-describedby={errors.dueDate ? `${uid}-due-date-error` : undefined}
          {...register('dueDate')}
        />
        {errors.dueDate && (
          <p id={`${uid}-due-date-error`} className="text-sm text-negative">
            {errors.dueDate.message}
          </p>
        )}
      </div>
      <div>
        <Input
          aria-label={`Edit notes for ${debt.person}`}
          placeholder="Notes (optional)"
          {...register('notes', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
        />
        {errors.notes && <p className="text-sm text-negative">{errors.notes.message}</p>}
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
