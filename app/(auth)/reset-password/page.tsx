import Link from 'next/link'
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
  const params = await searchParams
  // A repeated `?token=` arrives as an array; treat anything that is not a
  // single non-empty string as no token at all rather than guessing which one
  // was meant.
  const token = typeof params.token === 'string' && params.token !== '' ? params.token : null
  const error = params.error

  if (error !== undefined || token === null) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
        <h1 className="text-xl font-semibold">Reset link is invalid or expired</h1>
        <p className="text-sm text-muted-foreground">
          Reset links expire after one hour and can only be used once. Request a new one to
          continue.
        </p>
        <Link
          href="/forgot-password"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Request a new reset link
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">Set a new password</h1>
      <ResetPasswordForm token={token} />
    </div>
  )
}
