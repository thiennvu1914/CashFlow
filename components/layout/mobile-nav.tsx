'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown, Plus } from 'lucide-react'
import { cn } from 'cn'
import { LogoutButton } from '@/components/auth/logout-button'
import {
  ADD_TRANSACTION_HREF,
  MOBILE_MORE_ITEMS,
  MOBILE_TAB_ITEMS,
  isActiveNavItem,
} from './nav-items'

/**
 * The phone navigation: a top bar carrying the wordmark and a "More"
 * disclosure, and a fixed bottom tab bar with the four primary destinations
 * around a raised "Add transaction" action.
 *
 * The disclosure is a plain button and a conditionally rendered panel, not a
 * popover primitive: it needs `aria-expanded`, an outside-tap dismissal and
 * nothing else, and a Radix-style overlay would bring focus trapping and a
 * scroll lock that a four-item menu does not want.
 */

/** The top bar — wordmark on the left, the "More" disclosure on the right. */
export function MobileTopBar() {
  const pathname = usePathname()
  // The route the menu was opened on, rather than a plain boolean. Navigating
  // within the app is a client-side transition that leaves this component
  // mounted, so a boolean would leave the menu hanging open over the page the
  // user just asked for. Deriving `open` from the current pathname closes it on
  // arrival with no effect and no extra render.
  const [openedOn, setOpenedOn] = useState<string | null>(null)
  const open = openedOn === pathname
  const panelId = useId()

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface md:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="text-base font-semibold text-brand">
          CashFlow
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label="More navigation"
          onClick={() => setOpenedOn(open ? null : pathname)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          More
          <ChevronDown
            aria-hidden="true"
            className={cn('size-4 transition-transform', open && 'rotate-180')}
          />
        </button>
      </div>
      {open && (
        <div id={panelId} className="border-t border-border px-4 py-2">
          <ul className="flex flex-col">
            {MOBILE_MORE_ITEMS.map(({ href, label, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={isActiveNavItem(pathname, href) ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-2 text-sm',
                    isActiveNavItem(pathname, href)
                      ? 'bg-muted text-brand'
                      : 'text-foreground hover:bg-muted',
                  )}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-border pt-2">
            <LogoutButton />
          </div>
        </div>
      )}
    </header>
  )
}

/**
 * The bottom tab bar. Fixed, so it survives scrolling, which is why the shell
 * gives its content `pb-24` — the bar must sit beside the page, never on top of
 * its last row. The extra `env(safe-area-inset-bottom)` keeps the targets clear
 * of a home indicator.
 */
export function MobileTabBar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5 items-end">
        {MOBILE_TAB_ITEMS.slice(0, 2).map((item) => (
          <MobileTab key={item.href} item={item} pathname={pathname} />
        ))}
        <li className="flex justify-center">
          <Link
            href={ADD_TRANSACTION_HREF}
            aria-label="Add transaction"
            // Raised out of the bar and ringed in the page background rather
            // than lifted with a drop shadow — the same visual separation
            // without the glow this design system does not use.
            className="-mt-5 flex size-13 items-center justify-center rounded-full border-4 border-background bg-brand text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Plus aria-hidden="true" className="size-6" />
          </Link>
        </li>
        {MOBILE_TAB_ITEMS.slice(2).map((item) => (
          <MobileTab key={item.href} item={item} pathname={pathname} />
        ))}
      </ul>
    </nav>
  )
}

function MobileTab({
  item,
  pathname,
}: {
  item: (typeof MOBILE_TAB_ITEMS)[number]
  pathname: string
}) {
  const { href, label, icon: Icon } = item
  const active = isActiveNavItem(pathname, href)
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex flex-col items-center gap-0.5 px-1 py-2 text-[0.7rem]',
          active ? 'text-brand' : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  )
}
