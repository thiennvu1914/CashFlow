import { prisma } from '@/lib/prisma'
import type { Currency } from '@/lib/currency/provider'
import { orNullIfFxUnavailable } from '@/lib/ui/or-null-if-fx-unavailable'
import { getBalanceTimeline } from './balance-timeline'
import { getCurrentPosition, loadPositionAgreements } from './position'

/** One account list and one ledger aggregate feed the complete Accounts page. */
export async function getAccountOverview(userId: string, displayCurrency: Currency, now: Date) {
  // Three independent chains, one round trip each at most: the accounts and
  // then their balance timeline (which needs the account rows), the account
  // types, and the debts/loans the position adds to the balances. Running the
  // last two beside the first saves the sequential hop they used to wait for.
  const [{ allAccounts, timeline }, allTypes, agreements] = await Promise.all([
    (async () => {
      const allAccounts = await prisma.financialAccount.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      })
      return { allAccounts, timeline: await getBalanceTimeline(userId, allAccounts, [now]) }
    })(),
    // Includes archived types for existing account labels, while the create
    // form receives active types only. No relation queries per account list.
    prisma.accountType.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
    loadPositionAgreements(userId, now),
  ])
  const types = new Map(allTypes.map((type) => [type.id, type]))
  const accountsWithTypes = allAccounts.map((account) => {
    const accountType = types.get(account.accountTypeId)
    if (!accountType) throw new Error('Missing owned account type')
    return { ...account, accountType }
  })
  const balances = timeline.balances[0]
  // Keep the position's complete FX decision (including foreign agreements)
  // so even its outage behavior is unchanged. Native balances remain available
  // when the converted header is unavailable.
  const position = await orNullIfFxUnavailable(
    getCurrentPosition(userId, displayCurrency, {
      now,
      agreements,
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
