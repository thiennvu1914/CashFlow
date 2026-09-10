'use client'

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
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
 * The app's modal (spec §2, §7, §8).
 *
 * Base UI's Dialog gives most of the accessibility contract — `role`, the
 * focus trap, focus restoration to the opener, Escape and overlay dismissal,
 * all four re-verified in the browser by Task 16 — but NOT `aria-modal`, which
 * this comment used to claim it did: Base UI sets no `aria-modal` and marks
 * nothing outside the popup `inert`, so the page behind stayed readable to a
 * screen reader's virtual cursor. This file supplies it (see the popup below)
 * and adds CashFlow's surface: `--surface-2`, the one soft shadow the design
 * system allows, radius 10, and the below-640 behaviour the spec asks for (a
 * dialog becomes a bottom sheet).
 *
 * `aria-labelledby` is wired by rendering the title through
 * `DialogTitle`, and the description through `DialogDescription`, rather
 * than by hand-written ids that a later edit could unpick.
 *
 * Base UI API adaptation: `components/ui/dialog.tsx` (Task 1a) already
 * exports `Dialog`/`DialogPortal`/`DialogOverlay`/`DialogClose`/`DialogTitle`/
 * `DialogDescription` over this same Base UI primitive, and those are reused
 * here rather than reaching into `@base-ui/react/dialog` a second time for
 * anything but the bare `Popup`. `DialogOverlay`, `DialogClose`, `DialogTitle`
 * and `DialogDescription` carry no class that fights CashFlow's tokens (their
 * few defaults — `bg-black/10`, `text-base`, `text-sm` — merge away cleanly
 * under `cn`'s tailwind-merge semantics once this file's own classes are
 * appended). `DialogContent`, the file's other export, is NOT reused: it
 * bakes `rounded-xl` (12px — over this design system's 10px radius cap),
 * `bg-popover` and a fixed centred-only position into one non-overridable
 * bundle (its own internal `DialogOverlay` call takes no className at all),
 * which cannot express the spec's mobile-bottom-sheet / desktop-centred-card
 * responsive split. So the popup surface itself is built directly on
 * `DialogPrimitive.Popup` — still Base UI's Dialog, not hand-copied Radix.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  /**
   * The close button's accessible name. Optional: it defaults to
   * `common.close` (Task 2b), and a caller only needs to pass its own label
   * when re-announcing the dialog's title reads better than the generic word
   * — every existing caller keeps working unchanged.
   */
  closeLabel?: string
}) {
  const t = useTranslations('common')
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        {/* `supports-backdrop-filter:backdrop-blur-none` overrides the
            generated `DialogOverlay`'s `backdrop-blur-xs` (`components/ui/
            dialog.tsx:31`) — a blurred scrim reads as glassmorphism, which the
            design system forbids. `cn`'s tailwind-merge-style dedupe treats
            same-modifier `backdrop-blur-*` utilities as one conflict group
            (verified: the later value replaces the earlier one here), so this
            reliably removes the blur without touching the generated file. */}
        <DialogOverlay className="bg-foreground/20 duration-150 supports-backdrop-filter:backdrop-blur-none dark:bg-black/50" />
        {/* `aria-modal="true"` (Task 16, owner item G3). Base UI gives the
            focus trap, focus restoration, Escape and overlay dismissal — all
            four verified in the browser — but it marks NOTHING outside the
            popup: the page behind an open dialog carries no `inert` and no
            `aria-hidden`, so a screen reader's virtual cursor could still
            read and operate the whole page underneath while the modal was
            open. `aria-modal` is the attribute that confines it, and APG asks
            for exactly one of the two. It is set here rather than passed to
            `DialogRoot` because Base UI's `modal` prop governs pointer and
            scroll locking, not this. */}
        <DialogPrimitive.Popup
          aria-modal="true"
          className={cn(
            'fixed z-50 flex flex-col gap-4 border border-border bg-surface-2 p-6 shadow-[0_8px_24px_rgba(25,33,30,0.10)] transition-transform duration-150 dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]',
            // Below 640 it is a bottom sheet (spec §7); from 640 up, a centred
            // card at most 480 px wide.
            //
            // `left-0 right-0` here (not the `inset-x-0` shorthand) is
            // deliberate: `cn`'s tailwind-merge-style conflict resolution
            // treats `inset-x` and `left`/`right` as the SAME conflict group,
            // and — verified empirically — only lets a LATER `inset-x-*`
            // remove an earlier `left-*`, never the reverse. With `inset-x-0`
            // as the base and `sm:left-1/2` meant to re-center at the sm
            // breakpoint, an accompanying `sm:inset-x-auto` (to cancel the
            // base at that breakpoint) silently deleted `sm:left-1/2` from
            // the class list — the popup rendered flush against the left
            // edge, half off-screen, at every desktop width. Spelling both
            // sides out avoids the shorthand/longhand collision entirely.
            'left-0 right-0 bottom-0 max-h-[85vh] w-full max-w-none overflow-y-auto rounded-none rounded-t-lg',
            'sm:top-1/2 sm:left-1/2 sm:right-auto sm:bottom-auto sm:w-[30rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg',
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
            {/* `max-md:size-11` is the 44 px touch target below the icon
                rail (routed from Task 15, which measured this button at
                36 x 36 and deferred it as outside its enumerated set). It is
                the only VISIBLE way to close a sheet on a phone — Escape
                needs a keyboard and an overlay tap has no affordance — so it
                gets the box. Padding on the existing element, no new prop,
                and 36 x 36 from `md` up, where a pointer is doing the
                clicking. */}
            <DialogClose
              aria-label={closeLabel ?? t('close')}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground max-md:size-11"
            >
              <X aria-hidden="true" className="size-4" />
            </DialogClose>
          </div>
          {children}
          {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </DialogRoot>
  )
}
