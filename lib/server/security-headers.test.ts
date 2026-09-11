import { describe, it, expect } from 'vitest'
import {
  securityHeadersFor,
  isProductionMode,
  BASE_SECURITY_HEADERS,
  HSTS_HEADER,
} from './security-headers'

describe('securityHeadersFor', () => {
  it('carries the five base headers in development, no HSTS', () => {
    const headers = securityHeadersFor('development')
    expect(headers).toEqual(BASE_SECURITY_HEADERS)
    expect(headers.find((h) => h.key === 'Strict-Transport-Security')).toBeUndefined()
  })

  it('carries the five base headers in test, no HSTS', () => {
    const headers = securityHeadersFor('test')
    expect(headers.find((h) => h.key === 'Strict-Transport-Security')).toBeUndefined()
  })

  it('adds HSTS only in production', () => {
    const headers = securityHeadersFor('production')
    expect(headers).toEqual([...BASE_SECURITY_HEADERS, HSTS_HEADER])
  })

  it('pins the exact base header values', () => {
    expect(BASE_SECURITY_HEADERS).toEqual([
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
      },
    ])
  })

  it('pins the exact HSTS value (no preload)', () => {
    expect(HSTS_HEADER).toEqual({
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains',
    })
  })
})

describe('isProductionMode', () => {
  it('is true only for the literal string "production"', () => {
    expect(isProductionMode('production')).toBe(true)
    expect(isProductionMode('development')).toBe(false)
    expect(isProductionMode('test')).toBe(false)
    expect(isProductionMode(undefined)).toBe(false)
  })
})
