import { describe, it, expect, afterEach } from 'vitest'
import { makeTestAuth, nextTestIp, post, signUp } from './__testing__/auth-harness'

/**
 * These tests exercise the real Better Auth instance against an in-memory
 * database, so they need neither Postgres nor the network. They never import
 * `lib/prisma.ts` or `lib/auth/auth.ts` (the app singleton) for that reason.
 */
describe('createAuth', () => {
  it('applies the CashFlow defaults to a user created by email sign-up', async () => {
    const { auth, db } = makeTestAuth()

    const { headers, response } = await auth.api.signUpEmail({
      body: {
        name: 'Nguyen Van A',
        email: 'nguyen@example.com',
        password: 'correct-horse-battery-staple',
      },
      returnHeaders: true,
    })

    expect(response.user).toMatchObject({
      email: 'nguyen@example.com',
      baseCurrency: 'VND',
      locale: 'vi',
      theme: 'light',
      timezone: 'Asia/Ho_Chi_Minh',
      isDemo: false,
    })

    // The defaults are persisted, not just echoed back on the sign-up response.
    expect(db.user).toHaveLength(1)
    expect(db.user[0]).toMatchObject({
      baseCurrency: 'VND',
      locale: 'vi',
      theme: 'light',
      timezone: 'Asia/Ho_Chi_Minh',
      isDemo: false,
    })

    // And the session issued by sign-up resolves to that same user.
    const setCookie = headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: setCookie as string }),
    })
    expect(session?.user).toMatchObject({
      email: 'nguyen@example.com',
      baseCurrency: 'VND',
      isDemo: false,
    })
  })

  it('ignores additional user fields supplied in the sign-up request body', async () => {
    const { auth, db } = makeTestAuth()

    const response = await post(
      auth,
      '/sign-up/email',
      {
        name: 'Tran Thi B',
        email: 'tran@example.com',
        password: 'correct-horse-battery-staple',
        isDemo: true,
        baseCurrency: 'USD',
      },
      { ip: nextTestIp() },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { user: Record<string, unknown> }

    // `input: false` on every additional field means a client cannot set them.
    expect(body.user.isDemo).toBe(false)
    expect(body.user.baseCurrency).toBe('VND')
    expect(db.user).toHaveLength(1)
    expect(db.user[0]).toMatchObject({ isDemo: false, baseCurrency: 'VND' })
  })

  it('rejects an update-user request that tries to set isDemo', async () => {
    const { auth, db } = makeTestAuth()
    const ip = nextTestIp()

    const signUpResponse = await post(
      auth,
      '/sign-up/email',
      {
        name: 'Le Van C',
        email: 'le@example.com',
        password: 'correct-horse-battery-staple',
      },
      { ip },
    )
    expect(signUpResponse.status).toBe(200)
    const cookie = signUpResponse.headers.get('set-cookie')
    expect(cookie).toBeTruthy()

    const response = await post(
      auth,
      '/update-user',
      { isDemo: true },
      { ip, cookie: cookie as string },
    )

    // Better Auth rejects the request outright rather than silently dropping
    // the field, because `isDemo` is `input: false`. Asserting the code as well
    // as the status pins the rejection to that reason and not, say, a failed
    // session or origin check — an update of an ordinary field such as `name`
    // succeeds with 200 through this exact request shape.
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
    expect(db.user[0]).toMatchObject({ isDemo: false })
  })

  it('calls onUserCreated exactly once with the new user id after sign-up', async () => {
    const seeded: string[] = []
    const { auth, db } = makeTestAuth({
      onUserCreated: async (user) => {
        seeded.push(user.id)
      },
    })

    await signUp(
      auth,
      { name: 'Pham Thi D', email: 'pham@example.com', password: 'correct-horse-battery-staple' },
      { ip: nextTestIp() },
    )

    // The app singleton passes `seedDefaultsForUser` here, so this is what
    // guarantees a freshly registered user gets their default account types and
    // categories — and gets exactly one set of them.
    expect(db.user).toHaveLength(1)
    expect(seeded).toEqual([db.user[0].id])
  })
})

/**
 * `playwright.config.ts` sets `CASHFLOW_E2E_DISABLE_RATE_LIMIT=1` only in the
 * env of the dev server it spawns for the e2e suite, so that the suite's many
 * sequential sign-ups don't trip Better Auth's built-in 3-per-10s special rule
 * for `/sign-up/email` (see the comment on `rateLimit` in `create-auth.ts`).
 * These tests pin that the flag is read, and read exactly, by asserting on
 * `auth.options.rateLimit` — the same options object Better Auth's rate
 * limiter middleware consults at request time.
 */
describe('CASHFLOW_E2E_DISABLE_RATE_LIMIT', () => {
  const ENV_KEY = 'CASHFLOW_E2E_DISABLE_RATE_LIMIT'
  const originalValue = process.env[ENV_KEY]

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalValue
  })

  it('leaves rate limiting enabled when the flag is unset', () => {
    delete process.env[ENV_KEY]
    const { auth } = makeTestAuth()
    expect(auth.options.rateLimit?.enabled).toBe(true)
  })

  it('leaves rate limiting enabled when the flag is set to anything other than the exact string "1"', () => {
    process.env[ENV_KEY] = 'true'
    const { auth } = makeTestAuth()
    expect(auth.options.rateLimit?.enabled).toBe(true)
  })

  it('disables rate limiting only when the flag is exactly "1"', () => {
    process.env[ENV_KEY] = '1'
    const { auth } = makeTestAuth()
    expect(auth.options.rateLimit?.enabled).toBe(false)
  })

  it('lets a 4th sign-up within 10s succeed when the flag is set, unlike the default', async () => {
    process.env[ENV_KEY] = '1'
    const { auth } = makeTestAuth()
    const ip = nextTestIp()

    // `signUp` asserts the 200 itself, so a regression here fails loudly at
    // the 4th call rather than needing a duplicate assertion.
    for (let n = 1; n <= 4; n++) {
      await signUp(
        auth,
        { email: `flagged-${n}@example.com`, password: 'correct-horse-battery-staple' },
        { ip },
      )
    }
  })
})
