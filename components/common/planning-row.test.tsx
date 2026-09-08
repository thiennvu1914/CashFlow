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
})
