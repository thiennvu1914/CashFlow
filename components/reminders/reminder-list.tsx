import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import { recurrenceLabelKey, reminderTypeLabelKey } from '@/lib/ui/labels'
import type { ReminderDto } from '@/lib/ui/reminder-view-model'
import { MoneyText } from '@/components/common/money-text'
import { PlanningRow } from '@/components/common/planning-row'
import { StatusBadge } from '@/components/common/status-badge'

/**
 * The reminder *definitions* — the schedules, not the due instances.
 *
 * The distinction is the page's whole structure: "Sắp đến hạn" is what the
 * user has to answer, and this ("Lịch nhắc") is what will keep producing it. A
 * paused definition therefore still appears here, dimmed AND badged — a
 * reminder the user cannot see is one they cannot resume, and the Paused word
 * (not just the dimming) is what keeps the state readable in monochrome or to
 * a screen reader (spec §6.7 dark-theme expectation: dimming is never the only
 * signal).
 *
 * An async server component with no state of its own: every figure is already
 * a formatted string or plain enum from `toReminderDto`
 * (`lib/ui/reminder-view-model.ts`), so this file never touches a
 * `Prisma.Decimal` or a `Date` — neither can cross into the `ReminderToggle`
 * that `renderActions` mounts.
 *
 * No total, and no per-currency subtotal strip either (unlike `/loans` and
 * `/debts`): an expected amount is not an amount owed, so a "you have
 * 4.300.000 of reminders" figure would state a liability that does not exist.
 */
export async function ReminderList({
  reminders,
  locale,
  timeZone,
  renderActions,
}: {
  reminders: ReminderDto[]
  locale: Locale
  timeZone: string
  /** The Reminders page passes a client component rendering the row's
   *  pause/resume button. */
  renderActions?: (reminder: ReminderDto) => ReactNode
}) {
  const t = await getTranslations()

  return (
    <ul className="divide-y divide-border">
      {reminders.map((reminder) => (
        <PlanningRow
          key={reminder.id}
          title={reminder.title}
          badge={
            <>
              <StatusBadge
                label={t(reminderTypeLabelKey(reminder.type))}
                tone={reminder.type === 'INCOME' ? 'positive' : 'neutral'}
              />
              <StatusBadge
                label={t(reminder.active ? 'reminders.activeBadge' : 'reminders.pausedBadge')}
                tone={reminder.active ? 'neutral' : 'muted'}
              />
            </>
          }
          figureLine={<MoneyText value={reminder.amount} currency={reminder.currency} />}
          meta={t('reminders.definitionMeta', {
            recurrence: t(recurrenceLabelKey(reminder.frequency, reminder.interval), {
              count: reminder.interval,
            }),
            date: formatDate(reminder.startDate, { locale, timeZone, style: 'date' }),
          })}
          dim={!reminder.active}
          actions={renderActions?.(reminder)}
          extra={
            <>
              {(reminder.categoryName || reminder.accountName) && (
                <p className="text-xs/[1rem] text-muted-foreground">
                  {[reminder.categoryName, reminder.accountName]
                    .filter((part): part is string => Boolean(part))
                    .join(' · ')}
                </p>
              )}
              {reminder.note && (
                <p className="text-xs/[1rem] text-muted-foreground">{reminder.note}</p>
              )}
            </>
          }
        />
      ))}
    </ul>
  )
}
