import type { Currency } from '@prisma/client'

/** What the debt forms' account pickers need for one active account. */
export interface DebtAccountOption {
  id: string
  name: string
  currency: Currency
  /** Archived since the payment being edited was recorded: shown, labelled,
   *  so the edit does not silently switch to "don't record". The server still
   *  refuses it (ARCHIVED_ACCOUNT), which is the user's cue to choose again. */
  archived?: boolean
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

/**
 * The account "Record in an account" (spec 2026-10-12 §6.4) starts on, for a
 * debt or a loan that moved no money yet: the user's most recently used
 * account when the picker lists it, else the first one it lists. Unlike a
 * payment's picker there is no "don't record" to fall back to — recording is
 * the whole point — so `''` means only that no account in the agreement's
 * currency exists.
 */
export function defaultLinkAccountId(
  options: ReadonlyArray<DebtAccountOption>,
  mostRecentAccountId: string | null,
): string {
  return defaultPaymentAccountId(options, null, mostRecentAccountId) || (options[0]?.id ?? '')
}

/**
 * The date "Record in an account" (spec §6.4) starts on (Ruling P7): the
 * agreement's own date — the day a debt was added, a loan's start date — or
 * the oldest payment still to record, whichever is earlier, so the opening or
 * disbursement never lands after its own repayments. A payment already
 * recorded in an account is left alone by the link, so it does not count.
 * Both are `yyyy-MM-dd`, which sorts the same as a string and as a date.
 */
export function defaultLinkDate(
  agreementDate: string,
  payments: ReadonlyArray<{ date: string; accountId: string | null }>,
): string {
  return payments.reduce(
    (earliest, payment) =>
      payment.accountId === null && payment.date < earliest ? payment.date : earliest,
    agreementDate,
  )
}
