import { requireUserOrRedirect } from '@/lib/auth/require-user'
import {
  listActiveFinancialAccounts,
  listAllFinancialAccounts,
  accountsWithActivity,
} from '@/lib/server/services/financial-account'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { getAccountBalances } from '@/lib/server/services/balance'
import { AccountForm } from '@/components/accounts/account-form'
import { AccountList } from '@/components/accounts/account-list'

export default async function AccountsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const [accounts, accountTypes, allAccounts] = await Promise.all([
    listActiveFinancialAccounts(user.id),
    listAccountTypes(user.id),
    listAllFinancialAccounts(user.id),
  ])
  const archivedAccounts = allAccounts.filter((a) => a.status === 'ARCHIVED')
  // One batched call for every account on the page — never one query per
  // account — via `getAccountBalances`'s single `groupBy` + `findMany`.
  const [balances, locked] = await Promise.all([
    getAccountBalances(
      user.id,
      accounts.map((a) => a.id),
    ),
    // Whether an edit form must disable/omit currency & initialBalance
    // (Task 15's lock) — one batched query for every account on the page,
    // never one `accountHasActivity` call per row.
    accountsWithActivity(
      user.id,
      accounts.map((a) => a.id),
    ),
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
      <AccountList accounts={accountsWithBalance} accountTypes={accountTypes} />
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
