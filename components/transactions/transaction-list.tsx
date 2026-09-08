'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatInTimeZone } from 'date-fns-tz'
import { useTranslations } from 'next-intl'
import { Receipt } from 'lucide-react'
import type { Currency, TransactionType } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import { deleteTransactionAction } from '@/lib/server/actions/transaction-actions'
import { GENERIC_ERROR_KEY, TRANSACTION_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatDate } from '@/lib/ui/format-date'
import { formatMoney } from '@/lib/ui/format-money'
import { transactionTypeLabelKey } from '@/lib/ui/labels'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { InlineAlert } from '@/components/common/inline-alert'
import { MoneyText } from '@/components/common/money-text'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
import { groupByDay } from './transaction-day-group'

/**
 * The ledger (spec §6.2).
 *
 * No Prisma import beyond the two enum types — the page fetches, bounds and
 * shapes the rows; this component only renders. `amount` arrives as a
 * fixed-2-decimal string (the page's `Decimal#toFixed(2)`) rather than a raw
 * `Decimal`, which cannot cross the server-to-client-component boundary.
 *
 * Three things the pre-flight review asked for and that this shape delivers:
 *
 *  - the amount lives in a FIXED `min-w-[8.5rem]` column (`FinancialListRow`),
 *    so a long note can never push a VND figure off the row or wrap it
 *    mid-number;
 *  - the note is one ellipsised line with its full text in `title`;
 *  - the row's title is the category name or the TYPE's product label — never
 *    `tx.type` verbatim, which is how `CASH_OUT` used to reach the screen.
 *
 * Delete is a `ConfirmDialog`, not `window.confirm` (spec §10): a native dialog
 * cannot be styled, cannot be translated, and says nothing about what the
 * action does to the balance.
 */
export interface TransactionRow {
  id: string
  type: TransactionType
  amount: string
  currency: Currency
  date: Date
  note: string | null
  fxRateSource: string
  account: { name: string }
  category: { name: string } | null
}

export function TransactionList({
  transactions,
  timezone,
  locale,
  today,
  yesterday,
}: {
  transactions: TransactionRow[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page). `date` is a UTC instant; formatting it in the user's own
   * zone — rather than the server's or the browser's — is what keeps what is
   * shown identical on the server render and the client hydration (no
   * mismatch) while still showing *their* wall clock, not UTC's.
   */
  timezone: string
  locale: Locale
  /** `yyyy-MM-dd` in `timezone`, from the page — see `groupByDay`. */
  today: string
  yesterday: string
}) {
  const router = useRouter()
  const t = useTranslations()
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** The row awaiting confirmation, or `null`. One dialog for the whole list. */
  const [pendingDelete, setPendingDelete] = useState<TransactionRow | null>(null)

  async function confirmDelete(row: TransactionRow) {
    setErrors((prev) => {
      const next = { ...prev }
      delete next[row.id]
      return next
    })
    try {
      const result = await deleteTransactionAction(row.id)
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [row.id]: t(TRANSACTION_ERROR_KEYS[result.error]) }))
        return
      }
      setPendingDelete(null)
      router.refresh()
    } catch {
      console.error('TransactionList: delete failed')
      setErrors((prev) => ({ ...prev, [row.id]: t(GENERIC_ERROR_KEY) }))
    }
  }

  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        size="page"
        title={t('transactions.emptyTitle')}
        description={t('transactions.emptyBody')}
      />
    )
  }

  const groups = groupByDay(
    transactions,
    (row) => formatInTimeZone(row.date, timezone, 'yyyy-MM-dd'),
    today,
    yesterday,
  )

  return (
    <>
      {/* ONE bordered surface holding every row, with 1 px dividers — never a
          card per row (spec §2). The day header is sticky inside it so a long
          month stays readable while scrolling. */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {groups.map((group) => (
          <section key={group.day}>
            <h3 className="sticky top-0 z-10 border-b border-border bg-surface px-4 py-2 text-xs/[1rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
              {group.kind === 'today'
                ? t('transactions.dayToday')
                : group.kind === 'yesterday'
                  ? t('transactions.dayYesterday')
                  : formatDate(group.day, { locale, timeZone: timezone, style: 'weekday' })}
            </h3>
            <ul className="divide-y divide-border">
              {group.rows.map((row) => {
                const positive = isBalanceIncreasing(row.type)
                // Never render the raw rate — only a fallback-source hint.
                const cacheFallback = row.fxRateSource.startsWith('cache-fallback:')
                const rowName = row.category?.name ?? t(transactionTypeLabelKey(row.type))
                return (
                  <FinancialListRow
                    key={row.id}
                    title={rowName}
                    meta={
                      <>
                        <span className="tabular-nums">
                          {formatDate(row.date, { locale, timeZone: timezone, style: 'dateTime' })}
                        </span>
                        {' · '}
                        {row.account.name}
                        {cacheFallback && ` · ${t('transactions.rateFromCache')}`}
                      </>
                    }
                    note={row.note}
                    amount={
                      <MoneyText
                        // Display only — the sign is derived from `type`, never
                        // stored or computed arithmetically; `formatMoney`'s
                        // one `Number()` only feeds the formatter, and the
                        // string it parses already came out of `Decimal`
                        // arithmetic in the service.
                        value={formatMoney(row.amount, row.currency, locale)}
                        currency={row.currency}
                        sign={positive ? '+' : '−'}
                        // Spec §2: income is positive-toned, an ordinary
                        // expense is `foreground`. A page of red spending reads
                        // as a page of errors.
                        tone={positive ? 'positive' : 'default'}
                      />
                    }
                    actions={
                      <RowActionsMenu
                        label={t('common.rowActions', { name: rowName })}
                        actions={[
                          {
                            id: 'delete',
                            label: t('transactions.deleteAction'),
                            tone: 'negative',
                            onSelect: () => setPendingDelete(row),
                          },
                        ]}
                      />
                    }
                    className={errors[row.id] ? 'bg-negative/5' : undefined}
                  />
                )
              })}
            </ul>
          </section>
        ))}
      </div>

      {/* The row-level failures, below the card: an error inside a fixed-height
          row would either clip or move every figure beside it. */}
      {Object.entries(errors).map(([id, message]) => (
        <InlineAlert key={id} tone="negative" className="mt-2">
          {message}
        </InlineAlert>
      ))}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('transactions.deleteConfirmTitle')}
        description={t('transactions.deleteConfirmBody')}
        confirmLabel={t('transactions.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('transactions.deletePending')}
        onConfirm={() => (pendingDelete ? confirmDelete(pendingDelete) : undefined)}
      />
    </>
  )
}
