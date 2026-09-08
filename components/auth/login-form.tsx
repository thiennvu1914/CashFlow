'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { syncPreferenceCookies } from '@/lib/server/actions/sync-preference-cookies'
import { loginSchema, type LoginInput } from '@/lib/validation/auth'
import { GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * No `useHydrated()` gate: neither field has a `defaultValues` entry, so
 * react-hook-form reads the DOM into form state on mount instead of writing
 * over it (`lib/ui/use-hydrated.ts` documents the defect this gate exists
 * for) — there is nothing here for it to guard against, and `e2e/helpers.ts`'s
 * `registerNewUser` (the register form's sibling) already relies on the same
 * fact for `/register`. Do not add a gate here for symmetry with a form that
 * has one.
 */
export function LoginForm() {
  const t = useTranslations()
  const router = useRouter()
  const submit = useSubmitState()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) })

  async function onSubmit(values: LoginInput) {
    await submit.run(async () => {
      try {
        const { error } = await authClient.signIn.email({
          email: values.email,
          password: values.password,
        })
        if (error) {
          // Fixed message regardless of what Better Auth reports — never reveal
          // whether the email exists.
          setError('root', { message: t('auth.invalidCredentials') })
          return
        }
      } catch {
        console.error('Sign-in request failed')
        setError('root', { message: t(GENERIC_ERROR_KEY) })
        return
      }
      // Best-effort: a failure here means the next render falls back to the
      // cookie or the default, which is a cosmetic miss and not a broken
      // sign-in — so it must never block the navigation below.
      try {
        await syncPreferenceCookies()
      } catch {
        console.error('Preference cookie sync failed')
      }
      router.push('/dashboard')
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
        <legend className="sr-only">{t('auth.loginTitle')}</legend>

        <FormField id="login-email" label={t('auth.email')} error={errors.email?.message}>
          {(aria) => <Input {...aria} type="email" autoComplete="email" {...register('email')} />}
        </FormField>

        <FormField id="login-password" label={t('auth.password')} error={errors.password?.message}>
          {(aria) => (
            <Input
              {...aria}
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
          )}
        </FormField>

        {errors.root && <InlineAlert tone="negative">{errors.root.message}</InlineAlert>}

        <Button type="submit" className="w-full">
          {submit.pending ? t('auth.signingIn') : t('auth.signIn')}
        </Button>

        <Link
          href="/forgot-password"
          className="text-sm text-brand underline-offset-4 hover:underline"
        >
          {t('auth.forgotPassword')}
        </Link>
        <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
          {t('auth.noAccount')}{' '}
          <Link href="/register" className="text-brand underline-offset-4 hover:underline">
            {t('auth.createOne')}
          </Link>
        </p>
      </fieldset>
    </form>
  )
}
