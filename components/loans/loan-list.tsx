import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import { loanStatusLabelKey, paymentFrequencyLabelKey } from '@/lib/ui/labels'
import type { LoanDto } from '@/lib/ui/loan-view-model'
import { MoneyText } from '@/components/common/money-text'
import { PlanningRow } from '@/components/common/planning-row'
import { Progress } from '@/components/common/progress'
import { RowErrorAlert, RowErrorProvider } from '@/components/common/row-error-context'
import { StatusBadge, type StatusTone } from '@/components/common/status-badge'

/**
 * The shared loan row, used by both the Loans page (full rows, with
 * payment/edit/close via `renderActions`, and the closed section without it)
 * and — from a later group — the Dashboard's loans widget (`compact`: lender
 * and what principal is still outstanding, nothing else).
 *
 * An async server component with no state of its own: every figure it renders
 * is already a formatted string or plain number from `toLoanDto`
 * (`lib/ui/loan-view-model.ts`) — this file never touches a `Prisma.Decimal` or
 * a `Date`, neither of which can cross into the client components
 * `renderActions` mounts. It is rendered only from server pages/components
 * (`app/(app)/loans/page.tsx` and the Dashboard), so calling `getTranslations`
 * here needs no client boundary.
 *
 * Each loan is shown in its OWN currency and no row is ever converted (ledger
 * ruling R5-3); the per-currency subtotals live on the page, not here, because
 * a list of rows has no business summing anything.
 *
 * Colour is never the only signal. The status is a *word* in a `StatusBadge`
 * (`labels.loanStatus.*`, via `loanStatusLabelKey`), and the schedule line
 * changes its wording as well as its colour — `loans.overdueLine`,
 * `loans.dueSoonLine`, `loans.nextDueLine` — so nothing on this row depends on
 * being seen in colour to be read. The outstanding principal is the row's
 * DOMINANT figure and is `--foreground`, never red: it is a fact, not an
 * error — only the schedule line's OVERDUE wording carries `--negative`.
 *
 * `renderActions` returns TWO pieces, not one (fix round 1, findings 4/5/6/7 —
 * mirroring `GoalList`'s split): `inlineAction` (the row's "Ghi nhận thanh
 * toán" button, its own `PlanningRow` slot) and `actions` (the `…` menu). Each
 * row is wrapped in a `RowErrorProvider` so the menu's close-loan failure —
 * reported via `useRowError`, not a local `useState` — can be shown by
 * `RowErrorAlert` in `extra`, under the row, rather than squeezed into the
 * actions cell.
 */

/**
 * Only the two states that are *exceptional* carry colour: a repaid loan is
 * good news and a missed instalment needs paying. ACTIVE is the ordinary case,
 * and CLOSED is muted because the row is already dimmed inside the page's
 * `<details>` — colouring it would compete with the live loans above for
 * attention it no longer deserves.
 */
const STATUS_TONE: Record<LoanDto['status'], StatusTone> = {
  ACTIVE: 'neutral',
  OVERDUE: 'negative',
  PAID_OFF: 'positive',
  CLOSED: 'muted',
}

/**
 * The schedule line's message KEY: when the next instalment falls, what it is,
 * and how often.
 *
 * Three wordings rather than one coloured sentence, because a screen reader and
 * a colour-blind reader get the same three facts as everyone else. "Overdue"
 * outranks "due soon" by construction — the DTO makes the two flags mutually
 * exclusive — and a paid-off or closed loan always lands on the plain wording,
 * whatever its stored due date says.
 */
function scheduleLineKey(
  loan: LoanDto,
): 'loans.overdueLine' | 'loans.dueSoonLine' | 'loans.nextDueLine' {
  if (loan.overdue) return 'loans.overdueLine'
  if (loan.dueSoon) return 'loans.dueSoonLine'
  return 'loans.nextDueLine'
}

export async function LoanList({
  loans,
  locale,
  timeZone,
  compact,
  renderActions,
}: {
  loans: LoanDto[]
  locale: Locale
  timeZone: string
  /** Dashboard variant: lender and outstanding principal only. */
  compact?: boolean
  /** The Loans page passes the row's inline payment button and `…` menu as
   *  two separate pieces — they mount in two different `PlanningRow` slots
   *  and share no state. */
  renderActions?: (loan: LoanDto) => { actions: ReactNode; inlineAction?: ReactNode }
}) {
  const t = await getTranslations()

  return (
    <ul className="divide-y divide-border">
      {loans.map((loan) => {
        const key = scheduleLineKey(loan)
        const instalmentArgs = {
          date: formatDate(loan.nextDueDate, { locale, timeZone, style: 'date' }),
          amount: `${loan.scheduledPayment} ${loan.currency}`,
          frequency: t(paymentFrequencyLabelKey(loan.paymentFrequency)),
        }
        const parts = renderActions?.(loan)

        return (
          <RowErrorProvider key={loan.id}>
            <PlanningRow
              title={loan.lender}
              badge={
                !compact && (
                  <StatusBadge
                    label={t(loanStatusLabelKey(loan.status))}
                    tone={STATUS_TONE[loan.status]}
                  />
                )
              }
              figureLine={
                compact ? (
                  <MoneyText
                    value={loan.outstandingPrincipal}
                    currency={loan.currency}
                    size="kpi"
                  />
                ) : (
                  <div className="flex flex-col gap-1">
                    {/* A small muted caption above the figure (fix round 1,
                        finding 6) — not the whole sentence run through
                        `MoneyText`, whose `whitespace-nowrap` would force
                        label+figure+currency onto one unbreakable line and
                        clip at narrow widths. */}
                    <span className="text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
                      {t('loans.outstandingLabel')}
                    </span>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      {/* Two `MoneyText`s, one per breakpoint, not a single
                          responsive font-size utility — `size`'s class combo
                          is fixed on `MoneyText`'s own inner span and cannot
                          be overridden by a caller's `className` (the same
                          technique `SummaryPanel`'s `smallSize` uses). */}
                      <MoneyText
                        value={loan.outstandingPrincipal}
                        currency={loan.currency}
                        size="lg"
                        className="sm:hidden"
                      />
                      <MoneyText
                        value={loan.outstandingPrincipal}
                        currency={loan.currency}
                        size="kpi"
                        className="hidden sm:inline-flex"
                      />
                      <span className="text-xs/[1rem] text-muted-foreground">
                        {t('loans.principalOfLine', {
                          principal: loan.principal,
                          currency: loan.currency,
                        })}
                      </span>
                    </div>
                  </div>
                )
              }
              progress={
                !compact && (
                  // The bar measures *principal* repaid, which is the only
                  // part that pays a loan down — so it agrees with the
                  // outstanding figure above it rather than with the total
                  // paid. `label` is the bare lender name (fix round 1,
                  // finding 2), matching `DebtList`'s progress bar: not an
                  // untranslated English suffix hard-coded onto a Vietnamese
                  // page.
                  <Progress
                    percent={loan.percentRepaid}
                    valueText={loan.percentLabel}
                    label={loan.lender}
                    tone="positive"
                  />
                )
              }
              meta={
                !compact && (
                  <div className="flex flex-col gap-1">
                    <span
                      className={cn(
                        loan.overdue && 'text-negative',
                        loan.dueSoon && 'text-warning',
                      )}
                    >
                      {t(key, instalmentArgs)}
                    </span>
                    {/* The terms the loan was agreed on, and what it has cost
                        so far. The rate is informational — nothing in this
                        app computes interest from it — so it sits next to the
                        interest the user has actually recorded rather than
                        driving any figure. */}
                    <span>
                      {t('loans.interestLine', {
                        rate: loan.interestRateLabel,
                        paid: loan.interestPaid,
                        currency: loan.currency,
                      })}
                    </span>
                    <span>
                      {t('loans.termLine', {
                        months: loan.termMonths,
                        date: formatDate(loan.startDate, { locale, timeZone, style: 'date' }),
                      })}
                    </span>
                  </div>
                )
              }
              inlineAction={parts?.inlineAction}
              actions={parts?.actions}
              extra={
                <>
                  {!compact && (
                    <>
                      {loan.notes && (
                        <p className="text-xs/[1rem] text-muted-foreground">{loan.notes}</p>
                      )}
                      {loan.payments.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-xs/[1rem] text-muted-foreground">
                            {t('loans.paymentsSection', { count: loan.payments.length })}
                          </summary>
                          <ul className="mt-1 flex flex-col gap-1">
                            {loan.payments.map((payment) => (
                              <li key={payment.id} className="text-xs/[1rem] text-muted-foreground">
                                <span className="tabular-nums">
                                  {formatDate(payment.date, { locale, timeZone, style: 'date' })}
                                </span>{' '}
                                ·{' '}
                                {/* The split, spelled out: what was paid, and
                                    how much of it actually came off the loan.
                                    Both parts are listed because the total
                                    alone cannot be undone into them, and only
                                    the principal moved the loan. */}
                                {t('loans.paymentRowLine', {
                                  total: payment.total,
                                  principal: payment.principal,
                                  interest: payment.interest,
                                })}
                                {payment.note && ` · ${payment.note}`}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                  {renderActions && <RowErrorAlert />}
                </>
              }
            />
          </RowErrorProvider>
        )
      })}
    </ul>
  )
}
