import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/config'

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  const messages = (await import(`../messages/${locale}.json`)).default

  return {
    locale,
    messages,
  }
})
