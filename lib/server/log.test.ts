import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { log, redactFields } from '@/lib/server/log'

/**
 * `NODE_ENV` is read-only in the Next type surface but writable at runtime; the
 * same assignment shape the env and auth suites already use.
 */
function setNodeEnv(value: string): void {
  ;(process.env as Record<string, string>).NODE_ENV = value
}

describe('lib/server/log', () => {
  const originalNodeEnv = process.env.NODE_ENV
  let logSpy: MockInstance
  let warnSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setNodeEnv(originalNodeEnv ?? 'test')
  })

  describe('format', () => {
    it('writes one readable line in development, not JSON', () => {
      setNodeEnv('development')

      log.info('server.start', { runtime: 'nodejs' })

      expect(logSpy).toHaveBeenCalledTimes(1)
      const line = logSpy.mock.calls[0][0] as string
      // One string argument, so the existing suites that assert
      // `toHaveBeenCalledWith(expect.stringContaining(...))` keep working.
      expect(logSpy.mock.calls[0]).toHaveLength(1)
      expect(line).toContain('INFO')
      expect(line).toContain('server.start')
      expect(line).toContain('runtime=nodejs')
      expect(() => JSON.parse(line)).toThrow()
    })

    it('writes exactly one JSON object per line in production', () => {
      setNodeEnv('production')

      log.warn('health.probe_failed', { durationMs: 2000, ok: false })

      expect(warnSpy).toHaveBeenCalledTimes(1)
      const line = warnSpy.mock.calls[0][0] as string
      expect(line).not.toContain('\n')
      const record = JSON.parse(line) as Record<string, unknown>
      expect(record.level).toBe('warn')
      expect(record.event).toBe('health.probe_failed')
      expect(typeof record.time).toBe('string')
      expect(new Date(record.time as string).toISOString()).toBe(record.time)
      expect(record.durationMs).toBe(2000)
      expect(record.ok).toBe(false)
    })

    it('routes each level to its own console channel', () => {
      setNodeEnv('production')

      log.info('a.b')
      log.warn('c.d')
      log.error('e.f')

      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it('drops a field that would overwrite level, event or time', () => {
      setNodeEnv('production')

      log.error('request.error', { level: 'info', event: 'spoofed', time: 'nope', path: '/x' })

      const record = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>
      expect(record.level).toBe('error')
      expect(record.event).toBe('request.error')
      expect(record.time).not.toBe('nope')
      expect(record.path).toBe('/x')
    })
  })

  describe('redaction', () => {
    it('masks sensitive keys at the top level and nested, case-insensitively', () => {
      expect(
        redactFields({
          password: 'hunter2',
          Authorization: 'Bearer abc',
          resetToken: 'tok_123',
          'set-cookie': 'session=abc',
          smtp: { SMTP_PASSWORD: 'p', user: 'ops' },
          nested: { deeper: { sessionSecret: 's', kept: 1 } },
          kept: 'visible',
        }),
      ).toEqual({
        password: '[redacted]',
        Authorization: '[redacted]',
        resetToken: '[redacted]',
        'set-cookie': '[redacted]',
        smtp: { SMTP_PASSWORD: '[redacted]', user: 'ops' },
        nested: { deeper: { sessionSecret: '[redacted]', kept: 1 } },
        kept: 'visible',
      })
    })

    it('masks a string value that is a URL carrying credentials', () => {
      const redacted = redactFields({
        databaseUrl: 'postgresql://cashflow:s3cret@db.internal:5432/cashflow',
        safeUrl: 'https://example.test/api/health',
      })

      expect(redacted.databaseUrl).toBe('[redacted]')
      expect(redacted.safeUrl).toBe('https://example.test/api/health')
    })

    it('masks credentials embedded in a longer message', () => {
      const redacted = redactFields({
        message: 'connect ECONNREFUSED postgres://user:pw@10.0.0.2:5432/db while starting',
      })

      expect(redacted.message).toBe(
        'connect ECONNREFUSED postgres://[redacted]@10.0.0.2:5432/db while starting',
      )
      expect(redacted.message).not.toContain('pw@')
    })

    it('masks sensitive values through the real logger, not only the helper', () => {
      setNodeEnv('production')

      log.error('request.error', {
        cookie: 'session=abc',
        url: 'postgresql://u:p@host/db',
      })

      const line = errorSpy.mock.calls[0][0] as string
      expect(line).not.toContain('session=abc')
      expect(line).not.toContain('u:p@host')
      const record = JSON.parse(line) as Record<string, unknown>
      expect(record.cookie).toBe('[redacted]')
      expect(record.url).toBe('[redacted]')
    })

    it('serialises a Map and a Set as arrays instead of JSON.stringify silently dropping their entries to {}', () => {
      const redacted = redactFields({
        seen: new Set(['a', 'b']),
        counts: new Map<string, number>([
          ['x', 1],
          ['y', 2],
        ]),
      })

      expect(redacted.seen).toEqual(['a', 'b'])
      expect(redacted.counts).toEqual([
        ['x', 1],
        ['y', 2],
      ])
      // The failure mode this guards: `JSON.stringify(new Map(...))` is `'{}'`.
      expect(JSON.stringify(redacted.counts)).not.toBe('{}')
    })

    it('still masks a Map/Set entry that is itself a URL carrying credentials', () => {
      // `redactValue` runs on every element of a Map's `[key, value]` pair and
      // every element of a Set, the same as it does for an array entry, so a
      // credential-bearing URL nested inside either is still caught — this is
      // the pre-existing `redactString`/`hasCredentials` guard, unaffected by
      // the new array-serialisation shape.
      const redacted = redactFields({
        seen: new Set(['plain', 'postgresql://cashflow:s3cret@db.internal:5432/app']),
        byHost: new Map<string, string>([
          ['db', 'postgresql://cashflow:s3cret@db.internal:5432/app'],
        ]),
      })

      expect(redacted.seen).toEqual(['plain', '[redacted]'])
      expect(redacted.byHost).toEqual([['db', '[redacted]']])
    })

    it('truncates instead of following a cycle', () => {
      const cyclic: Record<string, unknown> = { a: 1 }
      cyclic.self = cyclic

      expect(() => JSON.stringify(redactFields({ cyclic }))).not.toThrow()
    })
  })

  describe('errors', () => {
    it('serialises an error as name, message and digest only — no stack in production', () => {
      setNodeEnv('production')
      const error = Object.assign(new Error('Account lookup failed'), { digest: '1234567890' })

      log.error('request.error', { error })

      const line = errorSpy.mock.calls[0][0] as string
      expect(line).not.toContain('stack')
      expect(line).not.toContain('log.test.ts')
      const record = JSON.parse(line) as { error: Record<string, unknown> }
      expect(record.error).toEqual({
        name: 'Error',
        message: 'Account lookup failed',
        digest: '1234567890',
      })
    })

    it('never prints a stack in development either', () => {
      setNodeEnv('development')

      log.error('request.error', { error: new Error('boom') })

      const line = errorSpy.mock.calls[0][0] as string
      expect(line).toContain('boom')
      expect(line).not.toContain('at ')
      expect(line).not.toContain('log.test.ts')
    })

    it('redacts credentials inside an error message', () => {
      setNodeEnv('production')

      log.error('db.unavailable', {
        error: new Error('P1001: cannot reach postgresql://cashflow:s3cret@db:5432/app'),
      })

      const line = errorSpy.mock.calls[0][0] as string
      expect(line).not.toContain('s3cret')
      expect(line).toContain('[redacted]')
    })
  })
})
