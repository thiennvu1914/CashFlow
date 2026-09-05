import { describe, it, expect, afterEach, vi } from 'vitest'
import { OpenErApiProvider, OPEN_ER_API_SOURCE } from './open-er-api-provider'

/**
 * All fetch calls are stubbed — no real network traffic. The success payload
 * shape mirrors the real response captured live from open.er-api.com during
 * Task 6 (2026-09-05): `result: "success"`, `rates.VND: 26025.122751`,
 * `time_last_update_utc: "Sat, 05 Sep 2026 00:02:32 +0000"`.
 */

const BASE_URL = 'https://open.er-api.com/v6'
const TIME_LAST_UPDATE_UTC = 'Sat, 05 Sep 2026 00:02:32 +0000'

function successPayload(overrides: Record<string, unknown> = {}) {
  return {
    result: 'success',
    provider: 'https://www.exchangerate-api.com',
    time_last_update_unix: 1788566552,
    time_last_update_utc: TIME_LAST_UPDATE_UTC,
    time_next_update_unix: 1788653902,
    time_next_update_utc: 'Sun, 06 Sep 2026 00:18:22 +0000',
    base_code: 'USD',
    rates: { USD: 1, VND: 26025.122751 },
    ...overrides,
  }
}

function stubFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubFetchRejection(error: unknown) {
  const fetchMock = vi.fn().mockRejectedValue(error)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenErApiProvider.getLatestRate', () => {
  it('returns a RateResult parsed from a successful response', async () => {
    const before = new Date()
    stubFetch({ ok: true, status: 200, json: async () => successPayload() })
    const provider = new OpenErApiProvider(BASE_URL)

    const result = await provider.getLatestRate({ base: 'USD', quote: 'VND' })
    const after = new Date()

    expect(result.rate).toBe(26025.122751)
    expect(result.effectiveDate).toEqual(new Date('2026-09-05T00:02:32.000Z'))
    expect(result.source).toBe('open.er-api.com')
    expect(result.source).toBe(OPEN_ER_API_SOURCE)
    expect(result.fetchedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(result.fetchedAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('requests the expected URL for the given pair', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => successPayload() })
    const provider = new OpenErApiProvider(BASE_URL)

    await provider.getLatestRate({ base: 'USD', quote: 'VND' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, unknown]
    expect(url).toBe(`${BASE_URL}/latest/USD`)
  })

  it('rejects with the HTTP status when the response is not ok', async () => {
    stubFetch({ ok: false, status: 500, json: async () => ({}) })
    const provider = new OpenErApiProvider(BASE_URL)

    await expect(provider.getLatestRate({ base: 'USD', quote: 'VND' })).rejects.toThrow('500')
  })

  it('rejects when the provider reports a non-success result', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => successPayload({ result: 'error' }),
    })
    const provider = new OpenErApiProvider(BASE_URL)

    await expect(provider.getLatestRate({ base: 'USD', quote: 'VND' })).rejects.toThrow()
  })

  it('rejects when rates.VND is missing', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => successPayload({ rates: { USD: 1 } }),
    })
    const provider = new OpenErApiProvider(BASE_URL)

    await expect(provider.getLatestRate({ base: 'USD', quote: 'VND' })).rejects.toThrow()
  })

  it('rejects when the rate is not a finite positive number', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => successPayload({ rates: { USD: 1, VND: -1 } }),
    })
    const provider = new OpenErApiProvider(BASE_URL)

    await expect(provider.getLatestRate({ base: 'USD', quote: 'VND' })).rejects.toThrow()
  })

  it('rejects when time_last_update_utc is missing', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => successPayload({ time_last_update_utc: undefined }),
    })
    const provider = new OpenErApiProvider(BASE_URL)

    await expect(provider.getLatestRate({ base: 'USD', quote: 'VND' })).rejects.toThrow()
  })

  it('rejects when time_last_update_utc is not a valid date', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => successPayload({ time_last_update_utc: 'not-a-date' }),
    })
    const provider = new OpenErApiProvider(BASE_URL)

    await expect(provider.getLatestRate({ base: 'USD', quote: 'VND' })).rejects.toThrow()
  })

  it('rejects with a body-free message when the response body is not valid JSON', async () => {
    const fakeBodyText = 'fake-body-text-that-must-never-leak'
    stubFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token < in JSON at position 0: ${fakeBodyText}`)
      },
    })
    const provider = new OpenErApiProvider(BASE_URL)

    const promise = provider.getLatestRate({ base: 'USD', quote: 'VND' })
    await expect(promise).rejects.toThrow('non-JSON')
    await expect(promise).rejects.not.toThrow(fakeBodyText)
  })

  it('rejects with a transport-failure message when fetch itself rejects', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    )
    stubFetchRejection(timeoutError)
    const provider = new OpenErApiProvider(BASE_URL)

    await expect(provider.getLatestRate({ base: 'USD', quote: 'VND' })).rejects.toThrow(
      'FX provider request timed out or failed to connect',
    )
  })
})

describe('OpenErApiProvider.getHistoricalRate', () => {
  it('resolves null and performs no fetch', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => successPayload() })
    const provider = new OpenErApiProvider(BASE_URL)

    const result = await provider.getHistoricalRate(
      { base: 'USD', quote: 'VND' },
      new Date('2025-01-15'),
    )

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
