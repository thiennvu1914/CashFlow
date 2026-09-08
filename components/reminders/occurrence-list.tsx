import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'

/**
 * The shared occurrence row, used by both the Reminders page (full rows, with
 * acknowledge/dismiss via `renderActions`) and — from a later group — the
 * Dashboard's reminders widget (`compact`: what it is, when it is due, and how
 * much, nothing else).
 *
 * A server component with no state of its own: every figure it renders is
 * already a formatted string from `toOccurrenceDto`
 * (`lib/ui/reminder-view-model.ts`) — this file never touches a
 * `Prisma.Decimal` or a `Date`, neither of which can cross into the client
 * components `renderActions` mounts.
 *
 * Each occurrence is shown in its reminder's OWN currency and no row is ever
 * converted (ledger ruling R5-3). There is no total anywhere in this list, and
 * that is deliberate rather than an omission: an expected amount is money the
 * user *thinks* will move, so summing a column of them would state a figure
 * that has not happened — and a reminder is never a Transaction (spec §4.7,
 * directive M).
 *
 * Nothing here shouts. An overdue occurrence is marked — the word "Overdue" and
 * a negative-toned line — and that is all: no icon, no count of days late, no
 * banner. Colour is never the only signal either: the due label and the type
 * are both *words*, so a screen reader and a colour-blind reader get the same
 * facts as everyone else.
 */

/**
 * Only income is coloured. Expected income arriving is the pleasant case and
 * reads as positive; a bill is the ordinary case, and colouring it negative
 * would make every reminder on the page look like a problem when a bill that is
 * simply due is not one. "Overdue" is what the due line is for.
 */
const TYPE_TEXT_COLOR: Record<OccurrenceDto['type'], string> = {
  INCOME: 'text-positive',
  EXPENSE: 'text-muted-foreground',
}

/** "Today · 2026-04-15" — the relative reading first, because that is the one
 *  the user acts on, and the date itself so the row is unambiguous. */
function dueLine(occurrence: OccurrenceDto): string {
  return `${occurrence.dueLabel} · ${occurrence.dueDate}`
}

/** The optional labels the reminder already carried with it, joined only when
 *  they exist — an empty separator would otherwise read as a missing value. */
function contextLine(occurrence: OccurrenceDto): string {
  return [occurrence.recurrenceLabel, occurrence.categoryName, occurrence.accountName]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

export function OccurrenceList({
  occurrences,
  compact,
  renderActions,
}: {
  occurrences: OccurrenceDto[]
  /** Dashboard variant: title, when it is due, and the amount. */
  compact?: boolean
  /** The Reminders page passes a client component rendering the row's
   *  acknowledge/dismiss buttons. */
  renderActions?: (occurrence: OccurrenceDto) => ReactNode
}) {
  return (
    <ul className="flex flex-col gap-2">
      {occurrences.map((occurrence) => (
        <li
          key={occurrence.id}
          className={cn('rounded-md border border-border p-3', compact && 'p-2')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{occurrence.title}</span>
              {!compact && (
                <span
                  className={cn(
                    'rounded-sm border border-border px-1.5 text-xs',
                    TYPE_TEXT_COLOR[occurrence.type],
                  )}
                >
                  {occurrence.typeLabel}
                </span>
              )}
            </div>
            <span className="text-sm tabular-nums whitespace-nowrap">
              {occurrence.amount} {occurrence.currency}
            </span>
          </div>
          {/* In both variants: an occurrence with no due date on it is not a
              reminder of anything. */}
          <p
            className={cn(
              'mt-1 text-xs',
              occurrence.overdue ? 'text-negative' : 'text-muted-foreground',
            )}
          >
            {dueLine(occurrence)}
          </p>
          {!compact && (
            <p className="mt-1 text-xs text-muted-foreground">{contextLine(occurrence)}</p>
          )}
          {/* Its own row, full width — not squeezed into the header line —
              because an answer to a reminder is a decision, not a chevron. */}
          {renderActions && (
            <div className="mt-2 flex justify-end">{renderActions(occurrence)}</div>
          )}
        </li>
      ))}
    </ul>
  )
}
