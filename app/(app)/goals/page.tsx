import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { listAllSavingsGoals } from '@/lib/server/services/savings-goal'
import { toSavingsGoalDto } from '@/lib/ui/savings-goal-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { GoalForm } from '@/components/goals/goal-form'
import { GoalList } from '@/components/goals/goal-list'
import { GoalRowActions } from '@/components/goals/goal-row-actions'

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
  // The one place the user's zone enters: whether a deadline has passed is a
  // comparison of calendar dates, never of instants (ruling R6-7).
  const today = todayCalendarDateInZone(timezone, new Date())

  const goals = await listAllSavingsGoals(user.id)

  // The only place a `Decimal` or a `Date` becomes a string on this page. Every
  // component below renders `SavingsGoalDto`s.
  const dtos = goals.map((goal) => toSavingsGoalDto(goal, today))
  const active = dtos
    .filter((dto) => dto.status !== 'ARCHIVED')
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
  const archived = dtos.filter((dto) => dto.status === 'ARCHIVED')

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <div>
          <h1 className="text-xl font-semibold">Savings</h1>
          <p className="text-sm text-muted-foreground">Manual targets — nothing here moves money</p>
        </div>

        {active.length === 0 ? (
          <p className="text-sm text-foreground/60">No savings goals yet — add one below.</p>
        ) : (
          <GoalList goals={active} renderActions={(goal) => <GoalRowActions goal={goal} />} />
        )}
      </div>

      <div id="new" className="scroll-mt-6">
        <h2 className="mb-3 text-lg font-semibold">Add goal</h2>
        <GoalForm />
      </div>

      {archived.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-foreground/60">
            Archived goals ({archived.length})
          </summary>
          {/* Read-only, like the archived accounts on `/accounts`: an archived
              goal refuses every write (`SavingsGoalArchivedError`), so no
              actions are offered here. */}
          <div className="mt-3 opacity-70">
            <GoalList goals={archived} />
          </div>
        </details>
      )}
    </div>
  )
}
