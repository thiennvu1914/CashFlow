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
 * `--color-accent` via `Progress`'s brand tone is deliberate — a spending
 * breakdown is a neutral fact, not a good/bad judgement, which is the same
 * choice `chart-theme.ts` makes for the account distribution.
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
        <li key={row.id} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm">{row.name}</span>
            <MoneyText value={row.amount} currency={currency} />
          </div>
          <Progress
            percent={row.percent}
            valueText={row.percentLabel}
            label={row.name}
            tone="brand"
          />
        </li>
      ))}
    </ul>
  )
}
