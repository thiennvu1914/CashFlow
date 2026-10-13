import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}|${JSON.stringify(args)}` : key,
}))

import { GoalList } from './goal-list'
import type { SavingsGoalDto, SavingsGoalEntryDto } from '@/lib/ui/savings-goal-view-model'

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
    percentLabel: '42 %',
    deadline: '2026-12-31',
    deadlinePassed: false,
    daysToDeadline: 114,
    linkedAccount: null,
    entries: [],
    editable: {
      name: 'MacBook',
      targetAmount: '50000000.00',
      currency: 'VND',
      deadline: '2026-12-31',
      note: '',
      linkedAccountId: '',
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
    expect(html).toContain('42 %')
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

  it('omits the meta line entirely once a goal is ACHIEVED — the badge alone says so (fix round 1, finding 10)', async () => {
    const html = renderToStaticMarkup(
      await GoalList({
        goals: [dto({ status: 'ACHIEVED', daysToDeadline: 30, deadline: '2026-12-31' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('labels.goalStatus.ACHIEVED')
    // No "goals.achieved" meta any more — repeating the badge's own word right
    // below it was a pointless duplicate now that the badge alone says so.
    expect(html).not.toContain('goals.achieved')
    expect(html).not.toContain('goals.deadlineMeta')
    expect(html).not.toContain('goals.deadlineToday')
  })

  it('gives a deadline exactly today its own wording, not "Còn 0 ngày" (fix round 1, finding 10)', async () => {
    const html = renderToStaticMarkup(
      await GoalList({
        goals: [
          dto({
            status: 'ACTIVE',
            daysToDeadline: 0,
            deadline: '2026-09-09',
            deadlinePassed: false,
          }),
        ],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('goals.deadlineToday')
    expect(html).not.toContain('goals.deadlineMeta')
  })

  it('announces the true percentage even when the bar is clamped', async () => {
    const html = renderToStaticMarkup(
      await GoalList({
        goals: [dto({ percent: 100, percentLabel: '120 %' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuetext="120 %"')
  })

  it('labels a linked goal as automatic and warns when its account is archived', async () => {
    const linked = async (archived: boolean) =>
      renderToStaticMarkup(
        await GoalList({
          goals: [dto({ linkedAccount: { id: 'a1', name: 'Quỹ', archived } })],
          locale: 'vi',
          timeZone: 'Asia/Ho_Chi_Minh',
        }),
      )
    const live = await linked(false)
    expect(live).toContain('goals.automatic|')
    expect(live).toContain('Quỹ')
    expect(live).not.toContain('goals.automaticArchived')
    const archived = await linked(true)
    expect(archived).toContain('goals.automaticArchived')
    expect(archived).toContain('text-warning')
  })

  it('shows the entry history with signed amounts, and none for a linked goal', async () => {
    const entries: SavingsGoalEntryDto[] = [
      {
        id: 'e2',
        kind: 'WITHDRAWAL',
        amount: '500.000',
        amountValue: '500000.00',
        date: '2026-09-02',
        note: 'Sửa xe',
      },
      {
        id: 'e1',
        kind: 'CONTRIBUTION',
        amount: '2.000.000',
        amountValue: '2000000.00',
        date: '2026-09-01',
        note: '',
      },
    ]
    const render = async (goal: SavingsGoalDto) =>
      renderToStaticMarkup(
        await GoalList({
          goals: [goal],
          locale: 'vi',
          timeZone: 'Asia/Ho_Chi_Minh',
          renderEntryActions: (_g, entry) => <b data-entry={entry.id} />,
        }),
      )
    const html = await render(dto({ entries }))
    expect(html).toContain('goals.historySection|{&quot;count&quot;:2}')
    expect(html).toContain('goals.entryWithdrawal')
    expect(html).toContain('−')
    expect(html).toContain('500.000')
    expect(html).toContain('+')
    expect(html).toContain('Sửa xe')
    expect(html).toContain('data-entry="e1"')

    const linked = await render(
      dto({ entries, linkedAccount: { id: 'a1', name: 'Quỹ', archived: false } }),
    )
    expect(linked).not.toContain('goals.historySection')
    expect(await render(dto())).not.toContain('goals.historySection')
  })
})
