import type { ReactNode } from 'react'
import { cn } from 'cn'

/**
 * A planning row — a budget, a savings goal, a debt, a loan, a reminder
 * definition (spec §6.5).
 *
 * One shape for all five, because they are the same shape: a thing with a
 * target, a status, how far along it is, and one or two things you can do about
 * it. Before this, four files each drew their own version of it and they had
 * drifted apart on padding, badge placement and where the actions went.
 *
 * Rows sit inside one bordered surface with `divide-y` dividers, like
 * `FinancialListRow` — not one card each.
 *
 * The header row is `items-start` with the actions cell pinned via `ml-auto`
 * rather than the container's `justify-content` (fix round 1, findings 4/5):
 * `justify-between` puts a lone item at `flex-start` once it wraps onto its
 * own line — which is exactly what stranded a long title's `…` trigger at the
 * LEFT edge of a third line at 375 px. `ml-auto` keeps the actions cell
 * pinned to the right on whichever line it ends up on, wrapped or not, and
 * `items-start` (rather than `items-center`) stops a short title from being
 * vertically centred against a taller actions cell — the case that put a
 * goal's full-width "Cập nhật tiến độ" button above its own title.
 */
export function PlanningRow({
  title,
  badge,
  figureLine,
  progress,
  meta,
  inlineAction,
  extra,
  actions,
  dim,
  className,
}: {
  title: ReactNode
  badge?: ReactNode
  figureLine: ReactNode
  progress?: ReactNode
  meta?: ReactNode
  /**
   * A row's one inline primary action (e.g. the goal row's "Cập nhật tiến
   * độ") — distinct from `actions` (the `…` menu): it sits beside the menu in
   * the actions cell from `sm` up, and on its own full-width line below the
   * meta line below `sm`, where a full-width button reads better than a
   * cramped inline one. Rendered twice (once per breakpoint, each hidden at
   * the other) rather than repositioned with JS, so there is no layout
   * flash and no client-only measurement.
   */
  inlineAction?: ReactNode
  extra?: ReactNode
  actions?: ReactNode
  dim?: boolean
  className?: string
}) {
  return (
    <li className={cn('relative flex flex-col gap-2 px-4 py-3', dim && 'opacity-70', className)}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm/[1.25rem] font-medium">{title}</span>
          {badge}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {inlineAction && <span className="hidden sm:inline-flex">{inlineAction}</span>}
          {actions}
        </div>
      </div>
      <div className="text-[0.9375rem]/[1.25rem] tabular-nums">{figureLine}</div>
      {progress}
      {meta && <div className="text-xs/[1rem] text-muted-foreground">{meta}</div>}
      {inlineAction && <div className="sm:hidden">{inlineAction}</div>}
      {extra}
    </li>
  )
}
