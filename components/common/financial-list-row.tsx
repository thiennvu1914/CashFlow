import { cn } from 'cn'

/**
 * A ledger row — a transaction, a transfer, an account (spec §6.2).
 *
 * The amount column is a FIXED `min-w-[8.5rem]`, right-aligned, and that is the
 * whole reason this component exists: a VND figure and a long note previously
 * shared one flexible line and collided at 375 px. The note is single-line and
 * ellipsised with its full text in `title`, so nothing is lost and nothing
 * pushes the figure off the row.
 *
 * Rows live inside ONE bordered surface and are separated by 1 px dividers —
 * never a card each (spec §2: "never a card inside a card"). The divider is the
 * parent `<ul>`'s `divide-y`, not this row's border.
 */
export function FinancialListRow({
  title,
  meta,
  note,
  amount,
  actions,
  className,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  note?: string | null
  amount: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <li className={cn('flex items-center gap-3 px-4 py-3', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-sm/[1.25rem] font-medium">{title}</div>
        {meta && <div className="truncate text-xs/[1rem] text-muted-foreground">{meta}</div>}
        {note && (
          // `title` carries the full text, so nothing is lost to the ellipsis.
          <div title={note} className="truncate text-xs/[1rem] text-muted-foreground">
            {note}
          </div>
        )}
      </div>
      <div className="flex min-w-[8.5rem] shrink-0 justify-end text-right">{amount}</div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </li>
  )
}
