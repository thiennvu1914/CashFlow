'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { Currency } from '@prisma/client'
import { createTransferFormSchema, type CreateTransferFormInput } from '@/lib/validation/transfer'
import { createTransferAction } from '@/lib/server/actions/transfer-actions'
import { GENERIC_ERROR_MESSAGE, TRANSFER_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import { todayInZone } from '@/lib/datetime/today-in-zone'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Same convention as `TransactionForm`: the form validates and submits
 * `createTransferFormSchema`, whose `date` stays the raw `yyyy-MM-dd` string
 * the `<input type="date">` produced. `createTransferAction` converts that
 * calendar day to an instant in the session user's IANA zone (ruling R-21b);
 * see `lib/datetime/calendar-date.ts`.
 */
type FormInput = CreateTransferFormInput

type Account = { id: string; name: string; currency: Currency }

function defaultValues(accounts: Account[], timezone: string): FormInput {
  return {
    fromAccountId: accounts[0]?.id ?? '',
    toAccountId: accounts[1]?.id ?? accounts[0]?.id ?? '',
    fromAmount: 0,
    toAmount: 0,
    date: todayInZone(timezone),
    note: undefined,
  }
}

export function TransferForm({
  accounts,
  timezone,
}: {
  accounts: Account[]
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
    resetField,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormInput>({
    resolver: zodResolver(createTransferFormSchema),
    defaultValues: defaultValues(accounts, timezone),
  })

  const fromAccountId = useWatch({ control, name: 'fromAccountId' })
  const toAccountId = useWatch({ control, name: 'toAccountId' })
  const fromAmount = useWatch({ control, name: 'fromAmount' })
  const fromAccount = accounts.find((a) => a.id === fromAccountId)
  const toAccount = accounts.find((a) => a.id === toAccountId)
  const sameCurrency = Boolean(fromAccount) && fromAccount?.currency === toAccount?.currency

  // A same-currency transfer conserves money by construction — the server
  // derives `toAmount` from `fromAmount` regardless of what arrives. The
  // field stays part of the validated shape even while its input is hidden,
  // so it is kept in sync here rather than left at its stale default.
  //
  // The reverse transition (currencies used to match and now don't) is
  // handled in the same effect via a ref rather than another state variable:
  // resetting `toAmount` back to its own default means the revealed "Amount
  // received" field starts over instead of pre-filled with the sent amount —
  // which would otherwise read as an accidental same-numbers cross-currency
  // transfer the user never entered.
  const wasSameCurrencyRef = useRef(sameCurrency)
  useEffect(() => {
    if (sameCurrency) {
      setValue('toAmount', fromAmount)
    } else if (wasSameCurrencyRef.current) {
      resetField('toAmount')
    }
    wasSameCurrencyRef.current = sameCurrency
  }, [sameCurrency, fromAmount, setValue, resetField])

  async function onSubmit(values: FormInput) {
    setError(null)
    try {
      // Belt and suspenders with the effect above: the client never trusts a
      // same-currency `toAmount` it might have raced past submitting — the
      // server re-derives it anyway, but this keeps the two paths agreeing.
      const payload = sameCurrency ? { ...values, toAmount: values.fromAmount } : values
      const result = await createTransferAction(payload)
      if (!result.ok) {
        setError(TRANSFER_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues(accounts, timezone))
      router.refresh()
    } catch {
      console.error('TransferForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <div>
        <select
          {...register('fromAccountId')}
          aria-label="From account"
          className="rounded-md border p-2"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currency})
            </option>
          ))}
        </select>
        {errors.fromAccountId && (
          <p className="text-sm text-negative">{errors.fromAccountId.message}</p>
        )}
      </div>
      <div>
        <select
          {...register('toAccountId')}
          aria-label="To account"
          className="rounded-md border p-2"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currency})
            </option>
          ))}
        </select>
        {errors.toAccountId && (
          <p className="text-sm text-negative">{errors.toAccountId.message}</p>
        )}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.01"
            aria-label="Amount sent"
            placeholder="Amount sent"
            {...register('fromAmount', { valueAsNumber: true })}
          />
          {/* Read-only: currency always follows the selected account, so the
             client never sends it — this is display only. */}
          <span className="text-sm text-foreground/60">{fromAccount?.currency ?? ''}</span>
        </div>
        {errors.fromAmount && <p className="text-sm text-negative">{errors.fromAmount.message}</p>}
      </div>
      {!sameCurrency && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.01"
            aria-label="Amount received"
            placeholder="Amount received"
            {...register('toAmount', { valueAsNumber: true })}
          />
          <span className="text-sm text-foreground/60">{toAccount?.currency ?? ''}</span>
        </div>
      )}
      {/* Rendered regardless of `sameCurrency` so a validation error on this
         field is never silently hidden by the field itself being hidden. */}
      {errors.toAmount && <p className="text-sm text-negative">{errors.toAmount.message}</p>}
      <div>
        <Input type="date" aria-label="Date" {...register('date')} />
        {errors.date && <p className="text-sm text-negative">{errors.date.message}</p>}
      </div>
      <div>
        <Input placeholder="Note (optional)" aria-label="Note" {...register('note')} />
        {errors.note && <p className="text-sm text-negative">{errors.note.message}</p>}
      </div>
      <Button type="submit" disabled={isSubmitting}>
        Transfer
      </Button>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </form>
  )
}
