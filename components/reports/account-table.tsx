import { cn } from 'cn'
import { MoneyText } from '@/components/common/money-text'

/**
 * Which account the money moved through (spec §6.8).
 *
 * Two renderings of the same rows, and both are in the DOM: a real `<table>`
 * from 768 up, and a stacked list below it. Not one table with
 * `overflow-x-auto` — a four-column money table on a 375 px phone is a table
 * nobody reads sideways, and spec §7 says tables become stacked rows below 768.
 *
 * The duplication is deliberate and cheap: these are a handful of already
 * formatted strings, and the alternative (a `useMediaQuery`) would make a
 * server-rendered table depend on the client.
 */
/*
 * The currency is NOT a prop (Task 18, owner item I11 — it was here, unused,
 * and the only `no-unused-vars` warning left in the product). Every figure
 * this table renders arrives as an already formatted string from
 * `app/(app)/reports/page.tsx`, and the unit itself is stated once for the
 * whole card by that page's `<ChartContainer caption={displayCurrency}>` —
 * repeating it per cell is what the report deliberately does not do. So there
 * was nothing for the prop to affect, and taking it away is the honest fix
 * rather than spending it on a currency code in ninety cells.
 */
export function AccountTable({
  rows,
  labels,
}: {
  rows: {
    id: string
    name: string
    income: string
    expense: string
    netIncome: string
    netNegative: boolean
  }[]
  labels: { account: string; income: string; expense: string; netIncome: string }
}) {
  return (
    <>
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="border-b border-border text-xs/[1rem] tracking-[0.04em] text-muted-foreground uppercase">
            <th scope="col" className="py-2 text-left font-medium">
              {labels.account}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {labels.income}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {labels.expense}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {labels.netIncome}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id} className="transition-colors hover:bg-muted/30">
              <th scope="row" className="py-2.5 pr-4 text-left font-medium">
                {row.name}
              </th>
              <td className="py-2.5 pl-4 text-right tabular-nums">{row.income}</td>
              <td className="py-2.5 pl-4 text-right tabular-nums">{row.expense}</td>
              <td
                className={cn(
                  'py-2.5 pl-4 text-right font-medium tabular-nums',
                  row.netNegative && 'text-negative',
                )}
              >
                {row.netIncome}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="flex flex-col divide-y divide-border md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1.5 py-3 transition-colors hover:bg-muted/30">
            <p className="text-sm font-semibold">{row.name}</p>
            <dl className="grid grid-cols-3 gap-2">
              <div className="flex flex-col">
                <dt className="text-xs/[1rem] text-muted-foreground">{labels.income}</dt>
                <dd>
                  <MoneyText value={row.income} size="meta" />
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs/[1rem] text-muted-foreground">{labels.expense}</dt>
                <dd>
                  <MoneyText value={row.expense} size="meta" />
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs/[1rem] text-muted-foreground">{labels.netIncome}</dt>
                <dd>
                  <MoneyText
                    value={row.netIncome}
                    size="meta"
                    tone={row.netNegative ? 'negative' : 'default'}
                  />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}
