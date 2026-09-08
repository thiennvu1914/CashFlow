/**
 * The locale constants, with NO server-only import — so a client component
 * (`TransactionList`, every form) can reach `Locale`/`INTL_LOCALE` without
 * dragging `next/headers` into the browser bundle, which is a build error.
 *
 * `lib/i18n/config.ts` re-exports all of this and adds `resolveLocale`, which
 * is the server-only half. Server code may import from either; client code
 * imports from here.
 */
export const SUPPORTED_LOCALES = ['vi', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'vi'
export const LOCALE_COOKIE = 'NEXT_LOCALE'

/**
 * The BCP-47 tag every `Intl` formatter gets. Separate from the app locale
 * because `'vi'` alone leaves the region to the runtime, and grouping is a
 * regional convention — `vi-VN` is what produces `25.000.000`, `en-US` what
 * produces `25,000,000` (spec §14, open decision 1: follow the locale).
 */
export const INTL_LOCALE: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' }

export function isSupportedLocale(value: string | undefined): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
