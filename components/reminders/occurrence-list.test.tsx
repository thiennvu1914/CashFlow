import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// `k=v` pairs rather than `JSON.stringify(args)`: this component nests one
// translated string inside another (`reminders.dueLine`'s `due` argument IS
// `t(dueKey(next), …)`'s own result), and JSON-stringifying a value that
// already contains quotes backslash-escapes them — asserting against that
// doubly-escaped shape would make every case here fragile for no reason.
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args
      ? `${key}(${Object.entries(args)
          .map(([k, v]) => `${k}=${v}`)
          .join(',')})`
      : key,
}))

import { OccurrenceList } from './occurrence-list'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'

function dto(overrides: Partial<OccurrenceDto> = {}): OccurrenceDto {
  return {
    id: 'o1',
    reminderId: 'r1',
    title: 'Gym membership',
    type: 'EXPENSE',
    frequency: 'WEEKLY',
    interval: 1,
    amount: '500.000',
    currency: 'VND',
    dueDate: '2026-09-11',
    daysToDue: 3,
    overdue: false,
    categoryName: null,
    accountName: null,
    status: 'PENDING',
    ...overrides,
  }
}

describe('OccurrenceList', () => {
  it('collapses four occurrences of one reminder into exactly one row carrying reminders.morePeriods {count:3}', async () => {
    const occurrences = [
      dto({ id: 'o1', dueDate: '2026-09-11', daysToDue: 3 }),
      dto({ id: 'o2', dueDate: '2026-09-18', daysToDue: 10 }),
      dto({ id: 'o3', dueDate: '2026-09-25', daysToDue: 17 }),
      dto({ id: 'o4', dueDate: '2026-10-02', daysToDue: 24 }),
    ]
    const html = renderToStaticMarkup(
      await OccurrenceList({
        occurrences,
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
        collapse: true,
      }),
    )

    // Counted by `PlanningRow`'s own outer class, not a bare `<li` — the
    // disclosure's three remaining periods are themselves `<li>`s nested
    // inside this one row's `extra` slot, and a bare count would see four.
    expect((html.match(/<li class="relative flex flex-col/g) ?? []).length).toBe(1)
    expect(html).toContain('reminders.morePeriods(count=3)')
  })

  it('without collapse, renders four rows and no morePeriods badge', async () => {
    const occurrences = [
      dto({ id: 'o1', dueDate: '2026-09-11', daysToDue: 3 }),
      dto({ id: 'o2', dueDate: '2026-09-18', daysToDue: 10 }),
      dto({ id: 'o3', dueDate: '2026-09-25', daysToDue: 17 }),
      dto({ id: 'o4', dueDate: '2026-10-02', daysToDue: 24 }),
    ]
    const html = renderToStaticMarkup(
      await OccurrenceList({
        occurrences,
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
        collapse: false,
      }),
    )

    expect((html.match(/<li/g) ?? []).length).toBe(4)
    expect(html).not.toContain('reminders.morePeriods')
  })

  it('uses reminders.overdue with text-negative for an overdue occurrence', async () => {
    const html = renderToStaticMarkup(
      await OccurrenceList({
        occurrences: [dto({ daysToDue: -2, overdue: true })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )

    expect(html).toContain('reminders.overdue(count=-2)')
    expect(html).toContain('text-negative')
  })

  it('picks dueTomorrow at daysToDue 1 and dueInDays {count:5} at daysToDue 5', async () => {
    const tomorrowHtml = renderToStaticMarkup(
      await OccurrenceList({
        occurrences: [dto({ daysToDue: 1, overdue: false })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(tomorrowHtml).toContain('reminders.dueTomorrow(count=1)')

    const inDaysHtml = renderToStaticMarkup(
      await OccurrenceList({
        occurrences: [dto({ daysToDue: 5, overdue: false })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(inDaysHtml).toContain('reminders.dueInDays(count=5)')
  })
})
