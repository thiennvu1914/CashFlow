import { z } from 'zod'
import { USER_FIELD_DEFAULTS } from '@/lib/auth/user-defaults'

/**
 * True only for a string `Intl.DateTimeFormat` accepts as an IANA time zone
 * (e.g. `'Asia/Ho_Chi_Minh'`, `'UTC'`) — `Intl` throws a `RangeError` for
 * anything else (`'Vietnam'`, a typo'd zone, `''`), which is what this
 * catches. Exported so `profileSchema.timezone` and `resolveProfileDefaults`
 * enforce the exact same rule (Ruling P-16).
 */
export function isValidIanaTimezone(value: string): boolean {
  if (!value) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// Deliberately excludes `isDemo`: this is the second of the two independent
// layers blocking a client-set `isDemo` (§4.1, §13 of the spec). The first is
// `additionalFields.isDemo.input: false` in `lib/auth/create-auth.ts`. Zod
// strips unknown keys by default, so an `isDemo`/`userId` present in the raw
// input simply has no path into `ProfileInput`.
export const profileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  baseCurrency: z.enum(['VND', 'USD']),
  locale: z.enum(['vi', 'en']),
  theme: z.enum(['light', 'dark']),
  timezone: z
    .string()
    .min(1, 'Timezone is required')
    .refine(isValidIanaTimezone, 'Enter a valid IANA timezone, e.g. Asia/Ho_Chi_Minh'),
})

export type ProfileInput = z.infer<typeof profileSchema>

// Same bounds and messages as `registerSchema.password` in
// `lib/validation/auth.ts`, which are also the `minPasswordLength` /
// `maxPasswordLength` Better Auth enforces server-side (see
// `lib/auth/create-auth.ts`) — changing a password must never accept weaker
// input than creating one.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
})

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

// `USER_FIELD_DEFAULTS` (`lib/auth/user-defaults.ts`) is the single source; the
// `satisfies` here is what proves those values are still members of this file's
// Zod enums, so a change over there that this schema cannot accept fails to
// compile rather than silently becoming an unreachable fallback.
const PROFILE_DEFAULTS = USER_FIELD_DEFAULTS satisfies Omit<ProfileInput, 'name'>

/**
 * Better Auth's additional-fields type inference exposes `baseCurrency` /
 * `locale` / `theme` / `timezone` on the session user object, but only as
 * plain `string` (confirmed with a scratch `tsc` check against
 * `requireUser()`'s return type) — not narrowed to the Zod enums declared
 * here. A stored value can therefore only ever be one of the enum's members
 * in practice (Better Auth's `additionalFields` config and the matching
 * Prisma `@default(...)` are the only writers, and Task 7's `updateProfile`
 * server action is the only client-reachable writer, itself validated by
 * `profileSchema`) — but this helper still falls back to CashFlow's defaults
 * defensively rather than ever passing an out-of-enum value to the form or
 * throwing while rendering the settings page.
 */
export function resolveProfileDefaults(user: {
  name: string
  baseCurrency: string
  locale: string
  theme: string
  timezone: string
}): ProfileInput {
  const baseCurrency = profileSchema.shape.baseCurrency.safeParse(user.baseCurrency)
  const locale = profileSchema.shape.locale.safeParse(user.locale)
  const theme = profileSchema.shape.theme.safeParse(user.theme)
  const timezone = profileSchema.shape.timezone.safeParse(user.timezone)

  return {
    name: user.name,
    baseCurrency: baseCurrency.success ? baseCurrency.data : PROFILE_DEFAULTS.baseCurrency,
    locale: locale.success ? locale.data : PROFILE_DEFAULTS.locale,
    theme: theme.success ? theme.data : PROFILE_DEFAULTS.theme,
    timezone: timezone.success ? timezone.data : PROFILE_DEFAULTS.timezone,
  }
}
