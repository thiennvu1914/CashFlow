import { Suspense } from 'react'
import { Wallet } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { resolveLocale } from '@/lib/i18n/config'
import { getAccountBalancesForUser } from '@/lib/server/services/balance-timeline'
import { listCategories } from '@/lib/server/services/category'
import { listActiveAccountPickerRows } from '@/lib/server/services/financial-account'
import { getOccurrencePrefill } from '@/lib/server/services/reminder'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { toAccountOptions } from '@/components/transactions/account-options'
import {
  TransactionCreatePanelBody,
  TransactionCreatePanelProvider,
  TransactionCreateTrigger,
} from '@/components/transactions/transaction-create-panel'
import {
  TransactionLedgerSection,
  TransactionLedgerSkeleton,
  TransactionsMonthTotal,
} from '@/components/transactions/transaction-ledger-section'

/** One day, in milliseconds — for computing "yesterday" from "now". */
const MS_PER_DAY = 24 * 60 * 60 * 1000

export default async function TransactionsPage({
  searchParams,
}: {
  // Query parameters as Next delivers them — untrusted, and never cast: a
  // repeated key arrives as `string[]` (the convention of
  // `app/(app)/reminders/page.tsx`).
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const { baseCurrency: displayCurrency, timezone } = resolveProfileDefaults(user)
  const locale = await resolveLocale()
  const t = await getTranslations()
  // ONE `now` for the whole request, so the month total, the day headers and
  // the form's pre-filled "now" cannot straddle midnight.
  const now = new Date()
  const today = todayCalendarDateInZone(timezone, now)
  const yesterday = todayCalendarDateInZone(timezone, new Date(now.getTime() - MS_PER_DAY))
  // `?occurrence=<id>`: a reminder's "Đã trả / Paid" could not record the
  // transaction in one tap and sent the user here to finish it (money-source
  // linking spec 2026-10-12 §6.6). Only the id comes from the URL; the form's
  // values are read from the occurrence itself, scoped to this user, and a
  // stale, answered or foreign id simply opens the ordinary empty form.
  const { occurrence } = await searchParams
  const occurrenceId = typeof occurrence === 'string' && occurrence !== '' ? occurrence : null

  const [accounts, categories, balances, prefill] = await Promise.all([
    listActiveAccountPickerRows(user.id),
    // Both transaction types use the same picker payload. One tenant-scoped
    // read preserves the service ordering and avoids two parallel queries for
    // rows that are concatenated again below.
    listCategories(user.id),
    // The account picker shows each account's balance (spec §2). Read beside
    // the page's other queries instead of after the account list; joined by id
    // below.
    getAccountBalancesForUser(user.id, now),
    // Beside the other reads, so a Paid hand-off costs no extra wait.
    occurrenceId ? getOccurrencePrefill(user.id, occurrenceId, timezone) : null,
  ])

  // The month total needs a summary query and the ledger a 200-row one; neither
  // gates the create form, so each streams behind its own boundary. The header
  // title and the form render as soon as the three reads above return.
  const monthTotalDescription = (
    // A `span`, not `Skeleton`: this sits inside `PageHeader`'s `<p>`, where a
    // `div` is invalid nesting and fails hydration.
    <Suspense
      fallback={
        <span
          aria-hidden="true"
          className="inline-block h-4 w-48 animate-pulse rounded-md bg-muted align-middle"
        />
      }
    >
      <TransactionsMonthTotal
        userId={user.id}
        displayCurrency={displayCurrency}
        timezone={timezone}
        locale={locale}
        now={now}
      />
    </Suspense>
  )

  /**
   * Zero active accounts (spec §14 fix round 1, finding 6): the page itself
   * — not just `TransactionForm` — replaces its whole body with ONE notice.
   * A first pass left the list's own "Chưa có giao dịch" empty state and the
   * create panel's own no-account notice as two SEPARATE things, reachable
   * only after opening the sheet on a phone — so a brand-new user's very
   * first visit read as "nothing to see here" until they went looking. No
   * header/mobile create trigger is rendered in this branch either: there is
   * nothing yet for it to create a transaction against.
   */
  if (accounts.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
        <PageHeader title={t('transactions.title')} description={monthTotalDescription} />
        <EmptyState
          icon={Wallet}
          size="page"
          title={t('transactions.noAccountTitle')}
          description={t('transactions.noAccountBody')}
          action={{ label: t('transactions.noAccountAction'), href: '/accounts' }}
        />
      </div>
    )
  }

  return (
    <TransactionCreatePanelProvider
      accounts={toAccountOptions(accounts, balances)}
      categories={categories.map((category) => ({
        id: category.id,
        name: category.name,
        type: category.type,
      }))}
      timezone={timezone}
      locale={locale}
      prefill={prefill}
    >
      {/* max-w 1200 because the two-column desktop layout needs it. */}
      <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
        <PageHeader
          title={t('transactions.title')}
          description={monthTotalDescription}
          actions={<TransactionCreateTrigger />}
        />

        {/* 7/12 + 5/12 at ≥ 1280 (spec §6.2); below that, one column, the
            create panel's own `md:flex`/`xl:sticky` classes give it the
            tablet composition (full width, below the list) and the sheet
            (below `md`) needs no grid cell at all. */}
        <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
          <div className="xl:col-span-7">
            <Suspense fallback={<TransactionLedgerSkeleton />}>
              <TransactionLedgerSection
                userId={user.id}
                timezone={timezone}
                locale={locale}
                today={today}
                yesterday={yesterday}
              />
            </Suspense>
          </div>
          <TransactionCreatePanelBody />
        </div>
      </div>
    </TransactionCreatePanelProvider>
  )
}
