import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { DebtDto } from '@/lib/ui/debt-view-model'

/**
 * The shared debt row, used by both the Debts page (full rows, with
 * payment/edit/write-off via `renderActions`, and the written-off section
 * without it) and — from a later group — the Dashboard's debts widget
 * (`compact`: person, direction and what is still outstanding, nothing else).
 *
 * A server component with no state of its own: every figure it renders is
 * already a formatted string or plain number from `toDebtDto`
 * (`lib/ui/debt-view-model.ts`) — this file never touches a `Prisma.Decimal` or
 * a `Date`, neither of which can cross into the client components
 * `renderActions` mounts.
 *
 * Each debt is shown in its OWN currency and no row is ever converted (ledger
 * ruling R5-3); the per-currency subtotals live on the page, not here, because
 * a list of rows has no business summing anything.
 *
 * Colour is never the only signal. The direction is a *word* ("Owes you" /
 * "You owe") that happens to be coloured, the status is a *word* in a badge,
 * and an overdue due date changes its wording ("Overdue since …") as well as
 * its colour — so nothing on this row depends on being seen in colour to be
 * read.
 */

/**
 * `text-positive` for money coming in, `text-negative` for money going out —
 * the same reading as the ledger's income and expense figures, so a receivable
 * and an income row do not disagree about which direction is which.
 */
const DIRECTION_TEXT_COLOR: Record<DebtDto['direction'], string> = {
  RECEIVABLE: 'text-positive',
  PAYABLE: 'text-negative',
}

/**
 * Only the two states that are *exceptional* carry colour: a settled debt is
 * good news and a late one needs chasing. OPEN and PARTIALLY_PAID are the
 * ordinary case, and WRITTEN_OFF is muted because the row is already dimmed
 * inside the page's `<details>` — colouring it would compete with the live
 * debts above for attention it no longer deserves.
 */
const STATUS_TEXT_COLOR: Record<DebtDto['status'], string> = {
  OPEN: 'text-muted-foreground',
  PARTIALLY_PAID: 'text-muted-foreground',
  PAID: 'text-positive',
  OVERDUE: 'text-negative',
  WRITTEN_OFF: 'text-muted-foreground',
}

export function DebtList({
  debts,
  compact,
  renderActions,
}: {
  debts: DebtDto[]
  /** Dashboard variant: person, direction and outstanding only. */
  compact?: boolean
  /** The Debts page passes a client component rendering the row's actions. */
  renderActions?: (debt: DebtDto) => ReactNode
}) {
  return (
    <ul className="flex flex-col gap-2">
      {debts.map((debt) => (
        <li key={debt.id} className={cn('rounded-md border border-border p-3', compact && 'p-2')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{debt.person}</span>
              <span
                className={cn('text-xs whitespace-nowrap', DIRECTION_TEXT_COLOR[debt.direction])}
              >
                {debt.directionLabel}
              </span>
              {!compact && (
                <span
                  className={cn(
                    'rounded-sm border border-border px-1.5 text-xs',
                    STATUS_TEXT_COLOR[debt.status],
                  )}
                >
                  {debt.statusLabel}
                </span>
              )}
            </div>
            {compact ? (
              <span className="text-sm tabular-nums whitespace-nowrap">
                {debt.outstanding} {debt.currency}
              </span>
            ) : (
              // "still owed of originally agreed" — the pair, because either
              // figure alone hides how far along the debt is.
              <span className="text-sm tabular-nums whitespace-nowrap">
                {debt.outstanding} of {debt.original} {debt.currency}
              </span>
            )}
          </div>
          {!compact && (
            <>
              <div
                role="progressbar"
                aria-valuenow={debt.percentPaid}
                aria-valuemin={0}
                aria-valuemax={100}
                // `aria-valuenow` is the clamped bar width (never over 100);
                // `percentLabel` carries the true figure, which is what a
                // screen reader announces.
                aria-valuetext={debt.percentLabel}
                aria-label={`${debt.person} repaid`}
                className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted"
              >
                {/* `bg-positive` in both directions: the bar measures
                    repayment, and being repaid is good news whichever way the
                    money is going. */}
                <div className="h-full bg-positive" style={{ width: `${debt.percentPaid}%` }} />
              </div>
              {debt.description && (
                <p className="mt-1 text-xs text-muted-foreground">{debt.description}</p>
              )}
              {debt.dueDate && (
                <p
                  className={cn(
                    'mt-1 text-xs text-muted-foreground',
                    debt.status === 'OVERDUE' && 'text-negative',
                  )}
                >
                  {debt.status === 'OVERDUE'
                    ? `Overdue since ${debt.dueDate}`
                    : `Due ${debt.dueDate}`}
                </p>
              )}
              {debt.notes && <p className="mt-1 text-xs text-muted-foreground">{debt.notes}</p>}
              {debt.payments.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Payments ({debt.payments.length})
                  </summary>
                  <ul className="mt-1 flex flex-col gap-1">
                    {debt.payments.map((payment) => (
                      <li key={payment.id} className="text-xs text-muted-foreground">
                        <span className="tabular-nums">{payment.date}</span> ·{' '}
                        <span className="tabular-nums">{payment.amount}</span>
                        {payment.note && ` · ${payment.note}`}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {/* Its own row, full width — not squeezed into the header line —
              because recording a payment renders a whole form here, not just
              buttons. */}
          {renderActions && <div className="mt-2 flex justify-end">{renderActions(debt)}</div>}
        </li>
      ))}
    </ul>
  )
}
