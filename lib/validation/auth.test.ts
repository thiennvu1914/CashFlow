import { describe, it, expect } from 'vitest'
import { registerSchema, loginSchema } from './auth'

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
