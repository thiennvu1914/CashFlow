import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { UnauthorizedError } from '@/lib/auth/require-user'
import type { ExportProfile } from '@/lib/server/export/export-context'
import type { ExportContext } from '@/lib/server/export/sheet-registry'

/**
 * A unit test, deliberately: the sheet content is proved against the real
 * database by `lib/server/export/*.test.ts`, and what is left for the route is
 * the HTTP contract — who may ask, what a bad query string does, and the
 * headers that make the response a download rather than a page.
 *
 * `requireUser` and the two workbook builders are mocked so no session, no
 * database and no spreadsheet of any size is involved in asserting that.
 */

const requireUser = vi.hoisted(() => vi.fn())
const loadExportProfile = vi.hoisted(() => vi.fn())
const resolveExportFx = vi.hoisted(() => vi.fn())
const buildFilteredWorkbook = vi.hoisted(() => vi.fn())
const buildFullWorkbook = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/require-user', async (importOriginal) => ({
  // `UnauthorizedError` stays the real class — the route narrows on it, and a
  // mocked stand-in would make the 401 branch pass for the wrong reason.
  ...(await importOriginal<typeof import('@/lib/auth/require-user')>()),
  requireUser,
}))
vi.mock('@/lib/server/export/export-context', () => ({ loadExportProfile, resolveExportFx }))
vi.mock('@/lib/server/export/filtered-export', () => ({ buildFilteredWorkbook }))
vi.mock('@/lib/server/export/sheet-registry', () => ({ buildFullWorkbook }))

const { GET } = await import('./route')

/** The smallest real workbook — enough to prove the route streams a file. */
function tinyWorkbook() {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Summary').addRow(['Metric', 'Value'])
  return workbook
}

const PROFILE: ExportProfile = {
  userId: 'user-1',
  displayCurrency: 'VND',
  timezone: 'Asia/Ho_Chi_Minh',
}

/**
 * 31 Dec 2026 18:00Z is already 01:00 on 1 Jan 2027 in Asia/Ho_Chi_Minh, so
 * pinning the clock here is what lets the filename assertions prove the stamp
 * is the user's local date rather than the UTC one.
 */
const FIXED_NOW = new Date('2026-12-31T18:00:00Z')

/** The context the route is expected to assemble for a given rate. */
function expectedContext(fx: ExportContext['fx']): ExportContext {
  return { ...PROFILE, fx, now: FIXED_NOW }
}

function request(query: string) {
  return new Request(`http://localhost:3000/api/reports/export${query}`)
}

describe('GET /api/reports/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // `shouldAdvanceTime` keeps real promises resolving; only the clock the
    // route reads for its filename stamp is pinned.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(FIXED_NOW)
    requireUser.mockResolvedValue({ id: 'user-1' })
    loadExportProfile.mockResolvedValue(PROFILE)
    resolveExportFx.mockResolvedValue(null)
    buildFilteredWorkbook.mockResolvedValue(tinyWorkbook())
    buildFullWorkbook.mockResolvedValue(tinyWorkbook())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers 401 rather than redirecting when there is no session', async () => {
    requireUser.mockRejectedValue(new UnauthorizedError())

    const response = await GET(request('?mode=full'))

    // A download link cannot follow a redirect into an HTML login page and
    // hand the browser something it will save as .xlsx.
    expect(response.status).toBe(401)
    expect(loadExportProfile).not.toHaveBeenCalled()
  })

  it('rejects an unknown mode with 400', async () => {
    const response = await GET(request('?mode=everything'))

    expect(response.status).toBe(400)
    expect(buildFullWorkbook).not.toHaveBeenCalled()
    expect(buildFilteredWorkbook).not.toHaveBeenCalled()
    // A mode that means nothing is refused before any work is done for it.
    expect(loadExportProfile).not.toHaveBeenCalled()
    expect(resolveExportFx).not.toHaveBeenCalled()
  })

  it('rejects a missing mode with 400', async () => {
    expect((await GET(request(''))).status).toBe(400)
  })

  it('rejects an invalid period with 400 and the resolver message', async () => {
    const response = await GET(request('?mode=filtered&period=bogus'))

    expect(response.status).toBe(400)
    expect(response.headers.get('Content-Type')).toContain('text/plain')
    expect(await response.text()).toContain('bogus')
  })

  it('refuses a bad range before it costs an exchange-rate lookup', async () => {
    const response = await GET(request('?mode=filtered&period=bogus'))

    expect(response.status).toBe(400)
    // The profile is needed to know the timezone the range is read in; the FX
    // provider is not, and a malformed URL must not cost a round trip to it.
    expect(loadExportProfile).toHaveBeenCalledTimes(1)
    expect(resolveExportFx).not.toHaveBeenCalled()
  })

  it('rejects a repeated range parameter with 400', async () => {
    const response = await GET(request('?mode=filtered&period=day&period=year'))

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('more than once')
  })

  it('rejects an unreal custom date with 400', async () => {
    const response = await GET(
      request('?mode=filtered&period=custom&from=2026-02-30&to=2026-03-01'),
    )

    expect(response.status).toBe(400)
  })

  it('streams the full workbook with download headers', async () => {
    const response = await GET(request('?mode=full'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    // The date is the user's local one — 1 Jan 2027 in Asia/Ho_Chi_Minh.
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="cashflow-full-20270101.xlsx"',
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
    expect(buildFullWorkbook).toHaveBeenCalledWith(expectedContext(null))
    expect(buildFilteredWorkbook).not.toHaveBeenCalled()
    // The full workbook restates balances at a current rate, so it gets one.
    expect(resolveExportFx).toHaveBeenCalledTimes(1)
  })

  it('hands the filtered builder the range the query string resolves to', async () => {
    const response = await GET(
      request('?mode=filtered&period=custom&from=2026-03-01&to=2026-03-31'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="cashflow-filtered-20270101.xlsx"',
    )
    expect(buildFilteredWorkbook).toHaveBeenCalledWith(expectedContext(null), {
      kind: 'custom',
      from: '2026-03-01',
      to: '2026-03-31',
      startUtc: new Date('2026-02-28T17:00:00.000Z'),
      endUtc: new Date('2026-03-31T17:00:00.000Z'),
    })
    expect(buildFullWorkbook).not.toHaveBeenCalled()
    // The filtered workbook is historical end to end, so no rate is fetched
    // for it at all.
    expect(resolveExportFx).not.toHaveBeenCalled()
  })
})
