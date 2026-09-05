import { betterAuth, type BetterAuthOptions } from 'better-auth'

export interface CreateAuthOptions {
  /**
   * The Better Auth database adapter. Injected rather than hard-wired so tests
   * can run the real auth instance against an in-memory database.
   */
  database: NonNullable<BetterAuthOptions['database']>
  /**
   * NOT WIRED YET — accepted so Task 6 has a seam to fill, but `createAuth`
   * deliberately ignores it until then: `emailAndPassword.sendResetPassword` is
   * added in Task 6, once Task 5's EmailSender abstraction exists for real,
   * rather than being stubbed here and replaced later. Passing it today sends
   * no email. Forgot Password is simply not wired up between now and Task 6;
   * every other auth flow (register / login / logout / change password) works
   * fully from this commit onward.
   */
  sendResetPasswordEmail?: (to: string, url: string) => Promise<void>
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
      // `sendResetPassword` is intentionally absent — see
      // `CreateAuthOptions.sendResetPasswordEmail`.
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
