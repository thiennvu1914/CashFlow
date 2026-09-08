import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import type { ReminderType } from '@prisma/client'
import { BellRing } from 'lucide-react'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { resolveLocale } from '@/lib/i18n/config'
import { listCategories } from '@/lib/server/services/category'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import {
  listReminders,
  listUpcomingOccurrences,
  OCCURRENCE_LOOKAHEAD_DAYS,
} from '@/lib/server/services/reminder'
import { toOccurrenceDto, toReminderDto } from '@/lib/ui/reminder-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { OccurrenceActions } from '@/components/reminders/occurrence-actions'
import { OccurrenceList } from '@/components/reminders/occurrence-list'
import { ReminderCreateButton } from '@/components/reminders/reminder-create-button'
import { ReminderList } from '@/components/reminders/reminder-list'
import { ReminderToggle } from '@/components/reminders/reminder-toggle'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { SectionHeader } from '@/components/common/section-header'
import { SegmentedControl } from '@/components/common/segmented-control'

/**
 * Reminders (spec §4.7, §6.7): the bills the user has to pay and the income
 * they are waiting for, each in its own currency and never converted to
 * `User.baseCurrency` (ledger ruling R5-3).
 *
 * **Nothing on this page records a transaction.** A reminder is a note about
 * money the user expects to move; whether it actually moved is a separate fact
 * they record separately, and no automatic rule can tell the two apart — which
 * is why the subtitle says so outright rather than leaving the reader to wonder
 * whether "Ghi nhận" has filed an expense somewhere. Acknowledging or
 * dismissing an occurrence changes that occurrence's status and nothing else
 * (directive M).
 *
 * There is no cron in this project. `listUpcomingOccurrences` is what
 * materializes the rows — one materializing read per page load, which is why it
 * is called once here and its result reused for both groups below rather than
 * queried twice.
 *
 * The list it returns is deliberately **unbounded**: a PENDING occurrence from
 * three months ago is a bill the user never answered, and dropping it because
 * it is old would be the app quietly forgetting it on their behalf. So the page
 * groups rather than truncates — overdue first, under a count line, then what
 * is coming — and nothing is ever hidden behind a "show more" other than the
 * per-reminder collapse `OccurrenceList` draws (spec §6.7).
 *
 * ## Two tabs, not one (spec §6.7, this task)
 *
 * "Sắp đến hạn" (occurrences — what the user has to answer) and "Lịch nhắc"
 * (definitions — the schedules that keep producing them) used to be two
 * sections of one page under a single filter. That folded two independent
 * choices into one: which LIST is showing, and which TYPE to filter it by. Two
 * URL parameters now say so explicitly — see the doc comment below.
 */

/**
 * Two independent URL parameters, because they are two independent choices
 * (spec §6.7): `view` picks the tab — what is due, or what is scheduled — and
 * `type` is a secondary filter INSIDE the due tab. Folding them into one
 * `?tab=` (as this page used to) made "Bills" a peer of "Due", which is why
 * the filter appeared to apply to the definitions list too.
 *
 * Both live in the URL rather than client state for the same reason as before:
 * a filtered Reminders page is then bookmarkable, shareable and reloadable,
 * and it works before (and without) JavaScript.
 */
const VIEWS = ['due', 'schedule'] as const
type View = (typeof VIEWS)[number]
const TYPE_FILTERS = ['all', 'bills', 'income'] as const
type TypeFilter = (typeof TYPE_FILTERS)[number]
const FILTER_TYPE: Record<TypeFilter, ReminderType | null> = {
  all: null,
  bills: 'EXPENSE',
  income: 'INCOME',
}

/**
 * A malformed value falls back to the safe default rather than rendering an
 * empty page: a typo, a stale link, or a repeated query key (which arrives as
 * `string[]`, not `string`) means the user has not chosen anything, and
 * showing them everything is the answer that is never wrong. The same
 * convention as `app/(app)/budgets/page.tsx`'s month.
 */
function resolveView(raw: string | string[] | undefined): View {
  return VIEWS.includes(raw as View) ? (raw as View) : 'due'
}
function resolveTypeFilter(raw: string | string[] | undefined): TypeFilter {
  return TYPE_FILTERS.includes(raw as TypeFilter) ? (raw as TypeFilter) : 'all'
}

/**
 * What the "Sắp đến hạn" tab says when it has nothing to show (ruling R6-20).
 *
 * Two different facts, so two different sentences. With nothing pending at all
 * the page can say so outright. But an empty list *under a filter* means
 * "nothing of this kind" — bills can sit overdue while `?type=income` is
 * showing — and the unfiltered sentence would then be a claim the user
 * disproves by clicking All. An empty state has to say what the filter is
 * hiding, not that there is nothing.
 *
 * `anyPending` is taken from the UNFILTERED service result, which is what makes
 * the distinction possible at all. The `all` filter only ever reaches the first
 * branch: its filtered list *is* the unfiltered one, so an empty one means
 * both are.
 */
function dueEmptyKey(filter: TypeFilter, anyPending: boolean): string {
  if (!anyPending) return 'reminders.emptyDueTitle'
  return filter === 'income' ? 'reminders.emptyDueIncome' : 'reminders.emptyDueBills'
}

/**
 * The same distinction for the "Lịch nhắc" tab. "Chưa có nhắc nhở" points at
 * the header's create action, which is the right answer for a user who has
 * none; it is the wrong answer for a user with three income reminders looking
 * at the Bills filter, who has plenty and is one click from seeing them.
 */
function scheduleEmptyKey(filter: TypeFilter, anyReminders: boolean): string {
  if (!anyReminders) return 'reminders.emptyDefinitionsTitle'
  return filter === 'income'
    ? 'reminders.emptyDefinitionsIncome'
    : 'reminders.emptyDefinitionsBills'
}

export default async function RemindersPage({
  searchParams,
}: {
  // Query parameters as Next delivers them — untrusted, and never cast: a
  // repeated query key arrives as `string[]`, not `string` (see the same
  // convention in `app/(app)/budgets/page.tsx`).
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` — never anything from the
  // query string — scopes every query below.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  const t = await getTranslations()
  const locale = await resolveLocale()
  // One `now` for the whole render, so materialization and the due wording
  // cannot straddle midnight. `today` is the user's own calendar day: whether
  // an occurrence is overdue is a comparison of calendar dates in *their*
  // zone, never of instants in the server's (ruling R6-7). The same `today`
  // seeds the form's start date, so "today" means one thing on this page.
  const now = new Date()
  const today = todayCalendarDateInZone(timezone, now)

  const params = await searchParams
  const view = resolveView(params.view)
  const filter = resolveTypeFilter(params.type)
  const filterType = FILTER_TYPE[filter]

  const [occurrenceRows, reminderRows, expenseCategories, incomeCategories, accounts] =
    await Promise.all([
      // The one materializing read on this page.
      listUpcomingOccurrences(user.id, timezone, now),
      listReminders(user.id),
      listCategories(user.id, 'EXPENSE'),
      listCategories(user.id, 'INCOME'),
      listActiveFinancialAccounts(user.id),
    ])

  // The only place a `Decimal` or a `Date` becomes a string on this page. Every
  // component below renders DTOs. Filtered before mapping, so the filter does
  // no formatting work for rows it is about to drop.
  const occurrences = occurrenceRows
    .filter((row) => filterType === null || row.reminder.type === filterType)
    .map((row) => toOccurrenceDto(row, timezone, today, locale))
  // Both halves keep the service's `dueAt asc` order, so the oldest unanswered
  // bill is at the top of the overdue group and the next thing to do is at the
  // top of the upcoming one.
  const overdue = occurrences.filter((occurrence) => occurrence.overdue)
  const upcoming = occurrences.filter((occurrence) => !occurrence.overdue)

  const reminders = reminderRows
    .filter((row) => filterType === null || row.type === filterType)
    .map((row) => toReminderDto(row, timezone, locale))

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-6 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('reminders.title')}
        description={t('reminders.description')}
        actions={
          <ReminderCreateButton
            today={today}
            locale={locale}
            // Projected to the two fields the selects render. A whole
            // `FinancialAccount` row would ship its `initialBalance` — a
            // `Prisma.Decimal` — into a client component, and a whole
            // `Category` its `userId` and `status`.
            expenseCategories={expenseCategories.map((c) => ({ id: c.id, name: c.name }))}
            incomeCategories={incomeCategories.map((c) => ({ id: c.id, name: c.name }))}
            accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          />
        }
      />

      <SegmentedControl
        label={t('reminders.tabs')}
        activeId={view}
        segments={[
          { id: 'due', label: t('reminders.tabDue'), href: `/reminders?view=due&type=${filter}` },
          {
            id: 'schedule',
            label: t('reminders.tabDefinitions'),
            href: `/reminders?view=schedule&type=${filter}`,
          },
        ]}
      />

      {/* The type filter is SECONDARY (spec §6.7), so it is a scrollable chip
          row rather than a second segmented control competing with the tabs
          above — and spec §7 permits horizontal scrolling for exactly this and
          forbids it for core metrics. */}
      <nav aria-label={t('reminders.filter')} className="-mx-1 flex gap-1 overflow-x-auto px-1">
        {TYPE_FILTERS.map((id) => (
          <Link
            key={id}
            href={`/reminders?view=${view}&type=${id}`}
            aria-current={filter === id ? 'page' : undefined}
            className={cn(
              'rounded-full px-3 py-1.5 text-[0.8125rem]/[1.125rem] whitespace-nowrap',
              filter === id
                ? 'bg-muted font-medium text-brand'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t(
              id === 'all'
                ? 'reminders.filterAll'
                : id === 'bills'
                  ? 'reminders.filterBills'
                  : 'reminders.filterIncome',
            )}
          </Link>
        ))}
      </nav>

      {view === 'due' ? (
        overdue.length === 0 && upcoming.length === 0 ? (
          <EmptyState
            icon={BellRing}
            size="page"
            // `occurrenceRows`, not `occurrences`: the UNFILTERED list is what
            // decides whether "nothing is due" is true or is just this filter.
            title={t(dueEmptyKey(filter, occurrenceRows.length > 0), {
              days: OCCURRENCE_LOOKAHEAD_DAYS,
            })}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {overdue.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionHeader
                  as="h3"
                  title={t('reminders.groupOverdue')}
                  right={
                    // A muted count rather than a banner: the list can be long
                    // (nothing prunes an unanswered bill) and the user needs to
                    // know how much of it there is without being shouted at.
                    <span className="text-xs/[1rem] text-negative tabular-nums">
                      {t('reminders.overdueCount', { count: overdue.length })}
                    </span>
                  }
                />
                <div className="overflow-hidden rounded-lg border border-border bg-surface">
                  <OccurrenceList
                    occurrences={overdue}
                    locale={locale}
                    timeZone={timezone}
                    collapse
                    renderActions={(occurrence) => <OccurrenceActions occurrence={occurrence} />}
                  />
                </div>
              </section>
            )}
            {upcoming.length > 0 && (
              <section className="flex flex-col gap-2">
                {/* `h2`, not `h3` (an intentional departure from the brief's
                    literal snippet, per the binding a11y acceptance criterion
                    "each group is an h2, the Overdue sub-group an h3"): the
                    heading hierarchy is h1 → h2 "Sắp tới" → h3 "Quá hạn", so
                    Upcoming — the ordinary group — keeps `SectionHeader`'s own
                    default rather than being demoted to the Overdue group's
                    level. */}
                <SectionHeader title={t('reminders.groupUpcoming')} />
                <div className="overflow-hidden rounded-lg border border-border bg-surface">
                  <OccurrenceList
                    occurrences={upcoming}
                    locale={locale}
                    timeZone={timezone}
                    collapse
                    renderActions={(occurrence) => <OccurrenceActions occurrence={occurrence} />}
                  />
                </div>
              </section>
            )}
          </div>
        )
      ) : reminders.length === 0 ? (
        <EmptyState
          icon={BellRing}
          size="page"
          // `reminderRows`, not `reminders`: a user with income reminders on
          // the Bills filter HAS reminders and must not be told they have none.
          title={t(scheduleEmptyKey(filter, reminderRows.length > 0))}
          description={reminderRows.length === 0 ? t('reminders.emptyDefinitionsBody') : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <ReminderList
            reminders={reminders}
            locale={locale}
            timeZone={timezone}
            renderActions={(reminder) => <ReminderToggle reminder={reminder} />}
          />
        </div>
      )}
    </div>
  )
}
