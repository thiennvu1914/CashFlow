import { betterAuth, type BetterAuthOptions } from 'better-auth'

export interface CreateAuthOptions {
  /**
   * The Better Auth database adapter. Injected rather than hard-wired so tests
   * can run the real auth instance against an in-memory database.
   */
  database: NonNullable<BetterAuthOptions['database']>
  /**
   * Overrides Better Auth's `BETTER_AUTH_URL` / request-derived base URL. Only
   * set by tests, which must not depend on the developer's local `.env`.
   */
  baseURL?: string
  /**
   * Overrides Better Auth's `BETTER_AUTH_SECRET`. Only set by tests, for the
   * same reason as `baseURL`. The app singleton always reads the real secret
   * from the environment.
   */
  secret?: string
  /**
   * Delivers the password-reset link. Required — every auth instance must have
   * real delivery, so a misconfigured build fails at construction rather than
   * silently dropping reset emails. `lib/auth/auth.ts` passes the real sender;
   * tests pass a fake that records what would have been sent.
   */
  sendResetPasswordEmail: (to: string, url: string) => Promise<void>
}

/**
 * Build a Better Auth instance with CashFlow's configuration.
 *
 * `lib/auth/auth.ts` calls this once with the Prisma adapter to create the app
 * singleton; tests call it with an in-memory adapter.
 */
export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: options.database,
    // Both fall back to the environment when undefined (Better Auth treats a
    // falsy value as "not provided").
    baseURL: options.baseURL,
    secret: options.secret,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // Same bounds as `registerSchema` / `resetPasswordSchema` in
      // `lib/validation/auth.ts`. These happen to be Better Auth's defaults;
      // stating them keeps the client-side Zod rules and the server-side
      // enforcement provably in step.
      minPasswordLength: 8,
      maxPasswordLength: 128,
      // Deliberately not wrapped in try/catch: a rejection must propagate, not
      // be turned into a fake success here. (Better Auth 1.7.2 awaits this via
      // `runInBackgroundOrAwait`, which logs a rejection and still answers 200
      // — see `node_modules/better-auth/dist/context/create-context.mjs`. That
      // is its choice, not ours: the endpoint intentionally returns the same
      // "if this email exists…" body for every address so nothing leaks.)
      sendResetPassword: async ({ user, url }) => {
        await options.sendResetPasswordEmail(user.email, url)
      },
    },
    user: {
      // `input: false` on every additional field means none of them can be set
      // through Better Auth's own sign-up / update-user request bodies —
      // changes go only through our own profile-update server action (Task 7),
      // which never accepts `isDemo` at all. This is the first of two
      // independent layers blocking a client-set `isDemo` (§4.1, §13 of the
      // spec); Task 7 adds the second.
      //
      // `defaultValue` is applied by Better Auth when it creates the record.
      // The matching `@default(...)` in `prisma/schema.prisma` is what covers
      // rows written by anything else.
      additionalFields: {
        baseCurrency: { type: 'string', defaultValue: 'VND', input: false },
        locale: { type: 'string', defaultValue: 'vi', input: false },
        theme: { type: 'string', defaultValue: 'light', input: false },
        timezone: { type: 'string', defaultValue: 'Asia/Ho_Chi_Minh', input: false },
        isDemo: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async () => {
            // Phase 2 Task 1 seeds DEFAULT_ACCOUNT_TYPES and DEFAULT_CATEGORIES
            // for `user.id` here.
          },
        },
      },
    },
  })
}
