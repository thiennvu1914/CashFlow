import { Prisma } from '@prisma/client'
import type { PaymentFrequency } from '@prisma/client'
import type { Currency } from '@/lib/currency/provider'
import {
  calendarDateToUtcCarrier,
  compareCalendarDates,
  formatCalendarDate,
} from '@/lib/datetime/calendar-date'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale'
import type { LoanDisplayStatus, LoanWithOutstanding } from '@/lib/server/services/loan'
import { formatMoney } from './format-money'

/**
 * The Loans page's DTO boundary, as two pure functions.
 *
 * `getLoansWithOutstanding` returns rows carrying `Prisma.Decimal`s and
 * `Date`s; nothing downstream of this file may touch either, because neither
 * can cross the server-to-client-component boundary (`LoanRowActions` takes a
 * whole `LoanDto`, and the payment and edit forms are client components).
 * `percentRepaid` is one of the two `toNumber()`s in this DTO — a progress-bar
 * width has to be a plain number — and `percentLabel` is rounded on the
 * `Decimal` itself, before that widening, so the label and the bar can never
 * read two different roundings of the same ratio.
 *
 * The other `toNumber()` is `interestRateLabel`'s, and it is the one place in
 * the codebase an interest rate is widened. That is sanctioned rather than an
 * inconsistency: an interest rate is *not money* — it is a percentage stored as
 * `Decimal(6, 3)`, informational only (nothing in this app computes interest
 * from it), and it is never summed, compared or spent. So it goes through
 * `Intl.NumberFormat` here rather than through `formatMoney`, which would apply
 * a currency's precision to a figure that has none.
 *
 * A loan is never converted to `User.baseCurrency` here or anywhere else
 * (ledger ruling R5-3): every figure is formatted in the loan's own `currency`,
 * full stop. That is also the whole reason `loanSubtotalsByCurrency` exists
 * rather than a single "total outstanding" — see its own comment.
 *
 * `displayStatus` is *not* recomputed here. The service derives it against the
 * user's `today` (`deriveLoanDisplayStatus`), and a second definition of
 * "overdue" in the UI is exactly the kind of drift that makes a badge and a
 * total disagree; this file only labels what it is given. `dueSoon` *is*
 * derived here, because it is not a service concept at all — it is a
 * presentation window on a due date the service already dated — and it is
 * gated on the service's ACTIVE so the two can never contradict each other.
 *
 * No status/frequency copy is baked in here at all (Phase 7): this module
 * returns the bare `paymentFrequency`/`status` enums and the component that
 * renders a row translates them via `paymentFrequencyLabelKey`/
 * `loanStatusLabelKey` (`lib/ui/labels.ts`) — this stays a pure function with
 * no translator of its own. `interestRateLabel` is the one exception, kept
 * exactly as it was: it is a percentage with its own `RATE_FORMATTER`, and the
 * `%` sign is not language-specific here.
 */
export interface LoanPaymentDto {
  id: string
  /** `yyyy-MM-dd` — the carrier read back as the day the user picked. */
  date: string
  /** All three formatted in the loan's own currency; an instalment inherits it
   *  and there are no cross-currency loan payments. */
  total: string
  principal: string
  interest: string
  note: string | null
}

export interface LoanDto {
  id: string
  lender: string
  currency: Currency
  /** All four formatted in the loan's own currency, never converted. */
  principal: string
  principalPaid: string
  /** What the loan has cost so far. Shown next to — never inside — the
   *  outstanding figure: interest repays nothing. */
  interestPaid: string
  outstandingPrincipal: string
  /** Bar fill 0–100, clamped; one of the two `toNumber()`s for this DTO. */
  percentRepaid: number
  /** e.g. "67 %" — whole percent, half-up on the `Decimal`, and deliberately
   *  NOT clamped: the bar's width may not overflow, the figure may. */
  percentLabel: string
  /** The stored carrier as the calendar date the user picked. */
  nextDueDate: string
  /** The next instalment falls inside the coming week, counted in calendar
   *  days from the user's `today`. ACTIVE only — see `toLoanDto`. */
  dueSoon: boolean
  /** The service's OVERDUE, relabelled as a boolean the row can style on. */
  overdue: boolean
  scheduledPayment: string
  paymentFrequency: PaymentFrequency
  /** e.g. "8,5 %" — the informational rate, not money. */
  interestRateLabel: string
  termMonths: number
  startDate: string
  status: LoanDisplayStatus
  /** The *stored* status is ACTIVE — what the page keys the row actions off. A
   *  closed loan refuses every write, so offering it a button would be a
   *  promise the service breaks. Not derivable from `status` alone: PAID_OFF
   *  and OVERDUE are both derived states of a loan that is still ACTIVE and
   *  can still be edited and closed. */
  active: boolean
  notes: string | null
  /** Oldest first, in the order the service returned them. */
  payments: LoanPaymentDto[]
  /** Prefill for the inline edit form — exactly `updateLoanSchema`'s three
   *  fields, and strings only (`''` is what an empty `<input>` needs, and what
   *  the schema reads back as "no value"). `principal`, `currency`,
   *  `interestRate`, `startDate`, `termMonths`, `paymentFrequency` and
   *  `nextDueDate` are absent because they are immutable after creation. */
  editable: {
    lender: string
    /** `toFixed(2)`, so the number input round-trips the stored scale. */
    scheduledPaymentAmount: string
    notes: string
  }
}

/**
 * Fixed English copy, kept ONLY because `lib/server/export/build-loans-sheet.ts`
 * (frozen this phase) still imports both for the Excel export's `Frequency` and
 * `Status` columns, which are English regardless of the reader's locale (spec
 * §12 says nothing about localising a workbook, and Phase 7's own export sheets
 * are out of scope). No UI component reads either: `toLoanDto` below returns
 * the bare `paymentFrequency`/`status` enums, and every renderer calls
 * `paymentFrequencyLabelKey`/`loanStatusLabelKey` instead.
 */
export const LOAN_FREQUENCY_LABELS: Record<PaymentFrequency, string> = {
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  YEARLY: 'Yearly',
}

/**
 * "Payment overdue" rather than the bare "Overdue" a debt uses: a loan is not
 * late, an *instalment* is — the loan itself may have another four years to run.
 */
export const LOAN_STATUS_LABELS: Record<LoanDisplayStatus, string> = {
  ACTIVE: 'Active',
  OVERDUE: 'Payment overdue',
  PAID_OFF: 'Paid off',
  CLOSED: 'Closed',
}

/** The bar can fill the track, never overflow it — and never run backwards. */
const MAX_PERCENT = 100
const MIN_PERCENT = 0

/** How far ahead "due soon" looks. A week, because a monthly instalment seen a
 *  week out is still actionable and one seen a month out is just the schedule. */
const DUE_SOON_DAYS = 7

/** Milliseconds in a day — exact on a UTC-midnight carrier, where no DST shift
 *  can shorten one (the same reasoning `lib/datetime/add-months-clamped.ts`
 *  gives for its weekly step). */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The rate is a percentage, so it is formatted as a number and not as money:
 * `formatMoney` would impose a currency's precision (0 for VND, 2 for USD) on
 * a figure whose own scale is 3. Vietnamese grouping and decimal separator,
 * like every other figure on the page — `8.5` reads "8,5 %" — and up to three
 * decimals, which is exactly what `Decimal(6, 3)` can hold, with trailing
 * zeroes dropped so a whole rate reads "8 %" rather than "8,000 %".
 */
const RATE_FORMATTER = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 })

/**
 * The calendar date `days` days after `today`, computed on a carrier rather
 * than by adding to the day number.
 *
 * `'2026-04-28'` + 7 is 5 May, not "35 April": a string built from `day + 7`
 * would be a date that does not exist, and comparing it lexicographically
 * against a real one gives an answer that is silently wrong for the last week
 * of every month. Carrier arithmetic in UTC is exact (no DST), and
 * `formatCalendarDate` is `calendarDateToUtcCarrier`'s exact inverse.
 */
function addCalendarDays(today: string, days: number): string {
  return formatCalendarDate(new Date(calendarDateToUtcCarrier(today).getTime() + days * MS_PER_DAY))
}

export function toLoanDto(
  { loan, principalPaid, interestPaid, outstandingPrincipal, displayStatus }: LoanWithOutstanding,
  /** The user's own calendar day, from `todayCalendarDateInZone` — never
   *  `new Date()` here, for the reason `lib/datetime/calendar-date.ts` gives:
   *  this module has no user, and passing the day in is what makes every
   *  `dueSoon` case testable without freezing a clock. */
  today: string,
  locale: Locale = DEFAULT_LOCALE,
): LoanDto {
  const currency = loan.currency
  // Safe without a zero guard: `Loan_principal_positive` (the CHECK in this
  // model's migration) and `createLoanSchema` both forbid a principal of zero,
  // so there is no stored row this could divide by.
  const ratio = principalPaid.div(loan.principal)
  const nextDueDate = formatCalendarDate(loan.nextDueDate)

  return {
    id: loan.id,
    lender: loan.lender,
    currency,
    principal: formatMoney(loan.principal, currency, locale),
    principalPaid: formatMoney(principalPaid, currency, locale),
    interestPaid: formatMoney(interestPaid, currency, locale),
    // Not clamped at zero: this is the authoritative derived figure the
    // service's own overpayment check compares against, and it can only go
    // negative if rows were written around the service — in which case showing
    // a negative is how the user finds out, rather than a tidy "0" hiding it.
    outstandingPrincipal: formatMoney(outstandingPrincipal, currency, locale),
    percentRepaid: Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, ratio.mul(100).toNumber())),
    percentLabel: `${ratio.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toString()} %`,
    nextDueDate,
    // Gated on the *service's* ACTIVE, which is what keeps the three states
    // mutually exclusive: OVERDUE is already past due (so "due soon" would
    // understate it), and a PAID_OFF or CLOSED loan very often carries a due
    // date days ahead — the last accepted payment advanced it and nothing will
    // move it again — so asking for another instalment would be wrong. Both
    // ends of the window are compared explicitly: the lower bound is implied
    // by ACTIVE today, and stating it means this flag still reads correctly if
    // the service's branch order is ever revisited.
    dueSoon:
      displayStatus === 'ACTIVE' &&
      compareCalendarDates(nextDueDate, today) >= 0 &&
      compareCalendarDates(nextDueDate, addCalendarDays(today, DUE_SOON_DAYS)) <= 0,
    overdue: displayStatus === 'OVERDUE',
    scheduledPayment: formatMoney(loan.scheduledPaymentAmount, currency, locale),
    paymentFrequency: loan.paymentFrequency,
    // The one `toNumber()` on an interest rate in the codebase — see the
    // module comment for why a percentage is not money.
    interestRateLabel: `${RATE_FORMATTER.format(loan.interestRate.toNumber())} %`,
    termMonths: loan.termMonths,
    startDate: formatCalendarDate(loan.startDate),
    status: displayStatus,
    active: loan.status === 'ACTIVE',
    notes: loan.notes,
    payments: loan.payments.map((p) => ({
      id: p.id,
      date: formatCalendarDate(p.paymentDate),
      total: formatMoney(p.totalAmount, currency, locale),
      principal: formatMoney(p.principalAmount, currency, locale),
      interest: formatMoney(p.interestAmount, currency, locale),
      note: p.note,
    })),
    editable: {
      lender: loan.lender,
      scheduledPaymentAmount: loan.scheduledPaymentAmount.toFixed(2),
      notes: loan.notes ?? '',
    },
  }
}

export interface LoanCurrencySubtotalDto {
  currency: Currency
  outstandingPrincipal: string
}

/**
 * The page's subtotal strip: what principal the user still owes, one row per
 * currency.
 *
 * Per currency and never across, because there is no rate on this page and
 * inventing one would be a fabricated FX conversion (`User.baseCurrency` is
 * display-only, ledger ruling R5-3): 20.000 USD and 240.000.000 VND is two
 * facts, and any single figure combining them would be a number the user could
 * not check.
 *
 * Principal only — the interest paid is not part of it. What is *owed* is the
 * principal still outstanding; interest already paid is a cost that has been
 * settled, and adding it to a liability would report a debt the lender does not
 * hold.
 *
 * Only ACTIVE loans with principal still outstanding are counted. A closed loan
 * is no longer a liability (the service's `activeOnly` says the same thing for
 * the dashboard), and a repaid one contributes zero — but dropping it
 * explicitly is what keeps a currency out of the strip entirely once every loan
 * in it is repaid, rather than leaving a row of zeroes behind.
 *
 * The sums are `Prisma.Decimal` throughout and each is formatted exactly once,
 * at the end: formatting a subtotal per loan and adding the strings would round
 * twice and could disagree with the rows above it.
 */
const SUBTOTAL_CURRENCY_ORDER: Currency[] = ['VND', 'USD']

export function loanSubtotalsByCurrency(
  rows: LoanWithOutstanding[],
  locale: Locale = DEFAULT_LOCALE,
): LoanCurrencySubtotalDto[] {
  const totals = new Map<Currency, Prisma.Decimal>()

  for (const { loan, outstandingPrincipal } of rows) {
    if (loan.status !== 'ACTIVE' || outstandingPrincipal.lte(0)) continue
    const running = totals.get(loan.currency) ?? new Prisma.Decimal(0)
    totals.set(loan.currency, running.add(outstandingPrincipal))
  }

  // Iterated in a declared order rather than in `Map` insertion order, so the
  // strip does not reorder itself — and a figure the user was reading does not
  // move — as loans are added, repaid or closed.
  return SUBTOTAL_CURRENCY_ORDER.filter((currency) => totals.has(currency)).map((currency) => ({
    currency,
    outstandingPrincipal: formatMoney(totals.get(currency)!, currency, locale),
  }))
}
