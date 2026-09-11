import { USER_FIELD_DEFAULTS } from '@/lib/auth/user-defaults'

/**
 * The theme constants, with NO server-only import — mirrors
 * `lib/i18n/locale.ts` so a client component (`app/global-error.tsx`) can
 * reach `Theme`/`THEME_COOKIE` without dragging `next/headers` into the
 * browser bundle, which is a build error.
 *
 * `lib/theme/config.ts` re-exports all of this and adds `resolveTheme`, the
 * server-only half. Server code may import from either; client code imports
 * from here.
 *
 * `cashflow-theme`, not `theme`: a one-word cookie name on a shared dev host
 * collides with every other app on `localhost`, and the earlier draft of this
 * work used the short name. The spec names this one.
 */
export const THEME_COOKIE = 'cashflow-theme'

export type Theme = 'light' | 'dark'

export const DEFAULT_THEME: Theme = USER_FIELD_DEFAULTS.theme

export function isTheme(value: string | undefined): value is Theme {
  return value === 'light' || value === 'dark'
}
