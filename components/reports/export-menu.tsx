'use client'

import { Menu } from '@base-ui/react/menu'
import { ChevronDown } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'

/**
 * The two export links as ONE secondary button (spec §6.8).
 *
 * Two side-by-side buttons ("Export this range (.xlsx)" and "Export all data
 * (.xlsx)") were the pre-flight finding: two secondary buttons of similar
 * weight beside a page title, one of which most users never want, competing
 * with the report itself. One menu, two items.
 *
 * The items are plain `<a href>`s, not `next/link`: the response is a file
 * download, not a route, so a client-side navigation is the wrong mechanism —
 * the same reasoning the page's header carried before.
 *
 * The `.xlsx` suffix is gone from the labels: the button says "Xuất Excel", so
 * repeating the extension in both items said the format three times. The
 * export itself — its sheet names, its columns, its cells — is untouched.
 */
export function ExportMenu({
  label,
  filteredHref,
  filteredLabel,
  fullHref,
  fullLabel,
}: {
  label: string
  /** `null` when no range resolved — there is nothing to export a filter of. */
  filteredHref: string | null
  filteredLabel: string
  fullHref: string
  fullLabel: string
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        className={buttonVariants({ variant: 'secondary', size: 'default' })}
      >
        {label}
        <ChevronDown aria-hidden="true" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="z-50 min-w-48 rounded-lg border border-border bg-surface-2 p-1 shadow-[0_8px_24px_rgba(25,33,30,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]">
            {filteredHref !== null && (
              <Menu.Item
                render={<a href={filteredHref} />}
                className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted"
              >
                {filteredLabel}
              </Menu.Item>
            )}
            <Menu.Item
              render={<a href={fullHref} />}
              className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted"
            >
              {fullLabel}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
