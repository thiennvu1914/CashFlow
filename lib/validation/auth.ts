import { z } from 'zod'

export const registerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
})

export const loginSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

export const forgotPasswordSchema = z.object({
  email: z.email('Enter a valid email address'),
})

// Same bounds as `registerSchema.password`, which are also the
// `minPasswordLength` / `maxPasswordLength` Better Auth enforces server-side
// (see `lib/auth/create-auth.ts`) — the client rules never promise more than
// the server accepts.
export const resetPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
