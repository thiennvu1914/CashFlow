import { describe, it, expect, vi } from 'vitest'

/**
 * These tests never touch Postgres or the network: `@/lib/auth/auth` (the app
 * singleton, which wires up the Prisma adapter) is mocked out entirely so that
 * `lib/prisma.ts` is never imported, and `next/headers` is mocked so each test
 * controls exactly which request headers `requireUser()`/`getOptionalSession()`
 * see. The mocked auth instance is a real Better Auth instance built by
 * `createAuth` against the in-memory adapter — same pattern as
 * `lib/auth/create-auth.test.ts` — so signing up through it produces a real
 * session cookie.
 */
const { BASE_URL, TEST_SECRET } = vi.hoisted(() => ({
  BASE_URL: 'http://localhost:3000',
  TEST_SECRET: 'require-user-unit-test-secret-32chars',
}))

const headersMock = vi.hoisted(() => vi.fn())

vi.mock('next/headers', () => ({
  headers: headersMock,
}))

vi.mock('@/lib/auth/auth', async () => {
  // Dynamic imports here (rather than referencing top-level imports of this
  // file) are required by Vitest's mock hoisting: this factory runs before
  // this file's own top-level statements, including any `import` bindings.
  const { createAuth } = await import('./create-auth')
  const { memoryAdapter } = await import('better-auth/adapters/memory')
  const db = { user: [], session: [], account: [], verification: [] }
  const auth = createAuth({
    database: memoryAdapter(db),
    baseURL: BASE_URL,
    secret: TEST_SECRET,
  })
  return { auth }
})

const { auth } = await import('@/lib/auth/auth')
const { requireUser, getOptionalSession, UnauthorizedError } = await import('./require-user')

describe('getOptionalSession', () => {
  it('returns null when there is no cookie', async () => {
    headersMock.mockResolvedValue(new Headers())

    expect(await getOptionalSession()).toBeNull()
  })
})

describe('requireUser', () => {
  it('throws UnauthorizedError when there is no cookie', async () => {
    headersMock.mockResolvedValue(new Headers())

    let error: unknown
    try {
      await requireUser()
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect((error as Error).name).toBe('UnauthorizedError')
  })

  it('resolves to the signed-up user identified by their session cookie', async () => {
    const { headers: signUpHeaders, response } = await auth.api.signUpEmail({
      body: {
        name: 'Pham Thi D',
        email: 'pham@example.com',
        password: 'correct-horse-battery-staple',
      },
      returnHeaders: true,
    })
    const setCookie = signUpHeaders.get('set-cookie')
    expect(setCookie).toBeTruthy()

    headersMock.mockResolvedValue(new Headers({ cookie: setCookie as string }))

    const user = await requireUser()

    // The identity comes from the session, never from any input we pass here.
    expect(user.id).toBe(response.user.id)
    expect(user.email).toBe('pham@example.com')
  })
})
