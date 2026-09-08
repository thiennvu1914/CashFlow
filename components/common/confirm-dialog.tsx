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
            className={
              tone === 'negative' ? 'bg-negative text-white hover:bg-negative/90' : undefined
            }
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
