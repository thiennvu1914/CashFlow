import Link from 'next/link'
import { cn } from 'cn'
import { PERIODS, type ReportRange } from '@/lib/reports/report-range'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The Reports page's range picker, with the range itself kept in the URL.
 *
 * Deliberately a *server* component with no state of its own: the named periods
 * are ordinary links and the custom range is an ordinary `GET` form, so the
 * address bar is the single source of truth. That is what makes a report
 * bookmarkable, shareable, reloadable and — because Task 7's export links are
 * built from the same resolved range — impossible to disagree with the file the
 * user downloads. It also means the filter works before (and without) any
 * JavaScript, which a `useSearchParams` + `router.push` version would not.
 *
 * The form posts `period=custom` as a hidden field rather than relying on the
 * button's value, so a browser that submits the form by pressing Enter in a
 * date field still lands on the custom branch of the resolver.
 */
export interface PeriodFilterProps {
  /**
   * The resolved range's kind, or `null` when the URL could not be resolved —
   * in which case nothing is highlighted, because nothing is being shown.
   */
  activeKind: ReportRange['kind'] | null
  /** `yyyy-MM-dd` prefill for the custom inputs, or `''` when there is none. */
  from: string
  to: string
}

export function PeriodFilter({ activeKind, from, to }: PeriodFilterProps) {
  const customActive = activeKind === 'custom'

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Period
          </h2>
          <nav aria-label="Report period" className="mt-2 flex flex-wrap gap-1">
            {PERIODS.map((period) => {
              const active = activeKind === period
              return (
                <Link
                  key={period}
                  href={`/reports?period=${period}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-sm capitalize',
                    // The rail's "you are here" treatment (a muted wash plus
                    // brand text), not a filled pill: switching period is
                    // navigation, not a call to action.
                    active
                      ? 'bg-muted font-medium text-brand'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {period}
                </Link>
              )
            })}
          </nav>
        </div>

        <form method="get" action="/reports" className="flex flex-wrap items-end gap-2">
          {/* Not a `<button name="period" value="custom">`: only the button that
              was clicked is submitted, so pressing Enter in a date field would
              otherwise send no period at all. */}
          <input type="hidden" name="period" value="custom" />
          <div className="flex flex-col gap-1">
            <label
              htmlFor="report-from"
              className={cn(
                'text-xs font-medium tracking-wide uppercase',
                customActive ? 'text-brand' : 'text-muted-foreground',
              )}
            >
              From
            </label>
            <Input
              id="report-from"
              name="from"
              type="date"
              required
              defaultValue={from}
              className="w-40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="report-to"
              className={cn(
                'text-xs font-medium tracking-wide uppercase',
                customActive ? 'text-brand' : 'text-muted-foreground',
              )}
            >
              To
            </label>
            <Input
              id="report-to"
              name="to"
              type="date"
              required
              defaultValue={to}
              className="w-40"
            />
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
      </div>
    </section>
  )
}
