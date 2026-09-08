import { getTranslations } from 'next-intl/server'
import { HandCoins } from 'lucide-react'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { resolveLocale } from '@/lib/i18n/config'
import { getDebtsWithOutstanding } from '@/lib/server/services/debt'
import { debtSubtotalsByCurrency, toDebtDto, type DebtDto } from '@/lib/ui/debt-view-model'
import { formatMoney } from '@/lib/ui/format-money'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { DebtCreateButton } from '@/components/debts/debt-create-button'
import { DebtList } from '@/components/debts/debt-list'
import { DebtRowActions } from '@/components/debts/debt-row-actions'
import { EmptyState } from '@/components/common/empty-state'
import { MoneyText } from '@/components/common/money-text'
import { PageHeader } from '@/components/common/page-header'
import { SectionHeader } from '@/components/common/section-header'

/**
 * Debts (spec §4.9, §6.6): money someone owes the user, and money the user owes
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
  const t = await getTranslations()
  const locale = await resolveLocale()
  // The one place the user's zone enters: whether a debt is overdue is a
  // comparison of calendar dates, never of instants (ruling R6-7). The same
  // `today` seeds the payment form's date, so "today" means one thing on this
  // page rather than one thing on the server and another in the browser.
  const today = todayCalendarDateInZone(timezone, new Date())

  const rows = await getDebtsWithOutstanding(user.id, today)

  // Subtotals are taken from the service rows — `Prisma.Decimal` sums, one per
  // currency — before anything is formatted, so the strip can never be the
  // result of adding up strings.
  const subtotals = debtSubtotalsByCurrency(rows, locale)
  // "Nothing outstanding in this direction/currency" reads as no row at all,
  // never a fabricated "0" — the same figure `formatMoney` would print for an
  // actual zero, so a currency that only ever appears in the OTHER direction
  // is filtered out of each section rather than shown here as a zero.
  const zeroOf = { VND: formatMoney(0, 'VND', locale), USD: formatMoney(0, 'USD', locale) }
  const receivableSubtotals = subtotals.filter((s) => s.receivable !== zeroOf[s.currency])
  const payableSubtotals = subtotals.filter((s) => s.payable !== zeroOf[s.currency])

  // The only place a `Decimal` or a `Date` becomes a string on this page. Every
  // component below renders `DebtDto`s.
  const dtos = rows.map((row) => toDebtDto(row, locale))
  const active = dtos
    .filter((dto) => dto.active)
    .sort((a, b) => displayRank(a.status) - displayRank(b.status))
  const receivable = active.filter((dto) => dto.direction === 'RECEIVABLE')
  const payable = active.filter((dto) => dto.direction === 'PAYABLE')
  const writtenOff = dtos.filter((dto) => !dto.active)

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('debts.title')}
        description={t('debts.description')}
        actions={<DebtCreateButton />}
      />

      {active.length === 0 ? (
        <EmptyState
          icon={HandCoins}
          size="page"
          title={t('debts.emptyTitle')}
          description={t('debts.emptyBody')}
        />
      ) : (
        <>
          {receivable.length > 0 && (
            <div className="flex flex-col gap-3">
              <SectionHeader
                title={t('debts.sectionReceivable')}
                right={
                  // One row per currency, never a single total: there is no
                  // rate on this page, and 500 USD plus 1.000.000 VND is two
                  // facts. Omitted entirely when nothing is outstanding,
                  // rather than shown as a row of zeroes.
                  receivableSubtotals.length > 0 && (
                    <ul className="flex flex-col items-end gap-1">
                      {receivableSubtotals.map((subtotal) => (
                        <li key={subtotal.currency} className="text-[0.8125rem]/[1.125rem]">
                          <span className="text-muted-foreground">
                            {subtotal.currency} · {t('debts.subtotalReceivable')}{' '}
                          </span>
                          <MoneyText value={subtotal.receivable} tone="positive" />
                        </li>
                      ))}
                    </ul>
                  )
                }
              />
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                <DebtList
                  debts={receivable}
                  locale={locale}
                  timeZone={timezone}
                  renderActions={(debt) => <DebtRowActions debt={debt} today={today} />}
                />
              </div>
            </div>
          )}

          {payable.length > 0 && (
            <div className="flex flex-col gap-3">
              <SectionHeader
                title={t('debts.sectionPayable')}
                right={
                  payableSubtotals.length > 0 && (
                    <ul className="flex flex-col items-end gap-1">
                      {payableSubtotals.map((subtotal) => (
                        <li key={subtotal.currency} className="text-[0.8125rem]/[1.125rem]">
                          <span className="text-muted-foreground">
                            {subtotal.currency} · {t('debts.subtotalPayable')}{' '}
                          </span>
                          <MoneyText value={subtotal.payable} tone="negative" />
                        </li>
                      ))}
                    </ul>
                  )
                }
              />
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                <DebtList
                  debts={payable}
                  locale={locale}
                  timeZone={timezone}
                  renderActions={(debt) => <DebtRowActions debt={debt} today={today} />}
                />
              </div>
            </div>
          )}
        </>
      )}

      {writtenOff.length > 0 && (
        <details className="rounded-lg border border-border bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
            {t('debts.writtenOffSection', { count: writtenOff.length })}
          </summary>
          {/* Read-only, like the archived accounts on `/accounts`: a written-off
              debt refuses every write (`DebtNotActiveError`), so no actions are
              offered here. The payment history stays — the money really did
              arrive, and writing the rest off does not undo that. */}
          <div className="border-t border-border opacity-70">
            <DebtList debts={writtenOff} locale={locale} timeZone={timezone} />
          </div>
        </details>
      )}
    </div>
  )
}
