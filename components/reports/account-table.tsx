import { cn } from 'cn'
import type { Currency } from '@/lib/currency/provider'
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
export function AccountTable({
  rows,
  currency,
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
  currency: Currency
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
            <tr key={row.id}>
              <th scope="row" className="py-2 pr-4 text-left font-normal">
                {row.name}
              </th>
              <td className="py-2 pl-4 text-right tabular-nums">{row.income}</td>
              <td className="py-2 pl-4 text-right tabular-nums">{row.expense}</td>
              <td
                className={cn(
                  'py-2 pl-4 text-right font-medium tabular-nums',
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
          <li key={row.id} className="flex flex-col gap-1 py-3">
            <p className="text-sm font-medium">{row.name}</p>
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
