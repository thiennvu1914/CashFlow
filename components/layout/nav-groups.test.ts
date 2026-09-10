import { describe, expect, it } from 'vitest'
import viNav from '@/messages/vi/nav.json'
import enNav from '@/messages/en/nav.json'
import { NAV_GROUPS } from './nav-groups'
import { MOBILE_MORE_ITEMS, MOBILE_TAB_ITEMS, NAV_ITEMS } from './nav-items'

function navKey(tree: Record<string, unknown>, key: string): unknown {
  return tree[key.replace(/^nav\./, '')]
}

describe('navigation', () => {
  it('groups every destination exactly once, in the spec’s five groups', () => {
    expect(NAV_GROUPS.map((group) => group.id)).toEqual([
      'overview',
      'money',
      'planning',
      'reports',
      'settings',
    ])
    const grouped = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href))
    expect(grouped).toHaveLength(NAV_ITEMS.length)
    expect(new Set(grouped).size).toBe(NAV_ITEMS.length)
    expect([...grouped].sort()).toEqual(NAV_ITEMS.map((item) => item.href).sort())
  })

  it('puts the money and planning modules in the spec’s order (§5)', () => {
    const byId = Object.fromEntries(
      NAV_GROUPS.map((group) => [group.id, group.items.map((i) => i.href)]),
    )
    expect(byId.overview).toEqual(['/dashboard'])
    expect(byId.money).toEqual(['/transactions', '/transfers', '/accounts', '/categories'])
    expect(byId.planning).toEqual(['/budgets', '/goals', '/debts', '/loans', '/reminders'])
    expect(byId.reports).toEqual(['/reports'])
    expect(byId.settings).toEqual(['/settings'])
  })

  it('names every item and group header with a key that exists in both locales', () => {
    const keys = [
      ...NAV_ITEMS.map((item) => item.labelKey),
      ...NAV_GROUPS.map((group) => group.headerKey),
    ]
    for (const key of keys) {
      expect(navKey(viNav, key), `vi ${key}`).toBeTypeOf('string')
      expect(navKey(enNav, key), `en ${key}`).toBeTypeOf('string')
    }
  })

  it('keeps every Vietnamese nav label within twelve characters (spec §4)', () => {
    for (const item of NAV_ITEMS) {
      const label = navKey(viNav, item.labelKey) as string
      expect(label.length, `${item.href} → "${label}"`).toBeLessThanOrEqual(12)
    }
  })

  it('shows exactly four routes in the bottom bar and the other eight behind More', () => {
    expect(MOBILE_TAB_ITEMS.map((item) => item.href)).toEqual([
      '/dashboard',
      '/transactions',
      '/accounts',
      '/reports',
    ])
    expect(MOBILE_MORE_ITEMS).toHaveLength(NAV_ITEMS.length - 4)
    expect(MOBILE_MORE_ITEMS.map((item) => item.href)).not.toContain('/dashboard')
  })
})
