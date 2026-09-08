import { getTranslations } from 'next-intl/server'
import { PERIODS, type ReportRange } from '@/lib/reports/report-range'
import { SegmentedControl, type Segment } from '@/components/common/segmented-control'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/common/form-field'
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
   * The resolved range's kind. Never `null`: an unresolved URL still passes
   * `'custom'` here (`app/(app)/reports/page.tsx`'s invalid-range branch) so
   * the segment the user needs to correct — "Tùy chọn", with its echoed
   * From/To values — is the one actually highlighted, rather than leaving
   * every segment unselected while the page shows an error.
   */
  activeKind: ReportRange['kind']
  /**
   * `yyyy-MM-dd` carriers for the custom inputs' `defaultValue`, or `''` when
   * there is none — never a display label: an `<input type="date">` cannot
   * hold one.
   */
  from: string
  to: string
  /**
   * The id of the page's `InlineAlert` explaining a rejected range (fix round
   * 1, promoted minor) — set only when the resolver actually rejected the
   * URL. Both date inputs get `aria-describedby` pointing at it and
   * `aria-invalid`, so a screen-reader user tabbing into From/To hears WHY
   * the range they typed did not apply, not just that a message exists
   * somewhere on the page. `undefined` on every ordinary render.
   */
  errorId?: string
}

/**
 * Explicit, not built from the enum: a template-literal key cannot be
 * type-checked and cannot be found by a key-usage grep.
 */
const PERIOD_LABEL_KEYS: Record<(typeof PERIODS)[number], string> = {
  day: 'reports.periodDay',
  week: 'reports.periodWeek',
  month: 'reports.periodMonth',
  quarter: 'reports.periodQuarter',
  year: 'reports.periodYear',
}

// `async`, because it now translates its own six segment labels. Still a
// SERVER component with no state: the address bar remains the single source
// of truth for which period is showing.
export async function PeriodFilter({ activeKind, from, to, errorId }: PeriodFilterProps) {
  const t = await getTranslations()
  const customActive = activeKind === 'custom'

  /**
   * Six segments, and "Tùy chọn" is one of them (spec §6.8): the pre-flight
   * finding was that a custom range left every segment unselected, so the
   * control claimed no period was active while the page showed one. It is a
   * link like the others — clicking it re-applies whatever `from`/`to` the URL
   * already carries, or, with none, lands on the resolver's error branch, which
   * is exactly where a user who asked for a custom range with no dates should
   * be.
   */
  const segments: Segment[] = [
    ...PERIODS.map((period) => ({
      id: period,
      label: t(PERIOD_LABEL_KEYS[period]),
      href: `/reports?period=${period}`,
    })),
    {
      id: 'custom',
      label: t('reports.periodCustom'),
      href: `/reports?period=custom${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`,
    },
  ]

  return (
    // `items-start` (fix round 1, promoted minor): without it, the flex-column
    // wrapper's default `align-items: stretch` sized the SegmentedControl's
    // track to the wrapper's full cross-axis width once the track itself
    // could wrap onto two rows (see `SegmentedControl`'s own `flex-wrap`
    // below `sm`) — stretching a control that should hug its own content, not
    // fill the page's `max-w-[75rem]` container.
    <div className="flex flex-col items-start gap-3">
      {/* Six segments do not fit at 375, so the TRACK wraps to a second row
          rather than clipping or relying only on its own `overflow-x-auto`
          fallback scroll (fix round 1, promoted minor — see
          `SegmentedControl`'s own doc comment). Spec §7's ban on horizontal
          scrolling is about core METRICS — a number the user must see must
          not be hidden — and a filter is not a metric. */}
      <SegmentedControl label={t('reports.period')} segments={segments} activeId={activeKind} />

      {/* The From/To pair appears only when the custom segment is selected
          (spec §6.8: "'Tùy chọn' ... reveals the From/To inputs and Apply"),
          so five of the six periods render a control with nothing under it. */}
      {customActive && (
        <form
          method="get"
          action="/reports"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-end"
        >
          {/* Not a `<button name="period" value="custom">`: only the button
              that was clicked is submitted, so pressing Enter in a date field
              would otherwise send no period at all. */}
          <input type="hidden" name="period" value="custom" />
          {/* `Label` + `Input` directly, not `FormField`: `FormField`'s
              control is a render prop (`children: (aria) => ReactNode`), and
              a *function* cannot cross the Server → Client boundary as a
              prop — `FormField` is a Client Component, `PeriodFilter` is not.
              This form has no Zod error to translate either, which is the
              other half of what `FormField` is for. Plain `<label htmlFor>` +
              `Input` is also the pattern this file already had here before
              this rewrite, and the one the accessibility criteria calls out
              as already correct.

              `sm:w-44`, not `flex-1` (fix round 1, promoted minor): a date
              input never needs more than a fixed compact width, and letting
              the pair grow to fill the row's remaining space read as loose
              rather than a compact control — the same reasoning the brief
              gives for the export control not dominating the header. */}
          <div className="flex flex-col gap-1.5 sm:w-44">
            <Label htmlFor="report-from">{t('reports.from')}</Label>
            <Input
              id="report-from"
              name="from"
              type="date"
              required
              defaultValue={from}
              aria-describedby={errorId}
              aria-invalid={errorId ? true : undefined}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:w-44">
            <Label htmlFor="report-to">{t('reports.to')}</Label>
            <Input
              id="report-to"
              name="to"
              type="date"
              required
              defaultValue={to}
              aria-describedby={errorId}
              aria-invalid={errorId ? true : undefined}
            />
          </div>
          <Button type="submit" variant="secondary" className="sm:mb-0">
            {t('reports.apply')}
          </Button>
        </form>
      )}
    </div>
  )
}
