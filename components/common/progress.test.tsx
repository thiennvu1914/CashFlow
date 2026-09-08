import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { Progress } from './progress'

describe('Progress', () => {
  it('clamps the bar width and aria-valuenow but announces the true figure', () => {
    const html = renderToStaticMarkup(
      <Progress percent={120} valueText="120 %" label="Overall budget" tone="negative" />,
    )
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuetext="120 %"')
    expect(html).toContain('width:100%')
  })

  it('never runs backwards', () => {
    const html = renderToStaticMarkup(<Progress percent={-5} valueText="0 %" label="x" />)
    expect(html).toContain('aria-valuenow="0"')
    expect(html).toContain('width:0%')
  })

  it('carries the full progressbar contract', () => {
    const html = renderToStaticMarkup(
      <Progress percent={42} valueText="42 %" label="Emergency fund" />,
    )
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="100"')
    expect(html).toContain('aria-label="Emergency fund"')
  })
})
