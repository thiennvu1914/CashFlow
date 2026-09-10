import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { buttonVariants } from '@/components/ui/button'

/**
 * Next's fallback for every unmatched URL across the whole app (and for a
 * segment that calls `notFound()`, which nothing here does yet — see
 * `A-2` in the Phase 8 pre-flight audit). One root file is enough: unlike
 * `app/global-error.tsx`, this renders INSIDE the root layout — same
 * `<html>`/`<body>`, same `NextIntlClientProvider` request pipeline — so it
 * can use full next-intl server-side, and there is no per-segment 404 UI to
 * make a nested `(app)/not-found.tsx` worthwhile.
 *
 * No auth check: an unmatched URL is exactly as likely signed-out as
 * signed-in, so both a `/dashboard` and a `/login` way forward are offered
 * rather than guessing.
 */
export default async function NotFound() {
  const t = await getTranslations()

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[30rem] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-[1.125rem]/[1.625rem] font-semibold">{t('errors.notFoundTitle')}</h1>
        <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
          {t('errors.notFoundBody')}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className={buttonVariants({ variant: 'default', size: 'lg' })}>
          {t('errors.goToDashboard')}
        </Link>
        <Link href="/login" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
          {t('errors.goToLogin')}
        </Link>
      </div>
    </div>
  )
}
