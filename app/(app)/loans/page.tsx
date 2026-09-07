import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getLoansWithOutstanding } from '@/lib/server/services/loan'
import { loanSubtotalsByCurrency, toLoanDto, type LoanDto } from '@/lib/ui/loan-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { LoanForm } from '@/components/loans/loan-form'
import { LoanList } from '@/components/loans/loan-list'
import { LoanRowActions } from '@/components/loans/loan-row-actions'

/**
 * Loans (spec §4.10): money the user owes a lender, and the instalments they
 * have recorded against it — each in its own currency and never converted to
 * `User.baseCurrency` (ledger ruling R5-3).
 *
 * Nothing on this page moves money. A loan is a record of an agreement with a
 * lender, and recording an instalment writes a `LoanPayment` row and advances
 * the loan's `nextDueDate` and nothing else — no Transaction, no Transfer, no
 * account balance — which is why the subtitle says so outright rather than
 * leaving the reader to wonder whether "I paid the April instalment" has left an
 * account somewhere. Whether the cash also passed through a tracked account is
 * a separate fact the user records separately, and no automatic rule can tell
 * the two apart.
 *
 * One query, not two: `getLoansWithOutstanding` already returns every status
 * (the closed section needs them anyway), so the split happens in memory. The
 * active half is then re-ordered by urgency, because what the user came to this
 * page for is the instalment they have missed.
 */

/**
 * Missed instalments first, repaid loans last. The rest of the service's order
 * comes free: `getLoansWithOutstanding` already returns `(createdAt, id)` — a
 * total order — and `Array#sort` is stable per spec, so ranking on this one
 * distinction leaves loans within a rank in exactly the order the service put
 * them.
 *
 * CLOSED is in the map only so the rank is total over `LoanDto['status']`; a
 * closed loan never reaches this sort, because it is filtered into the
 * read-only section below.
 */
const DISPLAY_RANK: Record<LoanDto['status'], number> = {
  OVERDUE: 0,
  ACTIVE: 1,
  PAID_OFF: 2,
  CLOSED: 3,
}

export default async function LoansPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` scopes the only query below.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  // The one place the user's zone enters: whether an instalment is overdue, or
  // due within the week, is a comparison of calendar dates and never of
  // instants (ruling R6-7). The same `today` seeds both forms' date fields, so
  // "today" means one thing on this page rather than one thing on the server
  // and another in the browser.
  const today = todayCalendarDateInZone(timezone, new Date())

  const rows = await getLoansWithOutstanding(user.id, today)

  // Subtotals are taken from the service rows — `Prisma.Decimal` sums, one per
  // currency — before anything is formatted, so the strip can never be the
  // result of adding up strings.
  const subtotals = loanSubtotalsByCurrency(rows)

  // The only place a `Decimal` or a `Date` becomes a string on this page. Every
  // component below renders `LoanDto`s.
  const dtos = rows.map((row) => toLoanDto(row, today))
  const active = dtos
    .filter((dto) => dto.active)
    .sort((a, b) => DISPLAY_RANK[a.status] - DISPLAY_RANK[b.status])
  const closed = dtos.filter((dto) => !dto.active)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <div>
          <h1 className="text-xl font-semibold">Loans</h1>
          <p className="text-sm text-muted-foreground">
            Loans you owe, tracked by hand — recording an instalment here never moves money between
            your accounts
          </p>
        </div>

        {/* One row per currency, never a single total: there is no rate on this
            page, and 20.000 USD plus 240.000.000 VND is two facts. Principal
            only — interest already paid is a settled cost, not something the
            lender still holds. Omitted entirely when nothing is outstanding,
            rather than shown as a row of zeroes. */}
        {subtotals.length > 0 && (
          <ul className="flex flex-col gap-1">
            {subtotals.map((subtotal) => (
              <li
                key={subtotal.currency}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm"
              >
                <span className="font-medium">{subtotal.currency}</span>
                <span className="text-muted-foreground">
                  Principal outstanding{' '}
                  <span className="text-negative tabular-nums">
                    {subtotal.outstandingPrincipal}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {active.length === 0 ? (
          <p className="text-sm text-foreground/60">No loans yet — add one below.</p>
        ) : (
          <LoanList
            loans={active}
            renderActions={(loan) => <LoanRowActions loan={loan} today={today} />}
          />
        )}
      </div>

      <div id="new" className="scroll-mt-6">
        <h2 className="mb-3 text-lg font-semibold">Add loan</h2>
        <LoanForm today={today} />
      </div>

      {closed.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-foreground/60">
            Closed loans ({closed.length})
          </summary>
          {/* Read-only, like the written-off debts on `/debts`: a closed loan
              refuses every write (`LoanNotActiveError`), so no actions are
              offered here. The instalment history stays — the money really was
              paid, and closing the loan does not undo that. */}
          <div className="mt-3 opacity-70">
            <LoanList loans={closed} />
          </div>
        </details>
      )}
    </div>
  )
}
