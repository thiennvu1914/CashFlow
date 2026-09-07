import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { applyVndPerUsdRate } from '@/lib/currency/apply-rate'
import { FxUnavailableError, getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import type { Currency, ExchangeRateProvider } from '@/lib/currency/provider'
import { getCurrentAccountBalances } from './balance'
import { getDebtsWithOutstanding } from './debt'
import { listActiveFinancialAccounts } from './financial-account'
import { getLoansWithOutstanding } from './loan'

/**
 * The user's current position: what they hold right now, restated in one
 * display currency (spec §5.4).
 *
 * **Net Worth = account assets + active receivables − active payables − active
 * outstanding loan principal** (spec §5.4), each term converted to
 * `displayCurrency` at the SAME single current rate. Written-off debts and
 * closed loans are excluded — a debt the user has given up on is not an asset
 * and a settled loan is not a liability — and so is anything with nothing left
 * outstanding, which falls out of the arithmetic rather than out of a status.
 * Interest paid on a loan is nowhere in the formula: interest is the cost of
 * borrowing, not a repayment of it, so only `outstandingPrincipal` counts.
 *
 * **Current position = balances as of now.** The balances come from
 * `getCurrentAccountBalances` (`balance.ts`), the single definition of a current
 * balance in this app: `now` is the cut-off, so a booked but future-dated
 * entry — next month's rent, a post-dated cheque — is not counted as money
 * already held. The Accounts page and the Excel export call the same helper, so
 * an account shows one figure everywhere, and these numbers agree by
 * construction with the Account Balance Over Time chart, whose current point is
 * likewise sampled at `now`.
 *
 * Everything the dashboard's Total Account Balance card, Net Worth card and
 * Account Balance Distribution chart need comes out of a single
 * `getCurrentPosition` call, so the three figures can never disagree with each
 * other: they are three views of one set of balances converted at one rate.
 *
 * Cost is constant, not per-account and not per-record: one
 * `listActiveFinancialAccounts`, one batched `getAccountBalances` for every id
 * at once, one `getDebtsWithOutstanding` and one `getLoansWithOutstanding`
 * (each of those is itself one `findMany` plus one `groupBy`, whatever the
 * number of rows), and — only when at least one active account, unsettled debt
 * or unsettled loan is held in a currency other than `displayCurrency` — one
 * call to `getUsableCurrentRate`. A single-currency user therefore never
 * touches FX at all and their dashboard renders unchanged through a provider
 * outage.
 *
 * No conversion happens inside a transaction and none of the three reads opens
 * one: the debt and loan services do no FX of their own (each record keeps its
 * own currency), so the single rate lookup here is the only network-capable
 * step and it sits outside every query.
 *
 * Arithmetic is `Prisma.Decimal` end to end and nothing is rounded here:
 * rounding is a presentation decision, and the pages convert to chart numbers
 * themselves.
 */

/** One active account's balance, in its own currency and in the display currency. */
export interface PositionAccount {
  id: string
  name: string
  currency: Currency
  /** The derived balance in the account's own currency — never converted. */
  nativeBalance: Prisma.Decimal
  /**
   * The same balance restated in `displayCurrency`. This — never
   * `nativeBalance` — is the only currency-correct input to a distribution
   * chart: charting "100" for a USD account beside "1,000,000" for a VND one
   * says nothing about their true relative size.
   */
  displayBalance: Prisma.Decimal
}

export interface CurrentPosition {
  /** Σ of every active account's `displayBalance`. */
  totalBalance: Prisma.Decimal
  /**
   * `totalBalance + receivables − payables − loanOutstanding`, in
   * `displayCurrency` (spec §5.4). See `getNetWorth`.
   */
  netWorth: Prisma.Decimal
  accounts: PositionAccount[]
  /**
   * Σ of what is still owed *to* the user across their active RECEIVABLE
   * debts, converted. An asset: it adds to Net Worth.
   */
  receivables: Prisma.Decimal
  /**
   * Σ of what the user still owes on their active PAYABLE debts, converted. A
   * liability: it subtracts.
   */
  payables: Prisma.Decimal
  /**
   * Σ of the principal still outstanding on the user's active loans,
   * converted — never including interest paid, which is the cost of the loan
   * rather than part of it. A liability: it subtracts.
   */
  loanOutstanding: Prisma.Decimal
  /**
   * The rate every conversion in this result used, or `null` when nothing —
   * account, debt or loan — needed converting. Carries `isFallback` and
   * `source`, so a caller can show "rate may be out of date" without asking
   * the policy a second question.
   */
  fx: UsableRateResult | null
}

/**
 * How a caller supplies, or delegates, the rate this position is computed at.
 *
 * The two keys are alternatives, not a pair. `fx` is for a caller that has
 * *already* resolved a rate and needs this result computed at that exact one —
 * the Excel export, which resolves the workbook's single rate up front so its
 * FX status line and its totals cannot describe two different numbers.
 * `providerOverride` is the test seam on the ordinary path.
 */
export interface CurrentPositionOptions {
  /** tests only; production callers omit it. Ignored when `fx` is present. */
  providerOverride?: ExchangeRateProvider
  /**
   * A rate the caller has already resolved through the shared policy.
   *
   * The **presence of the key** is what matters, not its value: `fx: null` is
   * an answer — "I asked, and no usable rate exists" — and is honoured as such,
   * so a needed conversion raises `FxUnavailableError` rather than quietly
   * going and finding a rate the caller was not told about. Omit the key
   * entirely to have the policy consulted here as usual.
   */
  fx?: UsableRateResult | null
  /**
   * The instant "now" means for this read — the cut-off the balances are taken
   * at, so a future-dated entry is not counted as money already held.
   *
   * Defaults to `new Date()`. A caller that renders several figures from one
   * page load (the dashboard, the Excel export) passes its own single `now`, so
   * every figure on that page is computed against the same instant rather than
   * against a clock that ticks between two awaits.
   */
  now?: Date
}

export async function getCurrentPosition(
  userId: string,
  displayCurrency: Currency,
  options: CurrentPositionOptions = {},
): Promise<CurrentPosition> {
  // Active only: an account can only be archived at a zero balance (Phase 2),
  // so an archived one would contribute nothing but a zero slice of noise.
  const accounts = await listActiveFinancialAccounts(userId)
  // `getCurrentAccountBalances` — the one shared "as of now" definition
  // (`balance.ts`), the same one the Accounts page and the Excel export use, so
  // no two surfaces can put different numbers on the same account. A booked
  // entry dated next week has not happened yet, and counting it here would also
  // make the KPI strip disagree with the Account Balance Over Time chart's
  // current point, which is sampled at `now` too.
  const asOf = options.now ?? new Date()
  // The debts and the loans travel with the balances rather than after them:
  // three independent reads, one round trip's worth of latency. Neither
  // service does any FX — each record keeps its own currency and the
  // conversion happens below, outside every query.
  //
  // `today` is what `getDebtsWithOutstanding`/`getLoansWithOutstanding` use to
  // derive `displayStatus` (OVERDUE against the user's calendar day) — and
  // `displayStatus` is the one field of theirs this function never reads. Every
  // amount below comes from `outstanding`/`outstandingPrincipal`, which are
  // pure arithmetic over the stored rows and do not depend on `today` at all,
  // so the UTC reading of `asOf` used here cannot move a figure by a dong. The
  // position deliberately takes no `timezone` option for a value it ignores;
  // the pages that *do* render an overdue badge pass their own
  // `todayCalendarDateInZone`.
  const today = formatInTimeZone(asOf, 'UTC', 'yyyy-MM-dd')
  const [balances, debts, loans] = await Promise.all([
    getCurrentAccountBalances(
      userId,
      accounts.map((account) => account.id),
      asOf,
    ),
    // Active only, both of them: a written-off debt and a closed loan are
    // history, not a position (they stay visible on their own pages).
    getDebtsWithOutstanding(userId, today, { activeOnly: true }),
    getLoansWithOutstanding(userId, today, { activeOnly: true }),
  ])

  // Nothing left owed contributes nothing, so a debt that has been repaid in
  // full drops out here — by value, where a written-off one dropped out by
  // status. Filtering *before* `needsConversion` is what makes the two
  // decisions one decision: a record skipped here can never be one whose
  // conversion would then need a rate nobody fetched.
  const unsettledDebts = debts.filter((row) => row.outstanding.gt(0))
  const unsettledLoans = loans.filter((row) => row.outstandingPrincipal.gt(0))

  // The rate is resolved once, up front, and only if it is actually needed —
  // never inside a per-record loop, and never for a user whose accounts, debts
  // and loans are all in the display currency already. A foreign-currency debt
  // on its own is enough: Net Worth would otherwise either omit it or sum
  // 100 USD into a total of dong.
  const needsConversion =
    accounts.some((account) => account.currency !== displayCurrency) ||
    unsettledDebts.some((row) => row.debt.currency !== displayCurrency) ||
    unsettledLoans.some((row) => row.loan.currency !== displayCurrency)
  // `in`, not a truthiness test: a supplied `null` must suppress the lookup
  // exactly as a supplied rate does.
  const rateWasSupplied = 'fx' in options
  let fx: UsableRateResult | null = null
  if (needsConversion) {
    fx = rateWasSupplied
      ? (options.fx ?? null)
      : // Deliberately not caught: when a conversion is genuinely required there
        // is no honest number to show, so `FxUnavailableError` propagates and the
        // caller degrades (spec §6.3) rather than this function inventing a rate.
        await getUsableCurrentRate({ base: 'USD', quote: 'VND' }, options.providerOverride)
    // The supplied-null case reaches the same refusal the policy would have
    // raised, so both paths fail identically and no caller has to special-case
    // which one it took.
    if (!fx) throw new FxUnavailableError()
  }

  /**
   * One amount, restated in `displayCurrency` at the single rate above.
   *
   * The same function for accounts, debts and loans, so "convert first, then
   * sum" is written once and no term of the Net Worth formula can be summed
   * raw. A same-currency amount is returned untouched — the `Decimal` instance
   * itself, not a recomputation of it — which is also what keeps this callable
   * when `fx` is legitimately `null`.
   */
  function inDisplayCurrency(amount: Prisma.Decimal, currency: Currency): Prisma.Decimal {
    if (currency === displayCurrency) return amount
    // Unreachable: `needsConversion` is true whenever this branch is, so `fx`
    // is non-null here. The throw exists so a future edit that decouples the
    // two fails loudly instead of silently charting native numbers.
    if (!fx) throw new Error('Missing exchange rate for a conversion that is required')
    return applyVndPerUsdRate(amount, currency, displayCurrency, fx.rateDecimal)
  }

  let totalBalance = new Prisma.Decimal(0)
  const positionAccounts: PositionAccount[] = accounts.map((account) => {
    const nativeBalance = balances.get(account.id) ?? new Prisma.Decimal(0)
    const displayBalance = inDisplayCurrency(nativeBalance, account.currency)
    totalBalance = totalBalance.add(displayBalance)
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      nativeBalance,
      displayBalance,
    }
  })

  let receivables = new Prisma.Decimal(0)
  let payables = new Prisma.Decimal(0)
  for (const { debt, outstanding } of unsettledDebts) {
    const converted = inDisplayCurrency(outstanding, debt.currency)
    // The direction is the whole difference between an asset and a liability,
    // and it is the stored field — never inferred from a sign, because every
    // outstanding amount here is positive.
    if (debt.direction === 'RECEIVABLE') receivables = receivables.add(converted)
    else payables = payables.add(converted)
  }

  let loanOutstanding = new Prisma.Decimal(0)
  for (const { loan, outstandingPrincipal } of unsettledLoans) {
    loanOutstanding = loanOutstanding.add(inDisplayCurrency(outstandingPrincipal, loan.currency))
  }

  return {
    totalBalance,
    netWorth: totalBalance.add(receivables).sub(payables).sub(loanOutstanding),
    accounts: positionAccounts,
    receivables,
    payables,
    loanOutstanding,
    fx,
  }
}

/** Σ of every active account's balance, restated in `displayCurrency`. */
export async function getTotalAccountBalance(
  userId: string,
  displayCurrency: Currency,
  options: CurrentPositionOptions = {},
): Promise<Prisma.Decimal> {
  const { totalBalance } = await getCurrentPosition(userId, displayCurrency, options)
  return totalBalance
}

/**
 * Net Worth = Total Account Balance + active receivables − active payables −
 * active outstanding loan principal (spec §5.4), each term converted from its
 * own currency to `displayCurrency` at the one current rate.
 *
 * Phase 4 answered `totalBalance` alone; Phase 6 widened the definition
 * without touching this signature, exactly as that phase's comment promised —
 * only `getCurrentPosition`'s body grew, so every caller written then (the
 * dashboard's KPI, the export's Summary sheet) picked the extension up as it
 * stood. A projection of the position and never a second definition of it:
 * this function computes nothing itself, so the KPI and the sheet cannot
 * disagree about what Net Worth means.
 */
export async function getNetWorth(
  userId: string,
  displayCurrency: Currency,
  options: CurrentPositionOptions = {},
): Promise<Prisma.Decimal> {
  const { netWorth } = await getCurrentPosition(userId, displayCurrency, options)
  return netWorth
}

/**
 * Per-account balances for the Account Balance Distribution chart, every one of
 * them already converted to `displayCurrency`. Decimals, not numbers: the page
 * maps them to chart values with whatever scale it chooses, and no digit is
 * dropped before it gets there.
 */
export async function getAccountDistribution(
  userId: string,
  displayCurrency: Currency,
  options: CurrentPositionOptions = {},
): Promise<PositionAccount[]> {
  const { accounts } = await getCurrentPosition(userId, displayCurrency, options)
  return accounts
}
