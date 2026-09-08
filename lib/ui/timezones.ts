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

export function timezoneGroups(current: string): TimezoneGroup[] {
  const all = Intl.supportedValuesOf('timeZone')
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
