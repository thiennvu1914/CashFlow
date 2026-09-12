import { prisma } from '@/lib/prisma'
import type { Currency } from '@/lib/currency/provider'
import { orNullIfFxUnavailable } from '@/lib/ui/or-null-if-fx-unavailable'
import { getBalanceTimeline } from './balance-timeline'
import { getCurrentPosition } from './position'

/** One account list and one ledger aggregate feed the complete Accounts page. */
export async function getAccountOverview(userId: string, displayCurrency: Currency, now: Date) {
  const [allAccounts, allTypes] = await Promise.all([
    prisma.financialAccount.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    // Includes archived types for existing account labels, while the create
    // form receives active types only. No relation queries per account list.
    prisma.accountType.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
  ])
  const types = new Map(allTypes.map((type) => [type.id, type]))
  const accountsWithTypes = allAccounts.map((account) => {
    const accountType = types.get(account.accountTypeId)
    if (!accountType) throw new Error('Missing owned account type')
    return { ...account, accountType }
  })
  const timeline = await getBalanceTimeline(userId, allAccounts, [now])
  const balances = timeline.balances[0]
  // Keep the position's complete FX decision (including foreign agreements)
  // so even its outage behavior is unchanged. Native balances remain available
  // when the converted header is unavailable.
  const position = await orNullIfFxUnavailable(
    getCurrentPosition(userId, displayCurrency, {
      now,
      accountState: { userId, asOf: now, accounts: allAccounts, balances },
    }),
  )
  return {
    accounts: accountsWithTypes.filter((account) => account.status === 'ACTIVE'),
    archivedAccounts: accountsWithTypes.filter((account) => account.status === 'ARCHIVED'),
    accountTypes: allTypes.filter((type) => type.status === 'ACTIVE'),
    balances,
    position,
    locked: timeline.accountsWithActivity,
    hasFutureEntries: timeline.hasFutureEntries,
  }
}
