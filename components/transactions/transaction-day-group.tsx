/**
 * Day grouping for the ledger (spec §6.2): "rows grouped by day headers (Hôm
 * nay, Hôm qua, then a locale date)".
 *
 * A pure function over already-computed day strings, so it has a unit test and
 * knows nothing about locale, zone or React. `today`/`yesterday` are passed in
 * as `yyyy-MM-dd` in the USER's zone — never derived from `new Date()` here,
 * for the reason `lib/datetime/calendar-date.ts` gives: this module has no user,
 * and passing the day in is what makes both branches testable without freezing
 * a clock.
 *
 * Consecutive runs only. The service returns rows date-descending so a day
 * appears once, but merging non-adjacent runs would reorder a user's ledger if
 * it ever did not — and an extra header is a cosmetic surprise while a
 * reordered ledger is a wrong one.
 */
export interface DayGroup<T> {
  day: string
  kind: 'today' | 'yesterday' | 'date'
  rows: T[]
}

export function groupByDay<T>(
  rows: T[],
  dayOf: (row: T) => string,
  today: string,
  yesterday: string,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  for (const row of rows) {
    const day = dayOf(row)
    const last = groups[groups.length - 1]
    if (last && last.day === day) {
      last.rows.push(row)
      continue
    }
    groups.push({
      day,
      kind: day === today ? 'today' : day === yesterday ? 'yesterday' : 'date',
      rows: [row],
    })
  }
  return groups
}
