'use client'

import {
  createContext,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type Ref,
} from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import type { OccurrencePrefill } from '@/lib/server/services/reminder'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'
import {
  TransactionForm,
  type AccountOption,
  type CategoryOption,
  type EditableTransaction,
} from './transaction-form'

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
 *
 * The same Provider also serves the edit form's home, `TransactionEditSheet`
 * (money-source linking spec 2026-10-12 §6.5), which the ledger renders and
 * opens with a row: one set of picker options for both forms.
 *
 * `prefill` (§6.6) is a reminder occurrence's starting values, read by the page
 * for `?occurrence=<id>` when a reminder's "Đã trả / Paid" could not record the
 * transaction in one tap. Both create forms — the sheet's and the panel's —
 * start from it, and both are keyed by its occurrence: once the save marks the
 * occurrence paid, the page re-renders without a prefill and they remount
 * empty, so the next entry can never be linked to the same bill again.
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
  prefill: OccurrencePrefill | null
  openSheet: () => void
}

/** A create form's `key`: a new occurrence prefill (or none) is a new form. */
function createFormKey(prefill: OccurrencePrefill | null): string {
  return prefill ? `occurrence-${prefill.occurrenceId}` : 'blank'
}

const TransactionCreateContext = createContext<TransactionCreateContextValue | null>(null)

export function TransactionCreatePanelProvider({
  accounts,
  categories,
  timezone,
  locale,
  prefill = null,
  children,
}: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  timezone: string
  locale: Locale
  /** A pending reminder occurrence's values, from `?occurrence=<id>`. */
  prefill?: OccurrencePrefill | null
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
    () => ({
      accounts,
      categories,
      timezone,
      locale,
      prefill,
      openSheet: () => setSheetOpen(true),
    }),
    [accounts, categories, timezone, locale, prefill],
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
          key={createFormKey(prefill)}
          accounts={accounts}
          categories={categories}
          timezone={timezone}
          locale={locale}
          prefill={prefill}
          onSaved={() => setSheetOpen(false)}
        />
      </Sheet>
    </TransactionCreateContext.Provider>
  )
}

export interface TransactionEditSheetHandle {
  open: (transaction: EditableTransaction) => void
}

/**
 * The edit form's home (money-source linking spec 2026-10-12 §6.5): the same
 * `TransactionForm`, in a `Sheet` at every width, pre-filled from the row.
 *
 * Rendered by the ledger (which owns the rows) inside this file's Provider
 * (which owns the pickers' options), and opened through `handleRef` with the
 * row — so its open state lives here and opening it re-renders this sheet
 * alone, never the memoised ledger rows (the same shape as the ledger's delete
 * confirmation). Outside the Provider there are no options to edit with, and
 * it renders nothing.
 *
 * `target` outlives `open` on purpose: the sheet keeps its content painted
 * through the close animation instead of collapsing mid-slide. Each opening
 * mounts a fresh form (`key`), so it always starts from the row as the server
 * last sent it — never from a previous, abandoned edit.
 */
export function TransactionEditSheet({
  handleRef,
}: {
  handleRef: Ref<TransactionEditSheetHandle>
}) {
  const t = useTranslations()
  const ctx = useContext(TransactionCreateContext)
  const [target, setTarget] = useState<{ transaction: EditableTransaction; key: number } | null>(
    null,
  )
  const [open, setOpen] = useState(false)
  useImperativeHandle(
    handleRef,
    () => ({
      open: (transaction) => {
        setTarget((prev) => ({ transaction, key: (prev?.key ?? 0) + 1 }))
        setOpen(true)
      },
    }),
    [],
  )

  if (!ctx) return null
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={t('transactions.editTitle')}
      closeLabel={t('common.close')}
    >
      {target && (
        <TransactionForm
          key={target.key}
          accounts={ctx.accounts}
          categories={ctx.categories}
          timezone={ctx.timezone}
          locale={ctx.locale}
          transaction={target.transaction}
          onSaved={() => setOpen(false)}
        />
      )}
    </Sheet>
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
      <h2 className="text-[1.125rem]/[1.625rem] font-semibold tracking-tight">
        {t('transactions.createTitle')}
      </h2>
      <TransactionForm
        key={createFormKey(ctx.prefill)}
        accounts={ctx.accounts}
        categories={ctx.categories}
        timezone={ctx.timezone}
        locale={ctx.locale}
        prefill={ctx.prefill}
      />
    </div>
  )
}
