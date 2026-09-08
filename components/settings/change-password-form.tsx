'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth/client'
import { changePasswordSchema, type ChangePasswordInput } from '@/lib/validation/profile'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The separate change-password form (amended spec §6.9): its own `<form>`, its
 * own Save, no `defaultValues` at all.
 *
 * That last point is why it needs no `useHydrated()` gate, unlike `ProfileForm`
 * next to it: `lib/ui/use-hydrated.ts` documents that react-hook-form only
 * overwrites a control's DOM value on mount when a field HAS a `defaultValues`
 * entry — `isUndefined(defaultValue)` takes the other branch and reads the DOM
 * into form state instead of writing over it. Neither password field has a
 * default (there is nothing to prefill), so there is nothing for RHF to revert.
 * Do not add a gate here for symmetry with `ProfileForm`; it would disable a
 * form that has no defect to guard against.
 */
export function ChangePasswordForm() {
  const t = useTranslations()
  const [notice, setNotice] = useState<string | null>(null)
  const submit = useSubmitState()
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) })

  async function onSubmit(values: ChangePasswordInput) {
    setNotice(null)
    await submit.run(async () => {
      try {
        const { error } = await authClient.changePassword({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
          revokeOtherSessions: true,
        })
        if (error) {
          // Never echo Better Auth's own message back to the user.
          setError('root', { message: t('settings.passwordError') })
          return
        }
      } catch {
        console.error('Change password request failed')
        setError('root', { message: t(GENERIC_ERROR_KEY) })
        return
      }
      reset()
      setNotice(t('settings.passwordChanged'))
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <fieldset
        disabled={submit.locked}
        aria-busy={submit.busy}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">{t('settings.securityTitle')}</legend>

        <FormField
          id="settings-current-password"
          label={t('settings.currentPassword')}
          error={errors.currentPassword?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="password"
              autoComplete="current-password"
              {...register('currentPassword')}
            />
          )}
        </FormField>

        <FormField
          id="settings-new-password"
          label={t('settings.newPassword')}
          error={errors.newPassword?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="password"
              autoComplete="new-password"
              {...register('newPassword')}
            />
          )}
        </FormField>

        {errors.root && <InlineAlert tone="negative">{errors.root.message}</InlineAlert>}
        {notice && <InlineAlert tone="positive">{notice}</InlineAlert>}

        <Button type="submit" className="self-start">
          {submit.pending
            ? t('settings.changePasswordPending')
            : t('settings.changePasswordAction')}
        </Button>
      </fieldset>
    </form>
  )
}
