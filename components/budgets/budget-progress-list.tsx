import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { BudgetProgressDto } from '@/lib/ui/budget-view-model'

/**
 * The shared budget-progress row, used by both the Budgets page (full rows,
 * with Edit/Delete via `renderActions`) and the Dashboard's budgets widget
 * (`compact`, no remaining line, no actions).
 *
 * A server component with no state of its own: every figure it renders is
 * already a formatted string or plain number from `toBudgetProgressDto`
 * (`lib/ui/budget-view-model.ts`) — this file never touches a `Prisma.Decimal`.
 *
 * The status badge and the bar fill both key off the same three-colour
 * mapping (`text-positive`/`text-warning`/`text-negative`), so the four
 * `BudgetStatus` bands stay visually distinguishable even without colour —
 * the label text differs at every band even where the colour repeats.
 */

const STATUS_TEXT_COLOR: Record<BudgetProgressDto['status'], string> = {
  ok: 'text-positive',
  warning_50: 'text-positive',
  warning_80: 'text-warning',
  at_100: 'text-negative',
  exceeded: 'text-negative',
}

const STATUS_FILL_COLOR: Record<BudgetProgressDto['status'], string> = {
  ok: 'bg-positive',
  warning_50: 'bg-positive',
  warning_80: 'bg-warning',
  at_100: 'bg-negative',
  exceeded: 'bg-negative',
}

export function BudgetProgressList({
  budgets,
  compact,
  renderActions,
}: {
  budgets: BudgetProgressDto[]
  /** Dashboard variant: tighter rows, no remaining line. */
  compact?: boolean
  /** Budgets page passes a client component rendering Edit/Delete for a row. */
  renderActions?: (budget: BudgetProgressDto) => ReactNode
}) {
  return (
    <ul className="flex flex-col gap-2">
      {budgets.map((budget) => (
        <li key={budget.id} className={cn('rounded-md border border-border p-3', compact && 'p-2')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">
                {budget.label}
                {budget.categoryArchived && (
                  <span className="ml-1 font-normal text-muted-foreground">(archived)</span>
                )}
              </span>
              <span
                className={cn(
                  'rounded-sm border border-border px-1.5 text-xs',
                  STATUS_TEXT_COLOR[budget.status],
                )}
              >
                {budget.statusLabel}
              </span>
            </div>
            <span className="text-sm tabular-nums whitespace-nowrap">
              {budget.spent} / {budget.amount} {budget.currency}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={budget.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${budget.label} budget`}
            className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted"
          >
            <div
              className={cn('h-full', STATUS_FILL_COLOR[budget.status])}
              style={{ width: `${budget.percent}%` }}
            />
          </div>
          {!compact && (
            <p className={cn('mt-1 text-xs text-muted-foreground', budget.over && 'text-negative')}>
              {budget.over ? `Over by ${budget.remaining}` : `Remaining ${budget.remaining}`}
            </p>
          )}
          {/* Its own row, full width — not squeezed into the header line —
              because editing renders a whole form here, not just two buttons. */}
          {renderActions && <div className="mt-2 flex justify-end">{renderActions(budget)}</div>}
        </li>
      ))}
    </ul>
  )
}
