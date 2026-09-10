'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from './dialog'

/**
 * The only destructive confirmation in the product (spec §10). It replaces
 * every `window.confirm` — a native dialog that cannot be styled, cannot be
 * translated, cannot be tested without a `page.once('dialog')` handler, and
 * says nothing about what the action actually does.
 *
 * The confirm button is the ONE place a solid `negative` fill is allowed
 * (spec §2); in a row, a destructive action is a ghost.
 *
 * `onConfirm` may be async: both buttons lock and the confirm button shows
 * `pendingLabel` until it settles, so a slow server action cannot be
 * double-submitted from here. The dialog closes on success and stays open on
 * failure, where the caller's own `InlineAlert` explains why.
 *
 * Initial focus (spec §7 a11y): `Dialog`'s footer renders Cancel before
 * Confirm, and Base UI's Dialog moves focus to the first tabbable element
 * inside the popup by default — here that is the header's close button,
 * ahead of both footer buttons, so a stray Enter on open can reach neither
 * Confirm nor Cancel. Verified in the browser (Task 1c Step 4): opening a
 * `ConfirmDialog` never lands focus on the destructive button.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  pendingLabel,
  tone = 'negative',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void | Promise<void>
  pendingLabel: string
  tone?: 'negative' | 'brand'
}) {
  const [pending, setPending] = useState(false)

  async function confirm() {
    setPending(true)
    try {
      await onConfirm()
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={pending}
            onClick={confirm}
            // The fill is overridden; the TEXT colour is not (Task 14 Step 3,
            // finding 2). This used to say `text-white`, which tailwind-merge
            // resolved over the `default` variant's own
            // `text-primary-foreground` — fine in light, where
            // `--primary-foreground` IS white, but in dark `--negative` is the
            // lighter salmon #D0807C and white on it measures 2.97:1, far
            // under the 4.5:1 text minimum (visibly washed out in the
            // Transactions delete and Accounts archive dialogs). Letting the
            // variant's `text-primary-foreground` stand gives #FFFFFF in light
            // — byte-identical to before — and the dark charcoal
            // `--background` in dark, which measures 5.80:1 on the same fill.
            className={tone === 'negative' ? 'bg-negative hover:bg-negative/90' : undefined}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
