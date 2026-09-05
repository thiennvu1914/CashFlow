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

function makeAuth() {
  const db: MemoryDB = { user: [], session: [], account: [], verification: [] }
  return createAuth({
    database: memoryAdapter(db),
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    sendResetPasswordEmail: async () => {},
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
    const retryAfter = sixth.headers.get('X-Retry-After')
    if (retryAfter !== null) {
      expect(Number(retryAfter)).toBeGreaterThan(0)
    }
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
