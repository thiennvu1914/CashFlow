import { formatInTimeZone } from 'date-fns-tz'
import { UnauthorizedError, requireUser } from '@/lib/auth/require-user'
import { InvalidReportRangeError, resolveReportRange } from '@/lib/reports/report-range'
import { loadExportProfile, resolveExportFx } from '@/lib/server/export/export-context'
import { buildFilteredWorkbook } from '@/lib/server/export/filtered-export'
import { buildFullWorkbook } from '@/lib/server/export/sheet-registry'
import type { ExportContext } from '@/lib/server/export/sheet-registry'

/**
 * `GET /api/reports/export` — the Excel download (spec §12).
 *
 * A Route Handler rather than a server action because the response is a file,
 * not a navigation: the Reports page links to it with a plain anchor, and the
 * browser saves what comes back.
 *
 * Three things are deliberate here.
 *
 * **401, not a redirect.** `requireUser` is the throwing guard, not
 * `requireUserOrRedirect`. A download link that followed a redirect would hand
 * the browser the login page's HTML and save it as a `.xlsx` the user cannot
 * open — a silent, confusing failure. An honest 401 is the answer.
 *
 * **The range is resolved, never cast.** Everything in the query string is
 * attacker-controlled. `mode` is compared against the two literals rather than
 * defaulted, so a typo is a visible 400 instead of quietly exporting something
 * else, and the range goes through the same `resolveReportRange` the Reports
 * page uses — including its refusal of a repeated parameter, which Next
 * delivers as an array. That shared resolver is what guarantees the workbook
 * covers exactly the window the page was showing.
 *
 * **Work is done in the cheapest order.** The profile is loaded, the range is
 * validated, and only then — and only for the full workbook — is an exchange
 * rate fetched. A malformed URL therefore costs no provider round trip, and the
 * filtered export costs none at all, because it is historical end to end and
 * reads no current rate.
 *
 * **Nothing is logged.** Not the parameters, not the row counts, not the user.
 * The payload is the user's complete financial history.
 */

export const dynamic = 'force-dynamic'

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * On every response from this route, refusals included.
 *
 * `nosniff` tells the browser to believe the `Content-Type` rather than
 * inspecting the bytes. Both directions matter here: a plain-text refusal must
 * never be sniffed into HTML and rendered in the download's origin, and the
 * workbook — an attacker-influenceable payload, since a transaction note is
 * whatever the user typed — must never be sniffed into anything executable.
 */
const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' } as const

const MODES = ['full', 'filtered'] as const
type ExportMode = (typeof MODES)[number]

function isMode(value: string | null): value is ExportMode {
  return value !== null && (MODES as readonly string[]).includes(value)
}

/** A plain-text refusal — never HTML, which a download would save as a file. */
function refuse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...NOSNIFF,
    },
  })
}

/**
 * One query parameter in the shape `resolveReportRange` expects: absent, a
 * single value, or the array a repeated key produces — which the resolver
 * refuses rather than silently picking one of.
 */
function rawParam(params: URLSearchParams, name: string): string | string[] | undefined {
  const values = params.getAll(name)
  if (values.length === 0) return undefined
  return values.length === 1 ? values[0] : values
}

export async function GET(request: Request): Promise<Response> {
  let user
  try {
    user = await requireUser()
  } catch (error) {
    if (error instanceof UnauthorizedError) return refuse('Not authenticated', 401)
    throw error
  }

  const params = new URL(request.url).searchParams
  const mode = params.get('mode')
  if (!isMode(mode)) {
    return refuse(`mode must be one of ${MODES.join(', ')}`, 400)
  }

  // The profile first and on its own — no FX yet. It carries the timezone the
  // range is resolved in, and a range the user typed wrong must be a 400
  // *before* a third-party rate lookup is made on its behalf.
  // `user.id` from the session, never anything from the query string, is what
  // scopes every query the builders run.
  const profile = await loadExportProfile(user.id)

  let range = null
  if (mode === 'filtered') {
    try {
      range = resolveReportRange(
        {
          period: rawParam(params, 'period'),
          from: rawParam(params, 'from'),
          to: rawParam(params, 'to'),
        },
        profile.timezone,
      )
    } catch (error) {
      // Exactly `InvalidReportRangeError`: a hand-typed `?period=weekly` is the
      // user's mistake and deserves its message; anything else is a fault and
      // must not be flattened into a 400.
      if (!(error instanceof InvalidReportRangeError)) throw error
      return refuse(error.message, 400)
    }
  }

  const ctx: ExportContext = {
    ...profile,
    // Only the full workbook restates anything at a current rate. The filtered
    // one is historical end to end — every figure comes from the rate its own
    // row snapshotted — so asking the provider for a rate it will never read
    // would be a network round trip spent on nothing.
    fx: mode === 'full' ? await resolveExportFx() : null,
    now: new Date(),
  }

  const workbook =
    range === null ? await buildFullWorkbook(ctx) : await buildFilteredWorkbook(ctx, range)

  const body = await workbook.xlsx.writeBuffer()
  // The date is the user's local one: a file saved at 01:00 on 1 January in
  // Asia/Ho_Chi_Minh must not be named for 31 December.
  const stamp = formatInTimeZone(ctx.now, ctx.timezone, 'yyyyMMdd')
  return new Response(body, {
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="cashflow-${mode}-${stamp}.xlsx"`,
      // A financial export must never sit in a shared or browser cache.
      'Cache-Control': 'no-store',
      ...NOSNIFF,
    },
  })
}
