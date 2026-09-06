import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { UnauthorizedError } from '@/lib/auth/require-user'
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
const buildExportContext = vi.hoisted(() => vi.fn())
const buildFilteredWorkbook = vi.hoisted(() => vi.fn())
const buildFullWorkbook = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/require-user', async (importOriginal) => ({
  // `UnauthorizedError` stays the real class — the route narrows on it, and a
  // mocked stand-in would make the 401 branch pass for the wrong reason.
  ...(await importOriginal<typeof import('@/lib/auth/require-user')>()),
  requireUser,
}))
vi.mock('@/lib/server/export/export-context', () => ({ buildExportContext }))
vi.mock('@/lib/server/export/filtered-export', () => ({ buildFilteredWorkbook }))
vi.mock('@/lib/server/export/sheet-registry', () => ({ buildFullWorkbook }))

const { GET } = await import('./route')

/** The smallest real workbook — enough to prove the route streams a file. */
function tinyWorkbook() {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Summary').addRow(['Metric', 'Value'])
  return workbook
}

const CONTEXT: ExportContext = {
  userId: 'user-1',
  displayCurrency: 'VND',
  timezone: 'Asia/Ho_Chi_Minh',
  fx: null,
  // 31 Dec 2026 18:00Z is already 01:00 on 1 Jan 2027 in Asia/Ho_Chi_Minh, so
  // the filename proves the date is stamped in the user's zone, not in UTC.
  now: new Date('2026-12-31T18:00:00Z'),
}

function request(query: string) {
  return new Request(`http://localhost:3000/api/reports/export${query}`)
}

describe('GET /api/reports/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUser.mockResolvedValue({ id: 'user-1' })
    buildExportContext.mockResolvedValue(CONTEXT)
    buildFilteredWorkbook.mockResolvedValue(tinyWorkbook())
    buildFullWorkbook.mockResolvedValue(tinyWorkbook())
  })

  it('answers 401 rather than redirecting when there is no session', async () => {
    requireUser.mockRejectedValue(new UnauthorizedError())

    const response = await GET(request('?mode=full'))

    // A download link cannot follow a redirect into an HTML login page and
    // hand the browser something it will save as .xlsx.
    expect(response.status).toBe(401)
    expect(buildExportContext).not.toHaveBeenCalled()
  })

  it('rejects an unknown mode with 400', async () => {
    const response = await GET(request('?mode=everything'))

    expect(response.status).toBe(400)
    expect(buildFullWorkbook).not.toHaveBeenCalled()
    expect(buildFilteredWorkbook).not.toHaveBeenCalled()
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
    expect(buildFullWorkbook).toHaveBeenCalledWith(CONTEXT)
    expect(buildFilteredWorkbook).not.toHaveBeenCalled()
  })

  it('hands the filtered builder the range the query string resolves to', async () => {
    const response = await GET(
      request('?mode=filtered&period=custom&from=2026-03-01&to=2026-03-31'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="cashflow-filtered-20270101.xlsx"',
    )
    expect(buildFilteredWorkbook).toHaveBeenCalledWith(CONTEXT, {
      kind: 'custom',
      from: '2026-03-01',
      to: '2026-03-31',
      startUtc: new Date('2026-02-28T17:00:00.000Z'),
      endUtc: new Date('2026-03-31T17:00:00.000Z'),
    })
    expect(buildFullWorkbook).not.toHaveBeenCalled()
  })
})
