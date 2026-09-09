'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { resetPasswordSchema, type ResetPasswordInput } from '@/lib/validation/auth'
import { GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * No `useHydrated()` gate: the password field has no `defaultValues` entry, so
 * react-hook-form reads the DOM into form state on mount instead of writing
 * over it (`lib/ui/use-hydrated.ts` documents the defect this gate exists
 * for) — there is nothing here for it to guard against.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations()
  const router = useRouter()
  const submit = useSubmitState()
  // Whether the SUBMIT-time failure was specifically the token being invalid
  // or expired (Better Auth's `resetPassword` returning an error), as opposed
  // to a network/generic failure. Only that case gets the same "request a new
  // link" recovery the server-rendered invalid-token state
  // (`app/(auth)/reset-password/page.tsx`, for a token that is already known
  // bad before this form even mounts) already offers — a plain "something
  // went wrong" failure has no reason to send someone away from the form.
  const [tokenInvalid, setTokenInvalid] = useState(false)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ResetPasswordInput>({ resolver: zodResolver(resetPasswordSchema) })

  async function onSubmit(values: ResetPasswordInput) {
    setTokenInvalid(false)
    await submit.run(async () => {
      try {
        const { error } = await authClient.resetPassword({
          newPassword: values.password,
          token,
        })
        if (error) {
          setTokenInvalid(true)
          setError('root', { message: t('auth.resetInvalid') })
          return
        }
      } catch {
        console.error('Password reset failed')
        setError('root', { message: t(GENERIC_ERROR_KEY) })
        return
      }
      router.push('/login')
      router.refresh()
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <fieldset
        disabled={submit.locked}
        aria-busy={submit.busy}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">{t('auth.resetTitle')}</legend>

        <FormField
          id="reset-password"
          label={t('auth.newPassword')}
          error={errors.password?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="password"
              autoComplete="new-password"
              {...register('password')}
            />
          )}
        </FormField>

        {errors.root && <InlineAlert tone="negative">{errors.root.message}</InlineAlert>}

        <Button type="submit" className="w-full">
          {submit.pending ? t('auth.settingNewPassword') : t('auth.setNewPassword')}
        </Button>
      </fieldset>

      {/* Below the fieldset, not inside it — same reasoning as the other three
          forms' secondary links. Only shown for the token-invalid failure,
          not a generic one (see `tokenInvalid` above). */}
      {tokenInvalid && (
        <Link
          href="/forgot-password"
          className="text-sm text-brand underline-offset-4 hover:underline"
        >
          {t('auth.requestNewLink')}
        </Link>
      )}
    </form>
  )
}
