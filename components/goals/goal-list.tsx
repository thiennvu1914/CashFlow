import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'

/**
 * The shared savings-goal row, used by both the Savings page (full rows, with
 * progress/edit/archive via `renderActions`) and — from Group 8 — the
 * Dashboard's goals widget (`compact`, no remaining line, no actions).
 *
 * A server component with no state of its own: every figure it renders is
 * already a formatted string or plain number from `toSavingsGoalDto`
 * (`lib/ui/savings-goal-view-model.ts`) — this file never touches a
 * `Prisma.Decimal` or a `Date`, neither of which can cross into the client
 * components `renderActions` mounts.
 *
 * The bar is `bg-brand` at every status rather than a three-colour band like
 * `BudgetProgressList`'s: a budget's fill is a warning that grows, a goal's is
 * an achievement that grows, and colouring a nearly-met goal red would invert
 * its meaning. Only the two things that *are* exceptional carry colour — an
 * achieved goal's badge (`text-positive`) and a missed deadline
 * (`text-warning`) — and each also differs in wording, so neither reading
 * depends on seeing colour.
 */

const STATUS_TEXT_COLOR: Record<SavingsGoalDto['status'], string> = {
  ACTIVE: 'text-muted-foreground',
  ACHIEVED: 'text-positive',
  ARCHIVED: 'text-muted-foreground',
}

export function GoalList({
  goals,
  compact,
  renderActions,
}: {
  goals: SavingsGoalDto[]
  /** Dashboard variant: tighter rows, no remaining line. */
  compact?: boolean
  /** The Savings page passes a client component rendering the row's actions. */
  renderActions?: (goal: SavingsGoalDto) => ReactNode
}) {
  return (
    <ul className="flex flex-col gap-2">
      {goals.map((goal) => (
        <li key={goal.id} className={cn('rounded-md border border-border p-3', compact && 'p-2')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{goal.name}</span>
              <span
                className={cn(
                  'rounded-sm border border-border px-1.5 text-xs',
                  STATUS_TEXT_COLOR[goal.status],
                )}
              >
                {goal.statusLabel}
              </span>
            </div>
            <span className="text-sm tabular-nums whitespace-nowrap">
              {goal.progress} / {goal.target} {goal.currency}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={goal.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            // `aria-valuenow` is the clamped bar width (never over 100); an
            // over-saved goal's true figure — "120 %" — still needs to be
            // announced, which is exactly what `percentLabel` carries.
            aria-valuetext={goal.percentLabel}
            aria-label={`${goal.name} progress`}
            className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted"
          >
            <div className="h-full bg-brand" style={{ width: `${goal.percent}%` }} />
          </div>
          {!compact && (
            <p className="mt-1 text-xs text-muted-foreground">Remaining {goal.remaining}</p>
          )}
          {goal.deadline && (
            <p
              className={cn(
                'mt-1 text-xs text-muted-foreground',
                goal.deadlinePassed && 'text-warning',
              )}
            >
              {goal.deadlinePassed ? `Deadline passed ${goal.deadline}` : `By ${goal.deadline}`}
            </p>
          )}
          {/* Its own row, full width — not squeezed into the header line —
              because editing renders a whole form here, not just buttons. */}
          {renderActions && <div className="mt-2 flex justify-end">{renderActions(goal)}</div>}
        </li>
      ))}
    </ul>
  )
}
