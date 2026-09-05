/**
 * The one place CashFlow's per-user field defaults are written down.
 *
 * Consumed by `lib/auth/create-auth.ts` (`user.additionalFields[*].defaultValue`,
 * applied by Better Auth when it creates a record) and by
 * `lib/validation/profile.ts` (`PROFILE_DEFAULTS`, the fallback used when a
 * stored value fails its Zod enum). `prisma/schema.prisma` carries a third,
 * unavoidable copy as `@default(...)` — the database's own answer for rows
 * written by anything that does not go through Better Auth — and points back
 * here in a comment. Keep the three in step; this const is the source.
 *
 * `isDemo` is deliberately absent: it is not a user-facing profile field, it
 * never appears in client-facing Zod (spec §4.1, §13), and its default lives
 * with the `input: false` declaration that blocks a client from setting it.
 */
export const USER_FIELD_DEFAULTS = {
  baseCurrency: 'VND',
  locale: 'vi',
  theme: 'light',
  timezone: 'Asia/Ho_Chi_Minh',
} as const
