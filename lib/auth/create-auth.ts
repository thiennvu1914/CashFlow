import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { isNonProductionEnvironment } from '@/lib/server/env'
import { USER_FIELD_DEFAULTS } from './user-defaults'

/**
 * The e2e escape hatch for Better Auth's rate limiter, and the two conditions
 * that must BOTH hold before it opens.
 *
 * `CASHFLOW_E2E_DISABLE_RATE_LIMIT === '1'` says what the operator asked for;
 * `isNonProductionEnvironment()` says whether this process is allowed to grant
 * it. The second check is the boundary: the variable is set only in the env of
 * the dev server `playwright.config.ts` spawns, but env blocks get copied
 * between a PaaS's environments, `.env` files get shipped into images, and a
 * Dockerfile inherits an `ARG`. If that ever happens, the cost is every rate
 * limit on sign-in, sign-up, change-password, change-email and
 * password-reset silently gone in production — so "nobody sets it there" is
 * not a control.
 *
 * `isNonProductionEnvironment()` (`lib/server/env.ts`) is true for exactly
 * `NODE_ENV=development` and `NODE_ENV=test`. Anything else — production, a
 * typo, or `NODE_ENV` unset, which is how a bare `node server.js` runs — is
 * treated as production and keeps the limiter on. Failing closed is the whole
 * point: an unrecognised environment must not be able to argue its way into
 * the bypass.
 *
 * Deliberately NOT also gated on `E2E_DATABASE_URL` being set. It would cost
 * one line and the Playwright-spawned server does inherit the variable
 * (`webServer.env` spreads `process.env`, into which `loadEnvConfig` has
 * already read `.env`), but it buys nothing: `E2E_DATABASE_URL` is documented
 * in `.env.example`, so the very copy-the-env-block accident this guard exists
 * for carries both variables together. `NODE_ENV` is the one input a
 * production runtime sets for itself.
 *
 * A `console.warn` on the bypass rather than silence: a developer who left the
 * variable exported in their shell should be able to see why sign-in never
 * locks out. Only the variable NAME is printed, never a value — and only
 * once, because `next dev` re-evaluates this module on every recompile and a
 * per-call warning buries the dev server's real output.
 */
let bypassWarned = false

function isRateLimitDisabledForE2e(): boolean {
  if (process.env.CASHFLOW_E2E_DISABLE_RATE_LIMIT !== '1') return false
  if (!isNonProductionEnvironment()) return false
  if (!bypassWarned && process.env.NODE_ENV !== 'test') {
    bypassWarned = true
    console.warn(
      'CASHFLOW_E2E_DISABLE_RATE_LIMIT is set: auth rate limiting is DISABLED for this process.',
    )
  }
  return true
}

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
  /**
   * IPs / CIDR ranges of the reverse proxies or CDN nodes in front of this app,
   * passed straight through to Better Auth's
   * `advanced.ipAddress.trustedProxies`
   * (`node_modules/@better-auth/core/dist/types/init-options.d.mts`).
   *
   * Rate limiting keys on `<clientIp>|<path>`, and the client IP comes from
   * `x-forwarded-for`. With no trusted proxies configured, Better Auth trusts
   * a header only when it holds exactly one value
   * (`getIPFromHeader` in `node_modules/@better-auth/core/dist/utils/ip.mjs`)
   * — which a direct client can forge, and which a chain-appending proxy never
   * produces, collapsing every caller into a single bucket. With them set, the
   * chain is walked right to left, trusted hops are skipped, and the first
   * untrusted address wins — so a spoofed left-most entry is ignored.
   *
   * `lib/auth/auth.ts` fills this from `TRUSTED_PROXY_CIDRS` and requires it in
   * production. Left undefined (dev/test, or a direct-to-Node deployment),
   * Better Auth keeps its single-value-header behaviour.
   */
  trustedProxies?: string[]
  /**
   * Called once, after Better Auth has written a new user row, with that row's
   * id. `lib/auth/auth.ts` passes `seedDefaultsForUser`, which creates the
   * user's default account types and categories; tests pass a recorder, or
   * nothing at all when registration side effects are not what they exercise.
   *
   * Injected rather than imported here so that `createAuth` itself stays free
   * of a `lib/prisma.ts` dependency — that is what lets the whole auth suite
   * run on the in-memory adapter with no database.
   */
  onUserCreated?: (user: { id: string }) => Promise<void>
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
    advanced: {
      ipAddress: {
        // `ipAddressHeaders` is deliberately left out so Better Auth keeps its
        // default of `["x-forwarded-for"]` (`DEFAULT_IP_HEADERS` in
        // `node_modules/@better-auth/core/dist/utils/ip.mjs`). Only the
        // trusted-proxy list is configured here.
        trustedProxies: options.trustedProxies,
      },
    },
    // Better Auth only rate-limits by default when `NODE_ENV=production`
    // (`enabled: options.rateLimit?.enabled ?? isProduction` in
    // `node_modules/better-auth/dist/context/create-context.mjs`). Setting
    // `enabled: true` explicitly makes dev/test behave the same as prod
    // instead of silently having no protection outside production.
    //
    // Storage is left at its default, an in-memory Map local to this process
    // (`node_modules/better-auth/dist/api/rate-limiter/index.mjs`). That is
    // fine for the single-instance MVP; if this app is ever horizontally
    // scaled, a shared store (`rateLimit.storage: 'secondary-storage'` backed
    // by Redis, or a custom store) is needed so one instance's count is seen
    // by the others.
    //
    // Rule paths are matched against the request path with the
    // `/api/auth` base stripped (`normalizePathname` in
    // `node_modules/@better-auth/core/dist/utils/url.mjs`), so `/sign-in/email`
    // and `/request-password-reset` below match `POST /api/auth/sign-in/email`
    // and `POST /api/auth/request-password-reset` respectively — confirmed in
    // `node_modules/better-auth/dist/api/rate-limiter/index.mjs`
    // (`resolveRateLimitConfig`). Better Auth also ships its own built-in
    // "special rules" for these same paths (`getDefaultSpecialRules` in that
    // file): sign-in/sign-up/change-password/change-email get 3 requests per
    // 10s, and request-password-reset/forget-password/send-verification-email
    // get 3 per 60s. A `customRules` entry with an exact-path key (no `*`)
    // always wins over those built-ins when present, so the values below are
    // the ones actually enforced for these two paths, not Better Auth's
    // (stricter) defaults.
    //
    // `/sign-up/email` has no `customRules` entry, so it is left on Better
    // Auth's built-in special rule of 3 requests per 10s (same file, same
    // function). That is deliberately strict for production, but the
    // Playwright e2e suite registers a brand-new user in almost every test
    // across many spec files run with `workers: 1`, so several sign-ups can
    // land inside one 10s window and the 4th (or later) gets 429 — which
    // `components/auth/register-form.tsx` shows as the generic "Something
    // went wrong" and strands the test on `/register`. `playwright.config.ts`
    // sets `CASHFLOW_E2E_DISABLE_RATE_LIMIT=1` only in the env of the dev
    // server IT spawns, so this check disables rate limiting only for that
    // process — never for `npm run dev` on its own, and never for the unit
    // tests in this directory (`rate-limit.test.ts` and the others call
    // `createAuth` directly with no env override, so they keep exercising
    // the real limiter). `isRateLimitDisabledForE2e` above additionally
    // refuses the bypass outside development and test, so a production
    // process that somehow inherits the variable keeps its limiter.
    rateLimit: {
      enabled: !isRateLimitDisabledForE2e(),
      window: 60,
      max: 10,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 5 },
      },
    },
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
      // Defaults to false. A reset is how someone recovers an account they may
      // have lost control of, so every pre-existing session must die with the
      // old password — otherwise an attacker who is already signed in keeps
      // their session after the real owner resets.
      revokeSessionsOnPasswordReset: true,
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
      // The values come from `lib/auth/user-defaults.ts`, the single source
      // shared with `lib/validation/profile.ts`. The matching `@default(...)`
      // in `prisma/schema.prisma` is what covers rows written by anything else.
      additionalFields: {
        baseCurrency: {
          type: 'string',
          defaultValue: USER_FIELD_DEFAULTS.baseCurrency,
          input: false,
        },
        locale: { type: 'string', defaultValue: USER_FIELD_DEFAULTS.locale, input: false },
        theme: { type: 'string', defaultValue: USER_FIELD_DEFAULTS.theme, input: false },
        timezone: { type: 'string', defaultValue: USER_FIELD_DEFAULTS.timezone, input: false },
        isDemo: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Better Auth 1.7.2 types this as
          // `(user: User & Record<string, unknown>, context: GenericEndpointContext | null) => Promise<void>`
          // (`databaseHooks` in
          // `node_modules/@better-auth/core/dist/types/init-options.d.mts`).
          // This runs AFTER the user row is committed (`with-hooks.mjs` in
          // `node_modules/better-auth/dist/db/`, whose transaction has already
          // closed by then — see
          // `node_modules/@better-auth/core/dist/context/transaction.mjs`), so
          // it is not part of the same atomic unit. A throw here therefore
          // leaves a committed user whose defaults are missing, and turns the
          // sign-up response into an error.
          //
          // Still deliberately not wrapped in try/catch: surfacing the failure
          // beats silently handing back an account with no account types or
          // categories, and the damage is repairable — `seedDefaultsForUser`
          // skips tables that already have rows, so re-running it for that user
          // finishes the job without duplicating what did get written.
          after: async (user) => {
            await options.onUserCreated?.(user)
          },
        },
      },
    },
  })
}
