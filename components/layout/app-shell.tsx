'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { cn } from 'cn'
import { LogoutButton } from '@/components/auth/logout-button'
import { buttonVariants } from '@/components/ui/button'
import { MobileTabBar, MobileTopBar } from './mobile-nav'
import { ADD_TRANSACTION_HREF, NAV_ITEMS, isActiveNavItem } from './nav-items'

/**
 * The frame every signed-in page renders inside.
 *
 * Two distinct navigations rather than one responsive one: a persistent rail on
 * desktop, where the horizontal space exists and a stable list of destinations
 * is worth keeping visible, and a four-tab bottom bar on phones, where it is
 * not. The mobile bar is not the rail with items hidden — it is a shorter,
 * thumb-reachable list with the remainder behind "More" (see `nav-items.ts`).
 *
 * A client component only because the active item depends on `usePathname`.
 * It renders `children` untouched, so every page underneath stays a server
 * component and no page data crosses the boundary through here.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      {/* Desktop rail. `sticky h-screen` keeps it in place while the page
          scrolls without taking the content out of normal flow. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <Link
          href="/dashboard"
          className="px-2 py-1 text-lg font-semibold tracking-tight text-brand"
        >
          CashFlow
        </Link>

        <Link
          href={ADD_TRANSACTION_HREF}
          aria-label="Add transaction"
          className={cn(buttonVariants({ size: 'lg' }), 'mt-6 w-full justify-start gap-2')}
        >
          <Plus aria-hidden="true" className="size-4" />
          Add transaction
        </Link>

        <nav aria-label="Primary" className="mt-6 min-h-0 flex-1 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = isActiveNavItem(pathname, href)
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2 py-2 text-sm',
                      // A muted wash plus brand text, not a filled brand pill:
                      // the active row should read as "you are here", not as a
                      // second call to action competing with Add transaction.
                      active
                        ? 'bg-muted font-medium text-brand'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="mt-4 border-t border-border pt-4">
          <LogoutButton />
        </div>
      </aside>

      <MobileTopBar />

      {/* `min-w-0` stops a wide child (a chart, a table) from forcing the flex
          row wider than the viewport; `pb-24` reserves the space the fixed
          mobile tab bar occupies so it never covers the last row of content. */}
      <main className="min-w-0 flex-1 pb-24 md:pb-0">{children}</main>

      <MobileTabBar />
    </div>
  )
}
