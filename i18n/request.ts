import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/config'

// Task 2b (`lib/i18n/messages.ts` / `loadMessages`) has not run yet, so this
// keeps the flat per-locale JSON import for now; 2b swaps it for `loadMessages`.
export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  const messages = (await import(`@/messages/${locale}.json`)).default

  return {
    locale,
    messages,
  }
})
