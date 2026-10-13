import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import type { UpcomingItemDto } from '@/lib/ui/dashboard-view-model'
import { MoneyText } from '@/components/common/money-text'
import { PlanningRow } from '@/components/common/planning-row'
import { OccurrenceList } from '@/components/reminders/occurrence-list'

/**
 * The dashboard's upcoming list: reminder occurrences and debt/loan due dates
 * in one date order. A reminder keeps its own row (`OccurrenceList`); a debt or
 * loan is a read-only row linking to its page — nothing here records anything.
 */
export async function UpcomingList({
  items,
  locale,
  timeZone,
}: {
  items: UpcomingItemDto[]
  locale: Locale
  timeZone: string
}) {
  const t = await getTranslations()

  return (
    <div className="divide-y divide-border">
      {items.map((item) => {
        if (item.kind === 'reminder') {
          return (
            <OccurrenceList
              key={`r-${item.occurrence.id}`}
              occurrences={[item.occurrence]}
              locale={locale}
              timeZone={timeZone}
              compact
            />
          )
        }
        const title =
          item.kind === 'loan'
            ? t('dashboard.dueLoan', { name: item.name })
            : t(
                item.direction === 'RECEIVABLE'
                  ? 'dashboard.dueReceivable'
                  : 'dashboard.duePayable',
                {
                  name: item.name,
                },
              )
        const due =
          item.daysToDue < 0
            ? 'reminders.overdue'
            : item.daysToDue === 0
              ? 'reminders.dueToday'
              : item.daysToDue === 1
                ? 'reminders.dueTomorrow'
                : 'reminders.dueInDays'
        return (
          <ul key={`${item.kind}-${item.id}`}>
            <PlanningRow
              title={
                <Link href={item.href} className="underline-offset-4 hover:underline">
                  {title}
                </Link>
              }
              figureLine={<MoneyText value={item.amount} currency={item.currency} />}
              meta={
                <span className={cn(item.overdue && 'text-negative')}>
                  {t('reminders.dueLine', {
                    due: t(due, { count: item.daysToDue }),
                    date: formatDate(item.dueDate, { locale, timeZone, style: 'date' }),
                  })}
                </span>
              }
            />
          </ul>
        )
      })}
    </div>
  )
}
