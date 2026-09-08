import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import { goalStatusLabelKey } from '@/lib/ui/labels'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import { PlanningRow } from '@/components/common/planning-row'
import { Progress } from '@/components/common/progress'
import { RowErrorAlert, RowErrorProvider } from '@/components/common/row-error-context'
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
 *
 * `renderActions` returns TWO pieces, not one (fix round 1, findings 4/5/6):
 * `inlineAction` (the row's "Cập nhật tiến độ" button, its own `PlanningRow`
 * slot) and `actions` (the `…` menu). Each row is wrapped in a
 * `RowErrorProvider` so the menu's archive failure — reported via
 * `useRowError`, not a local `useState` — can be shown by `RowErrorAlert` in
 * `extra`, under the row, rather than squeezed into the actions cell.
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
  /** The Savings page passes the row's inline progress button and `…` menu as
   *  two separate pieces — they mount in two different `PlanningRow` slots
   *  and share no state. */
  renderActions?: (goal: SavingsGoalDto) => { actions: ReactNode; inlineAction?: ReactNode }
}) {
  const t = await getTranslations()

  return (
    <ul className="divide-y divide-border">
      {goals.map((goal) => {
        const deadline = goal.deadline
        // Achieved omits the deadline/remaining meta entirely (fix round 1,
        // finding 10): the badge already says "Đạt mục tiêu"/"Achieved", and
        // repeating the same word as the meta line was a pointless duplicate
        // — the goal is done, so what the deadline used to say no longer
        // matters. `daysToDeadline === 0` gets its own "due today" wording
        // rather than the plural's `count: 0` reading as "Còn 0 ngày", which
        // is technically true and reads worse than just saying today.
        const meta =
          goal.status === 'ACHIEVED'
            ? undefined
            : deadline === null
              ? t('goals.remaining', { amount: goal.remaining, currency: goal.currency })
              : goal.deadlinePassed
                ? t('goals.deadlinePassed', {
                    date: formatDate(deadline, { locale, timeZone, style: 'date' }),
                  })
                : goal.daysToDeadline === 0
                  ? t('goals.deadlineToday')
                  : t('goals.deadlineMeta', {
                      count: goal.daysToDeadline ?? 0,
                      date: formatDate(deadline, { locale, timeZone, style: 'date' }),
                    })

        const parts = renderActions?.(goal)

        return (
          <RowErrorProvider key={goal.id}>
            <PlanningRow
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
              meta={
                meta ? (
                  <span className={cn(goal.deadlinePassed && 'text-warning')}>{meta}</span>
                ) : undefined
              }
              inlineAction={parts?.inlineAction}
              actions={parts?.actions}
              extra={renderActions && <RowErrorAlert />}
            />
          </RowErrorProvider>
        )
      })}
    </ul>
  )
}
