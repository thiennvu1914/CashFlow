import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { CategoryChipList } from './category-chip-list'

const PROPS = {
  title: 'Danh mục chi',
  addLabel: 'Thêm danh mục chi',
  addPlaceholder: 'Tên mới',
  archiveLabel: 'Lưu trữ',
  onCreate: async () => {},
  onArchive: async () => {},
}

describe('CategoryChipList', () => {
  it('renders default items as quiet chips with no border and no menu', () => {
    const html = renderToStaticMarkup(
      <CategoryChipList {...PROPS} items={[{ id: 'c1', name: 'Ăn uống', isDefault: true }]} />,
    )
    const chip = html.slice(html.indexOf('Ăn uống') - 300, html.indexOf('Ăn uống'))
    expect(chip).toContain('bg-muted')
    expect(chip).not.toContain('border-border')
    expect(html).not.toContain('common.rowActions')
  })

  it('gives a custom item a border and an actions menu', () => {
    const html = renderToStaticMarkup(
      <CategoryChipList {...PROPS} items={[{ id: 'c2', name: 'Cà phê', isDefault: false }]} />,
    )
    expect(html).toContain('border-border')
    expect(html).toContain('common.rowActions')
  })

  it('gives the inline add input its own visible label naming the section', () => {
    const html = renderToStaticMarkup(<CategoryChipList {...PROPS} items={[]} />)
    expect(html).toContain('<label')
    expect(html).toContain('Thêm danh mục chi')
    expect(html).toContain('for="')
  })

  it('says a section is empty rather than showing a bare add box', () => {
    const html = renderToStaticMarkup(<CategoryChipList {...PROPS} items={[]} />)
    expect(html).toContain('categories.emptyTitle')
  })

  it('says it through the EmptyState primitive — icon, title, one sentence, no action', () => {
    // Task 17, owner item H2: this used to be a bare muted `<p>`, the one
    // empty list in the product that did not go through the shared component.
    // No `<a>`/`<button>` inside the empty state: the section's own add field
    // is the next step, two rows below.
    const html = renderToStaticMarkup(<CategoryChipList {...PROPS} items={[]} />)
    const emptyState = html.slice(0, html.indexOf('categories.emptyBody'))
    expect(emptyState).toContain('lucide-tags')
    expect(emptyState).toContain('aria-hidden="true"')
    expect(html).toContain('categories.emptyBody')
    // The add row's own button is the only button on the section.
    expect(html.match(/<button/g) ?? []).toHaveLength(1)
  })
})
