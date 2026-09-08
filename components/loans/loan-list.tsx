import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { LoanDto } from '@/lib/ui/loan-view-model'

/**
 * The shared loan row, used by both the Loans page (full rows, with
 * payment/edit/close via `renderActions`, and the closed section without it)
 * and — from a later group — the Dashboard's loans widget (`compact`: lender
 * and what principal is still outstanding, nothing else).
 *
 * A server component with no state of its own: every figure it renders is
 * already a formatted string or plain number from `toLoanDto`
 * (`lib/ui/loan-view-model.ts`) — this file never touches a `Prisma.Decimal` or
 * a `Date`, neither of which can cross into the client components
 * `renderActions` mounts.
 *
 * Each loan is shown in its OWN currency and no row is ever converted (ledger
 * ruling R5-3); the per-currency subtotals live on the page, not here, because
 * a list of rows has no business summing anything.
 *
 * Colour is never the only signal. The status is a *word* in a badge, and the
 * schedule line changes its wording as well as its colour — "Overdue since …",
 * "Due soon …", "Next due …" — so nothing on this row depends on being seen in
 * colour to be read.
 */

/**
 * Only the two states that are *exceptional* carry colour: a repaid loan is
 * good news and a missed instalment needs paying. ACTIVE is the ordinary case,
 * and CLOSED is muted because the row is already dimmed inside the page's
 * `<details>` — colouring it would compete with the live loans above for
 * attention it no longer deserves.
 */
const STATUS_TEXT_COLOR: Record<LoanDto['status'], string> = {
  ACTIVE: 'text-muted-foreground',
  OVERDUE: 'text-negative',
  PAID_OFF: 'text-positive',
  CLOSED: 'text-muted-foreground',
}

/**
 * The schedule line: when the next instalment falls, what it is, and how often.
 *
 * Three wordings rather than one coloured sentence, because a screen reader and
 * a colour-blind reader get the same three facts as everyone else. "Overdue
 * since" outranks "Due soon" by construction — the DTO makes the two flags
 * mutually exclusive — and a paid-off or closed loan always lands on the plain
 * wording, whatever its stored due date says.
 */
function scheduleLine(loan: LoanDto): string {
  const instalment = `${loan.scheduledPayment} ${loan.currency} · ${loan.frequencyLabel}`
  if (loan.overdue) return `Overdue since ${loan.nextDueDate} · ${instalment}`
  if (loan.dueSoon) return `Due soon — ${loan.nextDueDate} · ${instalment}`
  return `Next due ${loan.nextDueDate} · ${instalment}`
}

export function LoanList({
  loans,
  compact,
  renderActions,
}: {
  loans: LoanDto[]
  /** Dashboard variant: lender and outstanding principal only. */
  compact?: boolean
  /** The Loans page passes a client component rendering the row's actions. */
  renderActions?: (loan: LoanDto) => ReactNode
}) {
  return (
    <ul className="flex flex-col gap-2">
      {loans.map((loan) => (
        <li key={loan.id} className={cn('rounded-md border border-border p-3', compact && 'p-2')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{loan.lender}</span>
              {!compact && (
                <span
                  className={cn(
                    'rounded-sm border border-border px-1.5 text-xs',
                    STATUS_TEXT_COLOR[loan.status],
                  )}
                >
                  {loan.statusLabel}
                </span>
              )}
            </div>
            {compact ? (
              <span className="text-sm tabular-nums whitespace-nowrap">
                {loan.outstandingPrincipal} {loan.currency}
              </span>
            ) : (
              // "principal still outstanding of principal borrowed" — the
              // pair, because either figure alone hides how far along the loan
              // is. Interest paid is deliberately not in this line: it repays
              // nothing, and adding it would make the loan look further along
              // than it is. It gets its own line below.
              <span className="text-sm tabular-nums whitespace-nowrap">
                {loan.outstandingPrincipal} of {loan.principal} {loan.currency}
              </span>
            )}
          </div>
          {!compact && (
            <>
              <div
                role="progressbar"
                aria-valuenow={loan.percentRepaid}
                aria-valuemin={0}
                aria-valuemax={100}
                // `aria-valuenow` is the clamped bar width (never over 100);
                // `percentLabel` carries the true figure, which is what a
                // screen reader announces.
                aria-valuetext={loan.percentLabel}
                aria-label={`${loan.lender} principal repaid`}
                className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted"
              >
                {/* The bar measures *principal* repaid, which is the only part
                    that pays a loan down — so it agrees with the outstanding
                    figure above it rather than with the total paid. */}
                <div className="h-full bg-positive" style={{ width: `${loan.percentRepaid}%` }} />
              </div>
              <p
                className={cn(
                  'mt-1 text-xs text-muted-foreground',
                  loan.overdue && 'text-negative',
                  loan.dueSoon && 'text-warning',
                )}
              >
                {scheduleLine(loan)}
              </p>
              {/* The terms the loan was agreed on, and what it has cost so far.
                  The rate is informational — nothing in this app computes
                  interest from it — so it sits next to the interest the user
                  has actually recorded rather than driving any figure. */}
              <p className="mt-1 text-xs text-muted-foreground">
                Interest {loan.interestRateLabel} ·{' '}
                <span className="tabular-nums">{loan.interestPaid}</span> {loan.currency} paid so
                far
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="tabular-nums">{loan.termMonths}</span> months from {loan.startDate}
              </p>
              {loan.notes && <p className="mt-1 text-xs text-muted-foreground">{loan.notes}</p>}
              {loan.payments.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Payments ({loan.payments.length})
                  </summary>
                  <ul className="mt-1 flex flex-col gap-1">
                    {loan.payments.map((payment) => (
                      <li key={payment.id} className="text-xs text-muted-foreground">
                        <span className="tabular-nums">{payment.date}</span> ·{' '}
                        {/* The split, spelled out: what was paid, and how much
                            of it actually came off the loan. Both parts are
                            listed because the total alone cannot be undone into
                            them, and only the principal moved the loan. */}
                        <span className="tabular-nums">{payment.total}</span> ·{' '}
                        <span className="tabular-nums">{payment.principal}</span> principal ·{' '}
                        <span className="tabular-nums">{payment.interest}</span> interest
                        {payment.note && ` · ${payment.note}`}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {/* Its own row, full width — not squeezed into the header line —
              because recording an instalment renders a whole form here, not
              just buttons. */}
          {renderActions && <div className="mt-2 flex justify-end">{renderActions(loan)}</div>}
        </li>
      ))}
    </ul>
  )
}
