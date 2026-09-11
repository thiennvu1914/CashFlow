import { cn } from 'cn'
import { ArrowDownLeft, ArrowUpRight, ShieldCheck, TrendingUp, Wallet } from 'lucide-react'
import type { Currency } from '@/lib/currency/provider'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'
import { MoneyText, type MoneySize } from '@/components/common/money-text'

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
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-surface shadow-sm md:grid-cols-3">
        {kpis.map((kpi, index) => (
          <Cell
            key={kpi.labelKey}
            kpi={kpi}
            currency={currency}
            labels={labels}
            hints={hints}
            size="kpi"
            // The grid goes to three EQUAL columns at exactly `md` (768) —
            // the same breakpoint `kpi`'s own bump used to use, which is what
            // clipped a 13-character VND figure against its neighbour at 768
            // (fix round 1, IMPORTANT finding: reverting `kpi` to `md:` in
            // `money-text.tsx` — it is shared with `loan-list.tsx` — moved
            // the fix here instead). `smallSize="lg"` (24 px, no breakpoint
            // of its own) covers the tight 768–1023 range and `smallBreakpoint
            // ="lg"` is what makes the split switch back to the full `kpi`
            // figure at 1024, where three columns already have room (proven
            // in this fix round's re-capture) — not at `sm` (640), which is
            // the OTHER cells' breakpoint and would leave the 768–1023 range
            // still showing the clipping-size figure.
            smallSize="lg"
            smallBreakpoint="lg"
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
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-surface shadow-sm md:grid-cols-6 xl:grid-cols-9">
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
        smallSize="row"
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
        smallSize="row"
        className="order-4 border-t border-border md:col-start-1 md:col-span-2 md:row-start-3 xl:col-start-4 xl:col-span-2 xl:row-start-1 xl:row-span-2 xl:border-t-0"
      />
      <Cell
        kpi={monthlyExpense}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        smallSize="row"
        className="order-5 border-t border-l border-border md:col-start-3 md:col-span-2 md:row-start-3 xl:col-start-6 xl:col-span-2 xl:row-start-1 xl:row-span-2 xl:border-t-0"
      />
      <Cell
        kpi={netIncome}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        smallSize="row"
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
  smallSize,
  smallBreakpoint,
  note,
  className,
}: {
  kpi: KpiDto
  currency: Currency
  labels: Record<string, string>
  hints: Record<string, string>
  size: MoneySize
  /**
   * The figure's size below `sm` (fix round 1, area C): the base grid is only
   * two columns wide, so each of the four 2×2 cells has roughly a phone's
   * half-width to show a figure in — a `size="lg"` (24 px) or even `"md"`
   * (22 px) 14-character VND figure ("21.141.376,59") no longer fits that
   * comfortably and was sitting flush against, or past, the card's right
   * edge. Undefined for Net Worth, the only cell that spans both base columns
   * and therefore never needed a smaller figure at any width.
   */
  smallSize?: MoneySize
  /**
   * Which breakpoint the `smallSize`/`size` split switches at (fix round 1,
   * IMPORTANT finding). Defaults to `'sm'` (640) — the dashboard variant's
   * four non-hero cells, which need the smaller figure only below the base
   * 2-column grid's own breakpoint. The `flat` variant passes `'lg'` (1024)
   * instead: its three-column grid starts at `md` (768) and stays tight
   * through 1023, so the smaller figure has to cover that whole range, not
   * just below `sm`.
   */
  smallBreakpoint?: 'sm' | 'lg'
  note?: string
  className?: string
}) {
  const isNetWorth = size === 'hero'
  const isTotalBalance = kpi.labelKey.includes('totalBalance')
  const isIncome = kpi.labelKey.includes('monthlyIncome')
  const isExpense = kpi.labelKey.includes('monthlyExpense')
  const isNetIncome = kpi.labelKey.includes('netIncome')

  return (
    <div
      className={cn(
        'group flex flex-col gap-2 bg-surface p-5 transition-all duration-150 hover:brightness-[0.98] dark:hover:brightness-110 xl:justify-center',
        isNetWorth && 'bg-gradient-to-br from-surface via-surface to-brand/12 dark:to-brand/20',
        isTotalBalance &&
          'bg-gradient-to-br from-surface via-surface to-accent/10 dark:to-accent/18',
        isIncome && 'bg-gradient-to-br from-surface via-surface to-positive/10 dark:to-positive/18',
        isExpense &&
          'bg-gradient-to-br from-surface via-surface to-negative/10 dark:to-negative/18',
        isNetIncome && 'bg-gradient-to-br from-surface via-surface to-brand/10 dark:to-brand/18',
        className,
      )}
    >
      <dt className="flex items-center gap-2.5 text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
        {isNetWorth && (
          <span className="flex size-7 items-center justify-center rounded-lg bg-brand/15 text-brand ring-1 ring-brand/30 shadow-xs">
            <ShieldCheck className="size-4" />
          </span>
        )}
        {isTotalBalance && (
          <span className="flex size-6.5 items-center justify-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/30 shadow-xs">
            <Wallet className="size-3.5" />
          </span>
        )}
        {isIncome && (
          <span className="flex size-6.5 items-center justify-center rounded-lg bg-positive/15 text-positive ring-1 ring-positive/30 shadow-xs">
            <ArrowDownLeft className="size-3.5" />
          </span>
        )}
        {isExpense && (
          <span className="flex size-6.5 items-center justify-center rounded-lg bg-negative/15 text-negative ring-1 ring-negative/30 shadow-xs">
            <ArrowUpRight className="size-3.5" />
          </span>
        )}
        {isNetIncome && (
          <span className="flex size-6.5 items-center justify-center rounded-lg bg-brand/15 text-brand ring-1 ring-brand/30 shadow-xs">
            <TrendingUp className="size-3.5" />
          </span>
        )}
        <span className="font-semibold text-foreground/80">{labels[kpi.labelKey]}</span>
      </dt>
      <dd className="flex flex-col gap-1">
        <Figure
          kpi={kpi}
          currency={currency}
          hints={hints}
          size={size}
          smallSize={smallSize}
          smallBreakpoint={smallBreakpoint}
        />
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
 *
 * `smallSize` renders TWO `MoneyText`s for a REAL value, one hidden below the
 * split and one hidden above it — not a single responsive font-size utility —
 * because `MoneyText`'s `size` prop already resolves to a fixed class combo
 * on its OWN inner span (not something a caller's `className` can reach or
 * override; see `money-text.tsx`). The split defaults to `sm` (640) but the
 * `flat` variant passes `lg` (1024) — see `smallBreakpoint` on `Cell`.
 * `undefined` (Net Worth) skips the split entirely and renders exactly as
 * before. The em-dash (no usable value) branch never splits regardless of
 * `smallSize`: a single "—" is never at risk of clipping at any width, and
 * duplicating it would only double what a screen reader announces.
 */
const SMALL_SIZE_CLASSES: Record<'sm' | 'lg', { small: string; large: string }> = {
  sm: { small: 'sm:hidden', large: 'hidden sm:inline-flex' },
  lg: { small: 'lg:hidden', large: 'hidden lg:inline-flex' },
}

function Figure({
  kpi,
  currency,
  hints,
  size,
  smallSize,
  smallBreakpoint = 'sm',
}: {
  kpi: KpiDto
  currency: Currency
  hints: Record<string, string>
  size: MoneySize
  smallSize?: MoneySize
  smallBreakpoint?: 'sm' | 'lg'
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
  const tone = kpi.negative ? 'negative' : 'default'
  if (!smallSize) {
    return <MoneyText value={kpi.value} currency={currency} tone={tone} size={size} />
  }
  const { small, large } = SMALL_SIZE_CLASSES[smallBreakpoint]
  return (
    <>
      <MoneyText
        value={kpi.value}
        currency={currency}
        tone={tone}
        size={smallSize}
        className={small}
      />
      <MoneyText value={kpi.value} currency={currency} tone={tone} size={size} className={large} />
    </>
  )
}
