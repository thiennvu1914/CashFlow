import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { StatusBadge } from './status-badge'

describe('StatusBadge', () => {
  it('always renders the label as text, so tone is never the only signal', () => {
    const html = renderToStaticMarkup(<StatusBadge label="Quá hạn" tone="negative" />)
    expect(html).toContain('Quá hạn')
  })

  it('tints the background rather than filling it', () => {
    const html = renderToStaticMarkup(<StatusBadge label="Đạt mục tiêu" tone="positive" />)
    expect(html).toContain('bg-positive/10')
    expect(html).not.toContain('bg-positive ')
  })

  it('puts the ON-TINT text token on a tinted tone, not the tone itself', () => {
    // `text-positive` on `bg-positive/10` measured 4.30:1 in light and 3.28:1
    // in dark — under the 4.5:1 text minimum (Task 16, F6). The assertion has
    // to be the exact class: `toContain('text-positive')` passes either way,
    // because `text-positive-on-tint` contains it.
    for (const tone of ['positive', 'warning', 'negative', 'brand'] as const) {
      const html = renderToStaticMarkup(<StatusBadge label={tone} tone={tone} />)
      expect(html, tone).toContain(`text-${tone}-on-tint`)
      expect(html, tone).not.toMatch(new RegExp(`text-${tone}[ "]`))
    }
  })

  it('defaults to the neutral tone', () => {
    const html = renderToStaticMarkup(<StatusBadge label="Đang thực hiện" />)
    expect(html).toContain('text-muted-foreground')
  })

  it('renders every tone without falling through to undefined classes', () => {
    for (const tone of ['neutral', 'positive', 'warning', 'negative', 'brand', 'muted'] as const) {
      const html = renderToStaticMarkup(<StatusBadge label={tone} tone={tone} />)
      expect(html, tone).not.toContain('undefined')
    }
  })
})
