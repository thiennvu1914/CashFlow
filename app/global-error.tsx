'use client'

import { useSyncExternalStore } from 'react'
import { buttonVariants } from '@/components/ui/button'
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@/lib/i18n/locale'
import './globals.css'

/**
 * The boundary for a throw in `app/layout.tsx` itself — `resolveLocale()`,
 * `resolveTheme()` or `loadMessages()` failing before any page has a chance
 * to render (A-2 in the Phase 8 pre-flight audit). Next requires this file to
 * define its own `<html>`/`<body>` and to be a Client Component (error
 * boundaries always are), which together mean it renders OUTSIDE
 * `NextIntlClientProvider` and outside `i18n/request.ts`'s request pipeline —
 * `resolveLocale()` itself is unreachable here (it needs `next/headers`,
 * a server-only API). Full next-intl is therefore not an option; per the
 * Phase 8 controller ruling this is a minimal hard-coded vi/en pair instead,
 * `Locale`-keyed like everywhere else.
 *
 * The locale is read from the browser's `NEXT_LOCALE` cookie via
 * `useSyncExternalStore`, not a `useState`/`useEffect` pair: this component's
 * first paint can itself be server-rendered (the root layout failing on the
 * very first request), and `document` does not exist yet on the server —
 * reading the cookie eagerly during render would make the server's markup
 * say `DEFAULT_LOCALE` and the client's hydration pass (where `document`
 * DOES already exist) say whatever the cookie holds, which is a rendered-text
 * hydration mismatch the moment those two disagree. `useSyncExternalStore`'s
 * `getServerSnapshot` is the built-in answer to exactly this: React uses it
 * for the server render AND the client's first (hydration) render, so the two
 * always agree, then re-renders once more with `getSnapshot`'s real answer
 * immediately after — a brief flash traded for zero mismatch risk, which is
 * the right trade for a screen this rare. (An effect that calls `setState`
 * unconditionally for this would be the more familiar shape, but it is
 * exactly the "derive state via effect" anti-pattern `react-hooks/set-state
 * -in-effect` exists to catch — `useSyncExternalStore` is the sanctioned
 * escape hatch for reading an external, non-React value safely.)
 *
 * A plain `<a>`, not `next/link`: this file can render with none of the
 * App Router's context providers mounted (they live inside the very layout
 * that just failed), and `<Link>` assumes that context exists.
 */
function subscribeToNothing(): () => void {
  // The cookie does not change while this boundary is mounted (there is no
  // affordance on this screen that could change it), so there is nothing to
  // subscribe to — `useSyncExternalStore` requires the function shape
  // regardless, and an unsubscribe that never fires is the correct no-op.
  return () => {}
}
const COPY: Record<
  Locale,
  { title: string; body: string; retry: string; home: string; reference: (code: string) => string }
> = {
  vi: {
    title: 'Không tải được ứng dụng.',
    body: 'Dữ liệu của bạn chưa bị thay đổi. Hãy thử lại, hoặc quay về trang chủ.',
    retry: 'Thử lại',
    home: 'Về trang chủ',
    reference: (code) => `Mã tham chiếu: ${code}`,
  },
  en: {
    title: 'The application failed to load.',
    body: 'Your data has not been changed. Try again, or go back to the home page.',
    retry: 'Retry',
    home: 'Back to home',
    reference: (code) => `Reference: ${code}`,
  },
}

function detectLocale(): Locale {
  const match = document.cookie.match(/(?:^|; )NEXT_LOCALE=([^;]+)/)
  const value = match ? decodeURIComponent(match[1]) : undefined
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const locale = useSyncExternalStore(subscribeToNothing, detectLocale, () => DEFAULT_LOCALE)
  const copy = COPY[locale]

  return (
    // global-error must include its own html and body tags — it replaces the
    // root layout, which is exactly what failed.
    <html lang={locale}>
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground antialiased">
        <div className="flex flex-col gap-1">
          <h1 className="text-[1.125rem]/[1.625rem] font-semibold">{copy.title}</h1>
          <p className="max-w-[36ch] text-[0.8125rem]/[1.125rem] text-muted-foreground">
            {copy.body}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => reset()} className={buttonVariants({ size: 'lg' })}>
            {copy.retry}
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see file doc: no router context to assume here */}
          <a href="/" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {copy.home}
          </a>
        </div>
        {/* `error.message`/stack are never rendered — see app/(app)/error.tsx's
            doc comment for why. `digest` is by construction opaque and PII-free
            (it exists to let a user quote a code back to support), so it is the
            one thing about `error` shown here. */}
        {error.digest && (
          <p className="text-xs text-muted-foreground">{copy.reference(error.digest)}</p>
        )}
      </body>
    </html>
  )
}
