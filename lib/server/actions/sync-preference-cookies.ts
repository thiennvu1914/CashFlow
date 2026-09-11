'use server'

import { cookies } from 'next/headers'
import { requireUser } from '@/lib/auth/require-user'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale } from '@/lib/i18n/config'
import { DEFAULT_THEME, THEME_COOKIE } from '@/lib/theme/config'
import { preferenceCookieOptions } from '@/lib/server/preference-cookies'

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

  // Same attribute set as `updateProfile`'s write, from one definition, so the
  // login-time mirror and the Settings-time mirror cannot disagree about
  // `secure`, `sameSite`, `path` or lifetime.
  const store = await cookies()
  const options = await preferenceCookieOptions()
  store.set(LOCALE_COOKIE, locale, options)
  store.set(THEME_COOKIE, theme, options)
}
