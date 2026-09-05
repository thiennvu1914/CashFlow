'use server'

import { requireUser } from '@/lib/auth/require-user'
import { prisma } from '@/lib/prisma'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'

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

  return { ok: true }
}
