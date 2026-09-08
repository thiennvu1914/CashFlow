'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'
import { TransactionForm, type AccountOption, type CategoryOption } from './transaction-form'

/**
 * The create form's two homes (spec §6.2, §14 decision 2).
 *
 * At ≥ 1280 (Tailwind `xl`) it is ALWAYS VISIBLE in a sticky 5/12 column, because
 * recording a transaction is the highest-frequency thing anyone does in this app
 * and a sheet would put a click in front of every single one. Below that — and
 * on every phone — it is a bottom sheet, opened by the header's primary button
 * or by the bottom bar's `+`.
 *
 * The `+` navigates to `/transactions#new` (the shell's `ADD_TRANSACTION_HREF`,
 * unchanged since Phase 4), so this component opens the sheet when the hash is
 * `#new` on mount and clears it afterwards — the alternative was making the
 * shell aware of a page's internal state.
 *
 * TWO mounted copies of `TransactionForm` would be two react-hook-form
 * instances fighting over one submit, so only one renders at a time: the
 * `xl:flex` panel and the sheet are mutually exclusive by breakpoint, and the
 * sheet's copy mounts on open (spec §9: "Edit/instalment/payment forms open in
 * Dialog or Sheet and mount on open — no SSR defaults problem").
 *
 * The `#new` anchor and the sheet's hash trigger share one id, and BOTH exist
 * at every width — the `<aside>` is merely `hidden` below `xl`, not absent —
 * so the effect below is gated on `matchMedia('(min-width: 1280px)')`: below
 * that width the anchor cannot scroll to a hidden element, so opening the
 * sheet is correct; at or above it, the always-visible panel is already the
 * destination, and opening the sheet too would show the form twice.
 */
export function TransactionCreatePanel({
  accounts,
  categories,
  timezone,
  locale,
}: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  timezone: string
  locale: Locale
}) {
  const t = useTranslations()
  const pathname = usePathname()
  const [sheetOpen, setSheetOpen] = useState(false)

  // `#new` arriving from the shell's Add-transaction action. Read once per
  // navigation: `window.location.hash` is not reactive, and `pathname` changing
  // is the only thing that can bring a new hash to this page.
  useEffect(() => {
    const isDesktop = window.matchMedia('(min-width: 1280px)').matches
    if (window.location.hash !== '#new' || isDesktop) return
    // `react-hooks/set-state-in-effect` (enforced in this repo, see
    // `lib/ui/use-hydrated.ts`) refuses a `setState` called synchronously in an
    // effect body — it is reasoned about as "force a re-render to sync with an
    // external data source", and its own suggested fix is `useSyncExternalStore`,
    // which fits a CONTINUOUSLY read value and not a one-shot mount signal like
    // a URL hash that this effect also consumes (clears). Deferring the update
    // to a microtask is the same escape hatch React's own effect-cleanup timing
    // relies on and keeps the update out of this synchronous commit, while still
    // running before the next paint — there is no user-visible delay.
    queueMicrotask(() => setSheetOpen(true))
    // Clear it so a later reload does not reopen the sheet the user closed.
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [pathname])

  return (
    <>
      {/* Mobile/tablet: the trigger. `xl:hidden` so the desktop panel below is
          the only copy at ≥ 1280. */}
      <Button type="button" className="xl:hidden" onClick={() => setSheetOpen(true)}>
        {t('transactions.openCreate')}
      </Button>

      <Sheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={t('transactions.createTitle')}
        closeLabel={t('common.close')}
      >
        <TransactionForm
          accounts={accounts}
          categories={categories}
          timezone={timezone}
          locale={locale}
          onCreated={() => setSheetOpen(false)}
        />
      </Sheet>

      {/* Desktop: the always-visible sticky panel. `id="new"` keeps the shell's
          `/transactions#new` anchor working for a user who lands on it at a
          desktop width, where there is no sheet to open. */}
      <aside
        id="new"
        className="sticky top-6 hidden h-fit scroll-mt-6 flex-col gap-4 rounded-lg border border-border bg-surface p-4 xl:flex"
      >
        <h2 className="text-[1.125rem]/[1.625rem] font-semibold">
          {t('transactions.createTitle')}
        </h2>
        <TransactionForm
          accounts={accounts}
          categories={categories}
          timezone={timezone}
          locale={locale}
        />
      </aside>
    </>
  )
}
