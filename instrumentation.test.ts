import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { onRequestError, register } from './instrumentation'

function setNodeEnv(value: string): void {
  ;(process.env as Record<string, string>).NODE_ENV = value
}

type ErrorRequest = Parameters<typeof onRequestError>[1]
type ErrorContext = Parameters<typeof onRequestError>[2]

function fakeRequest(overrides: Partial<ErrorRequest> = {}): ErrorRequest {
  return {
    path: '/dashboard',
    method: 'GET',
    headers: { cookie: 'cashflow.session_token=abc123' },
    ...overrides,
  } as ErrorRequest
}

function fakeContext(overrides: Partial<ErrorContext> = {}): ErrorContext {
  return {
    routerKind: 'App Router',
    routePath: '/(app)/dashboard/page',
    routeType: 'render',
    renderSource: 'react-server-components',
    revalidateReason: undefined,
    renderType: 'dynamic',
    ...overrides,
  } as ErrorContext
}

describe('instrumentation onRequestError', () => {
  const originalNodeEnv = process.env.NODE_ENV
  let errorSpy: MockInstance
  let logSpy: MockInstance

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    setNodeEnv('production')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setNodeEnv(originalNodeEnv ?? 'test')
  })

  function recordFrom(spy: MockInstance): Record<string, unknown> {
    expect(spy).toHaveBeenCalledTimes(1)
    return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>
  }

  it('records the digest, method, pathname and route kinds', async () => {
    const error = Object.assign(new Error('Dashboard query failed'), { digest: '2647821094' })

    await onRequestError(error, fakeRequest(), fakeContext())

    const record = recordFrom(errorSpy)
    expect(record.level).toBe('error')
    expect(record.event).toBe('request.error')
    expect(record.digest).toBe('2647821094')
    expect(record.method).toBe('GET')
    expect(record.path).toBe('/dashboard')
    expect(record.routerKind).toBe('App Router')
    expect(record.routeType).toBe('render')
    expect(record.error).toEqual({
      name: 'Error',
      message: 'Dashboard query failed',
      digest: '2647821094',
    })
  })

  it('drops the query string — a token in the URL never reaches the log', async () => {
    await onRequestError(
      new Error('boom'),
      fakeRequest({ path: '/reset-password?token=super-secret-reset-token&from=email' }),
      fakeContext({ routeType: 'route' }),
    )

    const line = errorSpy.mock.calls[0][0] as string
    expect(line).not.toContain('super-secret-reset-token')
    expect(line).not.toContain('token=')
    expect(recordFrom(errorSpy).path).toBe('/reset-password')
  })

  it('logs no headers, no cookie and no body', async () => {
    await onRequestError(
      Object.assign(new Error('boom'), { digest: '99' }),
      fakeRequest({
        headers: { cookie: 'cashflow.session_token=abc123', authorization: 'Bearer xyz' },
      }),
      fakeContext(),
    )

    const record = recordFrom(errorSpy)
    expect(record.headers).toBeUndefined()
    expect(Object.keys(record).sort()).toEqual(
      [
        'digest',
        'error',
        'event',
        'level',
        'method',
        'path',
        'routerKind',
        'routeType',
        'time',
      ].sort(),
    )
    const line = errorSpy.mock.calls[0][0] as string
    expect(line).not.toContain('abc123')
    expect(line).not.toContain('Bearer')
  })

  it('never prints a stack', async () => {
    await onRequestError(new Error('boom'), fakeRequest(), fakeContext())

    const line = errorSpy.mock.calls[0][0] as string
    expect(line).not.toContain('instrumentation.test.ts')
    expect(line).not.toContain('stack')
  })

  it('survives an error without a digest and a non-Error throw', async () => {
    await onRequestError(new Error('no digest here'), fakeRequest(), fakeContext())
    expect(recordFrom(errorSpy).digest).toBeUndefined()

    errorSpy.mockClear()
    await onRequestError('a thrown string', fakeRequest(), fakeContext())
    const record = recordFrom(errorSpy)
    expect(record.event).toBe('request.error')
    expect(record.error).toBe('a thrown string')
  })

  it('register writes a single startup line and nothing else', () => {
    register()

    const record = recordFrom(logSpy)
    expect(record.level).toBe('info')
    expect(record.event).toBe('server.start')
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
