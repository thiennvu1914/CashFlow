'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { LogoutButton } from '@/components/auth/logout-button'
import { buttonVariants } from '@/components/ui/button'
import { MobileTabBar, MobileTopBar } from './mobile-nav'
import { NAV_GROUPS } from './nav-groups'
import { ADD_TRANSACTION_HREF, isActiveNavItem, type NavItem } from './nav-items'

/**
 * The frame every signed-in page renders inside (spec §5).
 *
 * Three navigations, not one responsive one:
 *
 *  - >= 1280 (Tailwind `xl`, per the product owner's breakpoint ruling): a
 *    240 px rail with grouped destinations, the primary "Thêm giao dịch"
 *    action under the wordmark, and the user's name above a ghost Log out at
 *    the bottom (spec §14, decision 4).
 *  - 768–1279 (`md`..<`xl`): the same rail at 64 px, icons only with
 *    accessible names. NOT a bottom bar — this width has the vertical space
 *    and `e2e/phase4.spec.ts` asserts the bar stays hidden at 768.
 *  - < 768: a top bar and a five-slot bottom bar, in `mobile-nav.tsx`.
 *
 * A client component only because the active item depends on `usePathname`. It
 * renders `children` untouched, so every page underneath stays a server
 * component and no page data crosses this boundary. `userName` is a plain
 * string the `(app)` layout reads from the session — never the session object.
 */
export function AppShell({ userName, children }: { userName: string; children: React.ReactNode }) {
  const pathname = usePathname()
  const t = useTranslations()

  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      {/* First focusable element on the page (spec §8): a keyboard user should
          not have to walk twelve rail links to reach the content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2 focus:text-sm"
      >
        {t('nav.skipToContent')}
      </a>

      {/* `sticky h-screen` keeps the rail in place while the page scrolls
          without taking the content out of normal flow. 64 px at md, 240 px
          from xl (product owner's ruling: 1024–1279 is the TABLET
          composition, not a squeezed desktop) — one element, two widths, so
          there is no second rail to keep in step. */}
      <aside className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col border-r border-border bg-surface p-2 md:flex xl:w-60 xl:p-4">
        <Link
          href="/dashboard"
          className="flex h-9 items-center justify-center gap-2 rounded-md text-base font-semibold text-brand xl:justify-start xl:px-2"
        >
          {/* Decorative beside the visible desktop wordmark. On the tablet
              icon rail the existing screen-reader-only text names the link. */}
          <Image
            src="/brand/cashflow-mark.png"
            alt=""
            width={1254}
            height={1254}
            sizes="32px"
            loading="eager"
            className="size-8 shrink-0 dark:brightness-150"
          />
          <span className="sr-only xl:not-sr-only">{t('common.appName')}</span>
        </Link>

        <Link
          href={ADD_TRANSACTION_HREF}
          aria-label={t('nav.addTransaction')}
          title={t('nav.addTransaction')}
          className={cn(
            buttonVariants({ size: 'default' }),
            'mt-6 w-full justify-center gap-2 xl:justify-start',
          )}
        >
          <Plus aria-hidden="true" className="size-4" />
          <span className="sr-only xl:not-sr-only">{t('nav.addTransaction')}</span>
        </Link>

        <nav aria-label={t('nav.primary')} className="mt-6 min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4">
            {NAV_GROUPS.map((group) => (
              // `role="group"` + `aria-labelledby` is what makes the header
              // belong to its items for a screen reader; a bare `<p>` above a
              // `<ul>` is only a visual grouping. On the icon rail the header
              // is hidden and a divider stands in for it.
              <div
                key={group.id}
                role="group"
                aria-labelledby={`nav-group-${group.id}`}
                className="flex flex-col gap-0.5 border-t border-border pt-4 first:border-t-0 first:pt-0 xl:border-t-0 xl:pt-0"
              >
                <h2
                  id={`nav-group-${group.id}`}
                  className="sr-only px-2 pb-1 text-xs/[1rem] font-medium tracking-[0.04em] text-muted-foreground uppercase xl:not-sr-only"
                >
                  {t(group.headerKey)}
                </h2>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <RailLink item={item} active={isActiveNavItem(pathname, item.href)} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        {/* Spec §14, decision 4: the user's name above a ghost Log out, at the
            bottom of the rail — not a solid outline button competing with the
            one primary action at the top. */}
        <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4">
          <p className="hidden truncate px-2 text-[0.8125rem]/[1.125rem] text-muted-foreground xl:block">
            {userName}
          </p>
          <LogoutButton compact />
        </div>
      </aside>

      <MobileTopBar />

      {/* `min-w-0` stops a wide child (a chart, a table) forcing the flex
          row wider than the viewport; the bottom padding reserves the fixed
          mobile bar's 60 px height plus its safe-area inset plus a small gap,
          so the bar never covers the last row of content (see
          `mobile-nav.tsx`'s `MobileTabBar` for the matching height).
          `tabIndex={-1}` makes `#main` a legal target for the skip link above
          — an element needs to be focusable for `.focus()` (which following
          a link to a fragment triggers) to actually move focus there, and a
          bare `<main>` is not; `outline-none` stops that one programmatic
          focus from drawing a ring around the whole content region (the
          global focus-ring styling is for interactive elements, not a
          section landmark). */}
      <main
        id="main"
        tabIndex={-1}
        className="min-w-0 flex-1 pb-[calc(60px+env(safe-area-inset-bottom)+16px)] outline-none md:pb-0"
      >
        {children}
      </main>

      <MobileTabBar />
    </div>
  )
}

/**
 * One rail row. The 2 px brand bar on the left edge is the active marker
 * (spec §5) and it is drawn with a `before:` pseudo-element rather than a
 * border, so an inactive row's text does not shift by 2 px when it becomes
 * active.
 */
function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useTranslations()
  const label = t(item.labelKey)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      className={cn(
        'relative flex h-9 items-center justify-center gap-2.5 rounded-md text-sm xl:justify-start xl:px-2',
        active
          ? 'bg-muted font-medium text-brand before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      {/* Hidden on the icon rail, shown from xl. `aria-label` above carries
          the name at both widths, so a tablet user's screen reader is not left
          with an unnamed link. */}
      <span className="sr-only xl:not-sr-only">{label}</span>
    </Link>
  )
}
