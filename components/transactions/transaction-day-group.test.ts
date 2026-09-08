import { describe, expect, it } from 'vitest'
import { groupByDay } from './transaction-day-group'

type Row = { id: string; day: string }
const dayOf = (row: Row) => row.day

describe('groupByDay', () => {
  it('groups consecutive rows of the same day and keeps the input order', () => {
    const rows: Row[] = [
      { id: 'a', day: '2026-09-08' },
      { id: 'b', day: '2026-09-08' },
      { id: 'c', day: '2026-09-07' },
      { id: 'd', day: '2026-09-05' },
    ]
    const groups = groupByDay(rows, dayOf, '2026-09-08', '2026-09-07')
    expect(groups.map((group) => group.day)).toEqual(['2026-09-08', '2026-09-07', '2026-09-05'])
    expect(groups[0].rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(groups.map((group) => group.kind)).toEqual(['today', 'yesterday', 'date'])
  })

  it('does not merge two runs of the same day that are separated in the input', () => {
    // The list arrives ordered by date desc from the service, so this cannot
    // happen — but merging would silently reorder a user's ledger if it ever
    // did, and reordering money is worse than an extra header.
    const rows: Row[] = [
      { id: 'a', day: '2026-09-08' },
      { id: 'b', day: '2026-09-07' },
      { id: 'c', day: '2026-09-08' },
    ]
    const groups = groupByDay(rows, dayOf, '2026-09-08', '2026-09-07')
    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.rows.map((row) => row.id))).toEqual([['a'], ['b'], ['c']])
  })

  it('returns nothing for an empty list', () => {
    expect(groupByDay([], dayOf, '2026-09-08', '2026-09-07')).toEqual([])
  })

  it('labels a future-dated row as a plain date, never as today', () => {
    const groups = groupByDay([{ id: 'a', day: '2026-12-31' }], dayOf, '2026-09-08', '2026-09-07')
    expect(groups[0].kind).toBe('date')
  })
})
