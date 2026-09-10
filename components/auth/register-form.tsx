'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { registerSchema, type RegisterInput } from '@/lib/validation/auth'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Maps a Better Auth error onto one of three fixed message KEYS. The server's
 * own `error.message` is never rendered: it is library text we do not
 * control, it can change between versions, and it can carry detail (a
 * database or provider message) that has no business on a public sign-up
 * form.
 *
 * `POST /sign-up/email` answers a duplicate address with
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` — verified in
 * `node_modules/better-auth/dist/api/routes/sign-up.mjs`, which throws
 * `APIError.from('UNPROCESSABLE_ENTITY',
 * BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL)`. The shorter
 * `USER_ALREADY_EXISTS` is a sibling code in
 * `node_modules/@better-auth/core/dist/error/codes.mjs` used elsewhere in the
 * library, so both are accepted here rather than betting on one spelling.
 *
 * Telling a visitor their email is already registered is a deliberate
 * trade-off: a sign-up form leaks that fact anyway (it cannot create the
 * account), and a useless generic error here just sends people in circles. The
 * endpoints where enumeration actually matters — sign-in and
 * request-password-reset — stay uniform.
 *
 * `status === 429` (Task 13, D3) is checked before the code: Better Auth's own
 * rate limiter (`lib/auth/create-auth.ts`) answers a burst of sign-ups the
 * same way it answers a burst of sign-ins, and a visitor who tripped it needs
 * to know to wait, not "check the highlighted fields" or a generic failure —
 * mirroring the login form's identical `error.status === 429` branch.
 */
function registerErrorKey(
  error: { code?: string; status?: number } | undefined,
): 'auth.tooManyAttempts' | 'auth.emailTaken' | 'errors.generic' {
  if (error?.status === 429) return 'auth.tooManyAttempts'
  if (
    error?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' ||
    error?.code === 'USER_ALREADY_EXISTS'
  ) {
    return 'auth.emailTaken'
  }
  return 'errors.generic'
}

/**
 * No `useHydrated()` gate: none of the three fields has a `defaultValues`
 * entry, so react-hook-form reads the DOM into form state on mount instead of
 * writing over it (`lib/ui/use-hydrated.ts` documents the defect this gate
 * exists for) — there is nothing here for it to guard against.
 * `e2e/helpers.ts`'s `registerNewUser` relies on exactly that: it fills every
 * field before this form has finished hydrating.
 */
export function RegisterForm() {
  const t = useTranslations()
  const router = useRouter()
  const submit = useSubmitState()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) })

  async function onSubmit(values: RegisterInput) {
    await submit.run(async () => {
      try {
        const { error } = await authClient.signUp.email({
          email: values.email,
          password: values.password,
          name: values.name,
        })
        if (error) {
          setError('root', { message: t(registerErrorKey(error)) })
          return
        }
      } catch {
        console.error('Registration request failed')
        setError('root', { message: t('errors.generic') })
        return
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
        <legend className="sr-only">{t('auth.registerTitle')}</legend>

        <FormField id="register-name" label={t('auth.name')} error={errors.name?.message}>
          {(aria) => <Input {...aria} autoComplete="name" {...register('name')} />}
        </FormField>

        <FormField id="register-email" label={t('auth.email')} error={errors.email?.message}>
          {(aria) => <Input {...aria} type="email" autoComplete="email" {...register('email')} />}
        </FormField>

        <FormField
          id="register-password"
          label={t('auth.password')}
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
          {submit.pending ? t('auth.creatingAccount') : t('auth.createAccount')}
        </Button>
      </fieldset>

      {/* Below the fieldset, not inside it: navigation, not a member of the
          "Tạo tài khoản CashFlow" form group a screen reader announces the
          fieldset's contents as. */}
      <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
        {t('auth.haveAccount')}{' '}
        <Link href="/login" className="text-brand underline-offset-4 hover:underline">
          {t('auth.signIn')}
        </Link>
      </p>
    </form>
  )
}
