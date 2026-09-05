import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { listTransactions } from '@/lib/server/services/transaction'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listCategories } from '@/lib/server/services/category'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { TransactionForm } from '@/components/transactions/transaction-form'
import { TransactionList } from '@/components/transactions/transaction-list'

export default async function TransactionsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  const [transactions, accounts, expenseCategories, incomeCategories] = await Promise.all([
    listTransactions(user.id),
    listActiveFinancialAccounts(user.id),
    listCategories(user.id, 'EXPENSE'),
    listCategories(user.id, 'INCOME'),
  ])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <TransactionList transactions={transactions} timezone={timezone} />
      <div>
        <h2 className="mb-3 text-lg font-semibold">Add transaction</h2>
        <TransactionForm
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
          categories={[...expenseCategories, ...incomeCategories]}
          timezone={timezone}
        />
      </div>
    </div>
  )
}
