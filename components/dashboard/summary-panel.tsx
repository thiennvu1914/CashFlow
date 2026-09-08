import { cn } from 'cn'
import type { Currency } from '@/lib/currency/provider'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'
import { MoneyText } from '@/components/common/money-text'

/**
 * The dashboard's five headline figures as ONE bordered panel (spec §6.1).
 *
 * The shape is the point. The five used to be a flat strip of equal cells, and
 * the pre-flight finding was that a page of five equal numbers has no headline:
 * Net Worth is the answer to "how am I doing", Total Balance is what is liquid
 * inside it, and the three monthly metrics are how this month went. So one flat
 * grid, re-placed at each breakpoint:
 *
 *   < 768  — `grid-cols-2`. Net Worth spans both columns; the other four fill
 *            the 2×2 beneath it, and `order-*` puts them in reading order:
 *            Tổng số dư, Thu nhập ròng, Thu nhập tháng, Chi tiêu tháng. All
 *            four visible at once, never a horizontally scrolling strip —
 *            metrics are the one thing on this page that may not be hidden
 *            (spec §6.1, §7).
 *   768–1279 — `grid-cols-6`. Net Worth full width, Total Balance full width
 *            directly beneath it, then the three monthly metrics as a THIRD
 *            row, each a full 1/3 of the width. This is a deliberate
 *            deviation from the brief's original tablet composition (Net
 *            Worth/Total Balance in the left 3 of 6 columns, the three
 *            metrics squeezed into the right 3): that layout gives each
 *            metric only 1/6 of a 768 px viewport, and a `size="lg"` figure
 *            like "36.900.000 VND" does not fit in it — measured as a real
 *            `scrollWidth` > `innerWidth` overflow at exactly 768 during
 *            Task 4's browser check. Full-width rows are comfortable at
 *            every size this panel uses and this is the composition all the
 *            way to 1279 by design: the 12-column desktop grid starts at
 *            1280.
 *   ≥ 1280 — `grid-cols-9`, which is 12ths in thirds: Net Worth and Total
 *            Balance 3/9 (= 4/12) stacked on the left, the three monthly
 *            metrics 2/9 each (= 6/9 = 8/12) as one row on the right — the
 *            brief's original composition, which has headroom at this width
 *            (2/9 of 1200 px ≈ 266 px) and is restored here with `xl:`
 *            overrides. A literal 12-column grid cannot hold three equal
 *            cells in 8 columns, and a nested grid would break the flat `dl`
 *            a screen reader walks.
 *
 * DOM order is the view model's order — Net Worth, Total Balance, Thu nhập
 * tháng, Chi tiêu tháng, Thu nhập ròng — because that is the order spec §6.1
 * gives the three monthly columns at 768 and above. Only the base width
 * re-orders, with `order-*`, and it re-orders visually only: a screen reader
 * reads the DOM, where Total Balance still follows Net Worth.
 *
 * One card, dividers inside it — never a card per cell (spec §2, "never a card
 * inside a card"). `labels`/`hints` arrive already translated, so this stays a
 * plain server component with no translator of its own and a static-markup
 * test.
 */
export function SummaryPanel({
  variant = 'dashboard',
  kpis,
  currency,
  labels,
  hints,
}: {
  variant?: 'dashboard' | 'flat'
  kpis: KpiDto[]
  currency: Currency
  labels: Record<string, string>
  hints: Record<string, string>
}) {
  // `'flat'` is Reports' three equal figures: one row, no dominant cell, no
  // note. Same card, same dividers, same `dl` semantics — only the hierarchy
  // differs, which is why it is a variant and not a second component.
  if (variant === 'flat') {
    return (
      <dl className="grid grid-cols-1 gap-px rounded-lg border border-border bg-surface md:grid-cols-3">
        {kpis.map((kpi, index) => (
          <Cell
            key={kpi.labelKey}
            kpi={kpi}
            currency={currency}
            labels={labels}
            hints={hints}
            size="kpi"
            className={cn(index > 0 && 'border-t border-border md:border-t-0 md:border-l')}
          />
        ))}
      </dl>
    )
  }

  // The view model's order, which is also spec §6.1's order for the three
  // monthly columns at 768 and above.
  const [netWorth, totalBalance, monthlyIncome, monthlyExpense, netIncome] = kpis

  return (
    <dl className="grid grid-cols-2 gap-px rounded-lg border border-border bg-surface md:grid-cols-6 xl:grid-cols-9">
      {/* Net Worth: both columns at base, full width at md, the top-left 3/9
          (= 4/12) at xl.

          DEVIATION from the brief's tablet composition (documented in Task
          4's report): the brief places Net Worth/Total Balance in the LEFT 3
          of 6 md columns with the three monthly metrics squeezed into the
          right 3 — each metric then gets 1/6 of a 768 px viewport (roughly
          100 px of content after the cell's own padding), which measurably
          overflows the page (`scrollWidth` 785 vs `innerWidth` 768 at exactly
          768, confirmed with the Step 12 capture script) once a `size="lg"`
          figure like "36.900.000 VND" has to fit in it. Net Worth and Total
          Balance instead take the FULL md width (comfortable at `hero`/`md`
          size either way) and the three metrics drop to a third row below,
          each getting a full 1/3 of the width (≈ 240 px) — enough for any
          `lg`-size VND or USD figure this app formats. xl is unaffected: at
          ≥ 1280 the metrics revert to the brief's beside-hero placement,
          where 2/9 of a 1200 px grid (≈ 266 px) already had headroom. */}
      <Cell
        kpi={netWorth}
        currency={currency}
        labels={labels}
        hints={hints}
        size="hero"
        note={labels['dashboard.netWorthNote']}
        className="order-1 col-span-2 md:col-start-1 md:col-span-6 md:row-start-1 xl:col-start-1 xl:col-span-3 xl:border-r xl:border-border"
      />

      {/* Total Balance: directly under Net Worth at every width from md up.
          `order-2` at base puts it first in the 2×2. */}
      <Cell
        kpi={totalBalance}
        currency={currency}
        labels={labels}
        hints={hints}
        size="md"
        className="order-2 border-t border-border md:col-start-1 md:col-span-6 md:row-start-2 xl:col-start-1 xl:col-span-3 xl:border-r xl:border-border"
      />

      {/* The three monthly metrics, in spec §6.1's order. A full-width third
          row at md (see the deviation note above), each spanning both of the
          left column's rows again from xl up so the two blocks read as one
          composition once there is room for it. At base they take `order-4`
          and `order-5`, which leaves Thu nhập ròng (`order-3`) beside Total
          Balance on the 2×2's first line — the reading order the spec fixes. */}
      <Cell
        kpi={monthlyIncome}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        className="order-4 border-t border-border md:col-start-1 md:col-span-2 md:row-start-3 xl:col-start-4 xl:col-span-2 xl:row-start-1 xl:row-span-2 xl:border-t-0"
      />
      <Cell
        kpi={monthlyExpense}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        className="order-5 border-t border-l border-border md:col-start-3 md:col-span-2 md:row-start-3 xl:col-start-6 xl:col-span-2 xl:row-start-1 xl:row-span-2 xl:border-t-0"
      />
      <Cell
        kpi={netIncome}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        className="order-3 border-t border-l border-border md:col-start-5 md:col-span-2 md:row-start-3 xl:col-start-8 xl:col-span-2 xl:row-start-1 xl:row-span-2 xl:border-t-0"
      />
    </dl>
  )
}

/**
 * One `dt`/`dd` pair in a wrapper `div` — which is what a `dl` may contain
 * besides bare terms and descriptions, and what lets each cell be one grid item
 * carrying its own placement classes.
 */
function Cell({
  kpi,
  currency,
  labels,
  hints,
  size,
  note,
  className,
}: {
  kpi: KpiDto
  currency: Currency
  labels: Record<string, string>
  hints: Record<string, string>
  size: 'md' | 'lg' | 'kpi' | 'hero'
  note?: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1 bg-surface p-4', className)}>
      <dt className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{labels[kpi.labelKey]}</dt>
      <dd className="flex flex-col gap-1">
        <Figure kpi={kpi} currency={currency} hints={hints} size={size} />
        {note && <span className="text-xs/[1rem] text-muted-foreground">{note}</span>}
      </dd>
    </div>
  )
}

/**
 * One figure, or the em dash and the reason there is none.
 *
 * An em dash and not a zero: "we cannot say" and "nothing" are different
 * answers and only one of them is a number. The hint appears only in the cells
 * an FX outage actually broke — the three monthly metrics are historical and
 * are restated from each row's own snapshot, so they are never affected.
 */
function Figure({
  kpi,
  currency,
  hints,
  size,
}: {
  kpi: KpiDto
  currency: Currency
  hints: Record<string, string>
  size: 'md' | 'lg' | 'kpi' | 'hero'
}) {
  if (kpi.value === null) {
    return (
      <span className="flex flex-col gap-1">
        <MoneyText value="—" tone="muted" size={size} />
        {kpi.hintKey && (
          <span className="text-xs/[1rem] text-muted-foreground">{hints[kpi.hintKey]}</span>
        )}
      </span>
    )
  }
  return (
    <MoneyText
      value={kpi.value}
      currency={currency}
      tone={kpi.negative ? 'negative' : 'default'}
      size={size}
    />
  )
}
