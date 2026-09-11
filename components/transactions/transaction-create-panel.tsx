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
 *  - `TransactionCreateTrigger` is the header's button, `xl:hidden` — visible
 *    everywhere below `xl` (1280 px), because that is the range with no
 *    ALWAYS-IN-VIEW form to submit through instead (fix round 1, area D: it
 *    used to be `md:hidden`, so a tablet user — `md` to `< xl` — saw only a
 *    long ledger with the create panel stranded below it and no visible way
 *    to reach it, since the panel there is an ordinary in-flow block, not the
 *    `xl:sticky` one);
 *  - `TransactionCreatePanelBody` is the inline/sticky form: `hidden` below
 *    `md`, a plain full-width block from `md` to `< xl` (the tablet
 *    composition: below the list, full width — nothing else needed, since a
 *    single-column grid already stacks it there), and `xl:sticky` beside the
 *    list from `xl` (1280 px) up.
 *
 * Below `md` the trigger opens the sheet, exactly as before. From `md` to
 * `< xl` the form is already mounted on the page (just scrolled past), so the
 * trigger instead scrolls `#new` into view and focuses its first field —
 * opening the sheet there would show a SECOND, empty copy of the same form.
 * `#new` arriving as a hash (the shell's Add-transaction action) does the
 * same at those widths, via `focusInlinePanel` below.
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

/**
 * Brings the inline/sticky panel (`#new`) into view and focuses its own
 * first field — the md–`xl` alternative to opening the sheet, which at those
 * widths would only show a second, empty copy of the same form. Shared by the
 * header trigger and the `#new` hash effect so both reach the panel the same
 * way.
 *
 * "First field" is whichever the form actually puts first in the DOM — the
 * Type radiogroup's first button today — found generically rather than
 * hard-coded to one control, so this keeps working if the form's field order
 * ever changes.
 */
function focusInlinePanel() {
  const panel = document.getElementById('new')
  if (!panel) return
  panel.scrollIntoView({ block: 'start' })
  const firstField = panel.querySelector<HTMLElement>('input, select, textarea, [role="radio"]')
  firstField?.focus()
}

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
    if (window.location.hash !== '#new') return
    const isMdUp = window.matchMedia('(min-width: 768px)').matches
    const isXlUp = window.matchMedia('(min-width: 1280px)').matches
    // Below `md` the sheet is the only home the form has. From `md` to
    // `< xl` the inline panel is on the page but not scrolled to — bring it
    // into view and focus its first field (fix round 1, area D), rather than
    // relying on the browser's own anchor scroll, which moves the viewport
    // but focuses nothing. At `xl` and up the sticky panel is already always
    // in view, so there is nothing further to do.
    //
    // `react-hooks/set-state-in-effect` (enforced in this repo, see
    // `lib/ui/use-hydrated.ts`) refuses a `setState` called synchronously in an
    // effect body — it is reasoned about as "force a re-render to sync with an
    // external data source", and its own suggested fix is `useSyncExternalStore`,
    // which fits a CONTINUOUSLY read value and not a one-shot mount signal like
    // a URL hash that this effect also consumes (clears). Deferring the update
    // to a microtask is the same escape hatch React's own effect-cleanup timing
    // relies on and keeps the update out of this synchronous commit, while still
    // running before the next paint — there is no user-visible delay.
    if (!isMdUp) {
      queueMicrotask(() => setSheetOpen(true))
    } else if (!isXlUp) {
      queueMicrotask(focusInlinePanel)
    }
    // Clear it so a later reload does not reopen the sheet/refocus the panel
    // the user has already moved on from.
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

/** The header's primary action — visible below `xl` (fix round 1, area D;
 *  originally `md:hidden`, spec §14 fix round 1, finding 1). At `xl` and up,
 *  `TransactionCreatePanelBody` is sticky beside the list and always in view,
 *  so the trigger would be redundant; below that it opens the sheet (below
 *  `md`, the form's only home) or brings the already-mounted inline panel
 *  into view and focus (`md`–`xl`, where opening the sheet would only show a
 *  second, empty copy of the same form). */
export function TransactionCreateTrigger() {
  const t = useTranslations()
  const ctx = useContext(TransactionCreateContext)
  if (!ctx) return null
  // Destructured here, in the same narrowed scope as the guard above, rather
  // than read off `ctx` inside `handleClick` below: TS does not carry a
  // `const`'s narrowing into a nested function declaration, so `ctx.openSheet`
  // itself would still type as possibly-`null`-qualified there. `openSheet`
  // pulled out here is just a plain `() => void`, with nothing left to assert.
  const { openSheet } = ctx

  function handleClick() {
    const isMdUp = window.matchMedia('(min-width: 768px)').matches
    if (isMdUp) {
      focusInlinePanel()
    } else {
      openSheet()
    }
  }

  return (
    <Button type="button" className="xl:hidden" onClick={handleClick}>
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
      className="card-hover-effect hidden scroll-mt-6 flex-col gap-4 rounded-xl border border-border/80 bg-surface/90 p-5 shadow-xs md:flex xl:sticky xl:top-6 xl:col-span-5 xl:h-fit"
    >
      <h2 className="text-[1.125rem]/[1.625rem] font-semibold tracking-tight">{t('transactions.createTitle')}</h2>
      <TransactionForm
        accounts={ctx.accounts}
        categories={ctx.categories}
        timezone={ctx.timezone}
        locale={ctx.locale}
      />
    </div>
  )
}
