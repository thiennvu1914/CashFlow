'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { setReminderActiveAction } from '@/lib/server/actions/reminder-actions'
import { GENERIC_ERROR_KEY, REMINDER_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import type { ReminderDto } from '@/lib/ui/reminder-view-model'
import { InlineAlert } from '@/components/common/inline-alert'
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
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** Same shared in-flight lock as `OccurrenceActions` — spec §9. */
  const submit = useSubmitState()
  const label = t(reminder.active ? 'reminders.pauseAction' : 'reminders.resumeAction')

  async function toggle() {
    setError(null)
    await submit.run(async () => {
      try {
        const result = await setReminderActiveAction(reminder.id, !reminder.active)
        if (!result.ok) {
          setError(t(REMINDER_ERROR_KEYS[result.error]))
          return
        }
        router.refresh()
      } catch {
        console.error('ReminderToggle: set active failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Two reminders can share a title, but the button is rendered once per
          row and the title is what identifies the row to a screen reader — the
          action word is in the label too, so "Pause Internet bill" and "Resume
          Internet bill" are never the same name. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        // Height only: `size="sm"`'s 36 px is a mouse target, and spec §8
        // wants 44 px under a thumb — so this inline row action is 44 px
        // below the icon rail and the compact 36 px from `md` up.
        className="h-11 md:h-9"
        disabled={submit.locked}
        aria-label={`${label} ${reminder.title}`}
        onClick={toggle}
      >
        {label}
      </Button>
      {error && <InlineAlert tone="negative">{error}</InlineAlert>}
    </div>
  )
}
