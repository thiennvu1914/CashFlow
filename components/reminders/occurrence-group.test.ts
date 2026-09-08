import { describe, expect, it } from 'vitest'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'
import { clusterByReminder } from './occurrence-group'

function occ(id: string, reminderId: string, dueDate: string, daysToDue: number): OccurrenceDto {
  return {
    id,
    reminderId,
    title: 'Gym membership',
    type: 'EXPENSE',
    frequency: 'WEEKLY',
    interval: 1,
    amount: '500.000',
    currency: 'VND',
    dueDate,
    daysToDue,
    overdue: daysToDue < 0,
    categoryName: null,
    accountName: null,
    status: 'PENDING',
  }
}

describe('clusterByReminder', () => {
  it('collapses repeated occurrences of one reminder into a single cluster', () => {
    const clusters = clusterByReminder([
      occ('o1', 'r1', '2026-09-11', 3),
      occ('o2', 'r1', '2026-09-18', 10),
      occ('o3', 'r1', '2026-09-25', 17),
      occ('o4', 'r1', '2026-10-02', 24),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0].next.id).toBe('o1')
    expect(clusters[0].rest.map((o) => o.id)).toEqual(['o2', 'o3', 'o4'])
  })

  it('keeps different reminders apart and preserves the input order of the firsts', () => {
    const clusters = clusterByReminder([
      occ('a1', 'r1', '2026-09-09', 1),
      occ('b1', 'r2', '2026-09-10', 2),
      occ('a2', 'r1', '2026-09-16', 8),
    ])
    expect(clusters.map((c) => c.next.id)).toEqual(['a1', 'b1'])
    expect(clusters[0].rest.map((o) => o.id)).toEqual(['a2'])
    expect(clusters[1].rest).toEqual([])
  })

  it('takes the SOONEST occurrence as the cluster’s next, whatever the input order', () => {
    // The service returns `dueAt asc`, so the first is the soonest — but a
    // caller that ever sorted differently must not end up offering
    // Acknowledge on next month's instance.
    const clusters = clusterByReminder([
      occ('o2', 'r1', '2026-09-18', 10),
      occ('o1', 'r1', '2026-09-11', 3),
    ])
    expect(clusters[0].next.id).toBe('o1')
    expect(clusters[0].rest.map((o) => o.id)).toEqual(['o2'])
  })

  it('returns nothing for an empty list', () => {
    expect(clusterByReminder([])).toEqual([])
  })
})
