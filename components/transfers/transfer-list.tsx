'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeftRight } from 'lucide-react'
import type { Currency } from '@/lib/currency/provider'
import type { Locale } from '@/lib/i18n/locale'
import { deleteTransferAction } from '@/lib/server/actions/transfer-actions'
import { GENERIC_ERROR_KEY, TRANSFER_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatDate } from '@/lib/ui/format-date'
import { formatMoney, formatRate } from '@/lib/ui/format-money'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { InlineAlert } from '@/components/common/inline-alert'
import { MoneyText } from '@/components/common/money-text'
import { RowActionsMenu } from '@/components/common/row-actions-menu'

/**
 * The transfer ledger (spec §6.3) — a distinct read from `TransactionList`:
 * every row names a ROUTE (`Cash → Bank`), not a category or a type, and a
 * cross-currency row carries a second amount plus a human-readable rate.
 *
 * No Prisma import here — the page fetches and shapes the rows; this
 * component only renders. Amounts arrive as strings (the page's
 * `Decimal#toFixed(2)`) rather than raw `Decimal`s, and `exchangeRateUsed` as
 * `Decimal#toString()` or `null` for a same-currency transfer.
 */
export interface TransferRow {
  id: string
  date: Date
  fromAmount: string
  toAmount: string
  exchangeRateUsed: string | null
  fromAccount: { name: string; currency: string }
  toAccount: { name: string; currency: string }
}

/**
 * The rate, always quoted in the direction a person reads it: VND per one USD.
 *
 * `exchangeRateUsed` is stored as destination-per-source, so a VND→USD transfer
 * carries 0.00004. Printing that is technically true and useless — nobody
 * quotes the dong that way — so the pair is normalised to USD-per-1 and the
 * reciprocal is taken when the source is VND. The figure is `formatRate`'s, and
 * nothing reads it back into a calculation: `Number()` here is display-only,
 * downstream of the service's `Decimal` arithmetic, and the reciprocal is a
 * presentation choice — the stored rate itself is untouched.
 */
function readableRate(
  row: TransferRow,
  locale: Locale,
): { from: string; rate: string; to: string } | null {
  if (row.exchangeRateUsed === null) return null
  const sourceIsUsd = row.fromAccount.currency === 'USD'
  const rate = sourceIsUsd ? Number(row.exchangeRateUsed) : 1 / Number(row.exchangeRateUsed)
  return { from: 'USD', rate: formatRate(rate, locale), to: 'VND' }
}

export function TransferList({
  transfers,
  timezone,
  locale,
}: {
  transfers: TransferRow[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page) — same rationale as `TransactionList`: formatting `date`
   * (a UTC instant) in the user's own zone keeps the server render and client
   * hydration identical while still showing *their* wall clock.
   */
  timezone: string
  locale: Locale
}) {
  const router = useRouter()
  const t = useTranslations()
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** The row awaiting confirmation, or `null`. One dialog for the whole list. */
  const [pendingDelete, setPendingDelete] = useState<TransferRow | null>(null)

  async function confirmDelete(row: TransferRow) {
    setErrors((prev) => {
      const next = { ...prev }
      delete next[row.id]
      return next
    })
    try {
      const result = await deleteTransferAction(row.id)
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [row.id]: t(TRANSFER_ERROR_KEYS[result.error]) }))
        return
      }
      setPendingDelete(null)
      router.refresh()
    } catch {
      console.error('TransferList: delete failed')
      setErrors((prev) => ({ ...prev, [row.id]: t(GENERIC_ERROR_KEY) }))
    }
  }

  if (transfers.length === 0) {
    return (
      <EmptyState
        icon={ArrowLeftRight}
        size="page"
        title={t('transfers.emptyTitle')}
        description={t('transfers.emptyBody')}
      />
    )
  }

  return (
    <>
      <div className="rounded-lg border border-border bg-surface">
        <ul className="divide-y divide-border">
          {transfers.map((row, rowIndex) => {
            const crossCurrency = row.fromAccount.currency !== row.toAccount.currency
            const rate = crossCurrency ? readableRate(row, locale) : null
            const rowName = t('transfers.route', {
              from: row.fromAccount.name,
              to: row.toAccount.name,
            })
            const isLastRow = rowIndex === transfers.length - 1
            return (
              <FinancialListRow
                key={row.id}
                title={rowName}
                meta={
                  <>
                    {formatDate(row.date, { locale, timeZone: timezone, style: 'dateTime' })}
                    {rate && (
                      <>
                        {' · '}
                        {t('common.rateLine', rate)}
                      </>
                    )}
                  </>
                }
                amount={
                  <div className="flex flex-col items-end gap-0.5">
                    <MoneyText
                      // The row's currency crosses as a plain `string` (see
                      // `TransferRow`) rather than the `Currency` union, so the
                      // cast is here rather than widening `formatMoney`'s own
                      // signature for one caller — both values genuinely are
                      // `Currency`, having come from `financialAccount.currency`
                      // via the page.
                      value={formatMoney(
                        row.fromAmount,
                        row.fromAccount.currency as Currency,
                        locale,
                      )}
                      currency={row.fromAccount.currency}
                    />
                    {crossCurrency && (
                      <MoneyText
                        value={formatMoney(
                          row.toAmount,
                          row.toAccount.currency as Currency,
                          locale,
                        )}
                        currency={row.toAccount.currency}
                        size="meta"
                        // The received amount is money genuinely arriving in
                        // the destination account, which on this page it
                        // always is — unlike a transaction's amount, whose
                        // sign is conditional on its type.
                        tone="positive"
                      />
                    )}
                  </div>
                }
                actions={
                  <RowActionsMenu
                    label={t('common.rowActions', { name: rowName })}
                    actions={[
                      {
                        id: 'delete',
                        label: t('transfers.deleteAction'),
                        tone: 'negative',
                        onSelect: () => setPendingDelete(row),
                      },
                    ]}
                  />
                }
                className={isLastRow ? 'rounded-b-lg' : undefined}
              />
            )
          })}
        </ul>
      </div>

      {Object.entries(errors).map(([id, message]) => (
        <InlineAlert key={id} tone="negative" className="mt-2">
          {message}
        </InlineAlert>
      ))}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('transfers.deleteConfirmTitle')}
        description={t('transfers.deleteConfirmBody')}
        confirmLabel={t('transfers.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('transfers.deletePending')}
        onConfirm={() => (pendingDelete ? confirmDelete(pendingDelete) : undefined)}
      />
    </>
  )
}
