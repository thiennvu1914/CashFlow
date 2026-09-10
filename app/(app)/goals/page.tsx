import { getTranslations } from 'next-intl/server'
import { PiggyBank } from 'lucide-react'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { resolveLocale } from '@/lib/i18n/config'
import { listAllSavingsGoals } from '@/lib/server/services/savings-goal'
import { toSavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { GoalCreateButton } from '@/components/goals/goal-create-button'
import { GoalList } from '@/components/goals/goal-list'
import { GoalProgressButton, GoalRowMenu } from '@/components/goals/goal-row-actions'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'

/**
 * Savings (spec §4.8): manual targets, each in its own currency and never
 * converted to `User.baseCurrency` (ledger ruling R5-3).
 *
 * Nothing on this page moves money. A goal's progress is a figure the user
 * types in, so creating, editing, progressing or archiving a goal writes no
 * Transaction, no Transfer and no account balance — which is why the subtitle
 * says so outright rather than leaving the reader to wonder whether "saved
 * 20.000.000" has been taken out of an account somewhere.
 *
 * One query, not two: `listAllSavingsGoals` already returns every status, and
 * the archived section needs it anyway, so the split happens in memory. The
 * non-archived half is then re-ordered to `listSavingsGoals`' display order —
 * in-progress goals before achieved ones — because that ordering is the
 * service's statement about what the page should show first, and the archived
 * history stays in the order things happened.
 */

/**
 * In-progress before achieved — the rest of `listSavingsGoals`' order comes
 * free: the query already returns `(createdAt, id)`, which is a total order,
 * and `Array#sort` is stable per spec, so ranking on status alone leaves
 * same-status goals oldest-first exactly as the service would.
 */
const STATUS_RANK = { ACTIVE: 0, ACHIEVED: 1, ARCHIVED: 2 } as const

export default async function GoalsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` scopes the only query below.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  const t = await getTranslations()
  const locale = await resolveLocale()
  // The one place the user's zone enters: whether a deadline has passed is a
  // comparison of calendar dates, never of instants (ruling R6-7).
  const today = todayCalendarDateInZone(timezone, new Date())

  const goals = await listAllSavingsGoals(user.id)

  // The only place a `Decimal` or a `Date` becomes a string on this page. Every
  // component below renders `SavingsGoalDto`s.
  const dtos = goals.map((goal) => toSavingsGoalDto(goal, today, locale))
  const active = dtos
    .filter((dto) => dto.status !== 'ARCHIVED')
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
  const archived = dtos.filter((dto) => dto.status === 'ARCHIVED')

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('goals.title')}
        description={t('goals.description')}
        actions={<GoalCreateButton />}
      />

      {active.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          size="page"
          title={t('goals.emptyTitle')}
          description={t('goals.emptyBody')}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <GoalList
            goals={active}
            locale={locale}
            timeZone={timezone}
            renderActions={(goal) => ({
              actions: <GoalRowMenu goal={goal} />,
              inlineAction: <GoalProgressButton goal={goal} />,
            })}
          />
        </div>
      )}

      {archived.length > 0 && (
        <details className="rounded-lg border border-border bg-surface">
          {/* A heading element as a `<summary>`'s label is explicit content
              model (a `<summary>` may include one `h1`-`h6` as its label), and
              it is what gives this disclosure's own section a real heading
              rather than a clickable paragraph — the same treatment
              `/debts` and `/loans` already gave their written-off and closed
              sections, brought here by Task 16's heading-outline sweep (owner
              item G1): the page had no `h2` at all, so the archived list was
              a section with no name. `inline` keeps it on the summary's own
              line, so nothing moves.
              `max-md:min-h-11` is the 44 px touch target below the icon rail
              (routed from Task 15, which measured this summary at 42 px and
              deferred it): +2 px on a phone, nothing at all from `md` up. */}
          <summary className="cursor-pointer px-4 py-3 max-md:min-h-11">
            <h2 className="inline text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
              {t('goals.archivedSection', { count: archived.length })}
            </h2>
          </summary>
          {/* Read-only, like every other archived section in this app: an
              archived goal refuses every write, so no actions are offered here. */}
          <div className="border-t border-border opacity-70">
            <GoalList goals={archived} locale={locale} timeZone={timezone} />
          </div>
        </details>
      )}
    </div>
  )
}
