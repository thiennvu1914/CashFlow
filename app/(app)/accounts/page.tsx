import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { prisma } from '@/lib/prisma'
import {
  listActiveFinancialAccounts,
  listAllFinancialAccounts,
  accountsWithActivity,
} from '@/lib/server/services/financial-account'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { getCurrentAccountBalances } from '@/lib/server/services/balance'
import { getCurrentPosition } from '@/lib/server/services/position'
import { resolveLocale } from '@/lib/i18n/config'
import { formatMoney } from '@/lib/ui/format-money'
import { orNullIfFxUnavailable } from '@/lib/ui/or-null-if-fx-unavailable'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { AccountCreateButton } from '@/components/accounts/account-create-button'
import { AccountList } from '@/components/accounts/account-list'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'

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
  const { baseCurrency: displayCurrency } = resolveProfileDefaults(user)
  const t = await getTranslations()
  const locale = await resolveLocale()
  // ONE `now` for the whole request — the page owns it, not a component and not
  // a service reading the clock again mid-render, so every balance below is cut
  // at the same instant.
  const now = new Date()
  const [accounts, accountTypes, allAccounts, position] = await Promise.all([
    listActiveFinancialAccounts(user.id),
    listAccountTypes(user.id),
    listAllFinancialAccounts(user.id),
    // The base-currency total for the header (spec §6.4), from the same
    // position read the dashboard uses — so the two pages cannot disagree. It
    // may consult the CURRENT-rate policy, so it degrades to `null` on an FX
    // outage exactly as the dashboard's does, and the header then shows "—"
    // rather than a number nobody can stand behind.
    orNullIfFxUnavailable(getCurrentPosition(user.id, displayCurrency, { now })),
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
        meta={futureDatedCount > 0 ? t('accounts.asOfNow') : undefined}
        actions={<AccountCreateButton accountTypes={accountTypes} />}
      />

      <AccountList accounts={accountsWithBalance} accountTypes={accountTypes} locale={locale} />

      {archivedAccounts.length > 0 && (
        <details className="rounded-lg border border-border bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
            {t('accounts.archivedSection', { count: archivedAccounts.length })}
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
