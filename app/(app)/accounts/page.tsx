import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listAccountTypes } from '@/lib/server/services/account-type'
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

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <AccountList accounts={accounts} />
      <div>
        <h2 className="mb-3 text-lg font-semibold">Add account</h2>
        <AccountForm accountTypes={accountTypes} />
      </div>
    </div>
  )
}
