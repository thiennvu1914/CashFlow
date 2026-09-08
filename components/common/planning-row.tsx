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
 */
export function PlanningRow({
  title,
  badge,
  figureLine,
  progress,
  meta,
  extra,
  actions,
  dim,
  className,
}: {
  title: React.ReactNode
  badge?: React.ReactNode
  figureLine: React.ReactNode
  progress?: React.ReactNode
  meta?: React.ReactNode
  extra?: React.ReactNode
  actions?: React.ReactNode
  dim?: boolean
  className?: string
}) {
  return (
    <li className={cn('flex flex-col gap-2 px-4 py-3', dim && 'opacity-70', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm/[1.25rem] font-medium">{title}</span>
          {badge}
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      <div className="text-[0.9375rem]/[1.25rem] tabular-nums">{figureLine}</div>
      {progress}
      {meta && <div className="text-xs/[1rem] text-muted-foreground">{meta}</div>}
      {extra}
    </li>
  )
}
