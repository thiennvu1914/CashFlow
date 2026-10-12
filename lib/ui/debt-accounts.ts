import type { Currency } from '@prisma/client'

/** What the debt forms' account pickers need for one active account. */
export interface DebtAccountOption {
  id: string
  name: string
  currency: Currency
}

/**
 * The account a new payment's picker starts on (spec §6.2): the account of the
 * debt's opening transaction, else the user's most recently used account — but
 * only when it is one the picker will actually list, i.e. in the debt's
 * currency. A debt only ever moves money in its own currency, so an account in
 * the other one is not an option; `''` then means "don't record in an account"
 * and the user chooses.
 */
export function defaultPaymentAccountId(
  options: ReadonlyArray<DebtAccountOption>,
  openingAccountId: string | null,
  mostRecentAccountId: string | null,
): string {
  for (const candidate of [openingAccountId, mostRecentAccountId]) {
    if (candidate !== null && options.some((option) => option.id === candidate)) return candidate
  }
  return ''
}
