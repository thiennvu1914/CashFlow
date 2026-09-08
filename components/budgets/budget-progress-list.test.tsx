import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}|${JSON.stringify(args)}` : key,
}))

import { BudgetProgressList } from './budget-progress-list'
import type { BudgetProgressDto } from '@/lib/ui/budget-view-model'

function dto(overrides: Partial<BudgetProgressDto> = {}): BudgetProgressDto {
  return {
    id: 'b1',
    categoryName: 'Ăn uống',
    scope: 'CATEGORY',
    categoryArchived: false,
    currency: 'VND',
    amount: '20.000.000',
    spent: '3.720.000',
    remaining: '16.280.000',
    over: false,
    percent: 19,
    percentLabel: '19 %',
    status: 'ok',
    editable: { amount: '20000000.00', currency: 'VND' },
    ...overrides,
  }
}

describe('BudgetProgressList', () => {
  it('renders the spec’s figure line with spent, limit, remaining and percent', async () => {
    const html = renderToStaticMarkup(await BudgetProgressList({ budgets: [dto()], locale: 'vi' }))
    expect(html).toContain('budgets.figureLine')
    expect(html).toContain('3.720.000')
    expect(html).toContain('20.000.000')
    expect(html).toContain('16.280.000')
    expect(html).toContain('19 %')
  })

  it('switches to the over-budget wording rather than a negative "remaining"', async () => {
    const html = renderToStaticMarkup(
      await BudgetProgressList({
        budgets: [
          dto({ over: true, remaining: '2.000.000', status: 'exceeded', percentLabel: '110 %' }),
        ],
        locale: 'vi',
      }),
    )
    expect(html).toContain('budgets.figureLineOver')
    expect(html).not.toContain('budgets.figureLine|')
  })

  it('maps the five status bands onto the spec’s three tones', async () => {
    const tones: Record<BudgetProgressDto['status'], string> = {
      ok: 'text-positive',
      warning_50: 'text-positive',
      warning_80: 'text-warning',
      at_100: 'text-negative',
      exceeded: 'text-negative',
    }
    for (const [status, tone] of Object.entries(tones)) {
      const html = renderToStaticMarkup(
        await BudgetProgressList({
          budgets: [dto({ status: status as BudgetProgressDto['status'] })],
          locale: 'vi',
        }),
      )
      expect(html, status).toContain(tone)
    }
  })

  it('announces the true percentage even when the bar is clamped', async () => {
    const html = renderToStaticMarkup(
      await BudgetProgressList({
        budgets: [dto({ percent: 100, percentLabel: '120 %', status: 'exceeded', over: true })],
        locale: 'vi',
      }),
    )
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuetext="120 %"')
  })

  it('labels an OVERALL budget from the enum key, never the word "Overall"', async () => {
    const html = renderToStaticMarkup(
      await BudgetProgressList({
        budgets: [dto({ scope: 'OVERALL', categoryName: null })],
        locale: 'vi',
      }),
    )
    expect(html).toContain('labels.budgetScope.OVERALL')
    expect(html).not.toContain('>Overall<')
  })

  it('gives the OVERALL row a brand rule and a distinct surface tint, never the track colour (fix round 1, finding 3)', async () => {
    const html = renderToStaticMarkup(
      await BudgetProgressList({
        budgets: [dto({ scope: 'OVERALL', categoryName: null, percent: 40 })],
        locale: 'vi',
      }),
    )
    // The row's own <li>, not the whole markup — `Progress`'s track (a
    // sibling div inside the row) legitimately uses `bg-muted` on every row,
    // so asserting against the whole HTML string would always find it there.
    const liStart = html.indexOf('<li')
    const liOpenTag = html.slice(liStart, html.indexOf('>', liStart) + 1)
    expect(liOpenTag).toContain('border-l-2')
    expect(liOpenTag).toContain('border-brand')
    expect(liOpenTag).toContain('bg-surface-2')
    // `bg-muted` is `Progress`'s own track colour — an Overall row tinted
    // with it would make a below-100 % bar invisible against its own row
    // background, which is exactly what this finding flagged.
    expect(liOpenTag).not.toContain('bg-muted')
  })
})
