import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}|${JSON.stringify(args)}` : key,
}))

import { DebtList } from './debt-list'
import type { DebtDto } from '@/lib/ui/debt-view-model'

function dto(overrides: Partial<DebtDto> = {}): DebtDto {
  return {
    id: 'd1',
    person: 'Minh',
    direction: 'RECEIVABLE',
    currency: 'VND',
    original: '1.000.000',
    paid: '400.000',
    outstanding: '600.000',
    percentPaid: 40,
    percentLabel: '40 %',
    status: 'PARTIALLY_PAID',
    active: true,
    dueDate: '2026-04-15',
    description: 'Lunch money',
    notes: 'Pay back after payday',
    payments: [{ id: 'p1', date: '2026-03-02', amount: '400.000', note: null }],
    editable: { person: 'Minh', description: '', dueDate: '', notes: '' },
    ...overrides,
  }
}

describe('DebtList', () => {
  it('renders the figure line via debts.figureLine, carrying both the outstanding and original figures', async () => {
    const html = renderToStaticMarkup(
      await DebtList({ debts: [dto()], locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' }),
    )
    expect(html).toContain('debts.figureLine')
    expect(html).toContain('&quot;outstanding&quot;:&quot;600.000&quot;')
    expect(html).toContain('&quot;original&quot;:&quot;1.000.000&quot;')
  })

  it('renders the direction from labels.debtDirection, never a hard-coded English word', async () => {
    const receivableHtml = renderToStaticMarkup(
      await DebtList({
        debts: [dto({ direction: 'RECEIVABLE' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(receivableHtml).toContain('labels.debtDirection.RECEIVABLE')
    expect(receivableHtml).not.toContain('Owes you')
    expect(receivableHtml).not.toContain('You owe')

    const payableHtml = renderToStaticMarkup(
      await DebtList({
        debts: [dto({ direction: 'PAYABLE' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(payableHtml).toContain('labels.debtDirection.PAYABLE')
    expect(payableHtml).not.toContain('Owes you')
    expect(payableHtml).not.toContain('You owe')
  })

  it('uses debts.overdueMeta with text-negative for an OVERDUE debt, and debts.dueMeta without it otherwise', async () => {
    const overdueHtml = renderToStaticMarkup(
      await DebtList({
        debts: [dto({ status: 'OVERDUE', dueDate: '2026-03-01' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(overdueHtml).toContain('debts.overdueMeta')
    expect(overdueHtml).not.toContain('debts.dueMeta|')
    expect(overdueHtml).toContain('text-negative')

    const openHtml = renderToStaticMarkup(
      await DebtList({
        debts: [dto({ status: 'OPEN', dueDate: '2026-06-01' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(openHtml).toContain('debts.dueMeta')
    expect(openHtml).not.toContain('debts.overdueMeta')
  })

  it('keeps the repayment bar bg-positive in both directions, announcing the true percentage when clamped', async () => {
    for (const direction of ['RECEIVABLE', 'PAYABLE'] as const) {
      const html = renderToStaticMarkup(
        await DebtList({
          debts: [dto({ direction, percentPaid: 100, percentLabel: '120 %' })],
          locale: 'vi',
          timeZone: 'Asia/Ho_Chi_Minh',
        }),
      )
      expect(html, direction).toContain('bg-positive')
      expect(html, direction).toContain('aria-valuenow="100"')
      expect(html, direction).toContain('aria-valuetext="120 %"')
    }
  })

  it('compact renders the person, direction and outstanding figure, and no progress/badge/description/notes/history', async () => {
    const html = renderToStaticMarkup(
      await DebtList({
        debts: [dto()],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
        compact: true,
      }),
    )
    expect(html).toContain('Minh')
    expect(html).toContain('labels.debtDirection.RECEIVABLE')
    expect(html).toContain('600.000')
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('labels.debtStatus')
    expect(html).not.toContain('Lunch money')
    expect(html).not.toContain('Pay back after payday')
    expect(html).not.toContain('debts.paymentsSection')
  })
})
