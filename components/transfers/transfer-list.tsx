'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeftRight, ArrowRight } from 'lucide-react'
import type { Currency } from '@/lib/currency/provider'
import type { Locale } from '@/lib/i18n/locale'
import { deleteTransferAction } from '@/lib/server/actions/transfer-actions'
import { GENERIC_ERROR_KEY, TRANSFER_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatDate } from '@/lib/ui/format-date'
import { formatMoney, formatReadableRate } from '@/lib/ui/format-money'
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

  /** Drops any stale message for one row — a fresh attempt starts clean. */
  function clearError(rowId: string) {
    setErrors((prev) => {
      if (!(rowId in prev)) return prev
      const next = { ...prev }
      delete next[rowId]
      return next
    })
  }

  async function confirmDelete(row: TransferRow) {
    clearError(row.id)
    try {
      const result = await deleteTransferAction(row.id)
      if (!result.ok) {
        // The dialog closes on failure too (spec §10, and the same reasoning
        // `components/accounts/account-list.tsx` spells out): the row's
        // `InlineAlert` renders BELOW the card, so a dialog left open puts its
        // own scrim over the very message that explains the refusal — the user
        // would see a dialog that appears to have done nothing.
        setPendingDelete(null)
        setErrors((prev) => ({ ...prev, [row.id]: t(TRANSFER_ERROR_KEYS[result.error]) }))
        return
      }
      setPendingDelete(null)
      router.refresh()
    } catch {
      console.error('TransferList: delete failed')
      // Closed here too, for the reason above.
      setPendingDelete(null)
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
            const rateLine = crossCurrency
              ? formatReadableRate(
                  row.fromAccount.currency as Currency,
                  row.toAccount.currency as Currency,
                  row.exchangeRateUsed,
                  locale,
                )
              : null
            // The accessible NAME for the row's `…` menu — a plain string, used
            // nowhere else. The VISIBLE title below is structured markup, not
            // this string, precisely so the arrow can be `aria-hidden` and the
            // route can wrap instead of losing the destination account to an
            // ellipsis (Task 5b fix round 1, IMPORTANT finding).
            const rowName = t('transfers.route', {
              from: row.fromAccount.name,
              to: row.toAccount.name,
            })
            const isLastRow = rowIndex === transfers.length - 1
            return (
              <FinancialListRow
                key={row.id}
                wrapTitle
                wrapMeta
                title={
                  // `flex-wrap`, not one string: at 375 px `Cash → USD
                  // Savings` no longer fits one line, and a single
                  // `t('transfers.route', …)` string handed to a `truncate`d
                  // container used to render "USD Savings …" — the arrow AND
                  // the source account silently gone. Composing FROM/arrow/TO
                  // as separate nodes lets the group wrap onto two lines
                  // instead, so every word survives regardless of width.
                  <span className="flex flex-wrap items-center gap-x-1">
                    <span>{row.fromAccount.name}</span>
                    <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    {/* The visible arrow is decorative; a screen reader gets
                        the direction from this word instead, same as
                        `rowName` above says it in the menu's accessible name. */}
                    <span className="sr-only">{t('transfers.to')}</span>
                    <span>{row.toAccount.name}</span>
                  </span>
                }
                meta={
                  <span className="flex flex-wrap items-baseline gap-x-1">
                    <span>
                      {formatDate(row.date, { locale, timeZone: timezone, style: 'dateTime' })}
                    </span>
                    {rateLine && (
                      // `basis-full` forces the rate onto its own line below
                      // `sm` (where the date/time already fills the row);
                      // `sm:basis-auto` lets it sit inline once there is
                      // room, rather than ALWAYS forcing a second line.
                      //
                      // `whitespace-nowrap` keeps that line WHOLE (owner item
                      // F1). Measured at 375: the meta column is 105 px and
                      // "· 1 USD = 25.000 VND" needs 114 px, so the line used
                      // to break after "25.000" and leave "VND" alone on a
                      // third line — a figure severed from its currency, in
                      // the one row on this page that exists to state a rate.
                      // The 9 px it now needs beyond its column come out of
                      // the row's own interior (the 12 px gap before the
                      // right-aligned amount column, which carries ~26 px of
                      // slack of its own at this width), so nothing collides
                      // and the page still does not scroll sideways —
                      // `e2e/phase7-responsive.spec.ts` asserts exactly that
                      // at 375 and 414.
                      <span className="basis-full whitespace-nowrap sm:basis-auto">
                        {'· '}
                        {rateLine}
                      </span>
                    )}
                  </span>
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
                        onSelect: () => {
                          // A retry starts clean: a previous attempt's
                          // message for this row goes before the
                          // confirmation reopens (same as `AccountList`).
                          clearError(row.id)
                          setPendingDelete(row)
                        },
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
