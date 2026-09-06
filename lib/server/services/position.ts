import { Prisma } from '@prisma/client'
import { applyVndPerUsdRate } from '@/lib/currency/apply-rate'
import { FxUnavailableError, getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import type { Currency, ExchangeRateProvider } from '@/lib/currency/provider'
import { getCurrentAccountBalances } from './balance'
import { listActiveFinancialAccounts } from './financial-account'

/**
 * The user's current position: what they hold right now, restated in one
 * display currency (spec §5.4).
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
 * Cost is constant, not per-account: one `listActiveFinancialAccounts`, one
 * batched `getAccountBalances` for every id at once, and — only when at least
 * one account is held in a currency other than `displayCurrency` — one call to
 * `getUsableCurrentRate`. A single-currency user therefore never touches FX at
 * all and their dashboard renders unchanged through a provider outage.
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
  /** See `getNetWorth` — identical to `totalBalance` in Phase 4. */
  netWorth: Prisma.Decimal
  accounts: PositionAccount[]
  /**
   * The rate every conversion in this result used, or `null` when no account
   * needed converting. Carries `isFallback` and `source`, so a caller can show
   * "rate may be out of date" without asking the policy a second question.
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
  const balances = await getCurrentAccountBalances(
    userId,
    accounts.map((account) => account.id),
    asOf,
  )

  // The rate is resolved once, up front, and only if it is actually needed —
  // never inside the per-account loop, and never for a user whose accounts are
  // all in the display currency already.
  const needsConversion = accounts.some((account) => account.currency !== displayCurrency)
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

  let totalBalance = new Prisma.Decimal(0)
  const positionAccounts: PositionAccount[] = accounts.map((account) => {
    const nativeBalance = balances.get(account.id) ?? new Prisma.Decimal(0)
    let displayBalance = nativeBalance
    if (account.currency !== displayCurrency) {
      // Unreachable: `needsConversion` is true whenever this branch is, so `fx`
      // is non-null here. The throw exists so a future edit that decouples the
      // two fails loudly instead of silently charting native numbers.
      if (!fx) throw new Error('Missing exchange rate for a conversion that is required')
      displayBalance = applyVndPerUsdRate(
        nativeBalance,
        account.currency,
        displayCurrency,
        fx.rateDecimal,
      )
    }
    totalBalance = totalBalance.add(displayBalance)
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      nativeBalance,
      displayBalance,
    }
  })

  return { totalBalance, netWorth: totalBalance, accounts: positionAccounts, fx }
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
 * Phase 4: Net Worth = Total Account Balance only.
 *
 * Phase 6 extends this to `+ receivables outstanding − payables outstanding −
 * outstanding loan principal` (spec §5.4), each converted the same way (own
 * currency → `displayCurrency` at the current rate). The signature does not
 * change — only `getCurrentPosition`'s body grows — so every caller written
 * now keeps working when the definition widens.
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
