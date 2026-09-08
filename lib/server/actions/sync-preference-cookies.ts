'use server'

import { cookies } from 'next/headers'
import { requireUser } from '@/lib/auth/require-user'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale } from '@/lib/i18n/config'
import { DEFAULT_THEME, THEME_COOKIE } from '@/lib/theme/config'

/**
 * Writes the signed-in user's saved locale and theme into their mirror cookies
 * (spec §3: the cookie "is written by `updateProfile` and on login").
 *
 * Called by the login form immediately after a successful sign-in and before it
 * navigates, so the first authenticated render already paints in the theme and
 * language on the account rather than the browser's stale cookie or the
 * defaults — and so a user signing in on a new device does not have to visit
 * Settings to get their own theme back.
 *
 * Reads NOTHING from the client: the values come from `requireUser()`, so this
 * action cannot set a cookie for another user or to a value the user never
 * saved. It writes no database row and changes no financial state.
 */
export async function syncPreferenceCookies(): Promise<void> {
  const user = await requireUser()
  const rawLocale = (user as { locale?: string }).locale
  const rawTheme = (user as { theme?: string }).theme
  const locale = isSupportedLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE
  const theme = rawTheme === 'dark' || rawTheme === 'light' ? rawTheme : DEFAULT_THEME

  const store = await cookies()
  const oneYearSeconds = 60 * 60 * 24 * 365
  store.set(LOCALE_COOKIE, locale, { path: '/', sameSite: 'lax', maxAge: oneYearSeconds })
  store.set(THEME_COOKIE, theme, { path: '/', sameSite: 'lax', maxAge: oneYearSeconds })
}
