import { isNonProductionEnvironment } from '@/lib/server/env'

/**
 * The server's only logger (phase 8, E12).
 *
 * The repository's logging *content* discipline already exists — every call
 * site logs a fixed string and never an amount, an email address, a token or a
 * request body. What was missing is *structure*: a level, a timestamp and one
 * parseable line per event, so that a platform's stdout collector can filter by
 * severity and correlate a user's reference code with the server record behind
 * it.
 *
 * Two rules, inherited from the existing discipline and enforced by this
 * module's shape:
 *
 * 1. `event` is a fixed literal (`'request.error'`, `'health.probe_failed'`),
 *    never interpolated user data. It is the thing an operator greps for.
 * 2. `fields` carries small non-PII scalars. Never an email, an amount, an
 *    account name, a session token or a full request body. This module cannot
 *    know what a caller hands it, so it also redacts defensively
 *    ({@link redactFields}) — that guard is a second line of defence, not a
 *    licence to log secrets.
 *
 * Format by environment:
 *
 * - production (anything that is not `development`/`test`) — exactly one JSON
 *   object per line: `{"level":…,"event":…,"time":…,…fields}`.
 * - development and test — one readable line, because JSON in a terminal is
 *   worse than a sentence and the existing suites spy on `console.warn`.
 *
 * No logging library, no transport, no aggregator: stdout on a single host is
 * what every target platform already collects, and Phase 8 explicitly adopts no
 * monitoring platform.
 *
 * Worth knowing beside this convention: Better Auth swallows a failed
 * reset-email delivery and logs `Failed to run background task:` while
 * answering 200 (`README.md`). Once logs are JSON, that string is the one line
 * genuinely worth an alert.
 */

export type LogLevel = 'info' | 'warn' | 'error'

/** What a caller may attach to an event. Values are redacted before printing. */
export type LogFields = Record<string, unknown>

const REDACTED = '[redacted]'

/**
 * Keys whose value is never printed, whatever it is. Matched case-insensitively
 * anywhere in the key, so `Authorization`, `set-cookie`, `resetToken` and
 * `smtpPassword` are all caught.
 */
const SENSITIVE_KEY = /password|token|secret|authorization|cookie|set-cookie/i

/**
 * `scheme://user:password@host` inside any string — a `DATABASE_URL`, an SMTP
 * URL or a driver error that quotes one. The credentials are replaced; the rest
 * of the sentence survives so the log still says what failed.
 */
const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]*@/gi

/** Guards against a cyclic or absurdly deep object reaching `JSON.stringify`. */
const MAX_DEPTH = 4

/** The three keys this module owns; a field of the same name is dropped. */
const RESERVED_FIELDS = new Set(['level', 'event', 'time'])

function isReadableFormat(): boolean {
  return isNonProductionEnvironment()
}

function hasCredentials(value: string): boolean {
  // A bare `SELECT 1` or an English sentence is not a URL, and `new URL` says
  // so by throwing.
  try {
    const url = new URL(value)
    return url.username !== '' || url.password !== ''
  } catch {
    return false
  }
}

function redactString(value: string): string {
  if (hasCredentials(value)) return REDACTED
  return value.replace(CREDENTIALS_IN_URL, `$1${REDACTED}@`)
}

function isErrorLike(value: unknown): value is { name?: unknown; message?: unknown } {
  if (value instanceof Error) return true
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; message?: unknown }
  return typeof candidate.name === 'string' && typeof candidate.message === 'string'
}

/**
 * An error becomes `{ name, message, digest? }` and nothing else — in every
 * environment, production included.
 *
 * No `stack`, ever. A stack is the one field that routinely carries absolute
 * paths and, through framework frames, fragments of arguments; and the reader
 * who needs it in development already has Next's own overlay and its unredacted
 * console output. What the operator needs from a log line is the `digest` that
 * matches the reference code on the user's screen.
 */
function serializeError(error: { name?: unknown; message?: unknown }): Record<string, string> {
  const serialized: Record<string, string> = {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? redactString(error.message) : '',
  }
  const digest = (error as { digest?: unknown }).digest
  if (typeof digest === 'string' && digest !== '') serialized.digest = digest
  return serialized
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  if (typeof value === 'function') return '[function]'
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (isErrorLike(value)) return serializeError(value)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, depth + 1)
    }
    return out
  }
  return undefined
}

/**
 * Masks sensitive keys at any depth and credentials inside any string value.
 * Exported for the tests that prove the guard, not as a general utility.
 */
export function redactFields(fields: LogFields | undefined): Record<string, unknown> {
  if (!fields) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    // `level`/`event`/`time` are this module's own keys: a caller's field of the
    // same name would rewrite the record's identity, so it is dropped rather
    // than allowed to win.
    if (RESERVED_FIELDS.has(key)) continue
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, 1)
  }
  return out
}

function formatReadableValue(value: unknown): string {
  if (typeof value === 'string' && value !== '' && !/[\s"]/.test(value)) return value
  return JSON.stringify(value) ?? String(value)
}

function formatReadable(
  level: LogLevel,
  event: string,
  time: string,
  fields: Record<string, unknown>,
): string {
  const rendered = Object.entries(fields).map(
    ([key, value]) => ` ${key}=${formatReadableValue(value)}`,
  )
  return `${time} ${level.toUpperCase()} ${event}${rendered.join('')}`
}

function write(level: LogLevel, line: string): void {
  // `console.warn`/`console.error` go to stderr and `console.log` to stdout,
  // which is exactly the split a platform's log collector expects.
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  const safe = redactFields(fields)
  const time = new Date().toISOString()
  write(
    level,
    isReadableFormat()
      ? formatReadable(level, event, time, safe)
      : JSON.stringify({ level, event, time, ...safe }),
  )
}

export const log = {
  info(event: string, fields?: LogFields): void {
    emit('info', event, fields)
  },
  warn(event: string, fields?: LogFields): void {
    emit('warn', event, fields)
  },
  error(event: string, fields?: LogFields): void {
    emit('error', event, fields)
  },
}
