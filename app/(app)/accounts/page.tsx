import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { prisma } from '@/lib/prisma'
import {
  listActiveFinancialAccounts,
  listAllFinancialAccounts,
  accountsWithActivity,
} from '@/lib/server/services/financial-account'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { getCurrentAccountBalances } from '@/lib/server/services/balance'
import { AccountForm } from '@/components/accounts/account-form'
import { AccountList } from '@/components/accounts/account-list'

/**
 * How many of this user's entries are dated after `now` — a transaction or
 * either leg of a transfer. Only ever compared against zero: it decides whether
 * the "balances are as of now" note is shown, so the note appears exactly when
 * it has something to explain and stays absent for the ordinary user who never
 * post-dates anything.
 */
async function countFutureDatedEntries(userId: string, now: Date): Promise<number> {
  const [transactions, transfers] = await Promise.all([
    prisma.transaction.count({ where: { userId, date: { gt: now } } }),
    prisma.transfer.count({ where: { userId, date: { gt: now } } }),
  ])
  return transactions + transfers
}

export default async function AccountsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  // ONE `now` for the whole request — the page owns it, not a component and not
  // a service reading the clock again mid-render, so every balance below is cut
  // at the same instant.
  const now = new Date()
  const [accounts, accountTypes, allAccounts] = await Promise.all([
    listActiveFinancialAccounts(user.id),
    listAccountTypes(user.id),
    listAllFinancialAccounts(user.id),
  ])
  const archivedAccounts = allAccounts.filter((a) => a.status === 'ARCHIVED')
  // One batched call for every account on the page — never one query per
  // account — via `getCurrentAccountBalances`'s single `groupBy` + `findMany`.
  //
  // `getCurrentAccountBalances`, not `getAccountBalances`: a "current balance"
  // means the same thing here as on the dashboard and in the Excel export —
  // the balance as of now, with future-dated entries excluded until their date
  // (`lib/server/services/balance.ts`). Those entries are still stored and
  // still listed on the Transactions and Transfers pages; they simply are not
  // money held yet.
  const [balances, locked, futureDatedCount] = await Promise.all([
    getCurrentAccountBalances(
      user.id,
      accounts.map((a) => a.id),
      now,
    ),
    // Whether an edit form must disable/omit currency & initialBalance
    // (Task 15's lock) — one batched query for every account on the page,
    // never one `accountHasActivity` call per row.
    accountsWithActivity(
      user.id,
      accounts.map((a) => a.id),
    ),
    // Two cheap counts, only to decide whether the "as of now" note below is
    // worth showing. Not a balance input — nothing on this page is derived
    // from it.
    countFutureDatedEntries(user.id, now),
  ])
  // Serialised to a string/number here: a `Prisma.Decimal` cannot cross the
  // server-to-client-component boundary, so `AccountList` receives plain
  // values and formats/edits them for display only. `.get(account.id)` is
  // always present — `balances` was requested with exactly this page's
  // account ids.
  const accountsWithBalance = accounts.map((account) => {
    const balance = balances.get(account.id)
    if (!balance) throw new Error(`Missing balance for account ${account.id}`)
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      description: account.description,
      initialBalance: account.initialBalance.toNumber(),
      accountTypeId: account.accountTypeId,
      accountType: { name: account.accountType.name },
      balance: balance.toFixed(2),
      locked: locked.has(account.id),
    }
  })

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <AccountList accounts={accountsWithBalance} accountTypes={accountTypes} />
        {futureDatedCount > 0 && (
          <p className="text-sm text-muted-foreground">
            Balances are as of now; future-dated entries are excluded until their date.
          </p>
        )}
      </div>
      <div>
        <h2 className="mb-3 text-lg font-semibold">Add account</h2>
        <AccountForm accountTypes={accountTypes} />
      </div>
      {archivedAccounts.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-foreground/60">
            Archived accounts ({archivedAccounts.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {archivedAccounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between rounded-md border p-3 opacity-70"
              >
                <div>
                  <p className="font-medium">{account.name}</p>
                  <p className="text-sm text-foreground/60">
                    {account.accountType.name} · {account.currency}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
