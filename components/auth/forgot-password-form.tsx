'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { forgotPasswordSchema, type ForgotPasswordInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ForgotPasswordForm() {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isSubmitSuccessful },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) })

  async function onSubmit(values: ForgotPasswordInput) {
    try {
      // Better Auth answers identically whether or not the address is
      // registered, and so does this form — nothing here may reveal which
      // emails have accounts.
      const { error } = await authClient.requestPasswordReset({
        email: values.email,
        redirectTo: '/reset-password',
      })
      if (error) {
        setError('root', { message: 'Something went wrong. Please try again.' })
        return
      }
    } catch {
      console.error('Password reset request failed')
      setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }
  }

  // `setError('root', …)` already clears `isSubmitSuccessful`; the explicit
  // check keeps the success screen tied to "no error" without depending on
  // that react-hook-form detail.
  if (isSubmitSuccessful && !errors.root) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          If an account exists for that email, a reset link has been sent. The link expires in one
          hour and can only be used once.
        </p>
        <Link href="/login" className="text-sm text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input type="email" placeholder="Email" {...register('email')} />
        {errors.email && <p className="text-sm text-negative">{errors.email.message}</p>}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send reset link'}
      </Button>
      <p className="text-sm text-muted-foreground">
        Remembered it?{' '}
        <Link href="/login" className="text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
