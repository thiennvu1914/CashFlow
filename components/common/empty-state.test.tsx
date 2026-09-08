import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Wallet } from 'lucide-react'

import { EmptyState } from './empty-state'

describe('EmptyState', () => {
  it('says what is missing and offers exactly one way forward', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon={Wallet}
        title="Chưa có tài khoản"
        description="Thêm tài khoản đầu tiên để bắt đầu theo dõi."
        action={{ label: 'Đến Tài khoản', href: '/accounts' }}
      />,
    )
    expect(html).toContain('Chưa có tài khoản')
    expect(html).toContain('Thêm tài khoản đầu tiên để bắt đầu theo dõi.')
    expect(html).toContain('href="/accounts"')
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it('hides its icon from assistive technology — the title carries the meaning', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Wallet} title="Trống" />)
    expect(html).toContain('aria-hidden="true"')
  })

  it('renders without an action or a description', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Wallet} title="Trống" />)
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('undefined')
  })
})
