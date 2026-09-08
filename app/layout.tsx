import type { Metadata, Viewport } from 'next'
import { Manrope } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { resolveLocale } from '@/lib/i18n/config'
import { loadMessages } from '@/lib/i18n/messages'
import { resolveTheme } from '@/lib/theme/config'
import './globals.css'

const manrope = Manrope({
  variable: '--font-manrope',
  subsets: ['latin', 'vietnamese'],
  // Spec §2: 400/500/600 only. Naming them keeps the served font from carrying
  // the 700/800 faces nothing in the design system uses.
  weight: ['400', '500', '600'],
})

export const metadata: Metadata = {
  title: 'CashFlow',
  description: 'Personal finance management',
}

/**
 * The browser chrome colour follows the resolved theme, so the address bar on a
 * phone matches the page instead of framing a dark app in a white bar. It has
 * to be `generateViewport` rather than a static `viewport` export because the
 * value depends on this request's user.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = await resolveTheme()
  return { themeColor: theme === 'dark' ? '#171C1A' : '#F6F7F5' }
}

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const [locale, theme] = await Promise.all([resolveLocale(), resolveTheme()])
  const messages = await loadMessages(locale)

  return (
    // The `dark` class is decided on the SERVER and shipped in the first HTML
    // byte (spec §3), so there is no flash by construction and no client script
    // to flip it. `colorScheme` is what makes native chrome — scrollbars, the
    // `<input type="date">` picker, form control defaults — follow the theme
    // too; without it a dark app has a white date picker.
    <html
      lang={locale}
      className={`${manrope.variable} ${manrope.className} h-full antialiased${theme === 'dark' ? ' dark' : ''}`}
      style={{ colorScheme: theme }}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
