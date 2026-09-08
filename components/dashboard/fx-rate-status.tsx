import { getTranslations } from 'next-intl/server'
import type { FxStatus } from '@/lib/ui/dashboard-view-model'

/**
 * What rate this page's converted figures were produced with, and how much to
 * trust it (spec §6.3).
 *
 * A converted balance with no visible provenance is a number the user has to
 * take on faith. This line is the provenance: the rate itself, when we fetched
 * it, and — when the live provider was down and a recent cached rate stood in
 * for it — a warning that says so. It renders inside `PageHeader`'s `meta`
 * slot: 12 px muted, one line, demoted from the KPI strip it used to sit beside
 * (spec §6.1). The effective date moves off the visible line and into a
 * `title` tooltip — still reachable, never competing with the rate and the
 * fetch time for space.
 *
 * The four states are exhaustive by construction: the view model derives them
 * from the position, so there is no "unknown" branch to fall through to.
 *
 * A server component (not `'use client'`): `getTranslations` works here because
 * the page renders it directly, and a server component needs no client
 * boundary just to read three strings.
 */
export async function FxRateStatus({ status }: { status: FxStatus }) {
  const t = await getTranslations()

  if (status.kind === 'unavailable') {
    return <span className="text-negative">{t('dashboard.fxUnavailable')}</span>
  }
  if (status.kind === 'not-needed') {
    return <span>{t('dashboard.fxNotNeeded')}</span>
  }
  return (
    <span title={t('dashboard.fxEffective', { date: status.effectiveDate })}>
      <span className="tabular-nums">
        {t('common.rateLine', { from: 'USD', rate: status.rate, to: 'VND' })}
      </span>
      {' · '}
      <span className="tabular-nums">{t('dashboard.fxUpdated', { time: status.updatedAt })}</span>
      {status.kind === 'fallback' && (
        <span className="ml-2 rounded-md bg-warning/10 px-1.5 py-0.5 text-warning dark:bg-warning/18">
          {t('dashboard.fxCached')}
        </span>
      )}
    </span>
  )
}
