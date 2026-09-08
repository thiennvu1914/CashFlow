import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import { recurrenceLabelKey, reminderTypeLabelKey } from '@/lib/ui/labels'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'
import { MoneyText } from '@/components/common/money-text'
import { PlanningRow } from '@/components/common/planning-row'
import { StatusBadge, type StatusTone } from '@/components/common/status-badge'
import { clusterByReminder, type OccurrenceCluster } from './occurrence-group'

/**
 * The shared occurrence row, used by both the Reminders page (full rows, with
 * acknowledge/dismiss via `renderActions`, and the collapse this task adds) and
 * — from a later group — the Dashboard's reminders widget (`compact`: what it
 * is, when it is due, and how much, nothing else, with `collapse` always
 * `false` — see the prop's own doc).
 *
 * An async server component with no state of its own: every figure it renders
 * is already a formatted string or plain enum from `toOccurrenceDto`
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
 * Nothing here shouts. An overdue occurrence is marked — a negative-toned due
 * line — and that is all: no icon, no count of days late, no banner. Colour is
 * never the only signal either: the due wording and the type are both *words*,
 * so a screen reader and a colour-blind reader get the same facts as everyone
 * else.
 *
 * ## Collapse (spec §6.7, this task)
 *
 * `collapse` runs every occurrence through `clusterByReminder`
 * (`./occurrence-group.tsx`) so a weekly reminder's four due instances become
 * one row with a "+3 kỳ" badge and a `<details>` disclosure — one code path
 * draws both modes by treating an uncollapsed list as clusters of one
 * (`{ next: o, rest: [] }`), so there is exactly one place that lays out a row.
 */

/**
 * Only income is coloured. Expected income arriving is the pleasant case and
 * reads as positive; a bill is the ordinary case, and colouring it negative
 * would make every reminder on the page look like a problem when a bill that is
 * simply due is not one. The due wording is what carries "Overdue".
 */
const TYPE_TONE: Record<OccurrenceDto['type'], StatusTone> = {
  INCOME: 'positive',
  EXPENSE: 'neutral',
}

/** Which due-label key this occurrence's day count calls for. */
function dueKey(occurrence: OccurrenceDto): string {
  if (occurrence.daysToDue < 0) return 'reminders.overdue'
  if (occurrence.daysToDue === 0) return 'reminders.dueToday'
  if (occurrence.daysToDue === 1) return 'reminders.dueTomorrow'
  return 'reminders.dueInDays'
}

export async function OccurrenceList({
  occurrences,
  locale,
  timeZone,
  collapse,
  compact,
  renderActions,
}: {
  occurrences: OccurrenceDto[]
  locale: Locale
  timeZone: string
  /** Collapse repeated occurrences of one reminder into one row (spec §6.7).
   *  The dashboard widget passes `false` — it shows at most five rows total and
   *  a "+n" badge there would explain a list the user cannot expand. */
  collapse?: boolean
  /** Dashboard variant: title, when it is due, and the amount. */
  compact?: boolean
  /** The Reminders page passes a client component rendering the row's
   *  acknowledge/dismiss buttons. */
  renderActions?: (occurrence: OccurrenceDto) => ReactNode
}) {
  const t = await getTranslations()

  const clusters: OccurrenceCluster[] = collapse
    ? clusterByReminder(occurrences)
    : occurrences.map((occurrence) => ({ next: occurrence, rest: [] }))

  return (
    <ul className="divide-y divide-border">
      {clusters.map((cluster) => {
        const { next } = cluster
        // The optional labels the reminder already carried with it, joined
        // only when they exist — an empty separator would otherwise read as a
        // missing value.
        const contextParts = [
          t(recurrenceLabelKey(next.frequency, next.interval), { count: next.interval }),
          next.categoryName,
          next.accountName,
        ].filter((part): part is string => Boolean(part))

        return (
          <PlanningRow
            key={next.id}
            title={next.title}
            badge={
              <>
                {!compact && (
                  <StatusBadge
                    label={t(reminderTypeLabelKey(next.type))}
                    tone={TYPE_TONE[next.type]}
                  />
                )}
                {cluster.rest.length > 0 && (
                  <StatusBadge
                    label={t('reminders.morePeriods', { count: cluster.rest.length })}
                    tone="neutral"
                  />
                )}
              </>
            }
            figureLine={<MoneyText value={next.amount} currency={next.currency} />}
            meta={
              <>
                <span className={cn(next.overdue && 'text-negative')}>
                  {t('reminders.dueLine', {
                    due: t(dueKey(next), { count: next.daysToDue }),
                    date: formatDate(next.dueDate, { locale, timeZone, style: 'date' }),
                  })}
                </span>
                {!compact && contextParts.length > 0 && (
                  <span className="block">{contextParts.join(' · ')}</span>
                )}
              </>
            }
            inlineAction={renderActions?.(next)}
            extra={
              cluster.rest.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs/[1rem] text-muted-foreground">
                    {t('reminders.expandPeriods', { count: cluster.rest.length, name: next.title })}
                  </summary>
                  <ul className="mt-2 flex flex-col gap-2 border-l border-border pl-3">
                    {cluster.rest.map((occurrence) => (
                      <li
                        key={occurrence.id}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="text-xs/[1rem] text-muted-foreground tabular-nums">
                          {formatDate(occurrence.dueDate, { locale, timeZone, style: 'date' })}
                        </span>
                        {renderActions?.(occurrence)}
                      </li>
                    ))}
                  </ul>
                </details>
              )
            }
          />
        )
      })}
    </ul>
  )
}
