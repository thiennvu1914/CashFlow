'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
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
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ResetPasswordInput>({ resolver: zodResolver(resetPasswordSchema) })

  async function onSubmit(values: ResetPasswordInput) {
    await submit.run(async () => {
      try {
        const { error } = await authClient.resetPassword({
          newPassword: values.password,
          token,
        })
        if (error) {
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
    </form>
  )
}
