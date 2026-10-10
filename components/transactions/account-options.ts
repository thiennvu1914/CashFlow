import { Prisma, type Currency } from '@prisma/client'

/** What the create panel's account picker needs for one account. */
export interface AccountOption {
  id: string
  name: string
  currency: Currency
  /** Fixed-2-decimal string; display only. */
  balance: string
}

/**
 * Joins the picker rows to their derived balances.
 *
 * The rows and the balances are read in parallel, not in one transaction, so an
 * account created between the two reads has a picker row but no balance yet. A
 * balance is never stored — it is derived from Transaction + Transfer — and a
 * brand-new account has no movements, so its balance is exactly zero. That is
 * the truthful value, not a fabricated one, and it beats crashing the page.
 */
export function toAccountOptions(
  accounts: ReadonlyArray<{ id: string; name: string; currency: Currency }>,
  balances: ReadonlyMap<string, Prisma.Decimal>,
): AccountOption[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    currency: account.currency,
    // A `Prisma.Decimal` cannot cross the server-to-client-component
    // boundary, so the balance crosses as a fixed-2-decimal string and is
    // formatted for display only — no arithmetic happens on the client.
    balance: (balances.get(account.id) ?? new Prisma.Decimal(0)).toFixed(2),
  }))
}
