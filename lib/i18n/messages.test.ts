import { describe, expect, it } from 'vitest'
import { loadMessages, MESSAGE_DOMAINS } from './messages'

/** Every leaf key in a nested message object, as dotted paths. */
function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

function at(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree)
}

describe('message files', () => {
  it('merges every domain under its own namespace', async () => {
    const vi = await loadMessages('vi')
    expect(Object.keys(vi).sort()).toEqual([...MESSAGE_DOMAINS].sort())
    expect(at(vi, 'nav.dashboard')).toBe('Tổng quan')
    expect(at(vi, 'labels.transactionType.CASH_OUT')).toBe('Tiền ra (khác)')
  })

  it('has identical key sets in vi and en — no locale silently falls back', async () => {
    const viKeys = leafKeys(await loadMessages('vi')).sort()
    const enKeys = leafKeys(await loadMessages('en')).sort()
    expect({
      onlyVi: viKeys.filter((key) => !enKeys.includes(key)),
      onlyEn: enKeys.filter((key) => !viKeys.includes(key)),
    }).toEqual({ onlyVi: [], onlyEn: [] })
  })

  it('has no empty value anywhere — an empty string renders as a missing label', async () => {
    for (const locale of ['vi', 'en'] as const) {
      const messages = await loadMessages(locale)
      const empties = leafKeys(messages).filter((key) => at(messages, key) === '')
      expect(empties, locale).toEqual([])
    }
  })
})
