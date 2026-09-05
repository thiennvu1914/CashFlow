'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import type { TransactionType } from '@prisma/client'
import {
  deleteTransactionAction,
  type TransactionActionError,
} from '@/lib/server/actions/transaction-actions'
import { Button } from '@/components/ui/button'

type Row = {
  id: string
  type: TransactionType
  amount: unknown
  currency: string
  date: Date
  note: string | null
  fxRateSource: string
  account: { name: string }
  category: { name: string } | null
}

/** Types whose amount adds to the account — everything else subtracts. */
const POSITIVE_TYPES = new Set<TransactionType>(['INCOME', 'CASH_IN', 'ADJUSTMENT_INCREASE'])

const GENERIC_ERROR = 'Something went wrong. Please try again.'

const ACTION_ERROR_MESSAGES: Record<TransactionActionError, string> = {
  FX_UNAVAILABLE: 'Exchange rate is temporarily unavailable. Please try again in a moment.',
  ARCHIVED_ACCOUNT: 'This account is archived.',
  INVALID_CATEGORY: 'Choose a valid category for this type.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That record no longer exists.',
}

const amountFormatter = new Intl.NumberFormat('vi-VN')

function formatSignedAmount(tx: Row): { sign: string; text: string; className: string } {
  const positive = POSITIVE_TYPES.has(tx.type)
  // Display only — the sign is derived from `type`, never stored or computed
  // arithmetically; `Number(tx.amount)` only feeds the formatter.
  return {
    sign: positive ? '+' : '−',
    text: amountFormatter.format(Number(tx.amount)),
    className: positive ? 'text-positive' : 'text-negative',
  }
}

export function TransactionList({ transactions }: { transactions: Row[] }) {
  const router = useRouter()
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this transaction?')) return
    setErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      const result = await deleteTransactionAction(id)
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [id]: ACTION_ERROR_MESSAGES[result.error] }))
        return
      }
      router.refresh()
    } catch {
      console.error('TransactionList: delete failed')
      setErrors((prev) => ({ ...prev, [id]: GENERIC_ERROR }))
    }
  }

  if (transactions.length === 0) {
    return <p className="text-sm text-foreground/60">No transactions yet — add one below.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {transactions.map((tx) => {
        const amount = formatSignedAmount(tx)
        // Never render the raw rate here — only a fallback-source hint.
        const showCacheFallbackHint = tx.fxRateSource.startsWith('cache-fallback:')
        return (
          <li key={tx.id} className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="font-medium">
                {tx.category?.name ?? tx.type} · {tx.account.name}
              </p>
              <p className="text-sm text-foreground/60">
                {format(tx.date, 'yyyy-MM-dd')}
                {tx.note ? ` · ${tx.note}` : ''}
              </p>
              {showCacheFallbackHint && (
                <p className="text-xs text-foreground/50">rate from cache</p>
              )}
              {errors[tx.id] && <p className="text-sm text-negative">{errors[tx.id]}</p>}
            </div>
            <div className="flex items-center gap-3">
              <span className={`tabular-nums ${amount.className}`}>
                {amount.sign}
                {amount.text} {tx.currency}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Delete transaction on ${format(tx.date, 'yyyy-MM-dd')}`}
                onClick={() => handleDelete(tx.id)}
                className="text-negative"
              >
                Delete
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
