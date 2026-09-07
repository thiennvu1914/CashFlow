'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setReminderActiveAction } from '@/lib/server/actions/reminder-actions'
import { GENERIC_ERROR_MESSAGE, REMINDER_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import type { ReminderDto } from '@/lib/ui/reminder-view-model'
import { Button } from '@/components/ui/button'

/**
 * Pause or resume one reminder definition.
 *
 * A single button whose word states the *action*, not the state — the badge on
 * the row already says whether the reminder is active — so the two can never
 * read as a contradiction.
 *
 * Not a delete, and not offered as one: pausing stops new occurrences being
 * materialized and does nothing else. The occurrences the reminder already has
 * stay exactly as they are, because they really were due, and hiding them would
 * lose a bill the user still has to deal with. Resuming picks the schedule back
 * up from the current window, so a reminder paused for six months does not
 * flood them on the day it comes back — which is why there is no confirmation
 * dialog here: nothing is destroyed and the action is its own undo.
 */
export function ReminderToggle({ reminder }: { reminder: ReminderDto }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const label = reminder.active ? 'Pause' : 'Resume'

  async function toggle() {
    setError(null)
    setPending(true)
    try {
      const result = await setReminderActiveAction(reminder.id, !reminder.active)
      if (!result.ok) {
        setError(REMINDER_ERROR_MESSAGES[result.error])
        return
      }
      router.refresh()
    } catch {
      console.error('ReminderToggle: set active failed')
      setError(GENERIC_ERROR_MESSAGE)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Two reminders can share a title, but the button is rendered once per
          row and the title is what identifies the row to a screen reader — the
          action word is in the label too, so "Pause Internet bill" and "Resume
          Internet bill" are never the same name. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`${label} ${reminder.title}`}
        onClick={toggle}
      >
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </div>
  )
}
