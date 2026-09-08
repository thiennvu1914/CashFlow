import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getDebtsWithOutstanding } from '@/lib/server/services/debt'
import { debtSubtotalsByCurrency, toDebtDto, type DebtDto } from '@/lib/ui/debt-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { DebtForm } from '@/components/debts/debt-form'
import { DebtList } from '@/components/debts/debt-list'
import { DebtRowActions } from '@/components/debts/debt-row-actions'

/**
 * Debts (spec §4.9): money someone owes the user, and money the user owes
 * someone else, each in its own currency and never converted to
 * `User.baseCurrency` (ledger ruling R5-3).
 *
 * Nothing on this page moves money. A debt is a note about an agreement between
 * two people, and recording a repayment writes a `DebtPayment` row and nothing
 * else — no Transaction, no Transfer, no account balance — which is why the
 * subtitle says so outright rather than leaving the reader to wonder whether
 * "Minh paid me 250.000" has landed in an account somewhere. Whether the cash
 * also passed through a tracked account is a separate fact the user records
 * separately, and no automatic rule can tell the two apart.
 *
 * One query, not two: `getDebtsWithOutstanding` already returns every status
 * (the written-off section needs them anyway), so the split happens in memory.
 * The active half is then re-ordered to put settled debts last, because a debt
 * with nothing left owed is history the user is unlikely to be looking for;
 * everything still owed keeps the service's own order.
 */

/**
 * Settled last, everything still owed first. The rest of the service's order
 * comes free: `getDebtsWithOutstanding` already returns `(createdAt, id)` —
 * a total order — and `Array#sort` is stable per spec, so ranking on this one
 * distinction leaves OPEN, PARTIALLY_PAID and OVERDUE debts in exactly the
 * order the service put them.
 */
function displayRank(status: DebtDto['status']): number {
  return status === 'PAID' ? 1 : 0
}

export default async function DebtsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` scopes the only query below.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  // The one place the user's zone enters: whether a debt is overdue is a
  // comparison of calendar dates, never of instants (ruling R6-7). The same
  // `today` seeds the payment form's date, so "today" means one thing on this
  // page rather than one thing on the server and another in the browser.
  const today = todayCalendarDateInZone(timezone, new Date())

  const rows = await getDebtsWithOutstanding(user.id, today)

  // Subtotals are taken from the service rows — `Prisma.Decimal` sums, one per
  // currency — before anything is formatted, so the strip can never be the
  // result of adding up strings.
  const subtotals = debtSubtotalsByCurrency(rows)

  // The only place a `Decimal` or a `Date` becomes a string on this page. Every
  // component below renders `DebtDto`s.
  const dtos = rows.map(toDebtDto)
  const active = dtos
    .filter((dto) => dto.active)
    .sort((a, b) => displayRank(a.status) - displayRank(b.status))
  const writtenOff = dtos.filter((dto) => !dto.active)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <div>
          <h1 className="text-xl font-semibold">Debts</h1>
          <p className="text-sm text-muted-foreground">
            Receivables and payables you track by hand — recording a payment here never moves money
            between your accounts
          </p>
        </div>

        {/* One row per currency, never a single total: there is no rate on this
            page, and 500 USD plus 1.000.000 VND is two facts. Omitted entirely
            when nothing is outstanding, rather than shown as a row of zeroes. */}
        {subtotals.length > 0 && (
          <ul className="flex flex-col gap-1">
            {subtotals.map((subtotal) => (
              <li
                key={subtotal.currency}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm"
              >
                <span className="font-medium">{subtotal.currency}</span>
                <span className="text-muted-foreground">
                  Owed to you{' '}
                  <span className="text-positive tabular-nums">{subtotal.receivable}</span>
                </span>
                <span className="text-muted-foreground">
                  You owe <span className="text-negative tabular-nums">{subtotal.payable}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {active.length === 0 ? (
          <p className="text-sm text-foreground/60">No debts yet — add one below.</p>
        ) : (
          <DebtList
            debts={active}
            renderActions={(debt) => <DebtRowActions debt={debt} today={today} />}
          />
        )}
      </div>

      <div id="new" className="scroll-mt-6">
        <h2 className="mb-3 text-lg font-semibold">Add debt</h2>
        <DebtForm />
      </div>

      {writtenOff.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-foreground/60">
            Written-off debts ({writtenOff.length})
          </summary>
          {/* Read-only, like the archived accounts on `/accounts`: a written-off
              debt refuses every write (`DebtNotActiveError`), so no actions are
              offered here. The payment history stays — the money really did
              arrive, and writing the rest off does not undo that. */}
          <div className="mt-3 opacity-70">
            <DebtList debts={writtenOff} />
          </div>
        </details>
      )}
    </div>
  )
}
