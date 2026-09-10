import { cookies } from 'next/headers'
import { getOptionalSession } from '@/lib/auth/require-user'
import { USER_FIELD_DEFAULTS } from '@/lib/auth/user-defaults'

/**
 * Which theme this request renders in (spec §3).
 *
 * `User.theme` is the source of truth; the cookie mirrors it so a PRE-AUTH page
 * — login, register, forgot/reset password — can paint in the user's theme
 * before there is a session to ask. The order is therefore session → cookie →
 * light, exactly as `resolveLocale` resolves the locale.
 *
 * `cashflow-theme`, not `theme`: a one-word cookie name on a shared dev host
 * collides with every other app on `localhost`, and the earlier draft of this
 * work used the short name. The spec names this one.
 *
 * Better Auth's additional-fields inference types `theme` on the session user
 * as plain `string` (the same limitation `lib/validation/profile.ts:57-69`
 * documents for `resolveProfileDefaults`), so it is narrowed here rather than
 * trusted.
 */
export const THEME_COOKIE = 'cashflow-theme'

export type Theme = 'light' | 'dark'

export const DEFAULT_THEME: Theme = USER_FIELD_DEFAULTS.theme

function isTheme(value: string | undefined): value is Theme {
  return value === 'light' || value === 'dark'
}

export async function resolveTheme(): Promise<Theme> {
  const session = await getOptionalSession()
  const userTheme = (session?.user as { theme?: string } | undefined)?.theme
  if (isTheme(userTheme)) return userTheme

  const store = await cookies()
  const cookieTheme = store.get(THEME_COOKIE)?.value
  return isTheme(cookieTheme) ? cookieTheme : DEFAULT_THEME
}
