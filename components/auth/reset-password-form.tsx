'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { resetPasswordSchema, type ResetPasswordInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({ resolver: zodResolver(resetPasswordSchema) })

  async function onSubmit(values: ResetPasswordInput) {
    try {
      const { error } = await authClient.resetPassword({
        newPassword: values.password,
        token,
      })
      if (error) {
        setError('root', {
          message: 'This reset link is invalid or has expired. Request a new one.',
        })
        return
      }
    } catch {
      console.error('Password reset failed')
      setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }
    router.push('/login')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input type="password" placeholder="New password" {...register('password')} />
        {errors.password && <p className="text-sm text-negative">{errors.password.message}</p>}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Set new password'}
      </Button>
    </form>
  )
}
