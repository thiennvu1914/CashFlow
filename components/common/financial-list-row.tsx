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
 *
 * `wrapTitle`/`wrapMeta` (Task 5b fix round 1, IMPORTANT finding): `title` and
 * `meta` default to a single ellipsised line, which is right for a category
 * name or a date-and-account string but is actively harmful for a transfer's
 * `Cash → Bank` route — an ellipsis there silently deletes the destination
 * account and the arrow, the one thing the row exists to say. A caller whose
 * content can safely wrap (and MUST, rather than lose information) opts in
 * per-prop; both default to `false` so Transactions and the Dashboard's
 * recent-transactions list are byte-for-byte unchanged.
 */
export function FinancialListRow({
  title,
  meta,
  note,
  amount,
  actions,
  className,
  wrapTitle = false,
  wrapMeta = false,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  note?: string | null
  amount: React.ReactNode
  actions?: React.ReactNode
  className?: string
  /** Let `title` wrap onto more than one line instead of ellipsising. */
  wrapTitle?: boolean
  /** Let `meta` wrap onto more than one line instead of ellipsising. */
  wrapMeta?: boolean
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          className={cn('text-sm/[1.25rem] font-medium', wrapTitle ? 'break-words' : 'truncate')}
        >
          {title}
        </div>
        {meta && (
          <div
            className={cn(
              'text-xs/[1rem] text-muted-foreground',
              wrapMeta ? 'break-words' : 'truncate',
            )}
          >
            {meta}
          </div>
        )}
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
