import type { Currency } from '@prisma/client'

type AccountWithBalance = {
  id: string
  name: string
  currency: Currency
  accountType: { name: string }
  /**
   * Serialised with `.toFixed(2)` on the server (`app/(app)/accounts/page.tsx`)
   * — a `Prisma.Decimal` is not a plain object a server component can pass to
   * a client component, so the balance crosses that boundary as a string and
   * is parsed back with `Number()` here for display only.
   */
  balance: string
}

function formatBalance(balance: string, currency: Currency): string {
  // `Number()` here is for DISPLAY ONLY — the value driving this string
  // already came out of `Prisma.Decimal` arithmetic in the balance service;
  // nothing here re-derives or stores a balance.
  return new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: currency === 'USD' ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(Number(balance))
}

export function AccountList({ accounts }: { accounts: AccountWithBalance[] }) {
  if (accounts.length === 0) {
    return <p className="text-sm text-foreground/60">No accounts yet — add one below.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {accounts.map((account) => {
        const isNegative = account.balance.startsWith('-')
        return (
          <li key={account.id} className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="font-medium">{account.name}</p>
              <p className="text-sm text-foreground/60">
                {account.accountType.name} · {account.currency}
              </p>
            </div>
            <span className={`tabular-nums ${isNegative ? 'text-negative' : ''}`}>
              {formatBalance(account.balance, account.currency)} {account.currency}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
