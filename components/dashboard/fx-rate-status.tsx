import type { FxStatus } from '@/lib/ui/dashboard-view-model'

/**
 * What rate this page's converted figures were produced with, and how much to
 * trust it (spec §6.3).
 *
 * A converted balance with no visible provenance is a number the user has to
 * take on faith. This line is the provenance: the rate itself, the day it
 * applies to, when we fetched it, and — when the live provider was down and a
 * recent cached rate stood in for it — a warning that says so.
 *
 * The four states are exhaustive by construction: the view model derives them
 * from the position, so there is no "unknown" branch to fall through to.
 */
export function FxRateStatus({ status }: { status: FxStatus }) {
  if (status.kind === 'unavailable') {
    return <p className="text-xs text-negative">FX rate unavailable — converted figures hidden</p>
  }

  if (status.kind === 'not-needed') {
    // Every account is already in the display currency, so no rate was
    // consulted and there is nothing to disclose.
    return <p className="text-xs text-muted-foreground">No conversion needed</p>
  }

  return (
    <p className="text-xs text-muted-foreground">
      <span className="tabular-nums">1 USD = {status.rate} VND</span>
      {' · effective '}
      <span className="tabular-nums">{status.effectiveDate}</span>
      {' · updated '}
      <span className="tabular-nums">{status.updatedAt}</span>
      {status.kind === 'fallback' && (
        <span className="ml-2 rounded-sm border border-warning/40 px-1.5 py-0.5 text-warning">
          cached rate
        </span>
      )}
    </p>
  )
}
