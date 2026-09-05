'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { registerSchema, type RegisterInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function RegisterForm() {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) })

  async function onSubmit(values: RegisterInput) {
    const { error } = await authClient.signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
    })
    if (error) {
      setError('root', { message: error.message ?? 'Registration failed' })
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input placeholder="Name" {...register('name')} />
        {errors.name && <p className="text-sm text-negative">{errors.name.message}</p>}
      </div>
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
        {isSubmitting ? 'Creating account…' : 'Create account'}
      </Button>
      <p className="text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
