import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { PlanningRow } from './planning-row'
import { Progress } from './progress'
import { StatusBadge } from './status-badge'

describe('PlanningRow', () => {
  it('renders title, badge, figure line, progress and meta in that order', () => {
    const html = renderToStaticMarkup(
      <PlanningRow
        title="Ăn uống"
        badge={<StatusBadge label="Sắp vượt" tone="warning" />}
        figureLine="3.720.000 / 20.000.000 VND · còn 16.280.000 · 19 %"
        progress={<Progress percent={19} valueText="19 %" label="Ăn uống" tone="warning" />}
        meta="Tháng 9 2026"
      />,
    )
    const order = ['Ăn uống', 'Sắp vượt', '3.720.000', 'role="progressbar"', 'Tháng 9 2026'].map(
      (needle) => html.indexOf(needle),
    )
    expect(order.every((index) => index > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('dims an archived row without hiding it', () => {
    const html = renderToStaticMarkup(<PlanningRow title="Cũ" figureLine="0" dim />)
    expect(html).toContain('opacity-70')
    expect(html).toContain('Cũ')
  })

  it('renders inlineAction twice — once for the <sm full-width line, once beside actions from sm up', () => {
    const html = renderToStaticMarkup(
      <PlanningRow
        title="Máy ảnh"
        figureLine="0"
        inlineAction={<button type="button">Cập nhật tiến độ</button>}
        actions={<button type="button">…</button>}
      />,
    )
    const matches = html.match(/Cập nhật tiến độ/g) ?? []
    expect(matches).toHaveLength(2)
    // The mobile copy is wrapped in a `sm:hidden` element, the desktop copy in
    // a `hidden sm:inline-flex` one — asserted as classes actually present
    // rather than assuming which occurrence is which.
    expect(html).toContain('sm:hidden')
    expect(html).toContain('hidden sm:inline-flex')
  })

  it('omits both inlineAction slots when none is given', () => {
    const html = renderToStaticMarkup(<PlanningRow title="Sửa nhà" figureLine="0" />)
    expect(html).not.toContain('sm:hidden')
    expect(html).not.toContain('sm:inline-flex')
  })

  it('pins the actions cell with ml-auto rather than the container justify-content, so a lone wrapped cell is not stranded at flex-start', () => {
    const html = renderToStaticMarkup(
      <PlanningRow title="Sửa nhà" figureLine="0" actions={<button type="button">…</button>} />,
    )
    expect(html).toContain('ml-auto')
    expect(html).not.toContain('justify-between')
  })

  it('aligns the header row to the top (items-start), not centred, so a short title never floats against a taller actions cell', () => {
    const html = renderToStaticMarkup(<PlanningRow title="Sửa nhà" figureLine="0" />)
    expect(html).toContain('items-start')
  })

  it('gives the title cell a min-height matching the actions cell only when there IS an actions cell (fix round 2)', () => {
    const withActions = renderToStaticMarkup(
      <PlanningRow title="Sửa nhà" figureLine="0" actions={<button type="button">…</button>} />,
    )
    expect(withActions).toContain('min-h-11')
    expect(withActions).toContain('md:min-h-9')

    // No actions and no inlineAction — an archived/read-only row keeps its
    // pre-fix-round-1 compactness rather than being inflated to match a
    // button height it does not have.
    const withoutActions = renderToStaticMarkup(<PlanningRow title="Sửa nhà" figureLine="0" />)
    expect(withoutActions).not.toContain('min-h-11')
    expect(withoutActions).not.toContain('min-h-9')
  })

  it('restores gap-1 on the actions cell (fix round 2 — round 1 had drifted it to gap-2)', () => {
    const html = renderToStaticMarkup(
      <PlanningRow
        title="Sửa nhà"
        figureLine="0"
        inlineAction={<button type="button">Cập nhật tiến độ</button>}
        actions={<button type="button">…</button>}
      />,
    )
    const actionsCellMatch = html.match(/<div class="ml-auto flex shrink-0 items-center gap-\d">/)
    expect(actionsCellMatch?.[0]).toContain('gap-1')
  })
})
