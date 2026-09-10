import { Prisma } from '@prisma/client'
import type { DebtDirection } from '@prisma/client'
import type { Currency } from '@/lib/currency/provider'
import { formatCalendarDate } from '@/lib/datetime/calendar-date'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale'
import type { DebtDisplayStatus, DebtWithOutstanding } from '@/lib/server/services/debt'
import { formatMoney, formatPercent } from './format-money'

/**
 * The Debts page's DTO boundary, as two pure functions.
 *
 * `getDebtsWithOutstanding` returns rows carrying `Prisma.Decimal`s and
 * `Date`s; nothing downstream of this file may touch either, because neither
 * can cross the server-to-client-component boundary (`DebtRowActions` takes a
 * whole `DebtDto`, and the payment and edit forms are client components).
 * `percentPaid` is the one `toNumber()` in this DTO — a progress-bar width has
 * to be a plain number — and `percentLabel` is rounded on the `Decimal` itself,
 * before that widening, so the label and the bar can never read two different
 * roundings of the same ratio.
 *
 * A debt is never converted to `User.baseCurrency` here or anywhere else
 * (ledger ruling R5-3): `original`/`paid`/`outstanding` are formatted in the
 * debt's own `currency`, full stop. That is also the whole reason
 * `debtSubtotalsByCurrency` exists rather than a single "total outstanding" —
 * see its own comment.
 *
 * `displayStatus` is *not* recomputed here. The service derives it against the
 * user's `today` (`deriveDebtDisplayStatus`), and a second definition of
 * "overdue" in the UI is exactly the kind of drift that makes a badge and a
 * total disagree; this file only labels what it is given.
 *
 * No status/direction copy is baked in here at all (Phase 7): this module
 * returns the bare `direction`/`status` enums and the component that renders a
 * row translates them via `debtDirectionLabelKey`/`debtStatusLabelKey`
 * (`lib/ui/labels.ts`) — this stays a pure function with no translator of its
 * own.
 */
export interface DebtPaymentDto {
  id: string
  /** `yyyy-MM-dd` — the carrier read back as the day the user picked. */
  date: string
  amount: string
  note: string | null
}

export interface DebtDto {
  id: string
  person: string
  direction: DebtDirection
  currency: Currency
  /** All three formatted in the debt's own currency, never converted. */
  original: string
  paid: string
  outstanding: string
  /** Bar fill 0–100, clamped; the one `toNumber()` for this DTO. */
  percentPaid: number
  /** e.g. "67 %" — whole percent, half-up on the `Decimal`, and deliberately
   *  NOT clamped: the bar's width may not overflow, the figure may. */
  percentLabel: string
  status: DebtDisplayStatus
  /** The *stored* status is ACTIVE — what the page keys the row actions off. A
   *  written-off debt refuses every write, so offering it a button would be a
   *  promise the service breaks. Not derivable from `status` alone once a
   *  future group adds another terminal state. */
  active: boolean
  dueDate: string | null
  description: string | null
  notes: string | null
  /** Oldest first, in the order the service returned them. */
  payments: DebtPaymentDto[]
  /** Prefill for the inline edit form — exactly `updateDebtSchema`'s four
   *  fields, and strings only (`''` is what an empty `<input>` needs, and what
   *  the schema reads back as "no value"). `direction`, `originalAmount` and
   *  `currency` are absent because they are immutable after creation. */
  editable: {
    person: string
    description: string
    /** `yyyy-MM-dd` for `<input type="date">`; `''` when the debt has none. */
    dueDate: string
    notes: string
  }
}

/**
 * Fixed English copy for each stored status, kept ONLY because
 * `lib/server/export/build-debts-sheet.ts` (frozen this phase) still imports it
 * for the Excel export's `Status` column, which is English regardless of the
 * reader's locale (spec §12 says nothing about localising a workbook, and Phase
 * 7's own export sheets are out of scope). No UI component reads this:
 * `toDebtDto` below returns the bare `status` enum, and every renderer calls
 * `debtStatusLabelKey` instead. "Partly paid" rather than "Partially paid": a
 * badge sits in a row of figures and the shorter word reads the same.
 */
export const DEBT_STATUS_LABELS: Record<DebtDisplayStatus, string> = {
  OPEN: 'Open',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  WRITTEN_OFF: 'Written off',
}

/** The bar can fill the track, never overflow it — and never run backwards. */
const MAX_PERCENT = 100
const MIN_PERCENT = 0

export function toDebtDto(
  { debt, paid, outstanding, displayStatus }: DebtWithOutstanding,
  locale: Locale = DEFAULT_LOCALE,
): DebtDto {
  const currency = debt.currency
  // Safe without a zero guard: `Debt_originalAmount_positive` (the CHECK in
  // this model's migration) and `createDebtSchema` both forbid an original
  // amount of zero, so there is no stored row this could divide by.
  const ratio = paid.div(debt.originalAmount)
  const dueDate = debt.dueDate === null ? null : formatCalendarDate(debt.dueDate)

  return {
    id: debt.id,
    person: debt.person,
    direction: debt.direction,
    currency,
    original: formatMoney(debt.originalAmount, currency, locale),
    paid: formatMoney(paid, currency, locale),
    // Not clamped at zero, unlike a savings goal's "remaining": this is the
    // authoritative derived figure the service's own overpayment check compares
    // against, and it can only go negative if rows were written around the
    // service — in which case showing a negative is how the user finds out,
    // rather than a tidy "0" hiding it.
    outstanding: formatMoney(outstanding, currency, locale),
    percentPaid: Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, ratio.mul(100).toNumber())),
    // Rounded on the `Decimal` first (unchanged rounding semantics);
    // `formatPercent` only formats that already-rounded whole number for the
    // reader's locale and appends the sign -- it does no rounding of its own.
    percentLabel: formatPercent(
      ratio.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP),
      locale,
    ),
    status: displayStatus,
    active: debt.status === 'ACTIVE',
    dueDate,
    description: debt.description,
    notes: debt.notes,
    payments: debt.payments.map((p) => ({
      id: p.id,
      date: formatCalendarDate(p.date),
      amount: formatMoney(p.amount, currency, locale),
      note: p.note,
    })),
    editable: {
      person: debt.person,
      description: debt.description ?? '',
      dueDate: dueDate ?? '',
      notes: debt.notes ?? '',
    },
  }
}

export interface CurrencySubtotalDto {
  currency: Currency
  receivable: string
  payable: string
}

/**
 * The page's subtotal strip: what is still owed *to* the user and *by* the
 * user, one row per currency.
 *
 * Per currency and never across, because there is no rate on this page and
 * inventing one would be a fabricated FX conversion (`User.baseCurrency` is
 * display-only, ledger ruling R5-3): 500 USD receivable and 1.000.000 VND
 * payable is two facts, and any single figure combining them would be a number
 * the user could not check.
 *
 * Only ACTIVE debts with something still outstanding are counted. A written-off
 * debt is no longer an asset or a liability (the service's `activeOnly` says
 * the same thing for the dashboard), and a settled one contributes zero — but
 * dropping it explicitly is what keeps a currency out of the strip entirely
 * once every debt in it is repaid, rather than leaving a row of zeroes behind.
 *
 * The sums are `Prisma.Decimal` throughout and each is formatted exactly once,
 * at the end: formatting a subtotal per debt and adding the strings would round
 * twice and could disagree with the rows above it.
 */
const SUBTOTAL_CURRENCY_ORDER: Currency[] = ['VND', 'USD']

export function debtSubtotalsByCurrency(
  rows: DebtWithOutstanding[],
  locale: Locale = DEFAULT_LOCALE,
): CurrencySubtotalDto[] {
  const totals = new Map<Currency, { receivable: Prisma.Decimal; payable: Prisma.Decimal }>()

  for (const { debt, outstanding } of rows) {
    if (debt.status !== 'ACTIVE' || outstanding.lte(0)) continue
    const running = totals.get(debt.currency) ?? {
      receivable: new Prisma.Decimal(0),
      payable: new Prisma.Decimal(0),
    }
    if (debt.direction === 'RECEIVABLE') {
      running.receivable = running.receivable.add(outstanding)
    } else {
      running.payable = running.payable.add(outstanding)
    }
    totals.set(debt.currency, running)
  }

  // Iterated in a declared order rather than in `Map` insertion order, so the
  // strip does not reorder itself — and a figure the user was reading does not
  // move — as debts are added, repaid or written off.
  return SUBTOTAL_CURRENCY_ORDER.filter((currency) => totals.has(currency)).map((currency) => {
    const { receivable, payable } = totals.get(currency)!
    return {
      currency,
      receivable: formatMoney(receivable, currency, locale),
      payable: formatMoney(payable, currency, locale),
    }
  })
}
