import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}|${JSON.stringify(args)}` : key,
}))

import { GoalList } from './goal-list'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'

function dto(overrides: Partial<SavingsGoalDto> = {}): SavingsGoalDto {
  return {
    id: 'g1',
    name: 'MacBook',
    currency: 'VND',
    status: 'ACTIVE',
    target: '50.000.000',
    progress: '20.000.000',
    remaining: '30.000.000',
    percent: 42,
    percentLabel: '42 %',
    deadline: '2026-12-31',
    deadlinePassed: false,
    daysToDeadline: 114,
    editable: {
      name: 'MacBook',
      targetAmount: '50000000.00',
      currency: 'VND',
      deadline: '2026-12-31',
      note: '',
      currentProgress: '20000000.00',
    },
    ...overrides,
  }
}

describe('GoalList', () => {
  it('renders the figure line with progress, target and percent', async () => {
    const html = renderToStaticMarkup(
      await GoalList({ goals: [dto()], locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' }),
    )
    expect(html).toContain('goals.figureLine')
    expect(html).toContain('20.000.000')
    expect(html).toContain('50.000.000')
    expect(html).toContain('42 %')
  })

  it('keeps the bar bg-brand at every status, including ACHIEVED', async () => {
    for (const status of ['ACTIVE', 'ACHIEVED', 'ARCHIVED'] as const) {
      const html = renderToStaticMarkup(
        await GoalList({
          goals: [dto({ status })],
          locale: 'vi',
          timeZone: 'Asia/Ho_Chi_Minh',
        }),
      )
      expect(html, status).toContain('bg-brand')
      expect(html, status).not.toContain('bg-warning')
      expect(html, status).not.toContain('bg-negative')
    }
  })

  it('renders the deadline meta with the day count as a plain number', async () => {
    const html = renderToStaticMarkup(
      await GoalList({
        goals: [dto({ daysToDeadline: 114, deadline: '2026-12-31' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('goals.deadlineMeta')
    expect(html).toContain('&quot;count&quot;:114')
  })

  it('renders the passed-deadline meta in warning when the deadline has passed', async () => {
    const html = renderToStaticMarkup(
      await GoalList({
        goals: [dto({ deadlinePassed: true, daysToDeadline: -5 })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('goals.deadlinePassed')
    expect(html).toContain('text-warning')
  })

  it('shows "achieved" rather than a deadline meta once a goal is ACHIEVED', async () => {
    const html = renderToStaticMarkup(
      await GoalList({
        goals: [dto({ status: 'ACHIEVED', daysToDeadline: 30, deadline: '2026-12-31' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('labels.goalStatus.ACHIEVED')
    expect(html).toContain('goals.achieved')
    expect(html).not.toContain('goals.deadlineMeta')
  })

  it('announces the true percentage even when the bar is clamped', async () => {
    const html = renderToStaticMarkup(
      await GoalList({
        goals: [dto({ percent: 100, percentLabel: '120 %' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuetext="120 %"')
  })
})
