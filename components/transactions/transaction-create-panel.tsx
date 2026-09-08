'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'
import { TransactionForm, type AccountOption, type CategoryOption } from './transaction-form'

/**
 * The create form's homes (spec §6.2, §14 decision 2; breakpoints revised at
 * §14 fix round 1, finding 1).
 *
 * Three pieces, one shared Context, because the trigger lives in
 * `PageHeader`'s `actions` slot — a different branch of the page's JSX tree
 * from the panel/sheet — and both need the SAME "open the sheet" state:
 *
 *  - `TransactionCreatePanelProvider` owns `sheetOpen` and the sheet itself
 *    (mounted once, wherever this is rendered — Base UI's Dialog portals its
 *    content to `document.body` regardless), and wraps the WHOLE page body so
 *    both consumers below are its descendants;
 *  - `TransactionCreateTrigger` is the header's button, `md:hidden` — visible
 *    only below `md` (768 px), because that is the only range with no
 *    always-mounted form to submit through instead;
 *  - `TransactionCreatePanelBody` is the inline/sticky form: `hidden` below
 *    `md`, a plain full-width block from `md` to `< xl` (the tablet
 *    composition: below the list, full width — nothing else needed, since a
 *    single-column grid already stacks it there), and `xl:sticky` beside the
 *    list from `xl` (1280 px) up.
 *
 * A first pass mounted the sticky panel's `TransactionForm` AND the sheet's
 * `TransactionForm` at the same time below `xl` (the sticky `<aside>` was
 * only CSS-`hidden`, not absent), and both used hard-coded field ids — so a
 * `<label for="transaction-account">` in the mobile sheet could bind to the
 * OTHER, invisible instance's control.
 *
 * `TransactionCreatePanelBody` below is STILL always mounted — `page.tsx`
 * renders it unconditionally, and its own `hidden md:flex` is a CSS rule, not
 * a React one, so its `TransactionForm` is a real, live instance below `md`
 * too, simply not painted. So is the sheet's, whenever it is open. Two
 * `TransactionForm`s being mounted at once below `md` is therefore the
 * NORMAL case, not an edge case to avoid — what actually fixes the label
 * mis-binding is `useId()`: every field id is unique per mounted instance, so
 * a `<label for>` can never resolve to the OTHER one's control regardless of
 * how many instances happen to share the page at once.
 */
interface TransactionCreateContextValue {
  accounts: AccountOption[]
  categories: CategoryOption[]
  timezone: string
  locale: Locale
  openSheet: () => void
}

const TransactionCreateContext = createContext<TransactionCreateContextValue | null>(null)

export function TransactionCreatePanelProvider({
  accounts,
  categories,
  timezone,
  locale,
  children,
}: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  timezone: string
  locale: Locale
  children: React.ReactNode
}) {
  const t = useTranslations()
  const pathname = usePathname()
  const [sheetOpen, setSheetOpen] = useState(false)

  // `#new` arriving from the shell's Add-transaction action. Read once per
  // navigation: `window.location.hash` is not reactive, and `pathname` changing
  // is the only thing that can bring a new hash to this page.
  useEffect(() => {
    // Below `md` the sheet is the only home the form has; at `md` and up the
    // inline/sticky panel (`id="new"`, in `TransactionCreatePanelBody`) is
    // already on the page, so the browser's own anchor scroll is enough and
    // opening the sheet too would show the form twice.
    const isMdUp = window.matchMedia('(min-width: 768px)').matches
    if (window.location.hash !== '#new' || isMdUp) return
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

  const value = useMemo<TransactionCreateContextValue>(
    () => ({ accounts, categories, timezone, locale, openSheet: () => setSheetOpen(true) }),
    [accounts, categories, timezone, locale],
  )

  return (
    <TransactionCreateContext.Provider value={value}>
      {children}
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
    </TransactionCreateContext.Provider>
  )
}

/** The header's primary action — visible only below `md` (spec §14 fix round
 *  1, finding 1): from `md` up, `TransactionCreatePanelBody` is already on the
 *  page, so a second way to open the (now-empty) sheet would be redundant. */
export function TransactionCreateTrigger() {
  const t = useTranslations()
  const ctx = useContext(TransactionCreateContext)
  if (!ctx) return null
  return (
    <Button type="button" className="md:hidden" onClick={ctx.openSheet}>
      {t('transactions.openCreate')}
    </Button>
  )
}

/** The inline (`md`–`xl`) / sticky (`xl` and up) form. Rendered — and its
 *  `TransactionForm` mounted — at every width; `hidden` (a CSS rule) is what
 *  keeps it off-screen below `md`, where the sheet is the form's visible
 *  home. See the file doc comment above for why a second, invisible,
 *  mounted instance below `md` is fine rather than something to prevent. */
export function TransactionCreatePanelBody() {
  const t = useTranslations()
  const ctx = useContext(TransactionCreateContext)
  if (!ctx) return null
  return (
    <div
      id="new"
      className="hidden scroll-mt-6 flex-col gap-4 rounded-lg border border-border bg-surface p-4 md:flex xl:sticky xl:top-6 xl:col-span-5 xl:h-fit"
    >
      <h2 className="text-[1.125rem]/[1.625rem] font-semibold">{t('transactions.createTitle')}</h2>
      <TransactionForm
        accounts={ctx.accounts}
        categories={ctx.categories}
        timezone={ctx.timezone}
        locale={ctx.locale}
      />
    </div>
  )
}
