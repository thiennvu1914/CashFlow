import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { ReminderDto } from '@/lib/ui/reminder-view-model'

/**
 * The reminder *definitions* — the schedules, not the due instances.
 *
 * The distinction is the page's whole structure: the "Due" list above is what
 * the user has to answer, and this is what will keep producing it. A paused
 * definition therefore still appears here, dimmed and labelled, rather than
 * disappearing — a reminder the user cannot see is one they cannot resume.
 *
 * A server component with no state of its own: every figure is already a
 * formatted string from `toReminderDto` (`lib/ui/reminder-view-model.ts`), so
 * this file never touches a `Prisma.Decimal` or a `Date` — neither can cross
 * into the `ReminderToggle` that `renderActions` mounts.
 *
 * No total, and no per-currency subtotal strip either (unlike `/loans` and
 * `/debts`): an expected amount is not an amount owed, so a "you have
 * 4.300.000 of reminders" figure would state a liability that does not exist.
 */
export function ReminderList({
  reminders,
  renderActions,
}: {
  reminders: ReminderDto[]
  /** The Reminders page passes a client component rendering the row's
   *  pause/resume button. */
  renderActions?: (reminder: ReminderDto) => ReactNode
}) {
  return (
    <ul className="flex flex-col gap-2">
      {reminders.map((reminder) => (
        <li
          key={reminder.id}
          className={cn('rounded-md border border-border p-3', !reminder.active && 'opacity-70')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{reminder.title}</span>
              <span className="rounded-sm border border-border px-1.5 text-xs text-muted-foreground">
                {reminder.typeLabel}
              </span>
              {/* The state as a *word*, so a dimmed row is never the only
                  signal that a reminder has stopped producing occurrences. */}
              <span className="rounded-sm border border-border px-1.5 text-xs text-muted-foreground">
                {reminder.active ? 'Active' : 'Paused'}
              </span>
            </div>
            <span className="text-sm tabular-nums whitespace-nowrap">
              {reminder.amount} {reminder.currency}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {reminder.recurrenceLabel} · from {reminder.startDate}
          </p>
          {(reminder.categoryName || reminder.accountName) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {[reminder.categoryName, reminder.accountName]
                .filter((part): part is string => Boolean(part))
                .join(' · ')}
            </p>
          )}
          {reminder.note && <p className="mt-1 text-xs text-muted-foreground">{reminder.note}</p>}
          {renderActions && <div className="mt-2 flex justify-end">{renderActions(reminder)}</div>}
        </li>
      ))}
    </ul>
  )
}
