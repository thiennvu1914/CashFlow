import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listTransfers } from '@/lib/server/services/transfer'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { TransferForm } from '@/components/transfers/transfer-form'
import { TransferList } from '@/components/transfers/transfer-list'

export default async function TransfersPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  const [accounts, transfers] = await Promise.all([
    listActiveFinancialAccounts(user.id),
    listTransfers(user.id),
  ])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <TransferList
        transfers={transfers.map((t) => ({
          id: t.id,
          date: t.date,
          // Display strings only — Decimal math already happened in the
          // service; nothing here feeds back into any calculation.
          fromAmount: t.fromAmount.toFixed(2),
          toAmount: t.toAmount.toFixed(2),
          exchangeRateUsed: t.exchangeRateUsed ? t.exchangeRateUsed.toString() : null,
          fromAccount: { name: t.fromAccount.name, currency: t.fromAccount.currency },
          toAccount: { name: t.toAccount.name, currency: t.toAccount.currency },
        }))}
        timezone={timezone}
      />
      <div>
        <h2 className="mb-3 text-lg font-semibold">New transfer</h2>
        <TransferForm
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        />
      </div>
    </div>
  )
}
