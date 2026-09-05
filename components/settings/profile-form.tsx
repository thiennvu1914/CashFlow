'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'
import { updateProfile } from '@/lib/server/actions/update-profile'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ProfileForm({ defaultValues }: { defaultValues: ProfileInput }) {
  const router = useRouter()
  const [notice, setNotice] = useState<string | null>(null)
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
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input placeholder="Name" {...register('name')} />
        {errors.name && <p className="text-sm text-negative">{errors.name.message}</p>}
      </div>
      <div>
        <select {...register('baseCurrency')} className="rounded-md border p-2">
          <option value="VND">VND</option>
          <option value="USD">USD</option>
        </select>
        {errors.baseCurrency && (
          <p className="text-sm text-negative">{errors.baseCurrency.message}</p>
        )}
      </div>
      <div>
        <select {...register('locale')} className="rounded-md border p-2">
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
        {errors.locale && <p className="text-sm text-negative">{errors.locale.message}</p>}
      </div>
      <div>
        <select {...register('theme')} className="rounded-md border p-2">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        {errors.theme && <p className="text-sm text-negative">{errors.theme.message}</p>}
      </div>
      <div>
        <Input placeholder="Timezone (IANA, e.g. Asia/Ho_Chi_Minh)" {...register('timezone')} />
        {errors.timezone && <p className="text-sm text-negative">{errors.timezone.message}</p>}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      {notice && <p className="text-sm">{notice}</p>}
      <Button type="submit" disabled={isSubmitting || !isDirty}>
        {isSubmitting ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  )
}
