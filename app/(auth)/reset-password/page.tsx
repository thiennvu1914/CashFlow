import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'

/**
 * Better Auth 1.7.2 emails a link to its own
 * `GET /api/auth/reset-password/:token?callbackURL=…` endpoint, which verifies
 * the token and then redirects here as `/reset-password?token=…` — or
 * `/reset-password?error=INVALID_TOKEN` when the token is missing, unknown or
 * expired. So the token arrives as a query parameter, not a path segment.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations()
  const params = await searchParams
  // A repeated `?token=` arrives as an array; treat anything that is not a
  // single non-empty string as no token at all rather than guessing which one
  // was meant.
  const token = typeof params.token === 'string' && params.token !== '' ? params.token : null
  const error = params.error

  if (error !== undefined || token === null) {
    return (
      <>
        <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.invalidTokenTitle')}</h1>
        <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
          {t('auth.invalidTokenBody')}
        </p>
        <Link
          href="/forgot-password"
          className="text-sm text-brand underline-offset-4 hover:underline"
        >
          {t('auth.requestNewLink')}
        </Link>
      </>
    )
  }

  return (
    <>
      <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.resetTitle')}</h1>
      <ResetPasswordForm token={token} />
    </>
  )
}
