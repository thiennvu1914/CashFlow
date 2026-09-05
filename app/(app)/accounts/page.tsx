import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { getAccountBalances } from '@/lib/server/services/balance'
import { AccountForm } from '@/components/accounts/account-form'
import { AccountList } from '@/components/accounts/account-list'

export default async function AccountsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const [accounts, accountTypes] = await Promise.all([
    listActiveFinancialAccounts(user.id),
    listAccountTypes(user.id),
  ])
  // One batched call for every account on the page — never one query per
  // account — via `getAccountBalances`'s single `groupBy` + `findMany`.
  const balances = await getAccountBalances(
    user.id,
    accounts.map((a) => a.id),
  )
  // Serialised to a string here: a `Prisma.Decimal` cannot cross the
  // server-to-client-component boundary, so `AccountList` receives text and
  // formats it for display only. `.get(account.id)` is always present —
  // `balances` was requested with exactly this page's account ids.
  const accountsWithBalance = accounts.map((account) => {
    const balance = balances.get(account.id)
    if (!balance) throw new Error(`Missing balance for account ${account.id}`)
    return { ...account, balance: balance.toFixed(2) }
  })

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <AccountList accounts={accountsWithBalance} />
      <div>
        <h2 className="mb-3 text-lg font-semibold">Add account</h2>
        <AccountForm accountTypes={accountTypes} />
      </div>
    </div>
  )
}
