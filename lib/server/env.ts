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
 * is exactly the moment a value would end up in a platform log.
 *
 * Behaviour by environment:
 *
 * - production — one aggregated `Error` listing every offending variable, so a
 *   misconfigured deployment crashes on start instead of serving requests with
 *   a broken security property (a forgeable session cookie, a spoofable
 *   rate-limit key, a host-header-derived reset link, undeliverable email).
 * - development — `console.warn` naming the same variables and continue, so a
 *   half-configured local checkout still boots.
 * - test — silent. The suites stub environments on purpose and must not be
 *   drowned in warnings.
 *
 * `next build` runs with `NODE_ENV=production` but is not a boot: it imports
 * every route module to collect page data while serving no requests, and CI
 * builds legitimately have no auth or SMTP configuration. Next marks that pass
 * with `NEXT_PHASE=phase-production-build`
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
 * fails the process at start.
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

export interface ServerEnv {
  nodeEnv: 'development' | 'test' | 'production'
  isProduction: boolean
  isBuildPhase: boolean
  databaseUrl: string | undefined
  betterAuthSecret: string | undefined
  betterAuthUrl: string | undefined
  trustedProxyCidrs: string[]
  smtpHost: string | undefined
  smtpPort: number | undefined
  smtpUser: string | undefined
  smtpPassword: string | undefined
  emailFrom: string | undefined
  emailOutboxFile: string | undefined
  timezone: string | undefined
}

export interface ServerEnvValidation {
  env: ServerEnv
  /** Fatal in production, warned about in development. `NAME: reason` lines. */
  problems: string[]
  /** Advisory everywhere; never fatal. `NAME: reason` lines. */
  warnings: string[]
}

/** `true` only for a real production process. Unset `NODE_ENV` is not production. */
export function isProduction(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.NODE_ENV === 'production'
}

/**
 * `true` for the environments the automated suites run in. Fail-closed: an
 * unset or unrecognised `NODE_ENV` is NOT test-like, so a test-only bypass
 * gated on this can never open by accident. Exported for the callers that must
 * refuse a test-only switch outside these environments.
 */
export function isTestLikeEnvironment(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.NODE_ENV === 'test' || source.NODE_ENV === 'development'
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

/**
 * The declarative shape. Every field is optional here and every message is
 * written by hand (never zod's default, which can quote the received input) —
 * which variables are *required* depends on the environment and is decided in
 * `requirementProblems` below.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
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
    .refine((value) => URL.canParse(value) && new URL(value).protocol.startsWith('http'), {
      message: 'BETTER_AUTH_URL: must be an absolute http(s) origin',
    })
    .optional(),
  TRUSTED_PROXY_CIDRS: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z
    .string()
    .refine(
      (value) => {
        const port = Number.parseInt(value, 10)
        return String(port) === value.trim() && port > 0 && port <= 65535
      },
      { message: 'SMTP_PORT: must be an integer between 1 and 65535' },
    )
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

  const smtpHost = trimmedOrUndefined(source.SMTP_HOST)
  const smtpPortRaw = trimmedOrUndefined(source.SMTP_PORT)
  const smtpPortParsed = smtpPortRaw === undefined ? Number.NaN : Number.parseInt(smtpPortRaw, 10)

  const env: ServerEnv = {
    nodeEnv,
    isProduction: nodeEnvRaw === 'production',
    isBuildPhase: trimmedOrUndefined(source.NEXT_PHASE) === NEXT_BUILD_PHASE,
    databaseUrl: trimmedOrUndefined(source.DATABASE_URL),
    betterAuthSecret: trimmedOrUndefined(source.BETTER_AUTH_SECRET),
    betterAuthUrl: trimmedOrUndefined(source.BETTER_AUTH_URL),
    trustedProxyCidrs: parseTrustedProxies(source.TRUSTED_PROXY_CIDRS),
    smtpHost,
    smtpPort: Number.isInteger(smtpPortParsed) ? smtpPortParsed : undefined,
    smtpUser: trimmedOrUndefined(source.SMTP_USER),
    smtpPassword: trimmedOrUndefined(source.SMTP_PASSWORD),
    emailFrom: trimmedOrUndefined(source.EMAIL_FROM),
    emailOutboxFile: trimmedOrUndefined(source.EMAIL_OUTBOX_FILE),
    timezone: trimmedOrUndefined(source.TZ),
  }

  const problems = [...formatProblems]
  const warnings: string[] = []

  // Always required: the app cannot construct a Prisma client without it, in
  // any environment and at build time too.
  if (env.databaseUrl === undefined) {
    problems.push('DATABASE_URL: required but not set')
  }

  // `getEmailSender()` owns "production must use SMTP" and its own message;
  // this module only pins the variables the SMTP transport needs once that
  // sender is the one selected.
  if (env.smtpHost !== undefined && smtpPortRaw === undefined) {
    problems.push('SMTP_PORT: required when SMTP_HOST is set')
  }

  if (env.isProduction && !env.isBuildPhase) {
    const secret = secretProblem(env.betterAuthSecret)
    if (secret !== undefined) problems.push(secret)

    if (env.betterAuthUrl === undefined) {
      problems.push(
        'BETTER_AUTH_URL: required in production but not set; it pins the origin used in emailed reset links',
      )
    }
    if (env.trustedProxyCidrs.length === 0) {
      problems.push(
        'TRUSTED_PROXY_CIDRS: required in production but not set; without the reverse-proxy CIDRs rate limiting cannot identify a client',
      )
    }
    if (env.emailFrom === undefined) {
      problems.push(
        'EMAIL_FROM: required in production but not set; messages sent without a From address are rejected or spam-filed',
      )
    }
    if (env.emailOutboxFile !== undefined) {
      warnings.push(
        'EMAIL_OUTBOX_FILE: set in a production process; it is ignored there (the file outbox is never a production transport) and should be removed',
      )
    }
    for (const name of TEST_ONLY_VARIABLES) {
      if (trimmedOrUndefined(source[name]) !== undefined) {
        warnings.push(`${name}: test-only variable set in a production process; remove it`)
      }
    }
    if (env.timezone !== REQUIRED_SERVER_TIMEZONE) {
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
 * Validates the process environment once and returns the parsed contract.
 *
 * Called at module load by the three modules that already read the environment
 * at server start — `lib/prisma.ts`, `lib/auth/auth.ts` and
 * `lib/email/get-sender.ts` — so the check runs exactly once per process and a
 * production misconfiguration is fatal before the first request.
 *
 * Pass an explicit `source` to validate an arbitrary environment; that form is
 * never cached.
 */
export function loadServerEnv(source?: NodeJS.ProcessEnv): ServerEnv {
  if (source === undefined && cached !== undefined) return cached

  const { env, problems, warnings } = validateServerEnv(source ?? process.env)

  if (problems.length > 0 && env.isProduction && !env.isBuildPhase) {
    throw new Error(
      'Invalid server environment; refusing to start. Fix these variables ' +
        `(names only, no values are ever printed): ${problems.join(' | ')}`,
    )
  }

  if (env.nodeEnv === 'development' && (problems.length > 0 || warnings.length > 0)) {
    for (const line of [...problems, ...warnings]) {
      console.warn(`[env] ${line}`)
    }
  }

  if (source === undefined) cached = env
  return env
}

/** Test-only: drops the per-process cache so a suite can re-validate. */
export function resetServerEnvCache(): void {
  cached = undefined
}
