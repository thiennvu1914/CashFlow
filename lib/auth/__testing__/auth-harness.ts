import { expect } from 'vitest'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { createAuth, type CreateAuthOptions } from '../create-auth'

/**
 * Shared plumbing for the auth test files.
 *
 * Every auth test exercises the REAL Better Auth instance built by
 * `createAuth`, against an in-memory database and a fake email recorder, so
 * none of them needs Postgres, SMTP or the network — and none of them may
 * import `lib/prisma.ts` or `lib/auth/auth.ts` (the app singleton). This module
 * holds the request building and IP allocation that was previously copied into
 * four files; the assertions stay in the test files.
 *
 * Not a `*.test.ts` file, so Vitest's `include` globs in `vitest.config.ts`
 * (`lib/**\/*.test.ts` and friends) never collect it as a suite.
 */

export const TEST_BASE_URL = 'http://localhost:3000'
export const TEST_SECRET = 'cashflow-auth-harness-secret-32chars'

/**
 * RFC 5737 documentation ranges (TEST-NET-3, TEST-NET-2, TEST-NET-1). They are
 * guaranteed never to be routable, so a fake `x-forwarded-for` built from them
 * cannot collide with anything real.
 */
const TEST_IP_BLOCKS = ['203.0.113', '198.51.100', '192.0.2'] as const
const HOSTS_PER_BLOCK = 254

let allocatedIps = 0

/**
 * The single allocator of fake client IPs for the whole auth test suite.
 *
 * Rate limiting is on in every test (`rateLimit.enabled: true` in
 * `lib/auth/create-auth.ts`) and keys buckets on `<clientIp>|<path>`. Better
 * Auth's rate-limit store is a module-level Map shared by every instance in the
 * process (`memory` in
 * `node_modules/better-auth/dist/api/rate-limiter/index.mjs`), and with no IP
 * header `getIP` falls back to one shared `127.0.0.1` bucket in test/dev
 * (`node_modules/@better-auth/core/dist/utils/ip.mjs`). So a test that does not
 * carry a distinct IP fights another test's counter.
 *
 * Handing out addresses from here — rather than each file hand-picking a range
 * and hoping the ranges never meet — makes a collision impossible by
 * construction, and makes exhaustion loud rather than silent.
 */
export function nextTestIp(): string {
  const index = allocatedIps
  allocatedIps += 1
  const blockIndex = Math.floor(index / HOSTS_PER_BLOCK)
  const block = TEST_IP_BLOCKS[blockIndex]
  if (!block) {
    throw new Error(
      `nextTestIp() exhausted its ${TEST_IP_BLOCKS.length * HOSTS_PER_BLOCK} documentation-range addresses. ` +
        'Add another RFC 5737 block rather than reusing one — a reused IP silently shares a rate-limit bucket.',
    )
  }
  return `${block}.${(index % HOSTS_PER_BLOCK) + 1}`
}

export interface SentEmail {
  to: string
  url: string
}

export type TestAuth = ReturnType<typeof createAuth>

export interface TestAuthHarness {
  auth: TestAuth
  db: MemoryDB
  /** Every reset email the instance would have sent, in order. */
  sent: SentEmail[]
  baseURL: string
}

/**
 * Builds a Better Auth instance on a fresh in-memory database.
 *
 * `overrides` is passed straight through to `createAuth`, so a test can change
 * the base URL (`lib/auth/cookies.test.ts` needs an `https://` one to get the
 * `__Secure-` cookie prefix), add `trustedProxies`, or supply its own email
 * recorder. Anything not overridden uses the shared test defaults.
 */
export function makeTestAuth(overrides: Partial<CreateAuthOptions> = {}): TestAuthHarness {
  const db: MemoryDB = { user: [], session: [], account: [], verification: [] }
  const sent: SentEmail[] = []
  const auth = createAuth({
    database: memoryAdapter(db),
    baseURL: TEST_BASE_URL,
    secret: TEST_SECRET,
    sendResetPasswordEmail: async (to, url) => {
      sent.push({ to, url })
    },
    ...overrides,
  })
  return { auth, db, sent, baseURL: overrides.baseURL ?? TEST_BASE_URL }
}

export interface RequestOptions {
  /** Value for `x-forwarded-for`. Allocate it with `nextTestIp()`. */
  ip?: string
  cookie?: string
  /** Defaults to the harness base URL; override alongside `makeTestAuth`. */
  baseURL?: string
}

function buildHeaders(baseURL: string, options: RequestOptions, contentType: boolean): HeadersInit {
  const headers: Record<string, string> = { origin: baseURL }
  if (contentType) headers['content-type'] = 'application/json'
  if (options.ip) headers['x-forwarded-for'] = options.ip
  if (options.cookie) headers.cookie = options.cookie
  return headers
}

/**
 * `POST /api/auth<path>` with a JSON body. `path` is the Better Auth endpoint
 * path with the `/api/auth` base left off, e.g. `/sign-in/email`.
 */
export function post(
  auth: TestAuth,
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<Response> {
  const baseURL = options.baseURL ?? TEST_BASE_URL
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: 'POST',
      headers: buildHeaders(baseURL, options, true),
      body: JSON.stringify(body),
    }),
  )
}

/** `GET /api/auth<path>`. */
export function get(auth: TestAuth, path: string, options: RequestOptions = {}): Promise<Response> {
  const baseURL = options.baseURL ?? TEST_BASE_URL
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: 'GET',
      headers: buildHeaders(baseURL, options, false),
    }),
  )
}

export interface Credentials {
  email: string
  password: string
  name?: string
}

/**
 * Signs a user up and asserts the 200 — every caller treats a failed sign-up as
 * a broken fixture, not as the thing under test.
 */
export async function signUp(
  auth: TestAuth,
  credentials: Credentials,
  options: RequestOptions = {},
): Promise<Response> {
  const response = await post(
    auth,
    '/sign-up/email',
    {
      name: credentials.name ?? 'Test User',
      email: credentials.email,
      password: credentials.password,
    },
    options,
  )
  expect(response.status).toBe(200)
  return response
}

export function signIn(
  auth: TestAuth,
  credentials: { email: string; password: string },
  options: RequestOptions = {},
): Promise<Response> {
  return post(auth, '/sign-in/email', credentials, options)
}

/** Signs in, asserts the 200, and hands back the session cookie. */
export async function signInAndGetCookie(
  auth: TestAuth,
  credentials: { email: string; password: string },
  options: RequestOptions = {},
): Promise<string> {
  const response = await signIn(auth, credentials, options)
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toBeTruthy()
  return cookie as string
}

export function signOut(auth: TestAuth, options: RequestOptions = {}): Promise<Response> {
  const baseURL = options.baseURL ?? TEST_BASE_URL
  return auth.handler(
    new Request(`${baseURL}/api/auth/sign-out`, {
      method: 'POST',
      headers: buildHeaders(baseURL, options, false),
    }),
  )
}

export function getSessionRequest(options: RequestOptions = {}): Request {
  const baseURL = options.baseURL ?? TEST_BASE_URL
  return new Request(`${baseURL}/api/auth/get-session`, {
    method: 'GET',
    headers: buildHeaders(baseURL, options, false),
  })
}

export function getSession(auth: TestAuth, options: RequestOptions = {}): Promise<Response> {
  return auth.handler(getSessionRequest(options))
}

/**
 * `get-session` answers 200 with an empty or `null` body once the session is
 * gone, so "no user" is what has to be asserted, not a status code.
 */
export async function sessionUser(
  auth: TestAuth,
  options: RequestOptions = {},
): Promise<unknown | null> {
  const response = await getSession(auth, options)
  expect(response.status).toBe(200)
  const body = await response.text()
  const parsed = body === '' || body === 'null' ? null : (JSON.parse(body) as { user?: unknown })
  return parsed?.user ?? null
}

export function requestPasswordReset(
  auth: TestAuth,
  body: { email: string; redirectTo?: string },
  options: RequestOptions = {},
): Promise<Response> {
  return post(auth, '/request-password-reset', body, options)
}

export function resetPassword(
  auth: TestAuth,
  body: { token: string; newPassword: string },
  options: RequestOptions = {},
): Promise<Response> {
  return post(auth, '/reset-password', body, options)
}

export function changePassword(
  auth: TestAuth,
  body: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean },
  options: RequestOptions = {},
): Promise<Response> {
  return post(auth, '/change-password', body, options)
}
