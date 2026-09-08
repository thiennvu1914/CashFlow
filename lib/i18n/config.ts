import { cookies } from 'next/headers'
import { getOptionalSession } from '@/lib/auth/require-user'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale, type Locale } from './locale'

/**
 * Which language this request renders in.
 *
 * `User.locale` is the source of truth and the `NEXT_LOCALE` cookie mirrors it,
 * so a pre-auth page still renders in the language the user chose last time on
 * this browser. Phase 7 adds the session lookup: until now a saved preference
 * was stored and then ignored, which is the gap the spec calls out (§4).
 *
 * The session lookup is `getOptionalSession`, which is `cache`d per request, so
 * asking here and again in the page costs one query.
 */
export * from './locale'

export async function resolveLocale(): Promise<Locale> {
  const session = await getOptionalSession()
  const userLocale = (session?.user as { locale?: string } | undefined)?.locale
  if (isSupportedLocale(userLocale)) return userLocale

  const store = await cookies()
  const cookieLocale = store.get(LOCALE_COOKIE)?.value
  return isSupportedLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE
}
