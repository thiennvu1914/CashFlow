'use client'

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from 'cn'
import {
  Dialog as DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'

/**
 * The side/bottom panel (spec §5, §6): a right-hand 480 px sheet from 640 up,
 * a bottom sheet below it. Used for every creation form except the
 * always-visible Transactions one, and for the mobile "More" navigation.
 *
 * Built on the same Base UI Dialog as `Dialog`, and for the same reason: the
 * focus trap, focus restoration, Escape and overlay dismissal are the whole
 * point of the primitive, and the spec requires all four. There are no swipe
 * gestures here and none are coming (spec §1 non-goals).
 *
 * Base UI API adaptation: same as `components/common/dialog.tsx` — the
 * generated `components/ui/dialog.tsx`'s root/portal/overlay/close/title/
 * description exports are reused (their few baked classes merge away cleanly
 * under `cn`), but its `DialogContent` (fixed `rounded-xl`, `bg-popover`,
 * centred-only position, and an internal `DialogOverlay` call that takes no
 * className) is not, so the panel itself is built on `DialogPrimitive.Popup`.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  closeLabel: string
  children: React.ReactNode
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        {/* See `components/common/dialog.tsx`'s equivalent comment:
            `supports-backdrop-filter:backdrop-blur-none` overrides the
            generated `DialogOverlay`'s `backdrop-blur-xs`
            (`components/ui/dialog.tsx:31`) so the scrim never reads as
            glassmorphism. */}
        <DialogOverlay className="bg-foreground/20 duration-150 supports-backdrop-filter:backdrop-blur-none dark:bg-black/50" />
        <DialogPrimitive.Popup
          className={cn(
            'fixed z-50 flex flex-col gap-4 border-border bg-surface-2 p-6 shadow-[0_8px_24px_rgba(25,33,30,0.10)] transition-transform duration-150 dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]',
            // `left-0 right-0` (not `inset-x-0`) for the same reason as
            // `components/common/dialog.tsx`: `cn` only lets a LATER
            // `inset-x`/`inset-y` remove an earlier `left`/`right`/`top`/
            // `bottom`, never the reverse. A first draft paired `sm:inset-y-0`
            // (meant to give the desktop panel a full-height top AND bottom)
            // with `sm:bottom-auto` (meant to cancel the mobile `bottom-0`) —
            // same conflict group, both `sm:`-scoped, `bottom-auto` written
            // later — which silently deleted `inset-y-0`'s bottom, and the
            // desktop panel shrank to its content height instead of filling
            // the viewport. `sm:bottom-auto` was redundant anyway: `inset-y-0`
            // already sets `bottom: 0`, matching the mobile value, so nothing
            // needs cancelling.
            'left-0 right-0 bottom-0 max-h-[85vh] w-full max-w-none overflow-y-auto rounded-none rounded-t-lg border-t',
            'sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[30rem] sm:max-w-full sm:rounded-none sm:border-t-0 sm:border-l',
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="text-[1.125rem]/[1.625rem] font-semibold">
                {title}
              </DialogTitle>
              {description && (
                <DialogDescription className="text-[0.8125rem]/[1.125rem]">
                  {description}
                </DialogDescription>
              )}
            </div>
            <DialogClose
              aria-label={closeLabel}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </DialogClose>
          </div>
          {children}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </DialogRoot>
  )
}
