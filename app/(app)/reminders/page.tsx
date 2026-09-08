import Link from 'next/link'
import { cn } from 'cn'
import type { ReminderType } from '@prisma/client'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
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
import { ReminderForm } from '@/components/reminders/reminder-form'
import { ReminderList } from '@/components/reminders/reminder-list'
import { ReminderToggle } from '@/components/reminders/reminder-toggle'

/**
 * Reminders (spec §4.7): the bills the user has to pay and the income they are
 * waiting for, each in its own currency and never converted to
 * `User.baseCurrency` (ledger ruling R5-3).
 *
 * **Nothing on this page records a transaction.** A reminder is a note about
 * money the user expects to move; whether it actually moved is a separate fact
 * they record separately, and no automatic rule can tell the two apart — which
 * is why the subtitle says so outright rather than leaving the reader to wonder
 * whether "Acknowledge" has filed an expense somewhere. Acknowledging or
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
 * is coming — and nothing is ever hidden behind a "show more".
 */

/**
 * The tab set, in the URL rather than in client state: a filtered Reminders
 * page is then bookmarkable, shareable and reloadable, and the filter works
 * before (and without) JavaScript — the same reasoning, and the same visual
 * treatment, as `components/reports/period-filter.tsx`.
 *
 * The tab filters the *whole* page, both the due list and the definitions
 * below it. A filter that silently applied to only half of what is on screen
 * would be a page that disagrees with its own control.
 */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'bills', label: 'Bills' },
  { id: 'income', label: 'Income' },
] as const

type Tab = (typeof TABS)[number]['id']

/** Which reminder type each tab keeps; `null` is "no filter". */
const TAB_TYPE: Record<Tab, ReminderType | null> = {
  all: null,
  bills: 'EXPENSE',
  income: 'INCOME',
}

/**
 * A malformed `tab` falls back to `all` rather than rendering an empty page:
 * anything that is not one of the three ids — a typo, a stale link, a repeated
 * `?tab=` key (which arrives as `string[]`, not `string`) — means the user has
 * not chosen a filter, and showing them everything is the answer that is never
 * wrong. The same convention as `app/(app)/budgets/page.tsx`'s month.
 */
function resolveTab(raw: string | string[] | undefined): Tab {
  return TABS.some((tab) => tab.id === raw) ? (raw as Tab) : 'all'
}

/**
 * What the "Due" section says when it has nothing to show (ruling R6-20).
 *
 * Two different facts, so two different sentences. With nothing pending at all
 * the page can say so outright. But an empty list *under a tab* means "nothing
 * of this kind" — bills can sit overdue while `?tab=income` is showing — and
 * the unfiltered sentence would then be a claim the user disproves by clicking
 * All. An empty state has to say what the tab is hiding, not that there is
 * nothing.
 *
 * `anyPending` is taken from the UNFILTERED service result, which is what makes
 * the distinction possible at all. The `all` tab only ever reaches the first
 * branch: its filtered list *is* the unfiltered one, so an empty one means
 * both are.
 */
function dueEmptyMessage(tab: Tab, anyPending: boolean): string {
  // The window comes from the service's own exported constant, so this copy and
  // what materialization actually looks ahead cannot drift apart.
  const horizon = `in the next ${OCCURRENCE_LOOKAHEAD_DAYS} days.`
  if (!anyPending) return `Nothing due ${horizon}`
  return tab === 'income' ? `No income due ${horizon}` : `No bills due ${horizon}`
}

/**
 * The same distinction for the definitions list. "No reminders yet — add one
 * below." points at the form underneath, which is the right answer for a user
 * who has none; it is the wrong answer for a user with three income reminders
 * looking at the Bills tab, who has plenty and is one click from seeing them.
 */
function remindersEmptyMessage(tab: Tab, anyReminders: boolean): string {
  if (!anyReminders) return 'No reminders yet — add one below.'
  return tab === 'income' ? 'No income reminders yet.' : 'No bills yet.'
}

export default async function RemindersPage({
  searchParams,
}: {
  // Query parameters as Next delivers them — untrusted, and never cast: a
  // repeated `?tab=` key arrives as `string[]`, not `string` (see the same
  // convention in `app/(app)/budgets/page.tsx`).
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` — never anything from the
  // query string — scopes every query below.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  // One `now` for the whole render, so materialization and the labels cannot
  // straddle midnight. `today` is the user's own calendar day: whether an
  // occurrence is overdue is a comparison of calendar dates in *their* zone,
  // never of instants in the server's (ruling R6-7). The same `today` seeds the
  // form's start date, so "today" means one thing on this page.
  const now = new Date()
  const today = todayCalendarDateInZone(timezone, now)

  const params = await searchParams
  const tab = resolveTab(params.tab)
  const filterType = TAB_TYPE[tab]

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
  // component below renders DTOs. Filtered before mapping, so the tab does no
  // formatting work for rows it is about to drop.
  const occurrences = occurrenceRows
    .filter((row) => filterType === null || row.reminder.type === filterType)
    .map((row) => toOccurrenceDto(row, timezone, today))
  // Both halves keep the service's `dueAt asc` order, so the oldest unanswered
  // bill is at the top of the overdue group and the next thing to do is at the
  // top of the upcoming one.
  const overdue = occurrences.filter((occurrence) => occurrence.overdue)
  const upcoming = occurrences.filter((occurrence) => !occurrence.overdue)

  const reminders = reminderRows
    .filter((row) => filterType === null || row.type === filterType)
    .map((row) => toReminderDto(row, timezone))

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reminders</h1>
          <p className="text-sm text-muted-foreground">
            Bills and expected income — a reminder never records a transaction for you
          </p>
        </div>

        {/* Ordinary links, so the address bar is the single source of truth for
            which tab is showing. `aria-current="page"` is what tells a screen
            reader which one that is; the rail's "you are here" treatment (a
            muted wash plus brand text) rather than a filled pill, because
            switching tab is navigation and not a call to action. */}
        <nav aria-label="Reminder type" className="flex flex-wrap gap-1">
          {TABS.map(({ id, label }) => {
            const active = tab === id
            return (
              <Link
                key={id}
                href={`/reminders?tab=${id}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-sm',
                  active
                    ? 'bg-muted font-medium text-brand'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {label}
              </Link>
            )
          })}
        </nav>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Due</h2>

        {overdue.length === 0 && upcoming.length === 0 ? (
          // `occurrenceRows`, not `occurrences`: the unfiltered list is what
          // decides whether "nothing is due" is true or is just this tab.
          <p className="text-sm text-foreground/60">
            {dueEmptyMessage(tab, occurrenceRows.length > 0)}
          </p>
        ) : (
          <>
            {overdue.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">Overdue</h3>
                  {/* A muted count rather than a banner: the list can be long
                      (nothing prunes an unanswered bill), and the user needs to
                      know how much of it there is without being shouted at. */}
                  <p className="text-xs text-muted-foreground">{overdue.length} overdue</p>
                </div>
                <OccurrenceList
                  occurrences={overdue}
                  renderActions={(occurrence) => <OccurrenceActions occurrence={occurrence} />}
                />
              </div>
            )}

            {upcoming.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Upcoming</h3>
                <OccurrenceList
                  occurrences={upcoming}
                  renderActions={(occurrence) => <OccurrenceActions occurrence={occurrence} />}
                />
              </div>
            )}
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Your reminders</h2>
        {reminders.length === 0 ? (
          // `reminderRows`, not `reminders`: a user with income reminders on the
          // Bills tab has reminders, and must not be told they have none.
          <p className="text-sm text-foreground/60">
            {remindersEmptyMessage(tab, reminderRows.length > 0)}
          </p>
        ) : (
          // Paused definitions are listed here too, dimmed and labelled: a
          // reminder the user cannot see is one they cannot resume.
          <ReminderList
            reminders={reminders}
            renderActions={(reminder) => <ReminderToggle reminder={reminder} />}
          />
        )}
      </section>

      <div id="new" className="scroll-mt-6">
        <h2 className="mb-3 text-lg font-semibold">Add reminder</h2>
        {/* Projected to the two fields the selects render. A whole
            `FinancialAccount` row would ship its `initialBalance` — a
            `Prisma.Decimal` — into a client component, and a whole `Category`
            its `userId` and `status`. */}
        <ReminderForm
          today={today}
          expenseCategories={expenseCategories.map((c) => ({ id: c.id, name: c.name }))}
          incomeCategories={incomeCategories.map((c) => ({ id: c.id, name: c.name }))}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        />
      </div>
    </div>
  )
}
