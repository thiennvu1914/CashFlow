'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { LogoutButton } from '@/components/auth/logout-button'
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
      <aside className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col border-r border-border/70 bg-surface/90 backdrop-blur-md p-2 md:flex xl:w-60 xl:p-4">
        <Link
          href="/dashboard"
          className="group flex h-10 items-center justify-center gap-2.5 rounded-xl px-1 text-base font-bold text-foreground transition-all xl:justify-start xl:px-2"
        >
          <span className="relative size-7 shrink-0 overflow-hidden rounded-lg bg-brand/10 ring-1 ring-brand/20 transition-transform group-hover:scale-105">
            <Image
              src="/brand/cashflow-mark.png"
              alt=""
              width={1254}
              height={1254}
              sizes="48px"
              loading="eager"
              className="absolute top-1/2 left-1/2 size-12 max-w-none -translate-x-1/2 -translate-y-1/2 dark:brightness-150"
            />
          </span>
          <span className="sr-only text-base font-bold tracking-tight text-foreground xl:not-sr-only">
            Cash<span className="text-brand">Flow</span>
          </span>
        </Link>

        <Link
          href={ADD_TRANSACTION_HREF}
          aria-label={t('nav.addTransaction')}
          title={t('nav.addTransaction')}
          className={cn(
            'mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 px-3 font-medium text-white shadow-sm shadow-emerald-950/20 transition-all duration-200 hover:from-emerald-500 hover:via-teal-500 hover:to-emerald-600 hover:shadow-md hover:shadow-emerald-950/30 active:scale-[0.98] xl:justify-start',
          )}
        >
          <div className="flex size-5 items-center justify-center rounded-md bg-white/20">
            <Plus aria-hidden="true" className="size-3.5 stroke-[2.5]" />
          </div>
          <span className="sr-only text-sm font-semibold tracking-tight xl:not-sr-only">
            {t('nav.addTransaction')}
          </span>
        </Link>

        <nav aria-label={t('nav.primary')} className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="flex flex-col gap-5">
            {NAV_GROUPS.map((group) => (
              <div
                key={group.id}
                role="group"
                aria-labelledby={`nav-group-${group.id}`}
                className="flex flex-col gap-1 border-t border-border/60 pt-3 first:border-t-0 first:pt-0 xl:border-t-0 xl:pt-0"
              >
                <h2
                  id={`nav-group-${group.id}`}
                  className="sr-only px-2.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase xl:not-sr-only"
                >
                  {t(group.headerKey)}
                </h2>
                <ul className="flex flex-col gap-1">
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

        <div className="mt-4 flex flex-col gap-2 border-t border-border/70 pt-3">
          <div className="hidden items-center gap-2.5 rounded-lg px-2 py-1.5 xl:flex">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-bold text-brand ring-1 ring-brand/30">
              {userName ? userName.trim().charAt(0).toUpperCase() : 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-foreground">{userName}</p>
              <span className="block truncate text-[11px] text-muted-foreground">Tài khoản</span>
            </div>
          </div>
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
        'group relative flex h-9 items-center justify-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-all duration-150 xl:justify-start',
        active
          ? 'bg-brand/10 font-semibold text-brand shadow-xs dark:bg-brand/15 before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-1 before:rounded-r-full before:bg-brand'
          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'size-4 shrink-0 transition-transform duration-150 group-hover:scale-110',
          active ? 'text-brand stroke-[2.2]' : 'text-muted-foreground group-hover:text-foreground',
        )}
      />
      <span className="sr-only truncate xl:not-sr-only">{label}</span>
    </Link>
  )
}
