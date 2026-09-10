'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { LogoutButton } from '@/components/auth/logout-button'
import { Sheet } from '@/components/common/sheet'
import { MOBILE_MORE_ITEMS, isActiveNavItem } from './nav-items'

/**
 * The phone "Khác" ("More") panel (spec §5): the eight destinations the
 * bottom bar has no room for, as a two-column icon grid, plus Log out.
 *
 * A `Sheet` — so it closes by its own button, by Escape, by an overlay tap and
 * by a navigation, traps focus while open and hands focus back to the trigger
 * afterwards. No swipe gestures, now or later (spec §1 non-goals).
 *
 * A tap on a link also closes it explicitly: tapping the link for the page you
 * are already on changes no route, so nothing else would.
 */
export function MoreSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const pathname = usePathname()
  const t = useTranslations()

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('nav.moreSheetTitle')}
      closeLabel={t('common.close')}
    >
      {/* A `nav` landmark, with a name distinct from the rail's ("Điều hướng
          chính") and the bottom bar's ("Điều hướng nhanh") — Task 16, owner
          item G1: all three navigations are landmarks, and a screen reader
          listing them has to be able to tell them apart. Distinct from the
          sheet's own title too ("Tất cả mục"), which is the DIALOG's
          accessible name; two landmarks called the same thing inside one
          another is the confusion this avoids. */}
      <nav aria-label={t('nav.moreSheetNav')}>
        <ul className="grid grid-cols-2 gap-2">
          {MOBILE_MORE_ITEMS.map((item) => {
            const active = isActiveNavItem(pathname, item.href)
            const Icon = item.icon
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onOpenChange(false)}
                  className={cn(
                    'flex min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm',
                    active ? 'bg-muted text-brand' : 'text-foreground hover:bg-muted',
                  )}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  <span>{t(item.labelKey)}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="border-t border-border pt-4">
        <LogoutButton />
      </div>
    </Sheet>
  )
}
