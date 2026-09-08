/**
 * The IANA zone list for the Settings picker (spec §6.9: "timezone as a native
 * select of IANA zones grouped by region, with the current value first").
 *
 * `Intl.supportedValuesOf('timeZone')` is the runtime's own list, so it needs no
 * bundled data file and cannot drift from what `Intl.DateTimeFormat` accepts —
 * which matters, because `isValidIanaTimezone` in `lib/validation/profile.ts`
 * validates against exactly that.
 *
 * The current zone is hoisted into its own leading group for two reasons: a
 * user opening the picker is looking for what they have, and the list omits some
 * legacy aliases (`US/Pacific`), so a stored value that is not in it must still
 * be selectable or the form would silently change it on the next save.
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
  const all = new Set(Intl.supportedValuesOf('timeZone'))
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
