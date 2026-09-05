import { formatInTimeZone } from 'date-fns-tz'

/**
 * No Prisma import here — the page fetches and shapes the rows; this
 * component only renders. Amounts arrive as strings (the page's
 * `Decimal#toFixed(2)`) rather than raw `Decimal`s, and `exchangeRateUsed` as
 * `Decimal#toString()` or `null` for a same-currency transfer.
 */
type Row = {
  id: string
  date: Date
  fromAmount: string
  toAmount: string
  exchangeRateUsed: string | null
  fromAccount: { name: string; currency: string }
  toAccount: { name: string; currency: string }
}

const amountFormatter = new Intl.NumberFormat('vi-VN')

export function TransferList({
  transfers,
  timezone,
}: {
  transfers: Row[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page) — same rationale as `TransactionList`: formatting `date`
   * (a UTC instant) in the user's own calendar day keeps the server render
   * and client hydration identical while still showing *their* day.
   */
  timezone: string
}) {
  if (transfers.length === 0) {
    return <p className="text-sm text-foreground/60">No transfers yet — add one below.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {transfers.map((t) => {
        const crossCurrency = t.fromAccount.currency !== t.toAccount.currency
        return (
          <li key={t.id} className="rounded-md border p-3">
            <p className="font-medium">
              {t.fromAccount.name} → {t.toAccount.name}:{' '}
              {/* Display only — amounts arrive pre-formatted as fixed-2-decimal
                 strings from the page; `Number(...)` here only feeds the
                 formatter, never any arithmetic. */}
              {amountFormatter.format(Number(t.fromAmount))} {t.fromAccount.currency}
              {crossCurrency && (
                <>
                  {' '}
                  → {amountFormatter.format(Number(t.toAmount))} {t.toAccount.currency}
                </>
              )}
            </p>
            <p className="text-sm text-foreground/60">
              {formatInTimeZone(t.date, timezone, 'yyyy-MM-dd')}
            </p>
            {crossCurrency && t.exchangeRateUsed && (
              <p className="text-xs text-foreground/50">rate {t.exchangeRateUsed}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
