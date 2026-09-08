'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { MoreSheet } from './more-sheet'
import { ADD_TRANSACTION_HREF, MOBILE_TAB_ITEMS, isActiveNavItem, type NavItem } from './nav-items'

/**
 * The phone navigation (spec §5): a top bar carrying the wordmark and the
 * "Thêm" trigger, and a fixed bottom bar with five slots — two destinations, a
 * raised brand `+`, two more destinations.
 *
 * The "More" panel is now the shared `Sheet` primitive rather than the
 * hand-rolled disclosure this file used to contain. That disclosure wired
 * Escape, outside-pointer-down and `popstate` by hand and still had no focus
 * trap and no focus restoration — which is exactly what the spec requires and
 * what Base UI's Dialog gives for free.
 */
export function MobileTopBar() {
  const [open, setOpen] = useState(false)
  const t = useTranslations()

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface md:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="text-base font-semibold text-brand">
          {t('common.appName')}
        </Link>
        <button
          type="button"
          aria-label={t('nav.more')}
          onClick={() => setOpen(true)}
          className="flex h-11 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t('nav.more')}
        </button>
      </div>
      {/* Always mounted, `open`-driven: Base UI's Dialog needs to own the open
          transition to restore focus to the trigger, which a conditionally
          rendered panel cannot do. */}
      <MoreSheet open={open} onOpenChange={setOpen} />
    </header>
  )
}

/**
 * The bottom tab bar. Fixed, so it survives scrolling — which is why the shell
 * gives its content bottom padding: the bar must sit beside the page, never on
 * top of its last row. `env(safe-area-inset-bottom)` keeps the targets clear of
 * a home indicator.
 */
export function MobileTabBar() {
  const pathname = usePathname()
  const t = useTranslations()

  return (
    <nav
      // Distinct from the rail's name: a screen reader listing landmarks should
      // be able to tell the two navigations apart, and only one of them carries
      // the full set of destinations.
      aria-label={t('nav.compact')}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5 items-end">
        {MOBILE_TAB_ITEMS.slice(0, 2).map((item) => (
          <MobileTab key={item.href} item={item} pathname={pathname} />
        ))}
        <li className="flex justify-center">
          <Link
            href={ADD_TRANSACTION_HREF}
            aria-label={t('nav.addTransaction')}
            // Raised out of the bar and ringed in the bar's own colour rather
            // than lifted with a drop shadow — the same visual separation
            // without the glow this design system does not use. The ring is
            // `border-surface`, matching the bar it overlaps; `border-background`
            // drew a visible seam across it.
            className="-mt-5 flex size-13 items-center justify-center rounded-full border-4 border-surface bg-brand text-primary-foreground"
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

function MobileTab({ item, pathname }: { item: NavItem; pathname: string }) {
  const t = useTranslations()
  const active = isActiveNavItem(pathname, item.href)
  const Icon = item.icon
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        // `min-h-11` is the 44 px touch target (spec §8); no `truncate` on the
        // label, because the Vietnamese nav words were chosen to fit at 11 px
        // and an ellipsis on a tab label is a label that says nothing (spec §4).
        className={cn(
          'flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[0.6875rem]/[0.875rem]',
          active ? 'text-brand' : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
        <span>{t(item.labelKey)}</span>
      </Link>
    </li>
  )
}
