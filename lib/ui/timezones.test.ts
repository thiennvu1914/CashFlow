import { describe, expect, it } from 'vitest'
import { timezoneGroups } from './timezones'

describe('timezoneGroups', () => {
  it('puts the current zone first, in its own group', () => {
    const groups = timezoneGroups('Asia/Ho_Chi_Minh')
    expect(groups[0].zones).toEqual(['Asia/Ho_Chi_Minh'])
    expect(groups[0].region).toBe('current')
  })

  it('groups the rest by region, alphabetically within each', () => {
    const groups = timezoneGroups('Asia/Ho_Chi_Minh')
    const asia = groups.find((group) => group.region === 'Asia')
    expect(asia).toBeDefined()
    expect(asia!.zones).toEqual([...asia!.zones].sort())
    expect(asia!.zones).toContain('Asia/Tokyo')
    // The current zone appears once, not twice.
    expect(asia!.zones).not.toContain('Asia/Ho_Chi_Minh')
  })

  it('lists every zone exactly once across all groups', () => {
    const groups = timezoneGroups('UTC')
    const all = groups.flatMap((group) => group.zones)
    expect(new Set(all).size).toBe(all.length)
  })

  it('includes a zone the runtime does not enumerate, when it is the current one', () => {
    // `Intl.supportedValuesOf('timeZone')` omits some legacy aliases. A user
    // whose stored zone is one of them must still see it selected rather than
    // silently switched to something else on the next save.
    const groups = timezoneGroups('US/Pacific')
    expect(groups[0].zones).toEqual(['US/Pacific'])
  })

  it("keeps CashFlow's own default zone pickable even when it is NOT current", () => {
    // `Intl.supportedValuesOf('timeZone')` does not enumerate `Asia/Ho_Chi_Minh`
    // (it lists the canonical `Asia/Saigon` instead) — confirmed live. That
    // string is `USER_FIELD_DEFAULTS.timezone`, the value every new signup
    // starts with. Without special-casing it, a user who changed away from it
    // and wanted to switch back would find it had silently disappeared from
    // every group.
    const groups = timezoneGroups('Europe/London')
    const asia = groups.find((group) => group.region === 'Asia')
    expect(asia).toBeDefined()
    expect(asia!.zones).toContain('Asia/Ho_Chi_Minh')
    // Still exactly once across the whole list — not duplicated with whatever
    // the runtime itself already enumerates for that region.
    const all = groups.flatMap((group) => group.zones)
    expect(all.filter((zone) => zone === 'Asia/Ho_Chi_Minh')).toHaveLength(1)
  })
})
