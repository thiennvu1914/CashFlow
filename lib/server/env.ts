import { z } from 'zod'
import { parseTrustedProxies } from '@/lib/auth/trusted-proxies'

/**
 * The one place that decides what "production-ready configuration" means for
 * this app.
 *
 * Every variable the server reads is declared here, validated here, and
 * reported by NAME only. No message this module produces — thrown or logged —
 * ever interpolates a value, because the same code path handles
 * `BETTER_AUTH_SECRET`, `SMTP_PASSWORD` and `DATABASE_URL`, and a boot failure
 * is exactly the moment a value would end up in a platform log. For the same
 * reason the returned object carries only the values a caller actually
 * consumes: no cached record of `SMTP_PASSWORD` or `SMTP_USER` exists.
 *
 * Behaviour by environment:
 *
 * - production — one aggregated `Error` listing every offending variable, so a
 *   misconfigured deployment crashes instead of serving requests with a broken
 *   security property (a forgeable session cookie, a spoofable rate-limit key,
 *   a host-header-derived reset link, undeliverable email).
 * - development — `console.warn` naming the same variables and continue, so a
 *   half-configured local checkout still boots.
 * - test — silent. The suites stub environments on purpose and must not be
 *   drowned in warnings.
 *
 * Advisory findings (`warnings`) are logged in every non-test environment,
 * production included, and never fail a boot.
 *
 * The check runs before the first request that touches the database, auth or
 * email: `lib/prisma.ts`, `lib/auth/auth.ts` and `lib/email/get-sender.ts` all
 * call `loadServerEnv()`, the first of them at module load, and the result is
 * cached for the process.
 *
 * `next build` runs with `NODE_ENV=production` but serves nothing: it imports
 * every route module to collect page data, and CI builds legitimately have no
 * auth or SMTP configuration. Next marks that pass with
 * `NEXT_PHASE=phase-production-build`
 * (`node_modules/next/dist/build/index.js`), which is the one production case
 * exempted here. `next start` and any serverless runtime leave `NEXT_PHASE`
 * unset, so a real production process is still checked.
 *
 * This module absorbs the former `lib/auth/production-config.ts`
 * (`BETTER_AUTH_URL`, `TRUSTED_PROXY_CIDRS`) so there is one source of truth
 * rather than the same production/dev distinction re-derived per module.
 */

const NEXT_BUILD_PHASE = 'phase-production-build'

/**
 * The literal secret shipped in `.env.example`. It is exported so the example
 * file and the guard that rejects it cannot drift: an operator who runs
 * `cp .env.example .env` and deploys is refused at boot rather than signing
 * every session cookie and password-reset token with a string that is public
 * in this repository.
 */
export const PLACEHOLDER_BETTER_AUTH_SECRET =
  'replace-me-with-openssl-rand-base64-32-output-not-this-placeholder'

/**
 * Better Auth's own fallback secret (`DEFAULT_SECRET` in
 * `node_modules/better-auth/dist/context/create-context.mjs`). Better Auth
 * throws on it too, but only lazily on the first request; rejecting it here
 * fails the process earlier.
 */
const BETTER_AUTH_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890'

/** Better Auth's documented floor for a signing secret. */
export const MIN_BETTER_AUTH_SECRET_LENGTH = 32

/** The server/container timezone contract: all period math starts from UTC. */
export const REQUIRED_SERVER_TIMEZONE = 'UTC'

/**
 * Variables that exist only for the test harnesses. Their presence in a
 * production process is reported (by name) because each one is a foot-gun
 * there: two of them point at a throwaway database and one is the e2e
 * rate-limit switch.
 */
const TEST_ONLY_VARIABLES = [
  'TEST_DATABASE_URL',
  'E2E_DATABASE_URL',
  'CASHFLOW_E2E_DISABLE_RATE_LIMIT',
] as const

/**
 * Only the values a caller consumes. `DATABASE_URL` and `BETTER_AUTH_SECRET`
 * are here because `lib/prisma.ts` and `lib/auth/auth.ts` need them; the SMTP
 * credentials, `EMAIL_FROM`, `EMAIL_OUTBOX_FILE` and `TZ` are validated but
 * deliberately NOT carried, so a long-lived cached object never holds them.
 * `lib/email/smtp-sender.ts` keeps reading those from `process.env` at the
 * moment it sends.
 */
export interface ServerEnv {
  nodeEnv: 'development' | 'test' | 'production'
  isProduction: boolean
  isBuildPhase: boolean
  databaseUrl: string | undefined
  betterAuthSecret: string | undefined
  trustedProxyCidrs: string[]
}

export interface ServerEnvValidation {
  env: ServerEnv
  /** Fatal in production, warned about elsewhere. `NAME: reason` lines. */
  problems: string[]
  /** Advisory in every non-test environment; never fatal. `NAME: reason` lines. */
  warnings: string[]
}

/** `true` only for a real production process. Unset `NODE_ENV` is not production. */
export function isProduction(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.NODE_ENV === 'production'
}

/**
 * `true` for the two environments this app is allowed to run outside
 * production: `development` (which includes the dev server Playwright spawns)
 * and `test`. Fail-closed on purpose — an unset or unrecognised `NODE_ENV` is
 * NOT one of them, so a test-only bypass gated on this can never open by
 * accident on a host that forgot to set `NODE_ENV`. Exported for the callers
 * that must refuse a test-only switch outside these environments.
 */
export function isNonProductionEnvironment(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.NODE_ENV === 'development' || source.NODE_ENV === 'test'
}

/** `true` while `next build` is collecting page data (no requests are served). */
export function isNextBuildPhase(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.NEXT_PHASE === NEXT_BUILD_PHASE
}

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A port is valid only if the whole string round-trips through the parse. */
function isValidPort(value: string): boolean {
  const port = Number.parseInt(value, 10)
  return String(port) === value && port > 0 && port <= 65535
}

/**
 * The declarative shape. Every field is optional here and every message is
 * written by hand (never zod's default, which can quote the received input).
 * Which variables are *required* depends on the environment, and is decided in
 * `validateServerEnv` below.
 */
const serverEnvSchema = z.object({
  // Deliberately `z.string()` rather than `z.enum(...)`: zod's own enum
  // message can quote the received value, and nothing this module emits may
  // carry a value. An unrecognised NODE_ENV is reported as a warning below.
  NODE_ENV: z.string().optional(),
  NEXT_PHASE: z.string().optional(),
  DATABASE_URL: z
    .string()
    .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
      message: 'DATABASE_URL: must be a postgres:// or postgresql:// connection string',
    })
    .optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z
    .string()
    .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
      message: 'BETTER_AUTH_URL: must be an absolute http(s) origin',
    })
    .optional(),
  TRUSTED_PROXY_CIDRS: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z
    .string()
    .refine(isValidPort, { message: 'SMTP_PORT: must be an integer between 1 and 65535' })
    .optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_OUTBOX_FILE: z.string().optional(),
  TZ: z.string().optional(),
})

function secretProblem(secret: string | undefined): string | undefined {
  if (secret === undefined) return 'BETTER_AUTH_SECRET: required in production but not set'
  if (secret === PLACEHOLDER_BETTER_AUTH_SECRET || secret === BETTER_AUTH_DEFAULT_SECRET) {
    return 'BETTER_AUTH_SECRET: still set to a known placeholder; generate one with `openssl rand -base64 32`'
  }
  if (secret.length < MIN_BETTER_AUTH_SECRET_LENGTH) {
    return `BETTER_AUTH_SECRET: shorter than the ${MIN_BETTER_AUTH_SECRET_LENGTH}-character minimum`
  }
  return undefined
}

/**
 * Runs the whole contract against a plain environment object. Pure: it neither
 * throws, logs, nor reads `process.env` itself, so tests exercise every branch
 * without a process to corrupt.
 */
export function validateServerEnv(source: NodeJS.ProcessEnv): ServerEnvValidation {
  const normalized: Record<string, string | undefined> = {}
  for (const key of Object.keys(serverEnvSchema.shape)) {
    normalized[key] = trimmedOrUndefined(source[key])
  }

  const parsed = serverEnvSchema.safeParse(normalized)
  const formatProblems = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)

  const nodeEnvRaw = trimmedOrUndefined(source.NODE_ENV)
  const nodeEnv =
    nodeEnvRaw === 'production' || nodeEnvRaw === 'test' || nodeEnvRaw === 'development'
      ? nodeEnvRaw
      : 'development'

  const isBuildPhase = trimmedOrUndefined(source.NEXT_PHASE) === NEXT_BUILD_PHASE
  const isProductionRuntime = nodeEnvRaw === 'production' && !isBuildPhase

  const smtpHost = normalized.SMTP_HOST
  const smtpPort = normalized.SMTP_PORT
  const smtpUser = normalized.SMTP_USER
  const smtpPassword = normalized.SMTP_PASSWORD
  const emailFrom = normalized.EMAIL_FROM
  const emailOutboxFile = normalized.EMAIL_OUTBOX_FILE
  const timezone = normalized.TZ

  const env: ServerEnv = {
    nodeEnv,
    isProduction: nodeEnvRaw === 'production',
    isBuildPhase,
    databaseUrl: normalized.DATABASE_URL,
    betterAuthSecret: normalized.BETTER_AUTH_SECRET,
    trustedProxyCidrs: parseTrustedProxies(source.TRUSTED_PROXY_CIDRS),
  }

  const problems = [...formatProblems]
  const warnings: string[] = []

  // Always required: the app cannot construct a Prisma client without it, in
  // any environment and at build time too.
  if (env.databaseUrl === undefined) {
    problems.push('DATABASE_URL: required but not set')
  }

  // Whenever SMTP is the selected sender — production always, elsewhere as soon
  // as SMTP_HOST is set — the transport's own inputs must be complete.
  // `lib/email/smtp-sender.ts` adds SMTP auth only when SMTP_USER is set and
  // then passes SMTP_PASSWORD with it, so authentication is optional (an
  // anonymous relay is legal) but half-configured authentication is not: a user
  // without a password authenticates with `undefined` and every send fails.
  if (smtpHost !== undefined) {
    if (smtpPort === undefined) {
      problems.push('SMTP_PORT: required when SMTP_HOST is set')
    }
    if (smtpUser !== undefined && smtpPassword === undefined) {
      problems.push('SMTP_PASSWORD: required when SMTP_USER is set')
    }
  }

  if (isProductionRuntime) {
    const secret = secretProblem(env.betterAuthSecret)
    if (secret !== undefined) problems.push(secret)

    if (normalized.BETTER_AUTH_URL === undefined) {
      problems.push(
        'BETTER_AUTH_URL: required in production but not set; it pins the origin used in emailed reset links',
      )
    }
    if (env.trustedProxyCidrs.length === 0) {
      problems.push(
        'TRUSTED_PROXY_CIDRS: required in production but not set; without the reverse-proxy CIDRs rate limiting cannot identify a client',
      )
    }
    // Production has exactly one legal transport: SMTP. The console sender
    // prints reset links and the file outbox writes them to disk, and both are
    // refused by `getEmailSender()` there, so a production process without
    // SMTP_HOST cannot deliver a password reset at all — that is a boot
    // failure, not a first-send surprise.
    if (smtpHost === undefined) {
      problems.push(
        'SMTP_HOST: required in production but not set; SMTP is the only transport production accepts (the console and file senders are refused there)',
      )
    }
    if (emailFrom === undefined) {
      problems.push(
        'EMAIL_FROM: required in production but not set; messages sent without a From address are rejected or spam-filed',
      )
    }

    if (emailOutboxFile !== undefined) {
      warnings.push(
        'EMAIL_OUTBOX_FILE: set in a production process; it is ignored there (the file outbox is never a production transport) and should be removed',
      )
    }
    for (const name of TEST_ONLY_VARIABLES) {
      if (trimmedOrUndefined(source[name]) !== undefined) {
        warnings.push(`${name}: test-only variable set in a production process; remove it`)
      }
    }
    if (timezone !== REQUIRED_SERVER_TIMEZONE) {
      warnings.push(
        `TZ: the server contract is TZ=${REQUIRED_SERVER_TIMEZONE}; user-facing dates come from User.timezone`,
      )
    }
  }

  if (nodeEnvRaw !== undefined && nodeEnvRaw !== nodeEnv) {
    warnings.push('NODE_ENV: unrecognised value; treated as development')
  }

  return { env, problems, warnings }
}

let cached: ServerEnv | undefined

/**
 * Validates the process environment and returns the parsed contract, cached
 * for the process.
 *
 * Called by the three modules that read the environment for real —
 * `lib/prisma.ts`, `lib/auth/auth.ts` and `lib/email/get-sender.ts` — so the
 * contract is enforced before the first request that touches the database,
 * auth or email, and a production misconfiguration is fatal rather than a
 * broken feature discovered later.
 *
 * Pass an explicit `source` to validate an arbitrary environment; that form is
 * never cached.
 */
export function loadServerEnv(source?: NodeJS.ProcessEnv): ServerEnv {
  if (source === undefined && cached !== undefined) return cached

  const { env, problems, warnings } = validateServerEnv(source ?? process.env)
  const fatal = problems.length > 0 && env.isProduction && !env.isBuildPhase

  // Warnings are advisory everywhere and must be visible in production too —
  // they are how an operator learns that a test-only variable or a stray
  // outbox path reached a real deployment. They are emitted before the throw
  // so a fatal boot still reports them. Problems are logged only when they are
  // not about to be thrown. Names only, never values.
  if (env.nodeEnv !== 'test') {
    for (const line of fatal ? warnings : [...problems, ...warnings]) {
      console.warn(`[env] ${line}`)
    }
  }

  if (fatal) {
    throw new Error(
      'Invalid server environment; refusing to start. Fix these variables ' +
        `(names only, no values are ever printed): ${problems.join(' | ')}`,
    )
  }

  if (source === undefined) cached = env
  return env
}

/** Test-only: drops the per-process cache so a suite can re-validate. */
export function resetServerEnvCache(): void {
  cached = undefined
}
