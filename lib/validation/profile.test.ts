import { describe, it, expect } from 'vitest'
import {
  profileSchema,
  changePasswordSchema,
  resolveProfileDefaults,
  isValidIanaTimezone,
} from './profile'

const validProfile = {
  name: 'Pham Thi D',
  baseCurrency: 'VND' as const,
  locale: 'vi' as const,
  theme: 'light' as const,
  timezone: 'Asia/Ho_Chi_Minh',
}

describe('profileSchema', () => {
  it('accepts a valid profile input', () => {
    const result = profileSchema.safeParse(validProfile)
    expect(result.success).toBe(true)
  })

  it('rejects an invalid baseCurrency', () => {
    const result = profileSchema.safeParse({ ...validProfile, baseCurrency: 'EUR' })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid locale', () => {
    const result = profileSchema.safeParse({ ...validProfile, locale: 'fr' })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid theme', () => {
    const result = profileSchema.safeParse({ ...validProfile, theme: 'system' })
    expect(result.success).toBe(false)
  })

  it('rejects an empty timezone', () => {
    const result = profileSchema.safeParse({ ...validProfile, timezone: '' })
    expect(result.success).toBe(false)
  })

  it('accepts valid IANA timezones', () => {
    expect(profileSchema.safeParse({ ...validProfile, timezone: 'Asia/Ho_Chi_Minh' }).success).toBe(
      true,
    )
    expect(profileSchema.safeParse({ ...validProfile, timezone: 'UTC' }).success).toBe(true)
  })

  it('rejects a timezone that is not a valid IANA zone', () => {
    expect(profileSchema.safeParse({ ...validProfile, timezone: 'Vietnam' }).success).toBe(false)
    expect(profileSchema.safeParse({ ...validProfile, timezone: 'Asia/Saigon-typo' }).success).toBe(
      false,
    )
  })

  // `isDemo` must have no path into the database through this schema (§4.1,
  // §13 of the spec — see `lib/auth/create-auth.ts`). Zod strips unknown keys
  // by default, which is the mechanism this test pins: an `isDemo`/`userId`
  // carried in the input simply never survives `parse`/`safeParse`.
  it('parses successfully but drops isDemo and userId when they are present in the input', () => {
    const result = profileSchema.safeParse({
      ...validProfile,
      isDemo: true,
      userId: 'attacker-id',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).not.toHaveProperty('isDemo')
    expect(result.data).not.toHaveProperty('userId')
    expect(Object.keys(result.data).sort()).toEqual(
      ['baseCurrency', 'locale', 'name', 'theme', 'timezone'].sort(),
    )
  })
})

describe('isValidIanaTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidIanaTimezone('Asia/Ho_Chi_Minh')).toBe(true)
    expect(isValidIanaTimezone('UTC')).toBe(true)
  })

  it("rejects a non-IANA string, a typo'd zone, and an empty string", () => {
    expect(isValidIanaTimezone('Vietnam')).toBe(false)
    expect(isValidIanaTimezone('Asia/Saigon-typo')).toBe(false)
    expect(isValidIanaTimezone('')).toBe(false)
  })
})

describe('changePasswordSchema', () => {
  it('accepts a valid change-password input', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'correct-horse-battery-staple',
      newPassword: 'a-brand-new-passphrase-9000',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a new password shorter than the 8-character minimum', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'correct-horse-battery-staple',
      newPassword: 'short',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty current password', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: '',
      newPassword: 'a-brand-new-passphrase-9000',
    })
    expect(result.success).toBe(false)
  })
})

describe('resolveProfileDefaults', () => {
  it('passes through valid stored values unchanged', () => {
    const result = resolveProfileDefaults({
      name: 'Pham Thi D',
      baseCurrency: 'USD',
      locale: 'en',
      theme: 'dark',
      timezone: 'America/New_York',
    })

    expect(result).toEqual({
      name: 'Pham Thi D',
      baseCurrency: 'USD',
      locale: 'en',
      theme: 'dark',
      timezone: 'America/New_York',
    })
  })

  // Better Auth types these additional fields as plain `string`/`boolean` on
  // the session user (confirmed by a scratch `tsc` check against
  // `requireUser()`'s return type), so a stored value that somehow fell
  // outside the enum would otherwise reach the form unnarrowed. This helper
  // is the fallback layer for that case.
  it('falls back to CashFlow defaults when a stored value is outside the enum', () => {
    const result = resolveProfileDefaults({
      name: 'Pham Thi D',
      baseCurrency: 'EUR',
      locale: 'fr',
      theme: 'system',
      timezone: '',
    })

    expect(result).toEqual({
      name: 'Pham Thi D',
      baseCurrency: 'VND',
      locale: 'vi',
      theme: 'light',
      timezone: 'Asia/Ho_Chi_Minh',
    })
  })

  it('falls back to the default timezone when the stored value is not a real IANA zone', () => {
    const result = resolveProfileDefaults({
      name: 'Pham Thi D',
      baseCurrency: 'VND',
      locale: 'vi',
      theme: 'light',
      timezone: 'Nowhere/City',
    })

    expect(result.timezone).toBe('Asia/Ho_Chi_Minh')
  })
})
