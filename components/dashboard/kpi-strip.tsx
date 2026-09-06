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
 */
export function KpiStrip({ kpis, currency }: { kpis: KpiDto[]; currency: Currency }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-5">
      {kpis.map((kpi, index) => (
        <div
          key={kpi.label}
          className={cn(
            'flex flex-col gap-1 bg-surface p-4',
            index === kpis.length - 1 && kpis.length % 2 === 1 && 'col-span-2 md:col-span-1',
          )}
        >
          <dt className="text-xs text-muted-foreground">{kpi.label}</dt>
          <dd
            className={cn(
              'text-xl font-semibold tabular-nums',
              kpi.negative && 'text-negative',
              kpi.value === null && 'text-muted-foreground',
            )}
          >
            {/* An em dash, not a zero: "we cannot say" and "nothing" are
                different answers, and only one of them is a number. */}
            {kpi.value ?? '—'}
            {kpi.value !== null && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">{currency}</span>
            )}
          </dd>
          {kpi.value === null && kpi.hint && (
            <p className="text-xs text-muted-foreground">{kpi.hint}</p>
          )}
        </div>
      ))}
    </dl>
  )
}
