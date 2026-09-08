import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import { goalStatusLabelKey } from '@/lib/ui/labels'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import { PlanningRow } from '@/components/common/planning-row'
import { Progress } from '@/components/common/progress'
import { StatusBadge, type StatusTone } from '@/components/common/status-badge'

/**
 * The shared savings-goal row, used by both the Savings page (full rows, with
 * progress/edit/archive via `renderActions`) and the Dashboard's goals widget
 * (`compact`, no actions).
 *
 * An async server component with no state of its own: every figure it renders
 * is already a formatted string or plain number from `toSavingsGoalDto`
 * (`lib/ui/savings-goal-view-model.ts`) — this file never touches a
 * `Prisma.Decimal`, neither of which can cross into the client components
 * `renderActions` mounts. `deadline` on the DTO IS a carrier string
 * (`yyyy-MM-dd`), which is why `formatDate` can read it here without a `Date`
 * ever reaching this file.
 *
 * The bar is `bg-brand` at every status rather than a three-colour band like
 * `BudgetProgressList`'s: a budget's fill is a warning that grows, a goal's is
 * an achievement that grows, and colouring a nearly-met goal red would invert
 * its meaning. Only the two things that *are* exceptional carry colour — an
 * achieved goal's badge (`text-positive`, via `StatusBadge`'s tone) and a
 * missed deadline (`text-warning`) — and each also differs in wording, so
 * neither reading depends on seeing colour.
 *
 * `compact` is accepted (and the Dashboard's call site passes it) purely for
 * interface symmetry with `BudgetProgressList`: the deadline/achieved meta is
 * exactly what the old hand-rolled compact widget already showed regardless of
 * width, so there is nothing this component trims for it — it is not
 * destructured below.
 */
const STATUS_TONE: Record<SavingsGoalDto['status'], StatusTone> = {
  ACTIVE: 'neutral',
  ACHIEVED: 'positive',
  ARCHIVED: 'muted',
}

export async function GoalList({
  goals,
  locale,
  timeZone,
  renderActions,
}: {
  goals: SavingsGoalDto[]
  locale: Locale
  timeZone: string
  /** Dashboard variant: no actions. */
  compact?: boolean
  /** The Savings page passes a client component rendering the row's actions. */
  renderActions?: (goal: SavingsGoalDto) => ReactNode
}) {
  const t = await getTranslations()

  return (
    <ul className="divide-y divide-border">
      {goals.map((goal) => {
        const deadline = goal.deadline
        const meta =
          goal.status === 'ACHIEVED'
            ? t('goals.achieved')
            : deadline === null
              ? t('goals.remaining', { amount: goal.remaining, currency: goal.currency })
              : goal.deadlinePassed
                ? t('goals.deadlinePassed', {
                    date: formatDate(deadline, { locale, timeZone, style: 'date' }),
                  })
                : t('goals.deadlineMeta', {
                    count: goal.daysToDeadline ?? 0,
                    date: formatDate(deadline, { locale, timeZone, style: 'date' }),
                  })

        return (
          <PlanningRow
            key={goal.id}
            title={goal.name}
            badge={
              <StatusBadge
                label={t(goalStatusLabelKey(goal.status))}
                tone={STATUS_TONE[goal.status]}
              />
            }
            figureLine={t('goals.figureLine', {
              progress: goal.progress,
              target: goal.target,
              currency: goal.currency,
              percent: goal.percentLabel,
            })}
            progress={
              <Progress
                percent={goal.percent}
                valueText={goal.percentLabel}
                label={goal.name}
                tone="brand"
              />
            }
            meta={<span className={cn(goal.deadlinePassed && 'text-warning')}>{meta}</span>}
            actions={renderActions?.(goal)}
          />
        )
      })}
    </ul>
  )
}
