'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'
import { registerSchema, type RegisterInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const GENERIC_ERROR = 'Something went wrong. Please try again.'
const EMAIL_TAKEN_ERROR = 'An account with that email already exists.'

/**
 * Maps a Better Auth error onto one of two fixed strings. The server's own
 * `error.message` is never rendered: it is library text we do not control, it
 * can change between versions, and it can carry detail (a database or provider
 * message) that has no business on a public sign-up form.
 *
 * `POST /sign-up/email` answers a duplicate address with
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` — verified in
 * `node_modules/better-auth/dist/api/routes/sign-up.mjs`, which throws
 * `APIError.from('UNPROCESSABLE_ENTITY',
 * BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL)`. The shorter
 * `USER_ALREADY_EXISTS` is a sibling code in
 * `node_modules/@better-auth/core/dist/error/codes.mjs` used elsewhere in the
 * library, so both are accepted here rather than betting on one spelling.
 *
 * Telling a visitor their email is already registered is a deliberate
 * trade-off: a sign-up form leaks that fact anyway (it cannot create the
 * account), and a useless generic error here just sends people in circles. The
 * endpoints where enumeration actually matters — sign-in and
 * request-password-reset — stay uniform.
 */
function registerErrorMessage(code: string | undefined): string {
  if (code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' || code === 'USER_ALREADY_EXISTS') {
    return EMAIL_TAKEN_ERROR
  }
  return GENERIC_ERROR
}

export function RegisterForm() {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) })

  async function onSubmit(values: RegisterInput) {
    try {
      const { error } = await authClient.signUp.email({
        email: values.email,
        password: values.password,
        name: values.name,
      })
      if (error) {
        setError('root', { message: registerErrorMessage(error.code) })
        return
      }
    } catch {
      console.error('Registration request failed')
      setError('root', { message: GENERIC_ERROR })
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
