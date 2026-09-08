'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { syncPreferenceCookies } from '@/lib/server/actions/sync-preference-cookies'
import { loginSchema, type LoginInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoginForm() {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) })

  async function onSubmit(values: LoginInput) {
    try {
      const { error } = await authClient.signIn.email({
        email: values.email,
        password: values.password,
      })
      if (error) {
        // Fixed message regardless of what Better Auth reports — never reveal
        // whether the email exists.
        setError('root', { message: 'Invalid email or password' })
        return
      }
    } catch {
      console.error('Sign-in request failed')
      setError('root', { message: 'Something went wrong. Please try again.' })
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
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input type="email" placeholder="Email" {...register('email')} />
        {errors.email && <p className="text-sm text-negative">{errors.email.message}</p>}
      </div>
      <div>
        <Input type="password" placeholder="Password" {...register('password')} />
        {errors.password && <p className="text-sm text-negative">{errors.password.message}</p>}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <Link href="/forgot-password" className="text-sm text-accent underline">
        Forgot password?
      </Link>
      <p className="text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link href="/register" className="text-primary underline-offset-4 hover:underline">
          Create one
        </Link>
      </p>
    </form>
  )
}
