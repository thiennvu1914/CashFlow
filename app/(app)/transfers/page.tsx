import { Wallet } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { resolveLocale } from '@/lib/i18n/config'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listTransfers } from '@/lib/server/services/transfer'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { SectionHeader } from '@/components/common/section-header'
import { TransferForm } from '@/components/transfers/transfer-form'
import { TransferList } from '@/components/transfers/transfer-list'

export default async function TransfersPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  const locale = await resolveLocale()
  const t = await getTranslations()
  const [accounts, transfers] = await Promise.all([
    listActiveFinancialAccounts(user.id),
    listTransfers(user.id),
  ])

  // Fewer than two ACTIVE accounts (spec §6.3, owner requirement): a transfer
  // needs a genuine FROM and TO, so this `EmptyState` replaces whatever it
  // would otherwise sit next to — the form always (there is nothing it could
  // usefully submit), and the LIST too when there is no history yet (Task 5b
  // fix round 1, promoted minor): the two used to stack ("Chưa có lệnh
  // chuyển nào" over "Cần ít nhất hai tài khoản…"), which read as two
  // different problems instead of one. `listActiveFinancialAccounts` already
  // excludes archived accounts, so an archived second account cannot
  // silently make this branch pass.
  const needsTwoAccounts = accounts.length < 2
  const needTwoAccountsNotice = (
    <EmptyState
      icon={Wallet}
      size="page"
      title={t('transfers.needTwoAccountsTitle')}
      description={t('transfers.needTwoAccountsBody')}
      action={{ label: t('transfers.needTwoAccountsAction'), href: '/accounts' }}
    />
  )

  return (
    <div className="mx-auto flex max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader title={t('transfers.title')} />

      {needsTwoAccounts && transfers.length === 0 ? (
        needTwoAccountsNotice
      ) : (
        <>
          <TransferList
            transfers={transfers.map((transfer) => ({
              id: transfer.id,
              date: transfer.date,
              // Display strings only — Decimal math already happened in the
              // service; nothing here feeds back into any calculation.
              fromAmount: transfer.fromAmount.toFixed(2),
              toAmount: transfer.toAmount.toFixed(2),
              exchangeRateUsed: transfer.exchangeRateUsed
                ? transfer.exchangeRateUsed.toString()
                : null,
              fromAccount: {
                name: transfer.fromAccount.name,
                currency: transfer.fromAccount.currency,
              },
              toAccount: { name: transfer.toAccount.name, currency: transfer.toAccount.currency },
            }))}
            timezone={timezone}
            locale={locale}
          />

          <div className="flex flex-col gap-4">
            <SectionHeader title={t('transfers.createTitle')} />
            {/* History already showed above (or there was none to hide), but
                the form itself is still not usable with fewer than two
                accounts — this narrower notice replaces only the form. */}
            {needsTwoAccounts ? (
              needTwoAccountsNotice
            ) : (
              <TransferForm
                accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
                timezone={timezone}
                locale={locale}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
