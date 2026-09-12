import { describe, it, expect } from 'vitest'
import {
  makeTestAuth,
  nextTestIp,
  signIn,
  getSession,
  requestPasswordReset,
  type TestAuth,
} from './__testing__/auth-harness'

/**
 * Pins Task 8's rate-limit configuration at the HTTP level against the real
 * Better Auth instance and its default in-memory store, so these tests need
 * neither Postgres nor the network. They never import `lib/prisma.ts` or
 * `lib/auth/auth.ts` (the app singleton) for that reason.
 *
 * Better Auth keys each rate-limit bucket on `<ip>|<path>`
 * (`createRateLimitKey` in `node_modules/@better-auth/core/dist/utils/ip.mjs`),
 * and its store is a module-level Map shared by every instance in the process
 * (`memory` in `node_modules/better-auth/dist/api/rate-limiter/index.mjs`) — so
 * an IP reused across two `it()` blocks carries the earlier count over. Every
 * request below therefore carries an `x-forwarded-for` IP that the shared
 * `nextTestIp()` allocator guarantees is unique, or, in the trusted-proxy
 * block, a hand-written chain whose real client IP is stated in the test.
 */
const WRONG_PASSWORD = 'wrong-password'

function wrongPasswordSignIn(auth: TestAuth, ip: string, email: string) {
  return signIn(auth, { email, password: WRONG_PASSWORD }, { ip })
}

describe('auth rate limiting', () => {
  it('locks out sign-in after 5 wrong-password attempts within the window, per IP', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    const email = 'locked-out@example.com'

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await wrongPasswordSignIn(auth, ip, email)
      expect(response.status).toBe(401)
    }

    const sixth = await wrongPasswordSignIn(auth, ip, email)
    expect(sixth.status).toBe(429)
    // `rateLimitResponse` in
    // `node_modules/better-auth/dist/api/rate-limiter/index.mjs` always sets
    // this header on a 429, so it is asserted unconditionally.
    const retryAfter = sixth.headers.get('X-Retry-After')
    expect(retryAfter).not.toBeNull()
    expect(Number(retryAfter)).toBeGreaterThan(0)
  })

  it('does not share a sign-in lockout across different IPs', async () => {
    const { auth } = makeTestAuth()
    const lockedOutIp = nextTestIp()
    const otherIp = nextTestIp()
    const email = 'not-shared@example.com'

    for (let attempt = 1; attempt <= 6; attempt++) {
      await wrongPasswordSignIn(auth, lockedOutIp, email)
    }
    // Confirm that IP is now actually locked out before testing the other one.
    expect((await wrongPasswordSignIn(auth, lockedOutIp, email)).status).toBe(429)

    const fromOtherIp = await wrongPasswordSignIn(auth, otherIp, email)
    expect(fromOtherIp.status).toBe(401)
  })

  it('locks out request-password-reset after 5 attempts within the window', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    const email = 'reset-limited@example.com'

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await requestPasswordReset(auth, { email }, { ip })
      expect(response.status).toBe(200)
    }

    const sixth = await requestPasswordReset(auth, { email }, { ip })
    expect(sixth.status).toBe(429)
  })

  it('applies the general 10-per-60s rule to an endpoint with no custom rule', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()

    for (let attempt = 1; attempt <= 10; attempt++) {
      expect((await getSession(auth, { ip })).status).toBe(200)
    }

    const eleventh = await getSession(auth, { ip })
    expect(eleventh.status).toBe(429)
  })
})

/**
 * With `trustedProxies` configured, `getIPFromHeader`
 * (`node_modules/@better-auth/core/dist/utils/ip.mjs`) walks the
 * `x-forwarded-for` chain from RIGHT to LEFT, skipping every hop that matches a
 * trusted CIDR, and returns the first address that does not. The left-most
 * entries — the only ones a client can forge — are therefore never consulted
 * once a real proxy has appended its own hop. Without `trustedProxies` the same
 * function trusts a header only when it carries exactly one value, which is
 * both forgeable by a direct client and never true behind an appending proxy.
 */
describe('rate-limit client-IP resolution through trusted proxies', () => {
  const TRUSTED = ['10.0.0.0/8']

  it('keys one bucket on the real client IP even when the spoofable left-most entry changes', async () => {
    const { auth } = makeTestAuth({ trustedProxies: TRUSTED })
    const email = 'spoofer@example.com'
    // Same real client (5.5.5.5) behind the same trusted proxy (10.0.0.1), but
    // each request forges a different left-most value. If Better Auth trusted
    // the left-most entry these would be six separate buckets and none would
    // ever trip.
    const chains = [
      '9.9.9.1, 5.5.5.5, 10.0.0.1',
      '9.9.9.2, 5.5.5.5, 10.0.0.1',
      '9.9.9.3, 5.5.5.5, 10.0.0.1',
      '9.9.9.4, 5.5.5.5, 10.0.0.1',
      '9.9.9.5, 5.5.5.5, 10.0.0.1',
    ]

    for (const chain of chains) {
      const response = await wrongPasswordSignIn(auth, chain, email)
      expect(response.status).toBe(401)
    }

    const sixth = await wrongPasswordSignIn(auth, '9.9.9.6, 5.5.5.5, 10.0.0.1', email)
    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('X-Retry-After')).not.toBeNull()
  })

  it('does not limit a different real client behind the same trusted proxy', async () => {
    const { auth } = makeTestAuth({ trustedProxies: TRUSTED })
    const email = 'neighbour@example.com'
    // A real client distinct from the previous test's 5.5.5.5, because the
    // rate-limit store outlives a single `it()`.
    for (let attempt = 1; attempt <= 6; attempt++) {
      await wrongPasswordSignIn(auth, '9.9.9.9, 5.5.5.7, 10.0.0.1', email)
    }
    // Confirm 5.5.5.7 really is locked out before checking the neighbour.
    expect((await wrongPasswordSignIn(auth, '5.5.5.7, 10.0.0.1', email)).status).toBe(429)

    const other = await wrongPasswordSignIn(auth, '6.6.6.6, 10.0.0.1', email)
    expect(other.status).toBe(401)
  })

  it('collapses a multi-hop chain into one bucket when no trusted proxies are configured', async () => {
    // The counterpart of the two cases above, and the reason the option is
    // needed: with `trustedProxies` unset, a chain of more than one value
    // resolves to no IP at all, and `getIP` falls back to `127.0.0.1` in
    // dev/test — one shared bucket for every distinct client.
    const { auth } = makeTestAuth()
    const email = 'shared-bucket@example.com'

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await wrongPasswordSignIn(
        auth,
        `9.9.9.${attempt}, 5.5.5.${attempt}, 10.0.0.1`,
        email,
      )
      expect(response.status).toBe(401)
    }

    // A sixth request from a completely different chain still trips the limit,
    // because all six landed in the same fallback bucket.
    const sixth = await wrongPasswordSignIn(auth, '7.7.7.7, 8.8.8.8, 10.0.0.1', email)
    expect(sixth.status).toBe(429)
  })
})

describe('rate-limit client-IP resolution on Render', () => {
  it('uses cf-connecting-ip and ignores spoofed x-forwarded-for values', async () => {
    const { auth } = makeTestAuth({ ipAddressHeaders: ['cf-connecting-ip'] })
    const email = 'render-client@example.com'
    const clientIp = '198.51.100.200'

    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['cf-connecting-ip'])
    expect(auth.options.advanced?.ipAddress?.trustedProxies).toBeUndefined()

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await signIn(
        auth,
        { email, password: WRONG_PASSWORD },
        { ip: `203.0.113.${attempt}`, cfConnectingIp: clientIp },
      )
      expect(response.status).toBe(401)
    }

    const sixth = await signIn(
      auth,
      { email, password: WRONG_PASSWORD },
      { ip: '203.0.113.99', cfConnectingIp: clientIp },
    )
    expect(sixth.status).toBe(429)

    const otherClient = await signIn(
      auth,
      { email, password: WRONG_PASSWORD },
      { ip: '203.0.113.99', cfConnectingIp: '198.51.100.201' },
    )
    expect(otherClient.status).toBe(401)
  })
})
