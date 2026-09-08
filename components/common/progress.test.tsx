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

  it('drops the progressbar contract entirely when decorative (fix round 1)', () => {
    // A caller like CategoryBars whose bar-width and adjacent-figure percent
    // are two DIFFERENT quantities cannot honestly state either as THE
    // progressbar value — the bar becomes a picture instead, `aria-hidden`.
    const html = renderToStaticMarkup(
      <Progress percent={42} valueText="42 %" label="Travel" decorative />,
    )
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('aria-valuenow')
    expect(html).not.toContain('aria-valuemin')
    expect(html).not.toContain('aria-valuemax')
    expect(html).not.toContain('aria-valuetext')
    expect(html).not.toContain('aria-label')
    // The clamped fill width is unaffected — only the ARIA contract changes.
    expect(html).toContain('width:42%')
  })

  it('gives the accent tone its own class, for a neutral (not good/bad) breakdown', () => {
    const html = renderToStaticMarkup(
      <Progress percent={50} valueText="50 %" label="x" tone="accent" decorative />,
    )
    expect(html).toContain('bg-accent')
  })
})
