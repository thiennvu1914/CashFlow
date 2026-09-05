'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { Currency } from '@prisma/client'
import {
  createTransactionFormSchema,
  type CreateTransactionFormInput,
  type CreateTransactionInput,
} from '@/lib/validation/transaction'
import { createTransactionAction } from '@/lib/server/actions/transaction-actions'
import { GENERIC_ERROR_MESSAGE, TRANSACTION_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import { todayInZone } from '@/lib/datetime/today-in-zone'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type TransactionType = CreateTransactionInput['type']

/**
 * The form validates and submits `createTransactionFormSchema`, whose `date`
 * is the raw `yyyy-MM-dd` string the `<input type="date">` produced — input
 * and output types are the same here, so no `Date` ever exists client-side.
 *
 * That is deliberate (ruling R-21b): a calendar day only becomes an instant
 * once a timezone is chosen, and the browser's zone is not necessarily the
 * user's configured zone. `createTransactionAction` does the conversion in
 * the session user's IANA zone; see `lib/datetime/calendar-date.ts`.
 */
type FormInput = CreateTransactionFormInput

type Account = { id: string; name: string; currency: Currency }
type Category = { id: string; name: string; type: 'INCOME' | 'EXPENSE' }

/** The two types that hit the P&L and therefore need a matching category
 *  (mirrors `CATEGORY_REQUIRED_TYPES` in `lib/validation/transaction.ts`). */
const CATEGORY_REQUIRED_TYPES = new Set<TransactionType>(['INCOME', 'EXPENSE'])

const DEFAULT_TYPE: TransactionType = 'EXPENSE'

function defaultValues(accounts: Account[], timezone: string): FormInput {
  return {
    accountId: accounts[0]?.id ?? '',
    categoryId: undefined,
    type: DEFAULT_TYPE,
    date: todayInZone(timezone),
    amount: 0,
    note: undefined,
  }
}

export function TransactionForm({
  accounts,
  categories,
  timezone,
}: {
  accounts: Account[]
  categories: Category[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page) — the default date must land on *their* today, not
   * whatever calendar day it happens to be in UTC at the moment they open
   * the form.
   */
  timezone: string
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormInput>({
    resolver: zodResolver(createTransactionFormSchema),
    defaultValues: defaultValues(accounts, timezone),
  })

  const type = useWatch({ control, name: 'type' })
  const accountId = useWatch({ control, name: 'accountId' })
  const needsCategory = CATEGORY_REQUIRED_TYPES.has(type)
  const relevantCategories = categories.filter((c) => c.type === type)
  const selectedAccount = accounts.find((a) => a.id === accountId)

  useEffect(() => {
    if (!needsCategory) setValue('categoryId', undefined)
  }, [needsCategory, setValue])

  async function onSubmit(values: FormInput) {
    setError(null)
    try {
      const result = await createTransactionAction(values)
      if (!result.ok) {
        setError(TRANSACTION_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues(accounts, timezone))
      router.refresh()
    } catch {
      console.error('TransactionForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <div>
        <select
          {...register('type')}
          aria-label="Transaction type"
          className="rounded-md border p-2"
        >
          <option value="INCOME">Income</option>
          <option value="EXPENSE">Expense</option>
          <option value="CASH_IN">Cash In (other)</option>
          <option value="CASH_OUT">Cash Out (other)</option>
          <option value="ADJUSTMENT_INCREASE">Balance Adjustment — increase</option>
          <option value="ADJUSTMENT_DECREASE">Balance Adjustment — decrease</option>
        </select>
        {errors.type && <p className="text-sm text-negative">{errors.type.message}</p>}
      </div>
      <div>
        <select {...register('accountId')} aria-label="Account" className="rounded-md border p-2">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {errors.accountId && <p className="text-sm text-negative">{errors.accountId.message}</p>}
      </div>
      {needsCategory && (
        <div>
          <select
            {...register('categoryId', {
              // An emptied/untouched select's DOM value is `""` (the
              // placeholder option) — converting that to `undefined` here is
              // what lets the schema's friendly "Category is required for
              // income and expense transactions" refine message fire,
              // instead of the generic "at least 1 character" message a
              // stray `""` would otherwise trigger.
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
            aria-label="Category"
            defaultValue=""
            className="rounded-md border p-2"
          >
            <option value="">Select a category</option>
            {relevantCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {errors.categoryId && (
            <p className="text-sm text-negative">{errors.categoryId.message}</p>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step="0.01"
          aria-label="Amount"
          placeholder="Amount"
          {...register('amount', { valueAsNumber: true })}
        />
        {/* Read-only: currency always follows the selected account, so the
           client never sends it — this is display only. */}
        <span className="text-sm text-foreground/60">{selectedAccount?.currency ?? ''}</span>
      </div>
      {errors.amount && <p className="text-sm text-negative">{errors.amount.message}</p>}
      <div>
        <Input type="date" aria-label="Date" {...register('date')} />
        {errors.date && <p className="text-sm text-negative">{errors.date.message}</p>}
      </div>
      <div>
        <Input placeholder="Note (optional)" aria-label="Note" {...register('note')} />
        {errors.note && <p className="text-sm text-negative">{errors.note.message}</p>}
      </div>
      <Button type="submit" disabled={isSubmitting}>
        Add transaction
      </Button>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </form>
  )
}
