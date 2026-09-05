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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type AccountType = { id: string; name: string }

const GENERIC_ERROR = 'Something went wrong. Please try again.'

export function AccountForm({ accountTypes }: { accountTypes: AccountType[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<CreateFinancialAccountInput>({
    resolver: zodResolver(createFinancialAccountSchema),
    defaultValues: { currency: 'VND', initialBalance: 0 },
  })

  async function onSubmit(values: CreateFinancialAccountInput) {
    setError(null)
    try {
      await createFinancialAccountAction(values)
      reset()
      router.refresh()
    } catch {
      console.error('AccountForm: create failed')
      setError(GENERIC_ERROR)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <Input placeholder="Account name" {...register('name')} />
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
      <Input
        type="number"
        step="0.01"
        placeholder="Initial balance"
        {...register('initialBalance', { valueAsNumber: true })}
      />
      <select {...register('currency')} aria-label="Currency" className="rounded-md border p-2">
        <option value="VND">VND</option>
        <option value="USD">USD</option>
      </select>
      <Input placeholder="Description (optional)" {...register('description')} />
      <Button type="submit" disabled={isSubmitting}>
        Create account
      </Button>
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  )
}
