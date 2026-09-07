'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  createFinancialAccountSchema,
  type CreateFinancialAccountInput,
} from '@/lib/validation/financial-account'
import { createFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'
import { ACCOUNT_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type AccountType = { id: string; name: string }

export function AccountForm({ accountTypes }: { accountTypes: AccountType[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateFinancialAccountInput>({
    resolver: zodResolver(createFinancialAccountSchema),
    // `accountTypeId` defaults to the first option so the <select>'s visible
    // selection and the form's actual value always agree — without this, the
    // browser renders the first <option> while the form field stays `''`
    // until the user touches the control, so a submit before any interaction
    // would silently send an empty accountTypeId.
    defaultValues: {
      currency: 'VND',
      initialBalance: 0,
      accountTypeId: accountTypes[0]?.id ?? '',
    },
  })

  async function onSubmit(values: CreateFinancialAccountInput) {
    setError(null)
    try {
      const result = await createFinancialAccountAction(values)
      if (!result.ok) {
        setError(ACCOUNT_ERROR_MESSAGES[result.error])
        return
      }
      reset()
      router.refresh()
    } catch {
      console.error('AccountForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as
          `TransactionForm`'s; `lib/ui/use-hydrated.ts` documents the defect.
          A live pre-fix probe reverted this form's "Initial balance" to `0`
          5/5 times when it was typed before hydration finished. (The Account
          name survived 5/5 — it has no `defaultValues` entry, and RHF only
          overwrites the DOM for fields that do; the gate covers both rather
          than leaving the rule "whichever fields happen to have a default".)

          Every `<select>` here defaults to its own first option, so none needs
          a `defaultValue` to make the server HTML agree with the form. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">Account details</legend>
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
            {...register('initialBalance', { valueAsNumber: true })}
          />
          {errors.initialBalance && (
            <p className="text-sm text-negative">{errors.initialBalance.message}</p>
          )}
        </div>
        <div>
          <select {...register('currency')} aria-label="Currency" className="rounded-md border p-2">
            <option value="VND">VND</option>
            <option value="USD">USD</option>
          </select>
          {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
        </div>
        <div>
          <Input placeholder="Description (optional)" {...register('description')} />
          {errors.description && (
            <p className="text-sm text-negative">{errors.description.message}</p>
          )}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          Create account
        </Button>
        {error && <p className="text-sm text-negative">{error}</p>}
      </fieldset>
    </form>
  )
}
