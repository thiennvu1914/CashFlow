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
 * Maps a Better Auth error onto one of two fixed message KEYS. The server's
 * own `error.message` is never rendered: it is library text we do not
 * control, it can change between versions, and it can carry detail (a
 * database or provider message) that has no business on a public sign-up
 * form.
 *
 * Every server-side failure that is not a 429 collapses onto the SAME key,
 * `auth.registerFailed`. That is the point: `POST /sign-up/email` answers a
 * duplicate address with `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (verified in
 * `node_modules/better-auth/dist/api/routes/sign-up.mjs`, which throws
 * `APIError.from('UNPROCESSABLE_ENTITY', ...)`; the shorter
 * `USER_ALREADY_EXISTS` is a sibling code in
 * `node_modules/@better-auth/core/dist/error/codes.mjs`), and rendering a
 * distinct "that email is taken" message turns this form into an account
 * enumeration oracle: anyone can type an address and learn whether the person
 * banks here. Showing one message for "taken" and a different one for any
 * other failure would leak exactly the same bit, so the branch is gone rather
 * than merely reworded. The copy still tells a legitimate visitor what to do
 * next — check the address, or sign in / reset the password — which is the
 * useful half of the old message.
 *
 * Not addressed here, deliberately: response TIMING still differs between a
 * duplicate and a fresh address (Better Auth hashes a password for one and
 * not the other), and a determined attacker can measure it. Equalising it
 * would mean a fake hash on every duplicate; the owner ruled that out for
 * this app's threat model. Field validation is untouched — a malformed email
 * or a short password is the user's own input, not a fact about someone
 * else's account.
 *
 * `status === 429` (Task 13, D3) is checked first and keeps its own message:
 * Better Auth's rate limiter (`lib/auth/create-auth.ts`) answers a burst of
 * sign-ups the same way it answers a burst of sign-ins, and a visitor who
 * tripped it needs to know to wait rather than to re-check an address that
 * was fine. It reveals nothing about any account — it is a fact about this
 * client's request rate — and mirrors the login form's identical branch.
 *
 * Exported for `register-form.test.tsx`, which pins that the duplicate codes
 * and an unknown failure produce the byte-identical key.
 */
export function registerErrorKey(
  error: { code?: string; status?: number } | undefined,
): 'auth.tooManyAttempts' | 'auth.registerFailed' {
  if (error?.status === 429) return 'auth.tooManyAttempts'
  return 'auth.registerFailed'
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
        // A thrown request (the network, not an answer from the server) says
        // nothing about any account, but it renders the same message so the
        // form never has two visually distinguishable failure states.
        console.error('Registration request failed')
        setError('root', { message: t('auth.registerFailed') })
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
