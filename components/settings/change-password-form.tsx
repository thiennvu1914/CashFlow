'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/lib/auth/client'
import { changePasswordSchema, type ChangePasswordInput } from '@/lib/validation/profile'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ChangePasswordForm() {
  const [notice, setNotice] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) })

  async function onSubmit(values: ChangePasswordInput) {
    setNotice(null)
    try {
      const { error } = await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: true,
      })
      if (error) {
        // Never echo Better Auth's own message back to the user.
        setError('root', {
          message: 'Current password is incorrect or the new password is invalid',
        })
        return
      }
    } catch {
      console.error('Change password request failed')
      setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }
    reset()
    setNotice('Password updated')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input
          type="password"
          placeholder="Current password"
          autoComplete="current-password"
          {...register('currentPassword')}
        />
        {errors.currentPassword && (
          <p className="text-sm text-negative">{errors.currentPassword.message}</p>
        )}
      </div>
      <div>
        <Input
          type="password"
          placeholder="New password"
          autoComplete="new-password"
          {...register('newPassword')}
        />
        {errors.newPassword && (
          <p className="text-sm text-negative">{errors.newPassword.message}</p>
        )}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      {notice && <p className="text-sm">{notice}</p>}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  )
}
