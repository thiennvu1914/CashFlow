import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import { debtDirectionLabelKey, debtStatusLabelKey } from '@/lib/ui/labels'
import type { DebtDto } from '@/lib/ui/debt-view-model'
import { MoneyText } from '@/components/common/money-text'
import { PlanningRow } from '@/components/common/planning-row'
import { Progress } from '@/components/common/progress'
import { RowErrorAlert, RowErrorProvider } from '@/components/common/row-error-context'
import { StatusBadge, type StatusTone } from '@/components/common/status-badge'

/**
 * The shared debt row, used by both the Debts page (full rows, with
 * payment/edit/write-off via `renderActions`, and the written-off section
 * without it) and — from a later group — the Dashboard's debts widget
 * (`compact`: person, direction and what is still outstanding, nothing else).
 *
 * An async server component with no state of its own: every figure it renders
 * is already a formatted string or plain number from `toDebtDto`
 * (`lib/ui/debt-view-model.ts`) — this file never touches a `Prisma.Decimal` or
 * a `Date`, neither of which can cross into the client components
 * `renderActions` mounts. It is rendered only from server pages/components
 * (`app/(app)/debts/page.tsx` and the Dashboard), so calling `getTranslations`
 * here needs no client boundary.
 *
 * Each debt is shown in its OWN currency and no row is ever converted (ledger
 * ruling R5-3); the per-currency subtotals live on the page, not here, because
 * a list of rows has no business summing anything.
 *
 * Colour is never the only signal. The direction is a *word*
 * (`labels.debtDirection.*`, via `debtDirectionLabelKey`) that happens to be
 * coloured, the status is a *word* in a `StatusBadge`
 * (`labels.debtStatus.*`, via `debtStatusLabelKey`), and an overdue due date
 * changes its wording (`debts.overdueMeta` vs `debts.dueMeta`) as well as its
 * colour — so nothing on this row depends on being seen in colour to be read.
 *
 * `renderActions` returns TWO pieces, not one (fix round 1, findings 4/5/6 —
 * mirroring `GoalList`'s split): `inlineAction` (the row's "Ghi nhận thanh
 * toán" button, its own `PlanningRow` slot, pinned top-right on desktop and
 * full-width below the meta on mobile) and `actions` (the `…` menu). Each row
 * is wrapped in a `RowErrorProvider` so the menu's write-off failure —
 * reported via `useRowError`, not a local `useState` — can be shown by
 * `RowErrorAlert` in `extra`, under the row, rather than squeezed into the
 * actions cell.
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
const STATUS_TONE: Record<DebtDto['status'], StatusTone> = {
  OPEN: 'neutral',
  PARTIALLY_PAID: 'neutral',
  PAID: 'positive',
  OVERDUE: 'negative',
  WRITTEN_OFF: 'muted',
}

export async function DebtList({
  debts,
  locale,
  timeZone,
  compact,
  renderActions,
}: {
  debts: DebtDto[]
  locale: Locale
  timeZone: string
  /** Dashboard variant: person, direction and outstanding only. */
  compact?: boolean
  /** The Debts page passes the row's inline payment button and `…` menu as
   *  two separate pieces — they mount in two different `PlanningRow` slots
   *  and share no state. */
  renderActions?: (debt: DebtDto) => { actions: ReactNode; inlineAction?: ReactNode }
}) {
  const t = await getTranslations()

  return (
    <ul className="divide-y divide-border">
      {debts.map((debt) => {
        const parts = renderActions?.(debt)

        return (
          <RowErrorProvider key={debt.id}>
            <PlanningRow
              title={
                <>
                  {/* The person's own name is its own element, distinct from
                      the direction word beside it — so a reader (and a test)
                      can find "Minh" on its own, not only "MinhOwes you" run
                      together. */}
                  <span>{debt.person}</span>
                  <span className={cn('ml-2 text-xs', DIRECTION_TEXT_COLOR[debt.direction])}>
                    {t(debtDirectionLabelKey(debt.direction))}
                  </span>
                </>
              }
              badge={
                !compact && (
                  <StatusBadge
                    label={t(debtStatusLabelKey(debt.status))}
                    tone={STATUS_TONE[debt.status]}
                  />
                )
              }
              figureLine={
                compact ? (
                  <MoneyText value={debt.outstanding} currency={debt.currency} />
                ) : (
                  t('debts.figureLine', {
                    outstanding: debt.outstanding,
                    original: debt.original,
                    currency: debt.currency,
                  })
                )
              }
              progress={
                !compact && (
                  <Progress
                    // The bar is `tone="positive"` in BOTH directions: it
                    // measures repayment, and being repaid is good news
                    // whichever way the money is going.
                    percent={debt.percentPaid}
                    valueText={debt.percentLabel}
                    label={debt.person}
                    tone="positive"
                  />
                )
              }
              meta={
                !compact &&
                debt.dueDate && (
                  <span className={cn(debt.status === 'OVERDUE' && 'text-negative')}>
                    {t(debt.status === 'OVERDUE' ? 'debts.overdueMeta' : 'debts.dueMeta', {
                      date: formatDate(debt.dueDate, { locale, timeZone, style: 'date' }),
                    })}
                  </span>
                )
              }
              inlineAction={parts?.inlineAction}
              actions={parts?.actions}
              extra={
                <>
                  {!compact && (
                    <>
                      {debt.description && (
                        <p className="text-xs/[1rem] text-muted-foreground">{debt.description}</p>
                      )}
                      {debt.notes && (
                        <p className="text-xs/[1rem] text-muted-foreground">{debt.notes}</p>
                      )}
                      {debt.payments.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-xs/[1rem] text-muted-foreground">
                            {t('debts.paymentsSection', { count: debt.payments.length })}
                          </summary>
                          <ul className="mt-1 flex flex-col gap-1">
                            {debt.payments.map((payment) => (
                              <li key={payment.id} className="text-xs/[1rem] text-muted-foreground">
                                <span className="tabular-nums">
                                  {formatDate(payment.date, { locale, timeZone, style: 'date' })}
                                </span>{' '}
                                · <span className="tabular-nums">{payment.amount}</span>
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
