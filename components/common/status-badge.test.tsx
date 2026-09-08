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
    expect(html).toContain('text-positive')
    expect(html).not.toContain('bg-positive ')
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
