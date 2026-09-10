import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { PageHeader } from './page-header'
import { SectionHeader } from './section-header'

describe('PageHeader', () => {
  it('renders exactly one h1', () => {
    const html = renderToStaticMarkup(<PageHeader title="Tổng quan" description="Tháng 9 2026" />)
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Tổng quan')
    expect(html).toContain('Tháng 9 2026')
  })

  it('omits the description, meta and action slots when unused', () => {
    const html = renderToStaticMarkup(<PageHeader title="Cài đặt" />)
    expect(html.match(/<p/g)).toBeNull()
    expect(html).not.toContain('undefined')
  })
})

describe('SectionHeader', () => {
  it('renders an h2 by default and an h3 on request', () => {
    expect(renderToStaticMarkup(<SectionHeader title="Ngân sách" />)).toContain('<h2')
    expect(renderToStaticMarkup(<SectionHeader title="Quá hạn" as="h3" />)).toContain('<h3')
  })
})
