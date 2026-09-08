import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { MoneyText } from './money-text'

describe('MoneyText', () => {
  it('renders the figure with tabular digits and never wraps it', () => {
    const html = renderToStaticMarkup(<MoneyText value="25.000.000" currency="VND" />)
    expect(html).toContain('25.000.000')
    expect(html).toContain('tabular-nums')
    expect(html).toContain('whitespace-nowrap')
  })

  it('puts the currency code after the figure, muted and smaller', () => {
    const html = renderToStaticMarkup(<MoneyText value="100,00" currency="USD" />)
    const figureIndex = html.indexOf('100,00')
    const codeIndex = html.indexOf('USD')
    expect(figureIndex).toBeGreaterThan(-1)
    expect(codeIndex).toBeGreaterThan(figureIndex)
    expect(html).toContain('text-muted-foreground')
  })

  it('omits the code entirely when the caller gives none', () => {
    const html = renderToStaticMarkup(<MoneyText value="1.500" />)
    expect(html).toContain('1.500')
    expect(html).not.toContain('undefined')
  })

  it('renders the sign before the figure for ledger rows', () => {
    const html = renderToStaticMarkup(<MoneyText value="200.000" sign="−" tone="negative" />)
    expect(html).toMatch(/−\s*200\.000|−200\.000/)
    expect(html).toContain('text-negative')
  })

  it('scales from meta to hero without an undefined class', () => {
    for (const size of ['meta', 'row', 'md', 'lg', 'kpi', 'hero'] as const) {
      const html = renderToStaticMarkup(<MoneyText value="1" size={size} />)
      expect(html, size).not.toContain('undefined')
    }
  })

  it('gives md and lg their own sizes, between row and kpi', () => {
    // The dashboard's summary panel puts all three in one card, so a shared
    // class here would flatten the hierarchy spec §6.1 asks for.
    const md = renderToStaticMarkup(<MoneyText value="72.100.000" size="md" />)
    const lg = renderToStaticMarkup(<MoneyText value="30.000.000" size="lg" />)
    expect(md).toContain('text-[1.375rem]/[1.75rem]')
    expect(lg).toContain('text-[1.5rem]/[1.875rem]')
    expect(md).not.toContain('text-[1.5rem]')
  })
})
