import { cn } from 'cn'
import type { Currency } from '@/lib/currency/provider'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'

/**
 * The five headline figures, as one bordered strip divided into cells rather
 * than five separate cards.
 *
 * They are one reading of one month, so they belong in one object: five cards
 * would put four gutters between numbers the eye is meant to compare, and spend
 * five borders' worth of visual weight doing it.
 *
 * The dividers are a 1px grid gap over a border-coloured background, which is
 * what keeps them correct at every breakpoint — a `border-l` on alternate cells
 * draws a line down the middle of the wrong row as soon as the grid reflows.
 * Five cells do not divide into two columns, so the last one spans the row on
 * narrow screens instead of leaving a bare panel beside it.
 *
 * Reports shows the same strip with three figures, so the wide-screen column
 * count follows the number of cells: a fixed five would leave two empty panels
 * of bare border colour beside them.
 */

/**
 * Tailwind resolves class names from source text, so each one has to appear
 * whole — the counts the app actually renders are listed literally.
 *
 * Typed with `| undefined` on purpose: an index signature otherwise promises a
 * `string` for every number, which would make the `??` fallback below look like
 * dead code to a reader and to the type-checker.
 */
const MD_COLUMNS: Record<number, string | undefined> = {
  3: 'md:grid-cols-3',
  5: 'md:grid-cols-5',
}

/** What a count with no entry above falls back to — the dashboard's shape. */
const DEFAULT_MD_COLUMNS = 'md:grid-cols-5'

export function KpiStrip({ kpis, currency }: { kpis: KpiDto[]; currency: Currency }) {
  return (
    <dl
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border',
        MD_COLUMNS[kpis.length] ?? DEFAULT_MD_COLUMNS,
      )}
    >
      {kpis.map((kpi, index) => (
        <div
          key={kpi.label}
          className={cn(
            'flex flex-col gap-1 bg-surface p-4',
            index === kpis.length - 1 && kpis.length % 2 === 1 && 'col-span-2 md:col-span-1',
          )}
        >
          <dt className="text-xs text-muted-foreground">{kpi.label}</dt>
          {/* The hint lives inside the `dd`, not beside it: a `dl` (or its
              wrapper `div`) may contain only `dt` and `dd`, and a stray `p`
              between them is invalid enough to change how a screen reader
              pairs terms with descriptions. */}
          <dd className="flex flex-col gap-1">
            {/* `flex-wrap` with a `whitespace-nowrap` figure: the number itself
                may never break mid-digits, but the currency suffix is allowed
                to drop to a second line on a narrow phone rather than force the
                figure to overflow its cell. */}
            <span className="flex flex-wrap items-baseline gap-x-1">
              <span
                className={cn(
                  // A step smaller on phones, where two of these share a row.
                  'text-lg font-semibold whitespace-nowrap tabular-nums md:text-xl',
                  kpi.negative && 'text-negative',
                  kpi.value === null && 'text-muted-foreground',
                )}
              >
                {/* An em dash, not a zero: "we cannot say" and "nothing" are
                    different answers, and only one of them is a number. */}
                {kpi.value ?? '—'}
              </span>
              {kpi.value !== null && (
                <span className="text-sm text-muted-foreground">{currency}</span>
              )}
            </span>
            {kpi.value === null && kpi.hint && (
              <span className="text-xs text-muted-foreground">{kpi.hint}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
