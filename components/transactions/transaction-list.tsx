'use client'

import {
  memo,
  startTransition,
  useCallback,
  useImperativeHandle,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  type Ref,
} from 'react'
import { formatInTimeZone } from 'date-fns-tz'
import { useTranslations } from 'next-intl'
import { Receipt } from 'lucide-react'
import { cn } from 'cn'
import type { Currency, TransactionType } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import { deleteTransactionAction } from '@/lib/server/actions/transaction-actions'
import { TRANSACTION_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatDate } from '@/lib/ui/format-date'
import { formatMoney } from '@/lib/ui/format-money'
import { transactionTypeLabelKey } from '@/lib/ui/labels'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
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
 *
 * Why it is split into a list, a memoised row and a dialog: up to 200 rows are
 * client-rendered and each owns a Base UI menu, so when the dialog's open state
 * and the delete's pending state lived here, every change re-rendered every
 * row and the press on "Delete" felt laggy. Now the dialog owns its own state,
 * the row is `memo`ised, and the deleted row is hidden optimistically.
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
  const t = useTranslations()
  const [errors, setErrors] = useState<Record<string, string>>({})
  /**
   * Rows whose delete the server has ACCEPTED. `useOptimistic` alone is not
   * enough: its value reverts the moment the action's transition ends, but the
   * server-sent list (the action's `revalidatePath` re-render) can commit a
   * beat later, and in that gap the deleted row would flash back. Ids are never
   * reused, so remembering an accepted delete for the component's lifetime is
   * safe — the new props simply stop containing the row.
   */
  const [acceptedDeletes, setAcceptedDeletes] = useState<ReadonlySet<string>>(new Set())
  const settled = useMemo(
    () => transactions.filter((row) => !acceptedDeletes.has(row.id)),
    [transactions, acceptedDeletes],
  )
  /**
   * The ledger minus the row being deleted: hidden the instant the user
   * confirms, and restored by React itself if the action fails or throws (the
   * optimistic value reverts when the transition ends).
   */
  const [visible, hideRow] = useOptimistic(settled, (rows, hiddenId: string) =>
    rows.filter((row) => row.id !== hiddenId),
  )
  const dialogRef = useRef<DeleteDialogHandle>(null)
  const submit = useActionSubmit(t)

  /** Drops any stale message for one row — a fresh attempt starts clean. */
  const clearError = useCallback((rowId: string) => {
    setErrors((prev) => {
      if (!(rowId in prev)) return prev
      const next = { ...prev }
      delete next[rowId]
      return next
    })
  }, [])

  /**
   * Stable for the life of the list, so a memoised row never re-renders because
   * the dialog opened, a delete went pending or another row's error changed.
   */
  const requestDelete = useCallback(
    (row: TransactionRow) => {
      // A retry starts clean: a previous attempt's message for this row goes
      // before the confirmation reopens (same as `AccountList`).
      clearError(row.id)
      dialogRef.current?.open(row)
    },
    [clearError],
  )

  /** Resolves once the whole transition has ended, which is when the dialog closes. */
  function confirmDelete(row: TransactionRow): Promise<void> {
    return new Promise<void>((resolve) => {
      startTransition(async () => {
        hideRow(row.id)
        try {
          await submit.run({
            tag: 'TransactionList: delete failed',
            action: () => deleteTransactionAction(row.id),
            errorKeys: TRANSACTION_ERROR_KEYS,
            onError: (failure) =>
              failure === null
                ? clearError(row.id)
                : setErrors((prev) => ({ ...prev, [row.id]: failure.message })),
            onSuccess: () => setAcceptedDeletes((prev) => new Set(prev).add(row.id)),
          })
        } finally {
          resolve()
        }
      })
    })
  }

  const groups = useMemo(
    () =>
      groupByDay(
        visible,
        (row) => formatInTimeZone(row.date, timezone, 'yyyy-MM-dd'),
        today,
        yesterday,
      ),
    [visible, timezone, today, yesterday],
  )

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        size="page"
        title={t('transactions.emptyTitle')}
        description={t('transactions.emptyBody')}
      />
    )
  }

  return (
    <>
      {/* ONE bordered surface holding every row, with 1 px dividers — never a
          card per row (spec §2). The day header is sticky inside it so a long
          month stays readable while scrolling.

          NO `overflow-hidden` here (spec §14 fix round 1, finding 4): an
          ancestor with `overflow: hidden/auto/scroll` becomes the "nearest
          scrolling ancestor" `position: sticky` sticks WITHIN per the CSS
          spec, and this div never itself scrolls (the page does) — so with
          `overflow-hidden` on it, the `<h2>` below stuck to the top of a
          container that never moves, which reads as "not sticky" the moment
          you actually scroll. Rounding the card's corners without it clipping
          content is instead done on the two elements that could otherwise
          poke a square corner past the round border: the FIRST group's own
          `bg-surface` header, and the LAST row (only visible were it to also
          carry its own background, e.g. the error tint below). */}
      <div className="card-hover-effect rounded-lg border border-border bg-surface shadow-xs">
        {groups.map((group, groupIndex) => (
          <section key={group.day}>
            {/* `h2`, not `h3` (Task 16, owner item G1). The page's outline is
                `h1` "Giao dịch" -> these day groups -> `h2` "Thêm giao dịch"
                (the create panel), with nothing between the `h1` and the day
                groups: an `h3` there skipped a level, which is a real
                heading-order defect and not a styling choice — the class list
                below is unchanged, so this looks exactly as it did. The day
                groups ARE the ledger's top-level sections; the alternative
                (an extra sr-only `h2` above them, to hang `h3`s off) adds a
                heading nobody asked for. */}
            <h2
              className={cn(
                'sticky top-0 z-10 border-b border-border bg-surface/95 px-4 py-2 text-xs/[1rem] font-medium tracking-[0.04em] text-muted-foreground uppercase backdrop-blur-xs',
                groupIndex === 0 && 'rounded-t-lg',
              )}
            >
              {group.kind === 'today'
                ? t('transactions.dayToday')
                : group.kind === 'yesterday'
                  ? t('transactions.dayYesterday')
                  : formatDate(group.day, { locale, timeZone: timezone, style: 'weekday' })}
            </h2>
            <ul className="divide-y divide-border">
              {group.rows.map((row, rowIndex) => (
                <TransactionListRow
                  key={row.id}
                  row={row}
                  locale={locale}
                  timezone={timezone}
                  hasError={row.id in errors}
                  isLastRow={groupIndex === groups.length - 1 && rowIndex === group.rows.length - 1}
                  onRequestDelete={requestDelete}
                />
              ))}
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

      <DeleteTransactionDialog handleRef={dialogRef} onConfirm={confirmDelete} />
    </>
  )
}

/**
 * One ledger row. `memo`ised, and every prop is a primitive, a row object that
 * keeps its identity while the server data is unchanged, or the stable
 * `onRequestDelete` — so opening the dialog, a delete going pending or a
 * sibling's error never re-renders the other rows. It reads its own
 * translations from context instead of taking `t`, whose identity is not
 * guaranteed stable.
 */
const TransactionListRow = memo(function TransactionListRow({
  row,
  locale,
  timezone,
  hasError,
  isLastRow,
  onRequestDelete,
}: {
  row: TransactionRow
  locale: Locale
  timezone: string
  hasError: boolean
  isLastRow: boolean
  onRequestDelete: (row: TransactionRow) => void
}) {
  const t = useTranslations()
  const positive = isBalanceIncreasing(row.type)
  // Never render the raw rate — only a fallback-source hint.
  const cacheFallback = row.fxRateSource.startsWith('cache-fallback:')
  const rowName = row.category?.name ?? t(transactionTypeLabelKey(row.type))
  return (
    <FinancialListRow
      title={rowName}
      meta={
        <>
          {/* Time only, not the full date (spec §14 fix round 1, finding 5): the
              day header above already says WHICH day, so repeating it here
              crowded the account name out of a 375 px row (`19:38 08/09/202…`,
              the account name truncated away entirely). */}
          <span className="tabular-nums">
            {formatDate(row.date, { locale, timeZone: timezone, style: 'time' })}
          </span>
          {' · '}
          {row.account.name}
          {cacheFallback && ` · ${t('transactions.rateFromCache')}`}
        </>
      }
      note={row.note}
      amount={
        <MoneyText
          // Display only — the sign is derived from `type`, never stored or
          // computed arithmetically; `formatMoney`'s one `Number()` only feeds
          // the formatter, and the string it parses already came out of
          // `Decimal` arithmetic in the service.
          value={formatMoney(row.amount, row.currency, locale)}
          currency={row.currency}
          sign={positive ? '+' : '−'}
          // Spec §2: income is positive-toned, an ordinary expense is
          // `foreground`. A page of red spending reads as a page of errors.
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
              onSelect: () => onRequestDelete(row),
            },
          ]}
        />
      }
      className={cn(hasError && 'bg-negative/5', isLastRow && 'rounded-b-lg')}
    />
  )
})

interface DeleteDialogHandle {
  open: (row: TransactionRow) => void
}

/**
 * The one confirmation for the whole list, with its own `pendingDelete` state:
 * opening and closing it re-renders only this component, never the rows.
 *
 * It closes on BOTH outcomes (spec §10, and the same reasoning
 * `components/accounts/account-list.tsx` spells out): the row's `InlineAlert`
 * renders BELOW the card, so a dialog left open puts its own scrim over the very
 * message that explains the refusal — the user would see a dialog that appears
 * to have done nothing.
 */
function DeleteTransactionDialog({
  handleRef,
  onConfirm,
}: {
  handleRef: Ref<DeleteDialogHandle>
  /** Resolves when the delete has settled, success or failure. */
  onConfirm: (row: TransactionRow) => Promise<void>
}) {
  const t = useTranslations()
  /** The row awaiting confirmation, or `null`. */
  const [pendingDelete, setPendingDelete] = useState<TransactionRow | null>(null)
  useImperativeHandle(handleRef, () => ({ open: setPendingDelete }), [])

  async function confirm() {
    if (!pendingDelete) return
    try {
      await onConfirm(pendingDelete)
    } finally {
      setPendingDelete(null)
    }
  }

  return (
    <ConfirmDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => !open && setPendingDelete(null)}
      title={t('transactions.deleteConfirmTitle')}
      description={t('transactions.deleteConfirmBody')}
      confirmLabel={t('transactions.deleteConfirm')}
      cancelLabel={t('common.cancel')}
      pendingLabel={t('transactions.deletePending')}
      onConfirm={confirm}
    />
  )
}
