'use client'

import { Menu } from '@base-ui/react/menu'
import { MoreHorizontal } from 'lucide-react'
import { cn } from 'cn'

/**
 * A row's `…` menu (spec §6): everything that is not the row's one primary
 * inline action.
 *
 * Base UI's Menu carries the keyboard contract — arrow keys, Home/End,
 * type-ahead, Escape, and focus back to the trigger — which is why this is not
 * a hand-rolled `useState` dropdown. The trigger is a 36×36 icon button with an
 * `aria-label` naming the row, so a page of ten of them does not present ten
 * buttons called "More". Below 640 (spec's Mobile expectation: "the menu
 * trigger's touch box is ≥ 44 px") the box itself grows to 44×44 — not an
 * invisible hit-area layered over a 36 px visual, because the row layouts that
 * host this (`FinancialListRow`, `PlanningRow`) give the actions cell a plain
 * `flex items-center` with no fixed cross-axis size, so a taller trigger just
 * grows the row to fit it like any other flex child, the same way the row
 * already accommodates a two-line title. From 640 up it returns to 36×36 to
 * match the Desktop expectation.
 *
 * Base UI API adaptation: `components/ui/dropdown-menu.tsx` (Task 1a) wraps
 * this same Base UI Menu, but its `DropdownMenuContent` sizes the popup to
 * `w-(--anchor-width)` — the trigger's own width, 36 px here, far narrower
 * than any action label — and highlights items via `focus:bg-accent` (the
 * saturated Muted Blue Task 1a's reviewer already flagged) rather than the
 * `data-highlighted` attribute Base UI's `Menu.Item` actually exposes
 * (confirmed at
 * `node_modules/@base-ui/react/menu/item/MenuItemDataAttributes.d.ts`), which
 * this file needs anyway to give a `tone="negative"` action its own colour
 * independent of the highlight state. So this is built directly on
 * `@base-ui/react/menu`'s parts, not the generated wrapper.
 */
export interface RowAction {
  id: string
  label: string
  onSelect: () => void
  tone?: 'default' | 'negative'
  disabled?: boolean
}

export function RowActionsMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:size-9"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="z-50 min-w-40 rounded-lg border border-border bg-surface-2 p-1 shadow-[0_8px_24px_rgba(25,33,30,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]">
            {actions.map((action) => (
              <Menu.Item
                key={action.id}
                disabled={action.disabled}
                onClick={action.onSelect}
                className={cn(
                  'flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-disabled:opacity-50',
                  action.tone === 'negative' ? 'text-negative' : 'text-foreground',
                )}
              >
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
