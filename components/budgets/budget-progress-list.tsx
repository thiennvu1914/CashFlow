import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { budgetStatusLabelKey } from '@/lib/ui/labels'
import type { Locale } from '@/lib/i18n/locale'
import type { BudgetProgressDto } from '@/lib/ui/budget-view-model'
import { PlanningRow } from '@/components/common/planning-row'
import { Progress } from '@/components/common/progress'
import { RowErrorAlert, RowErrorProvider } from '@/components/common/row-error-context'
import { StatusBadge, type StatusTone } from '@/components/common/status-badge'

/**
 * The shared budget-progress row, used by both the Budgets page (full rows,
 * with Edit/Delete via `renderActions`) and the Dashboard's budgets widget
 * (`compact`, no meta line, no actions).
 *
 * An async server component with no state of its own: every figure it renders
 * is already a formatted string or plain number from `toBudgetProgressDto`
 * (`lib/ui/budget-view-model.ts`) — this file never touches a `Prisma.Decimal`.
 * It is rendered only from server pages/components (`app/(app)/budgets/page.tsx`
 * and the Dashboard) — verified with `grep -rn "BudgetProgressList" app
 * components` — so calling `getTranslations` here needs no client boundary.
 *
 * The spec's three tones (§6.5): Healthy → positive, Approaching → warning,
 * Exceeded → negative. Five bands map onto three because "over half used" is
 * still healthy and "at limit" is already exceeded in every way that matters
 * to the reader. The LABEL differs at every band regardless
 * (`labels.budgetStatus.*`, via `budgetStatusLabelKey`), so nothing depends on
 * seeing the colour.
 *
 * `compact` is accepted (and the Dashboard's call site passes it) purely for
 * symmetry with `GoalList`'s interface: the one line the old hand-rolled
 * compact variant trimmed — a standalone "Remaining …"/"Over by …" paragraph —
 * is now folded into `figureLine` itself, which is the same string at every
 * width. There is nothing left for this component to trim, so it is not
 * destructured below.
 *
 * `RowErrorProvider` (fix round 1, finding 6) wraps a row ONLY when
 * `renderActions` is given (fix round 2): the Dashboard's compact widget
 * passes none at all, so it has nothing that could ever set a row error, and
 * wrapping it in a Context Provider — a Client Component — regardless would
 * cost every widget row a needless client boundary for a feature it can never
 * use.
 */
const STATUS_TONE: Record<
  BudgetProgressDto['status'],
  Extract<StatusTone, 'positive' | 'warning' | 'negative'>
> = {
  ok: 'positive',
  warning_50: 'positive',
  warning_80: 'warning',
  at_100: 'negative',
  exceeded: 'negative',
}

export async function BudgetProgressList({
  budgets,
  renderActions,
}: {
  budgets: BudgetProgressDto[]
  /** Unused inside this component — every figure is already a formatted
   *  string from `toBudgetProgressDto`, which took the locale itself. Kept in
   *  the prop type for interface symmetry with `GoalList` (which DOES need it,
   *  to format the deadline carrier via `formatDate`) and so both call sites
   *  read the same way. */
  locale: Locale
  /** Dashboard variant: no meta line, no actions. */
  compact?: boolean
  /** Budgets page passes a client component rendering Edit/Delete for a row. */
  renderActions?: (budget: BudgetProgressDto) => ReactNode
}) {
  const t = await getTranslations()

  return (
    <ul className="divide-y divide-border">
      {budgets.map((budget) => {
        const scopeLabel = budget.categoryName ?? t('labels.budgetScope.OVERALL')
        const tone = STATUS_TONE[budget.status]

        // The OVERALL row reads visually stronger than a category budget
        // (owner requirement) via a 2 px brand rule on the left plus a
        // bolder title — not a `bg-muted` tint, which is the exact colour
        // `Progress` already uses for its own track (fix round 1, finding
        // 3): a below-100 % Overall bar would lose its track against an
        // identical background, and the tint read as near-invisible in
        // dark regardless. `bg-surface-2` is a real, distinct token from
        // both `--surface` and `--muted`, so it tints without colliding
        // with the bar underneath it.
        const rowContent = {
          className:
            budget.scope === 'OVERALL' ? 'border-l-2 border-brand bg-surface-2' : undefined,
          title: (
            <>
              <span className={budget.scope === 'OVERALL' ? 'font-semibold' : undefined}>
                {scopeLabel}
              </span>
              {budget.categoryArchived && (
                <span className="ml-1 font-normal text-muted-foreground">
                  {t('budgets.categoryArchived')}
                </span>
              )}
            </>
          ),
          badge: <StatusBadge label={t(budgetStatusLabelKey(budget.status))} tone={tone} />,
          figureLine: t(budget.over ? 'budgets.figureLineOver' : 'budgets.figureLine', {
            spent: budget.spent,
            limit: budget.amount,
            currency: budget.currency,
            remaining: budget.remaining,
            over: budget.remaining,
            percent: budget.percentLabel,
          }),
          progress: (
            <Progress
              percent={budget.percent}
              valueText={budget.percentLabel}
              label={scopeLabel}
              tone={tone}
            />
          ),
        }

        return renderActions ? (
          <RowErrorProvider key={budget.id}>
            <PlanningRow
              {...rowContent}
              actions={renderActions(budget)}
              extra={<RowErrorAlert />}
            />
          </RowErrorProvider>
        ) : (
          <PlanningRow key={budget.id} {...rowContent} />
        )
      })}
    </ul>
  )
}
