'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { Currency } from '@prisma/client'
import type { z } from 'zod'
import { createTransactionSchema, type CreateTransactionInput } from '@/lib/validation/transaction'
import {
  createTransactionAction,
  type TransactionActionError,
} from '@/lib/server/actions/transaction-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type TransactionType = CreateTransactionInput['type']

/**
 * `createTransactionSchema`'s `date` field is `z.coerce.date()`: its *input*
 * type (what the `<input type="date">` DOM element actually produces, and
 * what `defaultValues` must supply) is a plain string, while its *output*
 * type (what a submit handler receives after Zod coerces it) is a `Date` —
 * matching `CreateTransactionInput`. `useForm`'s three generics keep the two
 * sides straight instead of casting a string through `Date`.
 */
type FormInput = z.input<typeof createTransactionSchema>

type Account = { id: string; name: string; currency: Currency }
type Category = { id: string; name: string; type: 'INCOME' | 'EXPENSE' }

/** The two types that hit the P&L and therefore need a matching category
 *  (mirrors `CATEGORY_REQUIRED_TYPES` in `lib/validation/transaction.ts`). */
const CATEGORY_REQUIRED_TYPES = new Set<TransactionType>(['INCOME', 'EXPENSE'])

const GENERIC_ERROR = 'Something went wrong. Please try again.'

const ACTION_ERROR_MESSAGES: Record<TransactionActionError, string> = {
  FX_UNAVAILABLE: 'Exchange rate is temporarily unavailable. Please try again in a moment.',
  ARCHIVED_ACCOUNT: 'This account is archived.',
  INVALID_CATEGORY: 'Choose a valid category for this type.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That record no longer exists.',
}

/** `yyyy-mm-dd`, the format an `<input type="date">` requires — Zod coerces it
 *  back into a `Date` on submit. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

const DEFAULT_TYPE: TransactionType = 'EXPENSE'

function defaultValues(accounts: Account[]): FormInput {
  return {
    accountId: accounts[0]?.id ?? '',
    categoryId: undefined,
    type: DEFAULT_TYPE,
    date: todayIsoDate(),
    amount: 0,
    note: undefined,
  }
}

export function TransactionForm({
  accounts,
  categories,
}: {
  accounts: Account[]
  categories: Category[]
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
  } = useForm<FormInput, unknown, CreateTransactionInput>({
    resolver: zodResolver(createTransactionSchema),
    defaultValues: defaultValues(accounts),
  })

  const type = useWatch({ control, name: 'type' })
  const accountId = useWatch({ control, name: 'accountId' })
  const needsCategory = CATEGORY_REQUIRED_TYPES.has(type)
  const relevantCategories = categories.filter((c) => c.type === type)
  const selectedAccount = accounts.find((a) => a.id === accountId)

  useEffect(() => {
    if (!needsCategory) setValue('categoryId', undefined)
  }, [needsCategory, setValue])

  async function onSubmit(values: CreateTransactionInput) {
    setError(null)
    try {
      const result = await createTransactionAction(values)
      if (!result.ok) {
        setError(ACTION_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues(accounts))
      router.refresh()
    } catch {
      console.error('TransactionForm: create failed')
      setError(GENERIC_ERROR)
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
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  )
}
