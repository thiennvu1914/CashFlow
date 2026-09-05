import { describe, it, expect } from 'vitest'
import { parseTrustedProxies } from './trusted-proxies'

describe('parseTrustedProxies', () => {
  it('returns an empty list when the variable is unset', () => {
    expect(parseTrustedProxies(undefined)).toEqual([])
  })

  it('returns an empty list for an empty or whitespace-only value', () => {
    expect(parseTrustedProxies('')).toEqual([])
    expect(parseTrustedProxies('   ')).toEqual([])
    expect(parseTrustedProxies(',,')).toEqual([])
  })

  it('splits on commas and trims each entry', () => {
    expect(parseTrustedProxies('10.0.0.0/8, 192.0.2.10 ,2001:db8::/32')).toEqual([
      '10.0.0.0/8',
      '192.0.2.10',
      '2001:db8::/32',
    ])
  })

  it('drops empty entries left by stray commas', () => {
    expect(parseTrustedProxies('10.0.0.0/8,,  ,192.0.2.10,')).toEqual(['10.0.0.0/8', '192.0.2.10'])
  })

  it('keeps a malformed entry rather than hiding it, so Better Auth can warn about it', () => {
    // `findInvalidTrustedProxies` in
    // `node_modules/@better-auth/core/dist/utils/ip.mjs` is what reports a
    // typo'd CIDR, via a warning logged at construction. Filtering it out here
    // would silently swallow that signal.
    expect(parseTrustedProxies('10.0.0.0/8, not-an-ip')).toEqual(['10.0.0.0/8', 'not-an-ip'])
  })
})
