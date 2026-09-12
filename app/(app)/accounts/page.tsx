import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { getAccountOverview } from '@/lib/server/services/account-overview'
import { resolveLocale } from '@/lib/i18n/config'
import { formatMoney } from '@/lib/ui/format-money'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { AccountCreateButton } from '@/components/accounts/account-create-button'
import { AccountList } from '@/components/accounts/account-list'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'

export default async function AccountsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const { baseCurrency: displayCurrency } = resolveProfileDefaults(user)
  const t = await getTranslations()
  const locale = await resolveLocale()
  // ONE `now` for the whole request — the page owns it, not a component and not
  // a service reading the clock again mid-render, so every balance below is cut
  // at the same instant.
  const now = new Date()
  const { accounts, archivedAccounts, accountTypes, position, balances, locked, hasFutureEntries } =
    await getAccountOverview(user.id, displayCurrency, now)
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
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('accounts.title')}
        description={
          position === null
            ? t('accounts.totalUnavailable')
            : t('accounts.total', {
                amount: formatMoney(position.totalBalance, displayCurrency, locale),
                currency: displayCurrency,
              })
        }
        meta={hasFutureEntries ? t('accounts.asOfNow') : undefined}
        actions={<AccountCreateButton accountTypes={accountTypes} />}
      />

      <AccountList accounts={accountsWithBalance} accountTypes={accountTypes} locale={locale} />

      {archivedAccounts.length > 0 && (
        <details className="rounded-lg border border-border bg-surface">
          {/* A heading element as a `<summary>`'s label is explicit content
              model (a `<summary>` may include one `h1`-`h6` as its label), and
              it is what gives this disclosure's own section a real heading
              rather than a clickable paragraph — the same treatment
              `/debts` and `/loans` already gave their written-off and closed
              sections, brought here by Task 16's heading-outline sweep (owner
              item G1): the page had no `h2` at all, so the archived list was
              a section with no name. `inline` keeps it on the summary's own
              line, so nothing moves.
              `max-md:min-h-11` is the 44 px touch target below the icon rail
              (routed from Task 15, which measured this summary at 42 px and
              deferred it): +2 px on a phone, nothing at all from `md` up. */}
          <summary className="cursor-pointer px-4 py-3 max-md:min-h-11">
            <h2 className="inline text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
              {t('accounts.archivedSection', { count: archivedAccounts.length })}
            </h2>
          </summary>
          {/* Read-only, like every other archived section in this app: an
              archived account refuses every write, so no actions are offered. */}
          <ul className="divide-y divide-border border-t border-border opacity-70">
            {archivedAccounts.map((account) => (
              <FinancialListRow
                key={account.id}
                title={account.name}
                meta={`${account.accountType.name} · ${account.currency}`}
                wrapMeta
                amount={<StatusBadge label={t('labels.recordStatus.ARCHIVED')} tone="muted" />}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
