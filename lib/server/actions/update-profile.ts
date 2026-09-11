'use server'

import { cookies } from 'next/headers'
import { requireUser } from '@/lib/auth/require-user'
import { prisma } from '@/lib/prisma'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'
import { LOCALE_COOKIE } from '@/lib/i18n/config'
import { THEME_COOKIE } from '@/lib/theme/config'
import { preferenceCookieOptions } from '@/lib/server/preference-cookies'

export type UpdateProfileResult = { ok: true } | { ok: false; error: 'INVALID_INPUT' }

/**
 * The only write path to `baseCurrency`/`locale`/`theme`/`timezone`. Never
 * accepts `isDemo`: `profileSchema` doesn't declare it, and `data` below is
 * still built field-by-field from the parsed result (never `...parsed`) as a
 * second, independent layer — even a malformed request body that somehow
 * carried `isDemo` has no path into this object.
 *
 * The row to update is identified only by `requireUser()`'s id, never by
 * anything in `input` — so an `input.userId` (were one ever present) can
 * never redirect the write to a different user.
 */
export async function updateProfile(input: ProfileInput): Promise<UpdateProfileResult> {
  const user = await requireUser()
  const parsed = profileSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'INVALID_INPUT' }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      name: parsed.data.name,
      baseCurrency: parsed.data.baseCurrency,
      locale: parsed.data.locale,
      theme: parsed.data.theme,
      timezone: parsed.data.timezone,
    },
  })

  // The database row is the source of truth; these two cookies are its mirror,
  // and they exist for the pages that have no session to ask — login, register,
  // forgot/reset password (spec §3, §4). Written here because this action is
  // the only client-reachable writer of `locale`/`theme`, so the mirror cannot
  // drift from the row.
  //
  // Not `httpOnly`: both are presentation preferences with nothing to protect,
  // and a flag that guards nothing only blocks a future client-side read.
  // `sameSite: 'lax'` and `path: '/'` are what make them arrive on every
  // navigation, including the very next one; `secure` is decided per request
  // by `preferenceCookieOptions()` (HTTPS or production yes, localhost HTTP
  // no).
  const cookieStore = await cookies()
  const options = await preferenceCookieOptions()
  cookieStore.set(LOCALE_COOKIE, parsed.data.locale, options)
  cookieStore.set(THEME_COOKIE, parsed.data.theme, options)

  return { ok: true }
}
