import { describe, it, expect } from 'vitest'
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from './auth'

describe('registerSchema', () => {
  it('accepts a valid input', () => {
    const result = registerSchema.safeParse({
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'password123',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an empty name', () => {
    const result = registerSchema.safeParse({
      name: '',
      email: 'jane@example.com',
      password: 'password123',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid email', () => {
    const result = registerSchema.safeParse({
      name: 'Jane Doe',
      email: 'not-an-email',
      password: 'password123',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a 7-character password', () => {
    const result = registerSchema.safeParse({
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: '1234567',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a 129-character password', () => {
    const result = registerSchema.safeParse({
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'a'.repeat(129),
    })
    expect(result.success).toBe(false)
  })
})

describe('loginSchema', () => {
  it('rejects an empty password', () => {
    const result = loginSchema.safeParse({
      email: 'jane@example.com',
      password: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid email', () => {
    const result = loginSchema.safeParse({
      email: 'not-an-email',
      password: 'password123',
    })
    expect(result.success).toBe(false)
  })
})

describe('forgotPasswordSchema', () => {
  it('accepts a valid email', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'jane@example.com' }).success).toBe(true)
  })

  it('rejects an invalid email', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success).toBe(false)
  })

  it('rejects an empty email', () => {
    expect(forgotPasswordSchema.safeParse({ email: '' }).success).toBe(false)
  })
})

describe('resetPasswordSchema', () => {
  it('accepts an 8-character password', () => {
    expect(resetPasswordSchema.safeParse({ password: '12345678' }).success).toBe(true)
  })

  it('accepts a 128-character password', () => {
    expect(resetPasswordSchema.safeParse({ password: 'a'.repeat(128) }).success).toBe(true)
  })

  it('rejects a 7-character password', () => {
    expect(resetPasswordSchema.safeParse({ password: '1234567' }).success).toBe(false)
  })

  it('rejects a 129-character password', () => {
    expect(resetPasswordSchema.safeParse({ password: 'a'.repeat(129) }).success).toBe(false)
  })
})
