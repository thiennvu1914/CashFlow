import { getTranslations } from 'next-intl/server'
import { Landmark } from 'lucide-react'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { resolveLocale } from '@/lib/i18n/config'
import { getLoansWithOutstanding } from '@/lib/server/services/loan'
import { loanSubtotalsByCurrency, toLoanDto, type LoanDto } from '@/lib/ui/loan-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { LoanCreateButton } from '@/components/loans/loan-create-button'
import { LoanList } from '@/components/loans/loan-list'
import { LoanPaymentButton, LoanRowMenu } from '@/components/loans/loan-row-actions'
import { EmptyState } from '@/components/common/empty-state'
import { MoneyText } from '@/components/common/money-text'
import { PageHeader } from '@/components/common/page-header'
import { SectionHeader } from '@/components/common/section-header'

/**
 * Loans (spec §4.10, §6.6): money the user owes a lender, and the instalments
 * they have recorded against it — each in its own currency and never converted
 * to `User.baseCurrency` (ledger ruling R5-3).
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
  const t = await getTranslations()
  const locale = await resolveLocale()
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
  const subtotals = loanSubtotalsByCurrency(rows, locale)

  // The only place a `Decimal` or a `Date` becomes a string on this page. Every
  // component below renders `LoanDto`s.
  const dtos = rows.map((row) => toLoanDto(row, today, locale))
  const active = dtos
    .filter((dto) => dto.active)
    .sort((a, b) => DISPLAY_RANK[a.status] - DISPLAY_RANK[b.status])
  const closed = dtos.filter((dto) => !dto.active)

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('loans.title')}
        description={t('loans.description')}
        // One row per currency, never a single total: there is no rate on this
        // page, and 20.000 USD plus 240.000.000 VND is two facts. Principal
        // only — interest already paid is a settled cost, not something the
        // lender still holds. Omitted entirely when nothing is outstanding,
        // rather than shown as a row of zeroes.
        meta={
          subtotals.length > 0 && (
            <ul className="flex flex-col gap-1">
              {subtotals.map((subtotal) => (
                <li key={subtotal.currency} className="flex flex-wrap items-baseline gap-x-1">
                  <span>
                    {subtotal.currency} · {t('loans.subtotalPrincipal')}{' '}
                  </span>
                  <MoneyText value={subtotal.outstandingPrincipal} />
                </li>
              ))}
            </ul>
          )
        }
        actions={<LoanCreateButton today={today} />}
      />

      {active.length === 0 ? (
        <EmptyState
          icon={Landmark}
          size="page"
          title={t('loans.emptyTitle')}
          description={t('loans.emptyBody')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {/* One `h2` for the main list (spec a11y AC: "one h2 on Loans"),
              paralleling `debts.json`'s two section headings and the closed
              section's own `h2` below. */}
          <SectionHeader title={t('loans.activeSection')} />
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <LoanList
              loans={active}
              locale={locale}
              timeZone={timezone}
              renderActions={(loan) => ({
                inlineAction: <LoanPaymentButton loan={loan} today={today} locale={locale} />,
                actions: <LoanRowMenu loan={loan} />,
              })}
            />
          </div>
        </div>
      )}

      {closed.length > 0 && (
        <details className="rounded-lg border border-border bg-surface">
          {/* A heading element as a `<summary>`'s label is explicit content
              model (a `<summary>` may include one `h1`–`h6` as its label),
              which is what gives this disclosure's own section a real
              heading rather than a clickable paragraph — spec a11y AC: "h2 on
              each `<details>`". */}
          <summary className="cursor-pointer px-4 py-3">
            <h2 className="inline text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
              {t('loans.closedSection', { count: closed.length })}
            </h2>
          </summary>
          {/* Read-only, like the written-off debts on `/debts`: a closed loan
              refuses every write (`LoanNotActiveError`), so no actions are
              offered here. The instalment history stays — the money really was
              paid, and closing the loan does not undo that. */}
          <div className="border-t border-border opacity-70">
            <LoanList loans={closed} locale={locale} timeZone={timezone} />
          </div>
        </details>
      )}
    </div>
  )
}
