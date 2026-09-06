import { cn } from 'cn'

/**
 * One widget's frame: a small-caps muted heading, a hairline border, no shadow.
 *
 * Every widget on the dashboard uses it, which is what makes the page read as
 * one surface with sections rather than a tray of floating cards — the Calm
 * Premium Fintech direction in `AGENTS.md` (no gradients, no glassmorphism, no
 * large shadows, no giant radii).
 */
export function DashboardSection({
  title,
  caption,
  children,
  className,
}: {
  title: string
  /** A qualifier the reader needs in order not to misread the chart. */
  caption?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-md border border-border bg-surface p-4', className)}>
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/**
 * What a widget shows instead of an axis with nothing on it. Saying "no
 * transactions this month" is information; an empty grid is a bug report.
 */
export function DashboardEmpty({ children }: { children: React.ReactNode }) {
  return <p className="flex min-h-24 items-center text-sm text-muted-foreground">{children}</p>
}
