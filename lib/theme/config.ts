import { cookies } from 'next/headers'
import { getOptionalSession } from '@/lib/auth/require-user'
import { DEFAULT_THEME, THEME_COOKIE, isTheme, type Theme } from './theme'

/**
 * Which theme this request renders in (spec §3).
 *
 * `User.theme` is the source of truth; the cookie mirrors it so a PRE-AUTH page
 * — login, register, forgot/reset password — can paint in the user's theme
 * before there is a session to ask. The order is therefore session → cookie →
 * light, exactly as `resolveLocale` resolves the locale.
 *
 * Better Auth's additional-fields inference types `theme` on the session user
 * as plain `string` (the same limitation `lib/validation/profile.ts:57-69`
 * documents for `resolveProfileDefaults`), so it is narrowed here rather than
 * trusted.
 */
export * from './theme'

export async function resolveTheme(): Promise<Theme> {
  const session = await getOptionalSession()
  const userTheme = (session?.user as { theme?: string } | undefined)?.theme
  if (isTheme(userTheme)) return userTheme

  const store = await cookies()
  const cookieTheme = store.get(THEME_COOKIE)?.value
  return isTheme(cookieTheme) ? cookieTheme : DEFAULT_THEME
}
