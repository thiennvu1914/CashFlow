import { Progress } from '@/components/common/progress'
import { MoneyText } from '@/components/common/money-text'
import type { Currency } from '@/lib/currency/provider'

/**
 * Where the money went, as horizontal bars with their figures (spec §6.8).
 *
 * A list of names and numbers answers "how much"; a bar answers "compared to
 * what", which is the question a breakdown exists for. The bar is relative to
 * the LARGEST row, not to the total: a chart in which the biggest slice is 30 %
 * wide is a chart of empty space.
 *
 * `tone="accent"` (`--color-accent` via `Progress`) is deliberate — a
 * spending breakdown is a neutral fact, not a good/bad judgement, which is
 * the same choice `chart-theme.ts` makes for the account distribution.
 * Task 14 (owner item E3) made that reasoning the product-wide convention and
 * wrote it down in `components/dashboard/chart-theme.ts`: this row is the
 * `distribution` slot (`--color-accent`), and the dashboard's
 * `ExpenseByCategoryChart` — the same breakdown of the same numbers — was
 * moved onto the same slot so the two cannot disagree. `expense`
 * (`--color-negative`) stays reserved for a series that stands opposite an
 * income series.
 *
 * `decorative` (fix round 1, promoted minor): the bar's width is a share of
 * the LARGEST row, but `row.percentLabel` beside it is a share of the TOTAL —
 * two different percentages of the same row. `Progress`'s real
 * `role="progressbar"` contract assumes one quantity whose fill and announced
 * value agree, which these two numbers do not, and a zero-total denominator
 * could reach it as a literal "NaN %" announcement. The bar is a picture here;
 * the row's own visible name, amount and percent — already real text — carry
 * the meaning.
 */
export function CategoryBars({
  rows,
  currency,
}: {
  rows: { id: string; name: string; amount: string; percent: number; percentLabel: string }[]
  currency: Currency
}) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex flex-col gap-1.5 rounded-lg p-1.5 -mx-1.5 transition-colors hover:bg-muted/30"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
            <div className="flex items-baseline gap-2">
              {/* The share-of-total percent, as real visible text — not only
                  `Progress`'s (now decorative, fix round 1) `aria-valuetext`,
                  which nobody sighted or not could otherwise read. */}
              <span className="text-xs/[1rem] tabular-nums text-muted-foreground">
                {row.percentLabel}
              </span>
              <MoneyText value={row.amount} currency={currency} />
            </div>
          </div>
          <Progress
            percent={row.percent}
            valueText={row.percentLabel}
            label={row.name}
            tone="accent"
            decorative
          />
        </li>
      ))}
    </ul>
  )
}
