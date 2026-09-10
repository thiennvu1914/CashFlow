import { cn } from 'cn'

export type MoneySize = 'meta' | 'row' | 'md' | 'lg' | 'kpi' | 'hero'
export type MoneyTone = 'default' | 'positive' | 'negative' | 'muted'

/**
 * A money figure on screen (spec §2).
 *
 * It never formats: `value` is already the output of `formatMoney`, which is
 * the single place a `Prisma.Decimal` becomes a string. This component owns
 * only the *typography* of a figure — tabular digits so a column lines up, no
 * mid-number wrap, the currency code trailing at 12/500 muted, and the sign
 * (which comes from the transaction's `type`, never from arithmetic).
 *
 * Expense and neutral figures are `foreground`, not red: only income is
 * positive-toned and only a negative *total* is negative-toned (spec §2), so a
 * page of ordinary spending does not read as a page of errors.
 */
/**
 * Six sizes, all from spec §2's type scale — and `md`/`lg` exist because the
 * dashboard's summary panel needs three distinct weights of figure in one card
 * (§6.1): Net Worth `hero` 36/40, Total Balance `md` 22/28 beneath it, and the
 * three monthly metrics `lg` 24/30 beside it. `kpi` 30/36 is Reports' three
 * equal figures. A panel built from one size has no headline, which was the
 * pre-flight finding.
 *
 * `kpi` bumps at `md:` (768), same as `hero` — this is a SHARED size (also
 * used by `components/loans/loan-list.tsx`'s outstanding-principal figure),
 * so its breakpoint is not Reports' to move. A Task 10 fix round moved it to
 * `lg:` to paper over a Reports-only clipping bug, which quietly shrank
 * `/loans`' `kpi` figure at 768–1023 too (an accepted screen, unrelated to
 * Reports) — reverted. The clipping fix now lives where the bug actually is:
 * `SummaryPanel`'s `flat` variant (`components/dashboard/summary-panel.tsx`),
 * which switches to its three-column grid at this same `md` breakpoint and
 * needs a smaller figure specifically in the 768–1023 range, using the
 * existing `smallSize` two-instance technique at a `lg` split instead of
 * `sm`.
 */
const SIZE_CLASSES: Record<MoneySize, string> = {
  meta: 'text-[0.8125rem]/[1.125rem] font-normal',
  row: 'text-[0.9375rem]/[1.25rem] font-semibold',
  md: 'text-[1.375rem]/[1.75rem] font-semibold',
  lg: 'text-[1.5rem]/[1.875rem] font-semibold',
  kpi: 'text-[1.625rem]/[2rem] font-semibold md:text-[1.875rem]/[2.25rem]',
  hero: 'text-[1.875rem]/[2.25rem] font-semibold md:text-4xl/[2.5rem]',
}

const TONE_CLASSES: Record<MoneyTone, string> = {
  default: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-negative',
  muted: 'text-muted-foreground',
}

export function MoneyText({
  value,
  currency,
  tone = 'default',
  size = 'row',
  sign,
  className,
}: {
  value: string
  currency?: string
  tone?: MoneyTone
  size?: MoneySize
  sign?: '+' | '−'
  className?: string
}) {
  return (
    // `flex-wrap` with a `whitespace-nowrap` figure: the number may never break
    // mid-digit, but the code is allowed to drop to a second line on a narrow
    // phone rather than force the figure out of its column.
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-1', className)}>
      <span
        className={cn('whitespace-nowrap tabular-nums', SIZE_CLASSES[size], TONE_CLASSES[tone])}
      >
        {sign}
        {value}
      </span>
      {currency && (
        <span className="text-xs/[1rem] font-medium text-muted-foreground">{currency}</span>
      )}
    </span>
  )
}
