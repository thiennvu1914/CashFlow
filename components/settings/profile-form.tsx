'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'
import { updateProfile } from '@/lib/server/actions/update-profile'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ProfileForm({ defaultValues }: { defaultValues: ProfileInput }) {
  const router = useRouter()
  const [notice, setNotice] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ProfileInput>({ resolver: zodResolver(profileSchema), defaultValues })

  async function onSubmit(values: ProfileInput) {
    setNotice(null)
    try {
      const result = await updateProfile(values)
      if (!result.ok) {
        setError('root', { message: 'Something went wrong. Please try again.' })
        return
      }
    } catch {
      console.error('Profile update request failed')
      setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }
    reset(values)
    setNotice('Profile saved')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — the same mechanism the money forms use, for the
          same defect: `lib/ui/use-hydrated.ts` documents why react-hook-form's
          `ref` callback silently overwrites anything typed or chosen before
          hydration finishes. This form is the worst case of it, because EVERY
          field here carries a `defaultValues` entry, so every field was
          revertible; a live pre-fix probe reverted a name typed early 5/5.

          Until `useHydrated()` flips, `<fieldset disabled>` natively disables
          every control inside it (submit button included) and `:disabled`
          matches those descendants, so the existing `disabled:` styles on
          `Input`/`Button` apply with no new CSS. The form's layout classes
          moved here because the fieldset is now the flex container; `min-w-0`
          neutralises a fieldset's default `min-inline-size: min-content`, and
          Tailwind's preflight already zeroes its margin/padding/border — so
          nothing shifts when the gate lifts.

          Each control below also gets `defaultValue` (never `value` — that
          would make it controlled), so the SERVER renders the stored profile
          instead of an empty box and each select's first option, and RHF's
          one destructive ref write agrees with the markup it lands on. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">Profile</legend>
        <div>
          <Input placeholder="Name" {...register('name')} defaultValue={defaultValues.name} />
          {errors.name && <p className="text-sm text-negative">{errors.name.message}</p>}
        </div>
        <div>
          <select
            {...register('baseCurrency')}
            defaultValue={defaultValues.baseCurrency}
            className="rounded-md border p-2"
          >
            <option value="VND">VND</option>
            <option value="USD">USD</option>
          </select>
          {errors.baseCurrency && (
            <p className="text-sm text-negative">{errors.baseCurrency.message}</p>
          )}
        </div>
        <div>
          <select
            {...register('locale')}
            defaultValue={defaultValues.locale}
            className="rounded-md border p-2"
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
          {errors.locale && <p className="text-sm text-negative">{errors.locale.message}</p>}
        </div>
        <div>
          <select
            {...register('theme')}
            defaultValue={defaultValues.theme}
            className="rounded-md border p-2"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          {errors.theme && <p className="text-sm text-negative">{errors.theme.message}</p>}
        </div>
        <div>
          <Input
            placeholder="Timezone (IANA, e.g. Asia/Ho_Chi_Minh)"
            {...register('timezone')}
            defaultValue={defaultValues.timezone}
          />
          {errors.timezone && <p className="text-sm text-negative">{errors.timezone.message}</p>}
        </div>
        {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
        {notice && <p className="text-sm">{notice}</p>}
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? 'Saving…' : 'Save changes'}
        </Button>
      </fieldset>
    </form>
  )
}
