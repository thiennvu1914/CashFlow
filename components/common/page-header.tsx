import { cn } from 'cn'

/**
 * The one `h1` on a page, plus what qualifies it and what can be done from it
 * (spec §5: "every page renders a PageHeader — including Transactions,
 * Transfers, Accounts, Categories and Settings, which have none today").
 *
 * `actions` sits to the right from 640 up and stacks under the title below it
 * (spec §7), so a phone never has a title and a button competing for one line.
 * `meta` is the 12 px line the dashboard's FX status was demoted to.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: string
  description?: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
          {title}
        </h1>
        {description && (
          <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{description}</p>
        )}
        {meta && <div className="text-xs/[1rem] text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
