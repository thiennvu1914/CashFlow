/**
 * The IANA zone list for the Settings picker (spec §6.9: "timezone as a native
 * select of IANA zones grouped by region, with the current value first").
 *
 * `Intl.supportedValuesOf('timeZone')` is the runtime's own list, so it needs no
 * bundled data file and cannot drift from what `Intl.DateTimeFormat` accepts —
 * which matters, because `isValidIanaTimezone` in `lib/validation/profile.ts`
 * validates against exactly that.
 *
 * Two independent guarantees, not one, and deliberately no general alias
 * canonicalisation between them:
 *
 * 1. The CURRENT zone is always hoisted into its own leading group and always
 *    selectable, whether or not the runtime enumerates it — the list omits
 *    some legacy aliases (e.g. `US/Pacific`), so a stored value that happens to
 *    be one must still be pickable or the form would silently change it on the
 *    next save. This holds only while that value IS current; `US/Pacific`
 *    picked once and saved away from would not reappear elsewhere in the list
 *    (nothing in this app writes an arbitrary legacy alias going forward — the
 *    picker only ever offers enumerated ids plus the one exception below — so
 *    that case does not otherwise arise).
 * 2. `LEGACY_ALIASES` below is a second, narrower guarantee for exactly one
 *    string: CashFlow's own default zone, which every new signup starts with
 *    and which the runtime does not enumerate at all. That one stays listed
 *    (in its natural region group) even when it is NOT current.
 */
export interface TimezoneGroup {
  /** The region prefix of the IANA id, e.g. `'Asia'`; `'current'` for the
   *  single-entry group hoisted to the front. */
  region: string
  /** Ids in that region, alphabetical. */
  zones: string[]
}

/**
 * Legacy IANA aliases `Intl.supportedValuesOf('timeZone')` omits, but that this
 * app must keep pickable even when they are NOT the current value.
 *
 * `'Asia/Ho_Chi_Minh'` is not a hypothetical edge case: it is
 * `USER_FIELD_DEFAULTS.timezone` (`lib/auth/user-defaults.ts`), the value Better
 * Auth writes for every new signup. Without this list, `timezoneGroups` only
 * ever hoisted a legacy alias when it happened to be `current` — the moment a
 * user picked a different zone and later wanted to switch BACK, the app's own
 * default vanished from every group, because it is not one of the runtime's
 * enumerated ids. (Confirmed live: `Intl.supportedValuesOf('timeZone')` lists
 * `'Asia/Saigon'`, the canonical id, but not this alias.) Folding it into the
 * enumerated set — like any other zone, excluded only when it equals `current`
 * — fixes that for every render, not just the one where it starts out current.
 */
const LEGACY_ALIASES = ['Asia/Ho_Chi_Minh']

export function timezoneGroups(current: string): TimezoneGroup[] {
  // `Intl.supportedValuesOf` is itself a newer addition to `Intl` than
  // `Intl.DateTimeFormat` (which `isValidIanaTimezone` relies on) — guard it
  // rather than assume every runtime this ever executes on has it, and fall
  // back to just the stored zone, still selectable, rather than throwing and
  // taking the whole Settings page down with it.
  const all = new Set(
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [],
  )
  for (const alias of LEGACY_ALIASES) all.add(alias)

  const byRegion = new Map<string, string[]>()
  for (const zone of all) {
    if (zone === current) continue
    const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other'
    const existing = byRegion.get(region)
    if (existing) existing.push(zone)
    else byRegion.set(region, [zone])
  }
  return [
    { region: 'current', zones: [current] },
    ...[...byRegion.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([region, zones]) => ({ region, zones: zones.sort((a, b) => a.localeCompare(b)) })),
  ]
}
