import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'

/**
 * One row per REMINDER, not per occurrence (spec §6.7).
 *
 * A weekly gym membership inside a 30-day window materializes four
 * occurrences, and listing all four gave a page of identical rows in which the
 * one the user could act on was indistinguishable from the three they could
 * not usefully act on yet. So the soonest becomes the row — with Acknowledge
 * and Dismiss acting on IT — and the rest sit behind "+3 kỳ".
 *
 * Nothing is hidden: the disclosure lists every remaining occurrence with its
 * own actions. The list this operates on is deliberately unbounded (a PENDING
 * occurrence from three months ago is a bill the user never answered, and
 * dropping it because it is old would be the app forgetting it on their
 * behalf), and collapsing is the only way that stays readable.
 *
 * `next` is the soonest by `dueDate`, not the first in the input: the service
 * returns `dueAt asc` so the two agree today, but offering "Acknowledge" on
 * next month's instance because a caller sorted differently would record the
 * wrong answer against the wrong period.
 */
export interface OccurrenceCluster {
  /** The next (soonest) occurrence — the one the row's actions act on. */
  next: OccurrenceDto
  /** The remaining occurrences of the SAME reminder, in `dueAt asc` order. */
  rest: OccurrenceDto[]
}

export function clusterByReminder(occurrences: OccurrenceDto[]): OccurrenceCluster[] {
  const byReminder = new Map<string, OccurrenceDto[]>()
  // Insertion order of the FIRST sighting decides the cluster order, so the
  // page's `dueAt asc` grouping survives: `Map` iterates in insertion order.
  for (const occurrence of occurrences) {
    const existing = byReminder.get(occurrence.reminderId)
    if (existing) existing.push(occurrence)
    else byReminder.set(occurrence.reminderId, [occurrence])
  }
  return [...byReminder.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    const [next, ...rest] = sorted
    return { next, rest }
  })
}
