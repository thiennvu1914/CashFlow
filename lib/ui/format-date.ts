import { formatInTimeZone } from 'date-fns-tz'
import { INTL_LOCALE, type Locale } from '@/lib/i18n/locale'

/**
 * The one locale-aware date presenter in the UI (spec §4).
 *
 * It replaces the ad-hoc `formatInTimeZone(…, 'yyyy-MM-dd')` calls scattered
 * through the components — but ONLY in the UI. Services, the Excel export and
 * every `CalendarDate` carrier keep `yyyy-MM-dd`, because that is a data format
 * with a contract, not something a reader looks at.
 *
 * Two input shapes, and the difference matters:
 *
 *  - a `Date` is an INSTANT (a `Transaction.date`), so it is read in the user's
 *    own zone — the rule the whole codebase follows (ruling R6-7);
 *  - a `yyyy-MM-dd` string is a CALENDAR-DATE CARRIER (a due date, a deadline),
 *    which is UTC midnight by construction. Reading that in the reader's zone
 *    would show the 8th to anyone west of UTC for a date that is the 9th, so a
 *    carrier is always read in UTC.
 *
 * `Intl.DateTimeFormat`, not date-fns tokens, because the ORDER of the parts is
 * a locale decision (`09/09/2026` vs `Sep 9, 2026`) and a token string
 * hard-codes one language's order into every language.
 */
export type DateStyle = 'date' | 'dateTime' | 'monthYear' | 'weekday' | 'dayMonth'

const CARRIER_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: 'numeric', month: '2-digit', day: '2-digit' },
  dateTime: {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  },
  monthYear: { year: 'numeric', month: 'long' },
  weekday: { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' },
  dayMonth: { month: '2-digit', day: '2-digit' },
}

/**
 * English reads better with a named month at these four styles, and the
 * two-digit forms above are the Vietnamese convention — so the option set is
 * per locale, not global.
 */
const EN_OVERRIDES: Partial<Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  dateTime: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' },
  dayMonth: { month: 'short', day: 'numeric' },
}

export function formatDate(
  instantOrCarrier: Date | string,
  { locale, timeZone, style }: { locale: Locale; timeZone: string; style: DateStyle },
): string {
  const isCarrier = typeof instantOrCarrier === 'string' && CARRIER_PATTERN.test(instantOrCarrier)
  const instant = isCarrier
    ? new Date(`${instantOrCarrier}T00:00:00.000Z`)
    : new Date(instantOrCarrier)
  const options = { ...OPTIONS[style], ...(locale === 'en' ? EN_OVERRIDES[style] : undefined) }

  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    ...options,
    // A carrier is UTC midnight and means one calendar day everywhere; an
    // instant means "the moment", and which day that is depends on the reader.
    timeZone: isCarrier ? 'UTC' : timeZone,
    hourCycle: 'h23',
  }).format(instant)
}

/**
 * The `yyyy-MM-dd` a native `<input type="date">` is specified to take, for the
 * one caller that genuinely needs it — a `defaultValue`. Exported here so no
 * component reaches for `date-fns-tz` itself and accidentally localises a value
 * the browser then rejects.
 */
export function toDateInputValue(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd')
}
