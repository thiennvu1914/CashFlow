import { getTranslations } from 'next-intl/server'
import type { FxStatus } from '@/lib/ui/dashboard-view-model'

/**
 * What rate this page's converted figures were produced with, and how much to
 * trust it (spec §6.3).
 *
 * A converted balance with no visible provenance is a number the user has to
 * take on faith. This line is the provenance: what it is (`dashboard.fxLabel`),
 * the rate itself, when we fetched it, and — when the live provider was down
 * and a recent cached rate stood in for it — a warning that says so. It
 * renders inside `PageHeader`'s `meta` slot: 12 px muted, demoted from the KPI
 * strip it used to sit beside (spec §6.1).
 *
 * Fix round 1, finding 3: the effective date used to sit only in a `title`
 * attribute on a non-interactive span — reachable by a mouse hover and
 * nothing else, so a touch or keyboard user never saw it. It is now a second,
 * visibly muted line beside the primary one, using the same `fxEffective` key
 * (and `fxCached`, unchanged from where it already was — that badge was never
 * hidden).
 *
 * The four states are exhaustive by construction: the view model derives them
 * from the position, so there is no "unknown" branch to fall through to.
 *
 * A server component (not `'use client'`): `getTranslations` works here because
 * the page renders it directly, and a server component needs no client
 * boundary just to read a handful of strings.
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
    <span className="flex flex-col gap-0.5">
      <span>
        {t('dashboard.fxLabel')}
        {' · '}
        <span className="tabular-nums">
          {t('common.rateLine', { from: 'USD', rate: status.rate, to: 'VND' })}
        </span>
        {' · '}
        <span className="tabular-nums">{t('dashboard.fxUpdated', { time: status.updatedAt })}</span>
        {/* The same tinted pill as `StatusBadge`'s warning tone, so it takes
            the same `--warning-on-tint` text token (Task 16, F6): a wash of a
            tone over the surface leaves the tone itself under 4.5:1 on it in
            both themes. */}
        {status.kind === 'fallback' && (
          <span className="ml-2 rounded-md bg-warning/10 px-1.5 py-0.5 text-warning-on-tint dark:bg-warning/18">
            {t('dashboard.fxCached')}
          </span>
        )}
      </span>
      {/* `text-muted-foreground`, not `text-muted-foreground/80` (Task 16,
          owner item G6). The 80 % dilution was the ONLY alpha-diluted text
          colour in the product, and axe caught it as a real WCAG 1.4.3
          failure at 12 px: 3.74:1 in light and 4.16:1 in dark against
          `--background`. `--muted-foreground` itself is sized for exactly
          4.5:1 with a small margin (5.79 light / 5.75 dark on the page), so
          any alpha on top of it spends margin the token does not have. */}
      <span className="tabular-nums text-muted-foreground">
        {t('dashboard.fxEffective', { date: status.effectiveDate })}
      </span>
    </span>
  )
}
