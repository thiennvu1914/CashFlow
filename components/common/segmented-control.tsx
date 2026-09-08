import Link from 'next/link'
import { cn } from 'cn'

export interface Segment {
  id: string
  label: string
  href: string
}

/**
 * A real segmented control (spec §6.8): one bordered track, the active segment
 * visibly *selected* rather than merely tinted — which was the pre-flight
 * finding against the Reports period filter and the Reminders tabs.
 *
 * Ordinary links, so the address bar stays the single source of truth for which
 * segment is showing and the control works before (and without) JavaScript —
 * the same reasoning `components/reports/period-filter.tsx` and
 * `components/budgets/month-nav.tsx` already gave for their links.
 *
 * `flex-wrap` below `sm`, `sm:flex-nowrap` from `sm` up (fix round 1, promoted
 * minor): Reports' six-segment track was the first consumer with enough
 * segments to clip at 375 ("Tùy chọ…") rather than merely needing its
 * `overflow-x-auto` fallback scroll. Wrapping to a second row keeps every
 * segment visible and tappable instead of hiding one behind a horizontal
 * scroll a user has no visual cue to try. `sm:flex-nowrap` keeps every OTHER
 * consumer (`month-nav.tsx`'s 3 segments, the Reminders tabs' 2) rendering
 * exactly as before at every width they were already proven at — this only
 * changes behaviour below `sm` (640), and only when there are enough segments
 * to wrap in the first place.
 */
export function SegmentedControl({
  label,
  segments,
  activeId,
  className,
}: {
  label: string
  segments: Segment[]
  activeId: string | null
  className?: string
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        'inline-flex max-w-full flex-wrap overflow-x-auto rounded-md border border-border bg-surface p-0.5 sm:flex-nowrap',
        className,
      )}
    >
      {segments.map((segment) => {
        const active = segment.id === activeId
        return (
          <Link
            key={segment.id}
            href={segment.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm whitespace-nowrap',
              active
                ? 'bg-muted font-medium text-brand'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {segment.label}
          </Link>
        )
      })}
    </nav>
  )
}
