'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { Currency } from '@prisma/client'
import {
  updateFinancialAccountSchema,
  type UpdateFinancialAccountInput,
} from '@/lib/validation/financial-account'
import { updateFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'
import { ACCOUNT_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type AccountType = { id: string; name: string }

/**
 * Edits an existing FinancialAccount. Kept as its own (small) component
 * rather than a mode-switched `AccountForm`, since create and edit submit
 * different action shapes (`createFinancialAccountAction` takes no id; this
 * always has one) and only edit ever needs the `locked` behaviour.
 *
 * `locked` is computed server-side (`accountsWithActivity`, in
 * `app/(app)/accounts/page.tsx`) and passed in as a prop — this component
 * has no business logic of its own, it only reacts to the flag. When locked,
 * currency and initialBalance are both disabled AND stripped from the
 * submitted payload: `updateFinancialAccount` rejects an update that even
 * *carries* either field once the account has activity, regardless of
 * whether the value actually changed, so the locked fields must never be
 * sent at all, not merely sent unchanged.
 */
export function AccountEditForm({
  accountId,
  accountTypes,
  locked,
  initialValues,
  onDone,
}: {
  accountId: string
  accountTypes: AccountType[]
  locked: boolean
  initialValues: {
    name: string
    accountTypeId: string
    description?: string | null
    currency: Currency
    initialBalance: number
  }
  onDone?: () => void
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateFinancialAccountInput>({
    resolver: zodResolver(updateFinancialAccountSchema),
    defaultValues: {
      name: initialValues.name,
      accountTypeId: initialValues.accountTypeId,
      description: initialValues.description ?? undefined,
      currency: initialValues.currency,
      initialBalance: initialValues.initialBalance,
    },
  })

  async function onSubmit(values: UpdateFinancialAccountInput) {
    setError(null)
    const payload: UpdateFinancialAccountInput = locked
      ? {
          name: values.name,
          accountTypeId: values.accountTypeId,
          description: values.description,
        }
      : values

    try {
      const result = await updateFinancialAccountAction(accountId, payload)
      if (!result.ok) {
        setError(ACCOUNT_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
      onDone?.()
    } catch {
      console.error('AccountEditForm: update failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <div>
        <Input placeholder="Account name" {...register('name')} />
        {errors.name && <p className="text-sm text-negative">{errors.name.message}</p>}
      </div>
      <div>
        <select
          {...register('accountTypeId')}
          aria-label="Account type"
          className="rounded-md border p-2"
        >
          {accountTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {errors.accountTypeId && (
          <p className="text-sm text-negative">{errors.accountTypeId.message}</p>
        )}
      </div>
      <div>
        <Input
          type="number"
          step="0.01"
          placeholder="Initial balance"
          disabled={locked}
          aria-label="Initial balance"
          {...register('initialBalance', { valueAsNumber: true })}
        />
        {errors.initialBalance && (
          <p className="text-sm text-negative">{errors.initialBalance.message}</p>
        )}
      </div>
      <div>
        <select
          {...register('currency')}
          aria-label="Currency"
          disabled={locked}
          className="rounded-md border p-2"
        >
          <option value="VND">VND</option>
          <option value="USD">USD</option>
        </select>
        {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
      </div>
      {locked && (
        <p className="text-sm text-warning">
          Currency and initial balance are locked because this account already has activity.
        </p>
      )}
      <div>
        <Input placeholder="Description (optional)" {...register('description')} />
        {errors.description && (
          <p className="text-sm text-negative">{errors.description.message}</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          Save
        </Button>
        {onDone && (
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  )
}
