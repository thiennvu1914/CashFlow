import { cn } from 'cn'

/**
 * A section's heading inside a page. `as="h3"` for a group *inside* a section
 * (the Reminders page's "Quá hạn" under "Sắp đến hạn"), so the heading order
 * stays h1 → h2 → h3 with nothing skipped (spec §8).
 */
export function SectionHeader({
  title,
  caption,
  as: Tag = 'h2',
  right,
  className,
}: {
  title: string
  caption?: string
  as?: 'h2' | 'h3'
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-2', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <Tag
          className={cn(
            Tag === 'h2'
              ? 'text-[1.125rem]/[1.625rem] font-semibold'
              : 'text-sm/[1.25rem] font-medium',
          )}
        >
          {title}
        </Tag>
        {caption && <p className="text-xs/[1rem] text-muted-foreground">{caption}</p>}
      </div>
      {right}
    </div>
  )
}
