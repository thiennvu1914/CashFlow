import { cn } from 'cn'

/**
 * One widget's frame, and the one visual language every chart and list widget
 * on the dashboard and Reports shares (spec §6.1: "no chart forest ... one
 * visual language, no nested cards").
 *
 * Replaces `components/dashboard/dashboard-section.tsx`. Same card title
 * treatment (13/600 uppercase muted), same hairline border, no shadow — plus an
 * explicit body `height`, because the spec's grid specifies 300 / 260 / 240 per
 * row and a ragged row of charts was one of the pre-flight findings.
 */
export function ChartContainer({
  title,
  caption,
  right,
  height,
  children,
  className,
}: {
  title: string
  caption?: string
  right?: React.ReactNode
  height?: number
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn('flex flex-col rounded-lg border border-border bg-surface p-4', className)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[0.8125rem]/[1.125rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {title}
          </h2>
          {caption && <p className="text-xs/[1rem] text-muted-foreground">{caption}</p>}
        </div>
        {right}
      </div>
      {/* `min-w-0` so a recharts ResponsiveContainer inside a grid cell can
          shrink below its content width instead of widening the page. */}
      <div className="mt-3 min-w-0 flex-1" style={height ? { height } : undefined}>
        {children}
      </div>
    </section>
  )
}
