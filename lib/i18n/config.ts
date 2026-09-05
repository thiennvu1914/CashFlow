import { cookies } from 'next/headers'

export const SUPPORTED_LOCALES = ['vi', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'vi'

export async function resolveLocale(): Promise<Locale> {
  const store = await cookies()
  const value = store.get('NEXT_LOCALE')?.value
  return (SUPPORTED_LOCALES as readonly string[]).includes(value ?? '')
    ? (value as Locale)
    : DEFAULT_LOCALE
}
