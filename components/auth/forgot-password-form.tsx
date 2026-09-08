'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { forgotPasswordSchema, type ForgotPasswordInput } from '@/lib/validation/auth'
import { GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * No `useHydrated()` gate: the email field has no `defaultValues` entry, so
 * react-hook-form reads the DOM into form state on mount instead of writing
 * over it (`lib/ui/use-hydrated.ts` documents the defect this gate exists
 * for) — there is nothing here for it to guard against.
 */
export function ForgotPasswordForm() {
  const t = useTranslations()
  const submit = useSubmitState()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitSuccessful },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) })

  async function onSubmit(values: ForgotPasswordInput) {
    await submit.run(async () => {
      try {
        // Better Auth answers identically whether or not the address is
        // registered, and so does this form — nothing here may reveal which
        // emails have accounts.
        const { error } = await authClient.requestPasswordReset({
          email: values.email,
          redirectTo: '/reset-password',
        })
        if (error) {
          setError('root', { message: t(GENERIC_ERROR_KEY) })
          return
        }
      } catch {
        console.error('Password reset request failed')
        setError('root', { message: t(GENERIC_ERROR_KEY) })
      }
    })
  }

  // `setError('root', …)` already clears `isSubmitSuccessful`; the explicit
  // check keeps the success screen tied to "no error" without depending on
  // that react-hook-form detail.
  if (isSubmitSuccessful && !errors.root) {
    return (
      <div className="flex flex-col gap-4">
        <InlineAlert tone="positive">{t('auth.resetSent')}</InlineAlert>
        <Link href="/login" className="text-sm text-brand underline-offset-4 hover:underline">
          {t('auth.backToSignIn')}
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <fieldset
        disabled={submit.locked}
        aria-busy={submit.busy}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">{t('auth.forgotTitle')}</legend>

        <FormField id="forgot-email" label={t('auth.email')} error={errors.email?.message}>
          {(aria) => <Input {...aria} type="email" autoComplete="email" {...register('email')} />}
        </FormField>

        {errors.root && <InlineAlert tone="negative">{errors.root.message}</InlineAlert>}

        <Button type="submit" className="w-full">
          {submit.pending ? t('auth.sendingResetLink') : t('auth.sendResetLink')}
        </Button>

        <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
          {t('auth.rememberedIt')}{' '}
          <Link href="/login" className="text-brand underline-offset-4 hover:underline">
            {t('auth.signIn')}
          </Link>
        </p>
      </fieldset>
    </form>
  )
}
