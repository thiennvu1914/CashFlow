import { describe, it, expect } from 'vitest'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { createAuth } from './create-auth'

/**
 * Pins Task 8's rate-limit configuration at the HTTP level against the real
 * Better Auth instance and its default in-memory store, so these tests need
 * neither Postgres nor the network. They never import `lib/prisma.ts` or
 * `lib/auth/auth.ts` (the app singleton) for that reason — same pattern as
 * `lib/auth/sign-in.test.ts`.
 *
 * Better Auth keys each rate-limit bucket on `<ip>|<path>`
 * (`createRateLimitKey` in `node_modules/@better-auth/core/dist/utils/ip.mjs`).
 * In a test/dev process with no trustworthy IP header it falls back to a
 * single shared `127.0.0.1` bucket per path (same file, `getIP`), which would
 * make every test in this file (and every other auth test file that shares
 * the module-level in-memory store within one Vitest worker) fight over the
 * same counter. Each request below therefore carries an explicit
 * `x-forwarded-for` header — the default `ipAddressHeaders` entry
 * (`DEFAULT_IP_HEADERS` in that same file) — with an IP unique to its test
 * case, so counters never bleed between cases even though they share the
 * module-level memory store within this file.
 */
const BASE_URL = 'http://localhost:3000'
const TEST_SECRET = 'rate-limit-unit-test-secret-32characte'

function makeAuth(trustedProxies?: string[]) {
  const db: MemoryDB = { user: [], session: [], account: [], verification: [] }
  return createAuth({
    database: memoryAdapter(db),
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    sendResetPasswordEmail: async () => {},
    trustedProxies,
  })
}

type Auth = ReturnType<typeof createAuth>

function signInRequest(ip: string, email: string, password: string) {
  return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE_URL,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify({ email, password }),
  })
}

function requestPasswordResetRequest(ip: string, email: string) {
  return new Request(`${BASE_URL}/api/auth/request-password-reset`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE_URL,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify({ email }),
  })
}

function getSessionRequest(ip: string) {
  return new Request(`${BASE_URL}/api/auth/get-session`, {
    method: 'GET',
    headers: { origin: BASE_URL, 'x-forwarded-for': ip },
  })
}

async function signIn(auth: Auth, ip: string, email: string, password: string) {
  return auth.handler(signInRequest(ip, email, password))
}

describe('auth rate limiting', () => {
  it('locks out sign-in after 5 wrong-password attempts within the window, per IP', async () => {
    const auth = makeAuth()
    const ip = '203.0.113.10'
    const email = 'nobody-203-0-113-10@example.com'

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await signIn(auth, ip, email, 'wrong-password')
      expect(response.status).toBe(401)
    }

    const sixth = await signIn(auth, ip, email, 'wrong-password')
    expect(sixth.status).toBe(429)
    // `rateLimitResponse` in
    // `node_modules/better-auth/dist/api/rate-limiter/index.mjs` always sets
    // this header on a 429, so it is asserted unconditionally.
    const retryAfter = sixth.headers.get('X-Retry-After')
    expect(retryAfter).not.toBeNull()
    expect(Number(retryAfter)).toBeGreaterThan(0)
  })

  it('does not share a sign-in lockout across different IPs', async () => {
    const auth = makeAuth()
    const lockedOutIp = '203.0.113.11'
    const otherIp = '203.0.113.12'
    const email = 'nobody-203-0-113-11@example.com'

    for (let attempt = 1; attempt <= 6; attempt++) {
      await signIn(auth, lockedOutIp, email, 'wrong-password')
    }
    // Confirm that IP is now actually locked out before testing the other one.
    expect((await signIn(auth, lockedOutIp, email, 'wrong-password')).status).toBe(429)

    const fromOtherIp = await signIn(auth, otherIp, email, 'wrong-password')
    expect(fromOtherIp.status).toBe(401)
  })

  it('locks out request-password-reset after 5 attempts within the window', async () => {
    const auth = makeAuth()
    const ip = '203.0.113.20'
    const email = 'reset-203-0-113-20@example.com'

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await auth.handler(requestPasswordResetRequest(ip, email))
      expect(response.status).toBe(200)
    }

    const sixth = await auth.handler(requestPasswordResetRequest(ip, email))
    expect(sixth.status).toBe(429)
  })

  it('applies the general 10-per-60s rule to an endpoint with no custom rule', async () => {
    const auth = makeAuth()
    const ip = '203.0.113.30'

    let lastResponse: Response | undefined
    for (let attempt = 1; attempt <= 10; attempt++) {
      lastResponse = await auth.handler(getSessionRequest(ip))
      expect(lastResponse.status).toBe(200)
    }

    const eleventh = await auth.handler(getSessionRequest(ip))
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
    const auth = makeAuth(TRUSTED)
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
      const response = await signIn(auth, chain, email, 'wrong-password')
      expect(response.status).toBe(401)
    }

    const sixth = await signIn(auth, '9.9.9.6, 5.5.5.5, 10.0.0.1', email, 'wrong-password')
    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('X-Retry-After')).not.toBeNull()
  })

  it('does not limit a different real client behind the same trusted proxy', async () => {
    const auth = makeAuth(TRUSTED)
    const email = 'neighbour@example.com'
    // A real client distinct from the previous test's 5.5.5.5: Better Auth's
    // rate-limit store is a module-level Map shared by every instance in the
    // process (`memory` in
    // `node_modules/better-auth/dist/api/rate-limiter/index.mjs`), so a bucket
    // reused across `it()` blocks would carry the earlier count over.
    for (let attempt = 1; attempt <= 6; attempt++) {
      await signIn(auth, '9.9.9.9, 5.5.5.7, 10.0.0.1', email, 'wrong-password')
    }
    // Confirm 5.5.5.7 really is locked out before checking the neighbour.
    expect((await signIn(auth, '5.5.5.7, 10.0.0.1', email, 'wrong-password')).status).toBe(429)

    const other = await signIn(auth, '6.6.6.6, 10.0.0.1', email, 'wrong-password')
    expect(other.status).toBe(401)
  })

  it('collapses a multi-hop chain into one bucket when no trusted proxies are configured', async () => {
    // The counterpart of the two cases above, and the reason the option is
    // needed: with `trustedProxies` unset, a chain of more than one value
    // resolves to no IP at all, and `getIP` falls back to `127.0.0.1` in
    // dev/test — one shared bucket for every distinct client.
    const auth = makeAuth()
    const email = 'shared-bucket@example.com'

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await signIn(
        auth,
        `9.9.9.${attempt}, 5.5.5.${attempt}, 10.0.0.1`,
        email,
        'wrong-password',
      )
      expect(response.status).toBe(401)
    }

    // A sixth request from a completely different chain still trips the limit,
    // because all six landed in the same fallback bucket.
    const sixth = await signIn(auth, '7.7.7.7, 8.8.8.8, 10.0.0.1', email, 'wrong-password')
    expect(sixth.status).toBe(429)
  })
})
