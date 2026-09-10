import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/config'
import { loadMessages } from '@/lib/i18n/messages'

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  return { locale, messages: await loadMessages(locale) }
})
