'use client'

import { useEffect, useId, useRef, useState } from 'react'
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
 * The disclosure is a plain button and a conditionally rendered panel rather
 * than a popover primitive — a four-item menu does not want the focus trap and
 * scroll lock an overlay component brings. What it does need is every ordinary
 * way of dismissing a menu, and `MobileTopBar` wires all of them by hand.
 */

/** The top bar — wordmark on the left, the "More" disclosure on the right. */
export function MobileTopBar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  // The whole header, so a tap on the "More" button itself does not count as
  // "outside" and immediately re-close what it just opened.
  const headerRef = useRef<HTMLElement>(null)

  // Every dismissal that is not a click on a panel link. Registered only while
  // the menu is open, so a closed menu costs no document listeners: Escape (the
  // keyboard's universal "never mind"), a pointer down anywhere outside the
  // header, and any navigation at all — including a browser Back that no click
  // handler of ours would ever see.
  useEffect(() => {
    if (!open) return

    function close() {
      setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && headerRef.current?.contains(target)) return
      close()
    }

    // `popstate` covers Back/Forward; `pathname` in the dependency list covers
    // every other navigation, by tearing this effect down and re-running it
    // against a menu the render below has already been told to close.
    window.addEventListener('popstate', close)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('popstate', close)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open])

  // A route change closes the menu, whatever caused it. Written as a cleanup
  // rather than an effect body because a bare `setOpen(false)` during an effect
  // is a cascading render (and `react-hooks/set-state-in-effect` rejects it);
  // the cleanup runs precisely when `pathname` changes or the bar unmounts,
  // which is exactly the moment the menu should be gone.
  useEffect(() => {
    return () => setOpen(false)
  }, [pathname])

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-20 border-b border-border bg-surface md:hidden"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="text-base font-semibold text-brand">
          CashFlow
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label="More navigation"
          onClick={() => setOpen((wasOpen) => !wasOpen)}
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
            {MOBILE_MORE_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = isActiveNavItem(pathname, href)
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    // Closed on click as well as on the route change, because
                    // tapping the link for the page you are already on changes
                    // no route and would otherwise leave the menu hanging open.
                    onClick={() => setOpen(false)}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-2 text-sm',
                      active ? 'bg-muted text-brand' : 'text-foreground hover:bg-muted',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {label}
                  </Link>
                </li>
              )
            })}
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
      // Distinct from the rail's "Primary": a screen reader listing landmarks
      // should be able to tell the two navigations apart, and only one of them
      // carries the full set of destinations.
      aria-label="Primary (compact)"
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
            // Raised out of the bar and ringed in the bar's own colour rather
            // than lifted with a drop shadow — the same visual separation
            // without the glow this design system does not use. The ring is
            // `border-surface`, matching the bar it overlaps; `border-background`
            // drew a visible seam across it.
            className="-mt-5 flex size-13 items-center justify-center rounded-full border-4 border-surface bg-brand text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
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
