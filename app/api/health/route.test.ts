import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { GET, PROBE_TIMEOUT_MS, checkHealth } from '@/app/api/health/route'

/**
 * The probe is injected, so these cases need no database and no timers: the
 * timeout path uses a promise that never settles with a 5 ms bound.
 */
describe('GET /api/health', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers 200 {"status":"ok"} with no-store when the probe resolves', async () => {
    const response = await checkHealth(async () => [{ '?column?': 1 }])

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('answers 503 {"status":"unavailable"} when the probe rejects', async () => {
    const response = await checkHealth(async () => {
      throw new Error('P1001: cannot reach postgresql://cashflow:s3cret@db:5432/app')
    })

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'unavailable' })
  })

  it('answers 503 when the probe never settles within the bound', async () => {
    const response = await checkHealth(() => new Promise(() => {}), 5)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'unavailable' })
  })

  it('leaks nothing: the body carries exactly one key and no driver text', async () => {
    for (const response of [
      await checkHealth(async () => 1),
      await checkHealth(async () => {
        throw new Error('connect ECONNREFUSED postgresql://cashflow:s3cret@10.0.0.2:5432/app')
      }),
      await checkHealth(() => new Promise(() => {}), 5),
    ]) {
      const body = (await response.json()) as Record<string, unknown>
      expect(Object.keys(body)).toEqual(['status'])
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('s3cret')
      expect(serialized).not.toContain('ECONNREFUSED')
      expect(serialized).not.toContain('postgresql')
      expect(serialized).not.toMatch(/stack|at /i)
    }
  })

  it('logs the failure server-side without the connection credentials', async () => {
    await checkHealth(async () => {
      throw new Error('cannot reach postgresql://cashflow:s3cret@db:5432/app')
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = warnSpy.mock.calls[0][0] as string
    expect(line).toContain('health.probe_failed')
    expect(line).not.toContain('s3cret')
  })

  it('bounds the default probe at about two seconds', () => {
    expect(PROBE_TIMEOUT_MS).toBe(2_000)
  })

  it('exports a GET handler and no other method', async () => {
    const routeModule = (await import('@/app/api/health/route')) as Record<string, unknown>

    expect(typeof GET).toBe('function')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(routeModule[method]).toBeUndefined()
    }
  })
})
