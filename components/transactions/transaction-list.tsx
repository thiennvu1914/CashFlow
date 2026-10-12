'use client'

import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  type Ref,
} from 'react'
import { formatInTimeZone } from 'date-fns-tz'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Receipt } from 'lucide-react'
import { cn } from 'cn'
import type { Currency, TransactionType } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import { deleteTransactionAction } from '@/lib/server/actions/transaction-actions'
import type { TransactionLink } from '@/lib/server/services/transaction-links'
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
import { StatusBadge } from '@/components/common/status-badge'
import { TransactionEditSheet, type TransactionEditSheetHandle } from './transaction-create-panel'
import { groupByDay } from './transaction-day-group'
import { hideDeletedRow, settledLedger } from './transaction-delete-visibility'
import { transactionRowActions } from './transaction-row-actions'

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
 * the row is `memo`ised, and the deleted row is hidden optimistically. The edit
 * sheet follows the same shape: it owns its open state and is opened with the
 * row through a handle.
 *
 * Money-source linking (spec 2026-10-12 §2 Q4, §6.5): a row a debt or loan
 * owns (`link`) carries a badge naming it, and its menu offers only "open the
 * debt/loan" — see `transaction-row-actions.ts`.
 */
export interface TransactionRow {
  id: string
  type: TransactionType
  amount: string
  currency: Currency
  date: Date
  note: string | null
  fxRateSource: string
  /** The edit sheet pre-selects its pickers with these two. */
  accountId: string
  categoryId: string | null
  account: { name: string }
  category: { name: string } | null
  /** The debt or loan that owns this row, or `null` for an ordinary one. */
  link: TransactionLink | null
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
    () => settledLedger(transactions, acceptedDeletes),
    [transactions, acceptedDeletes],
  )
  /**
   * The ledger minus the row being deleted, with every other row's delete
   * disabled: both the instant the user confirms, and both restored by React
   * itself when the transition ends (the optimistic value reverts), whether
   * the action succeeded, failed or threw.
   *
   * "A delete is in flight" is optimistic too because `submit.locked` cannot
   * say it here: `submit.run` sets it inside this transition, and React holds
   * an async transition's state updates back until the action finishes, so it
   * never renders as `true` — tried, and `e2e/phase7-confirm-dialogs` still
   * found the other row's delete enabled mid-flight.
   */
  const [ledger, hideRow] = useOptimistic(settled, hideDeletedRow<TransactionRow>)
  const dialogRef = useRef<DeleteDialogHandle>(null)
  const editRef = useRef<TransactionEditSheetHandle>(null)
  const submit = useActionSubmit(t)
  const router = useRouter()

  /**
   * `?edit=<id>` opens that row's edit sheet — a link another page can send
   * the user to right after recording a transaction for them (a reminder's
   * "Transaction recorded — Edit"). Only an ordinary row on this page opens; a
   * row a debt or loan owns is not editable here, and one outside the newest
   * 200 is not on the page. Either way the parameter is consumed, so a reload
   * or the revalidation after a save does not reopen the sheet.
   *
   * After commit, when the sheet's handle is attached; `useSearchParams` so a
   * second link to this same, already-mounted page is seen too.
   */
  const editId = useSearchParams().get('edit')
  useEffect(() => {
    if (!editId) return
    const row = transactions.find((candidate) => candidate.id === editId)
    if (row && !row.link) editRef.current?.open(row)
    const url = new URL(window.location.href)
    url.searchParams.delete('edit')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }, [editId, transactions])

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
   * the dialog opened or another row's error changed.
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

  /** Stable, like `requestDelete`: opens the edit sheet with the row. */
  const requestEdit = useCallback((row: TransactionRow) => editRef.current?.open(row), [])

  /** A linked row's only action: its debt or loan, where it is edited. */
  const openSource = useCallback(
    (link: TransactionLink) => router.push(link.kind === 'debt' ? '/debts' : '/loans'),
    [router],
  )

  /**
   * Fire-and-forget: the dialog has already closed, so nothing awaits this.
   * `hideRow` runs INSIDE the `run` callback (synchronously, so still within
   * the transition) rather than before it: `submit.run` refuses a second delete
   * while one is in flight, and a row hidden — and every delete locked — before
   * that refusal would snap back with no message. No second delete can be
   * chosen meanwhile (`ledger.deleteInFlight` disables them), so the guard only
   * matters for a same-tick race, where the refused row simply stays visible.
   */
  function confirmDelete(row: TransactionRow) {
    startTransition(async () => {
      await submit.run({
        tag: 'TransactionList: delete failed',
        action: () => {
          hideRow(row.id)
          return deleteTransactionAction(row.id)
        },
        errorKeys: TRANSACTION_ERROR_KEYS,
        onError: (failure) =>
          failure === null
            ? clearError(row.id)
            : setErrors((prev) => ({ ...prev, [row.id]: failure.message })),
        onSuccess: () => setAcceptedDeletes((prev) => new Set(prev).add(row.id)),
      })
    })
  }

  const groups = useMemo(
    () =>
      groupByDay(
        ledger.rows,
        (row) => formatInTimeZone(row.date, timezone, 'yyyy-MM-dd'),
        today,
        yesterday,
      ),
    [ledger.rows, timezone, today, yesterday],
  )

  if (ledger.rows.length === 0) {
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
                  deleteDisabled={ledger.deleteInFlight}
                  onRequestEdit={requestEdit}
                  onRequestDelete={requestDelete}
                  onOpenSource={openSource}
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
      <TransactionEditSheet handleRef={editRef} />
    </>
  )
}

/**
 * One ledger row. `memo`ised, and every prop is a primitive, a row object that
 * keeps its identity while the server data is unchanged, or one of the stable
 * `onRequest…`/`onOpenSource` callbacks — so opening the dialog or the edit
 * sheet, or a sibling's error, never re-renders the other rows. A delete going
 * in flight does, once each way, because every row's delete item has to
 * disable (`deleteDisabled`). It reads its own translations from context
 * instead of taking `t`, whose identity is not guaranteed stable.
 */
const TransactionListRow = memo(function TransactionListRow({
  row,
  locale,
  timezone,
  hasError,
  isLastRow,
  deleteDisabled,
  onRequestEdit,
  onRequestDelete,
  onOpenSource,
}: {
  row: TransactionRow
  locale: Locale
  timezone: string
  hasError: boolean
  isLastRow: boolean
  /** Another delete is in flight (`LedgerView.deleteInFlight`). */
  deleteDisabled: boolean
  onRequestEdit: (row: TransactionRow) => void
  onRequestDelete: (row: TransactionRow) => void
  onOpenSource: (link: TransactionLink) => void
}) {
  const t = useTranslations()
  const positive = isBalanceIncreasing(row.type)
  // Never render the raw rate — only a fallback-source hint.
  const cacheFallback = row.fxRateSource.startsWith('cache-fallback:')
  const rowName = row.category?.name ?? t(transactionTypeLabelKey(row.type))
  return (
    <FinancialListRow
      title={
        row.link ? (
          // Which debt or loan owns the row, before the menu is opened — the
          // reason it offers no edit or delete. A muted pill: it labels the
          // row, it is not a status to act on. The title cell ellipsises on one
          // line, so the name truncates on its own and the pill is a flex
          // sibling that does not shrink: a long name can no longer push it
          // out of a 375 px row. Capped, with its own ellipsis, so a long
          // person or lender still leaves the name some room and the
          // "Nợ:"/"Vay:" prefix always shows.
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{rowName}</span>
            <StatusBadge
              className="block max-w-[60%] shrink-0 truncate"
              label={
                row.link.kind === 'debt'
                  ? t('transactions.linkedDebtBadge', { person: row.link.person })
                  : t('transactions.linkedLoanBadge', { lender: row.link.lender })
              }
            />
          </span>
        ) : (
          rowName
        )
      }
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
          actions={transactionRowActions(row, {
            labels: {
              edit: t('transactions.editAction'),
              delete: t('transactions.deleteAction'),
              openDebt: t('transactions.openDebtAction'),
              openLoan: t('transactions.openLoanAction'),
            },
            deleteDisabled,
            onEdit: onRequestEdit,
            onDelete: onRequestDelete,
            onOpenSource,
          })}
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
 * It closes the moment the user confirms, not when the server answers: the
 * delete is optimistic, so the row is already gone and a modal left up with a
 * spinner would make the user wait out the round trip for nothing. A failure
 * is still explained — the row's `InlineAlert` renders BELOW the card, where
 * no scrim covers it (the older reason to close on both outcomes), and the
 * hidden row comes back with it.
 */
function DeleteTransactionDialog({
  handleRef,
  onConfirm,
}: {
  handleRef: Ref<DeleteDialogHandle>
  onConfirm: (row: TransactionRow) => void
}) {
  const t = useTranslations()
  /** The row awaiting confirmation, or `null`. */
  const [pendingDelete, setPendingDelete] = useState<TransactionRow | null>(null)
  useImperativeHandle(handleRef, () => ({ open: setPendingDelete }), [])

  function confirm() {
    if (!pendingDelete) return
    const row = pendingDelete
    setPendingDelete(null)
    onConfirm(row)
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
