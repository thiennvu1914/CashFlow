'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatInTimeZone } from 'date-fns-tz'
import type { TransactionType } from '@prisma/client'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import { deleteTransactionAction } from '@/lib/server/actions/transaction-actions'
import { GENERIC_ERROR_MESSAGE, TRANSACTION_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import { Button } from '@/components/ui/button'

/**
 * No Prisma import here — the page fetches, bounds and shapes the rows; this
 * component only renders. `amount` arrives as a fixed-2-decimal string (the
 * page's `Decimal#toFixed(2)`) rather than a raw `Decimal`, which cannot cross
 * the server-to-client-component boundary.
 */
type Row = {
  id: string
  type: TransactionType
  amount: string
  currency: string
  date: Date
  note: string | null
  fxRateSource: string
  account: { name: string }
  category: { name: string } | null
}

const amountFormatter = new Intl.NumberFormat('vi-VN')

function formatSignedAmount(tx: Row): { sign: string; text: string; className: string } {
  const positive = isBalanceIncreasing(tx.type)
  // Display only — the sign is derived from `type`, never stored or computed
  // arithmetically; `Number(tx.amount)` only feeds the formatter, and the
  // string it parses already came out of `Prisma.Decimal` arithmetic.
  return {
    sign: positive ? '+' : '−',
    text: amountFormatter.format(Number(tx.amount)),
    className: positive ? 'text-positive' : 'text-negative',
  }
}

export function TransactionList({
  transactions,
  timezone,
}: {
  transactions: Row[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page). `date` is a UTC instant with no time-of-day meaning to
   * the user; formatting it in their own calendar day — rather than the
   * server's or the browser's — is what keeps the date shown here identical
   * on the server render and the client hydration (no mismatch) while still
   * showing *their* day, not UTC's.
   */
  timezone: string
}) {
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
        setErrors((prev) => ({ ...prev, [id]: TRANSACTION_ERROR_MESSAGES[result.error] }))
        return
      }
      router.refresh()
    } catch {
      console.error('TransactionList: delete failed')
      setErrors((prev) => ({ ...prev, [id]: GENERIC_ERROR_MESSAGE }))
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
                {formatInTimeZone(tx.date, timezone, 'yyyy-MM-dd')}
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
                aria-label={`Delete transaction on ${formatInTimeZone(tx.date, timezone, 'yyyy-MM-dd')}`}
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
