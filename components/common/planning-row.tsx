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
 * ## The header row (fix round 2)
 *
 * The header row is `items-start`, and the actions cell is pinned via
 * `ml-auto` rather than the container's `justify-content` (fix round 1,
 * findings 4/5): `justify-between` puts a lone item at `flex-start` once it
 * wraps onto its own line — which is exactly what stranded a long title's `…`
 * trigger at the LEFT edge of a third line at 375 px. `ml-auto` keeps the
 * actions cell pinned to the right on whichever line it ends up on, wrapped
 * or not.
 *
 * `items-start` alone, though, mis-centred the common case (fix round 2's
 * regression): a single-line title is ~20 px tall, but the actions cell can
 * be 44 px (the `…` trigger's mobile touch target, `size-11`) or 36 px (its
 * desktop size, `md:size-9`) — top-aligning two boxes of different heights
 * puts their CONTENTS at different vertical centres, which reads as the `…`
 * trigger sitting low against the title. The fix is not `items-center` on the
 * header (that is what caused fix round 1's regression in the other
 * direction) — it is giving the TITLE cell the SAME min-height as the actions
 * cell can reach (`min-h-11` below 768, `md:min-h-9` from the icon rail
 * up — the SAME breakpoint the trigger moved to when the owner ruled 44 px for
 * the whole sub-768 band, matching
 * `RowActionsMenu`'s own trigger sizes exactly) and keeping `items-center`
 * *inside* that cell. Two boxes of equal height, both top-aligned in an
 * `items-start` row, have coincident centres — restoring pixel-identical
 * single-line alignment — while a title that genuinely wraps to two lines
 * still grows past that floor and the actions cell, unaffected, stays pinned
 * top-right by `ml-auto`. The floor only applies when there IS an actions
 * cell to match (`inlineAction` or `actions` present) — an actions-less row
 * (an archived/read-only section with no `renderActions`) is exactly as
 * compact as it was before either fix round, since forcing every row to a
 * button's height when no button exists would be its own regression.
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
  // See the module doc above: only inflates the title cell to match the
  // actions cell's own height when there is an actions cell to match.
  const hasActionsCell = Boolean(inlineAction || actions)

  return (
    <li
      className={cn(
        'relative flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-foreground/4',
        dim && 'opacity-70',
        className,
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-2',
            hasActionsCell && 'min-h-11 md:min-h-9',
          )}
        >
          <span className="truncate text-sm/[1.25rem] font-medium">{title}</span>
          {badge}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
