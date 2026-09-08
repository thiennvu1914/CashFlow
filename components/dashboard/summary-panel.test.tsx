import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { SummaryPanel } from './summary-panel'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'

const LABELS = {
  'dashboard.netWorth': 'Tài sản ròng',
  'dashboard.totalBalance': 'Tổng số dư',
  'dashboard.monthlyIncome': 'Thu nhập tháng',
  'dashboard.monthlyExpense': 'Chi tiêu tháng',
  'dashboard.netIncome': 'Thu nhập ròng',
  'dashboard.netWorthNote': 'gồm phải thu, phải trả và dư nợ gốc',
}
const HINTS = { 'dashboard.fxUnavailableHint': 'Chưa có tỷ giá' }

/** The view model's order, which is what `SummaryPanel` destructures. */
const KPIS: KpiDto[] = [
  { labelKey: 'dashboard.netWorth', value: '95.600.000', negative: false },
  { labelKey: 'dashboard.totalBalance', value: '72.100.000', negative: false },
  { labelKey: 'dashboard.monthlyIncome', value: '30.000.000', negative: false },
  { labelKey: 'dashboard.monthlyExpense', value: '11.200.000', negative: false },
  { labelKey: 'dashboard.netIncome', value: '18.800.000', negative: false },
]

describe('SummaryPanel', () => {
  it('is ONE bordered surface, not five cards (spec §6.1)', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    // One card border on the panel itself; the internal separation is dividers.
    expect(html.match(/rounded-lg border border-border/g)).toHaveLength(1)
    expect(html).toContain('border-t border-border')
  })

  it('names all five figures as a definition list', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html).toContain('<dl')
    expect(html.match(/<dt/g)).toHaveLength(5)
    expect(html.match(/<dd/g)).toHaveLength(5)
    for (const label of Object.values(LABELS)) {
      if (label.includes('gồm')) continue
      expect(html).toContain(label)
    }
  })

  it('renders Net Worth as the dominant figure with its note, and Total Balance a step down', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    const netWorthBlock = html.slice(html.indexOf('Tài sản ròng'), html.indexOf('Tổng số dư'))
    expect(netWorthBlock).toContain('text-4xl')
    expect(netWorthBlock).toContain('gồm phải thu, phải trả và dư nợ gốc')
    // Total Balance is `size="md"` (22/28), below the hero and above the
    // monthly metrics' `lg` (24/30) — which is deliberate: it is a supporting
    // figure for Net Worth, not a fourth monthly metric.
    const totalBlock = html.slice(html.indexOf('Tổng số dư'), html.indexOf('Thu nhập tháng'))
    expect(totalBlock).toContain('text-[1.375rem]/[1.75rem]')
    expect(totalBlock).not.toContain('text-4xl')
  })

  it('is one grid-cols-2 grid at base width, with Net Worth spanning both columns', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html).toContain('grid grid-cols-2')
    expect(html).not.toContain('overflow-x-auto')
    expect(html).not.toContain('overflow-x-scroll')
    const netWorthCell = html.slice(0, html.indexOf('Tài sản ròng'))
    expect(netWorthCell).toContain('col-span-2')
  })

  it('orders the four non-hero cells Tổng số dư → Thu nhập ròng → Thu nhập tháng → Chi tiêu tháng at base width', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    // The DOM order is the view model's (spec §6.1's order for the three
    // monthly columns at ≥ 768); `order-*` is what re-reads it as a 2×2.
    const domOrder = [
      'Tài sản ròng',
      'Tổng số dư',
      'Thu nhập tháng',
      'Chi tiêu tháng',
      'Thu nhập ròng',
    ].map((label) => html.indexOf(label))
    expect([...domOrder].sort((a, b) => a - b)).toEqual(domOrder)

    // And the visual order comes from the `order-N` on each of the four cells.
    const orderOf = (label: string) => {
      const cellStart = html.lastIndexOf('<div class', html.indexOf(label))
      const match = /order-(\d)/.exec(html.slice(cellStart, html.indexOf(label)))
      return match ? Number(match[1]) : null
    }
    expect(orderOf('Tài sản ròng')).toBe(1)
    expect(orderOf('Tổng số dư')).toBe(2)
    expect(orderOf('Thu nhập ròng')).toBe(3)
    expect(orderOf('Thu nhập tháng')).toBe(4)
    expect(orderOf('Chi tiêu tháng')).toBe(5)
  })

  it('stacks Total Balance under Net Worth full width at 768, with the three metrics in a full-width third row', () => {
    // A deliberate deviation from the brief's original tablet composition
    // (Net Worth/Total Balance in the left half of a 6-column md grid, the
    // three metrics squeezed into the right half): that gave each metric only
    // 1/6 of a 768 px viewport, which measurably overflowed the page once a
    // `size="lg"` figure like "36.900.000 VND" had to fit in it (`scrollWidth`
    // 785 vs `innerWidth` 768, found during Task 4's browser check). Net
    // Worth and Total Balance now take the full md width and the three
    // metrics form a full-width third row instead — see the component's own
    // doc comment for the measured numbers.
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html).toContain('md:col-start-1 md:col-span-6 md:row-start-1')
    expect(html).toContain('md:col-start-1 md:col-span-6 md:row-start-2')
    expect(html.match(/md:row-start-3/g)).toHaveLength(3)
    // 9ths at xl, because 12ths cannot hold three equal cells in 8 columns —
    // the brief's original beside-hero composition, restored with `xl:`
    // overrides once there is headroom for it (2/9 of 1200 px ≈ 266 px).
    expect(html).toContain('xl:grid-cols-9')
    expect(html.match(/xl:col-span-2/g)).toHaveLength(3)
    expect(html.match(/xl:row-span-2/g)).toHaveLength(3)
  })

  it('shows an em dash and the hint only in the cells FX actually broke', () => {
    const degraded: KpiDto[] = [
      {
        labelKey: 'dashboard.netWorth',
        value: null,
        hintKey: 'dashboard.fxUnavailableHint',
        negative: false,
      },
      {
        labelKey: 'dashboard.totalBalance',
        value: null,
        hintKey: 'dashboard.fxUnavailableHint',
        negative: false,
      },
      ...KPIS.slice(2),
    ]
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={degraded} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html.match(/—/g)).toHaveLength(2)
    expect(html.match(/Chưa có tỷ giá/g)).toHaveLength(2)
    // The three monthly figures are historical and untouched by an FX outage.
    expect(html).toContain('30.000.000')
    expect(html).toContain('11.200.000')
    expect(html).toContain('18.800.000')
  })

  it('renders the flat variant as three equal cells with no dominant figure', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel
        variant="flat"
        kpis={KPIS.slice(2)}
        currency="VND"
        labels={LABELS}
        hints={HINTS}
      />,
    )
    expect(html.match(/<dt/g)).toHaveLength(3)
    expect(html).toContain('md:grid-cols-3')
    expect(html).not.toContain('text-4xl')
  })

  it("splits the flat variant's figure at lg, not sm — the 768-1023 clipping fix (fix round 1)", () => {
    // The three-column grid starts at `md` (768) and stays tight through
    // 1023, so the smaller figure must cover that whole range — a plain
    // `sm` split (the dashboard variant's own breakpoint) would already have
    // switched back to the full `kpi` size well before 768.
    const html = renderToStaticMarkup(
      <SummaryPanel
        variant="flat"
        kpis={KPIS.slice(2)}
        currency="VND"
        labels={LABELS}
        hints={HINTS}
      />,
    )
    expect(html).toContain('lg:hidden')
    expect(html).toContain('hidden lg:inline-flex')
    expect(html).not.toContain('sm:hidden')
    expect(html).not.toContain('hidden sm:inline-flex')
  })

  it('marks a negative net income without relying on the minus sign alone', () => {
    const negative: KpiDto[] = [
      ...KPIS.slice(0, 4),
      { labelKey: 'dashboard.netIncome', value: '−2.000.000', negative: true },
    ]
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={negative} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html).toContain('text-negative')
  })
})
