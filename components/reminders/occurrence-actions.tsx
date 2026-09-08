'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  acknowledgeOccurrenceAction,
  dismissOccurrenceAction,
} from '@/lib/server/actions/reminder-actions'
import { GENERIC_ERROR_MESSAGE, REMINDER_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'
import { Button } from '@/components/ui/button'

/**
 * The user's answer to one due occurrence: "I have dealt with this"
 * (Acknowledge) or "this one does not apply" (Dismiss).
 *
 * Two buttons and no form, because there is nothing to type — and deliberately
 * two *distinct* answers rather than one "Done": the subscription that was
 * cancelled and the bill that was paid mean different things about the same due
 * date, and a history that conflated them would tell the user they paid
 * something they did not.
 *
 * Neither answer records a Transaction. Acknowledging a bill changes the
 * occurrence's status and `actionedAt` and nothing else (spec §4.7, directive
 * M) — whether the cash actually moved through a tracked account is a separate
 * fact the user records separately on `/transactions`, and no automatic rule
 * can tell the two apart. That is also why there is no confirmation dialog on
 * either: nothing is destroyed, no money moves, and the state is visible in the
 * history afterwards.
 *
 * Takes a whole `OccurrenceDto` — already strings and booleans only
 * (`lib/ui/reminder-view-model.ts` and its DTO-boundary case), because a
 * `Prisma.Decimal` or a `Date` cannot cross into this component.
 *
 * `Acknowledge` is `variant="outline"` and `Dismiss` is `variant="ghost"`: the
 * common answer is the one that gets a visible edge, and neither is a primary
 * call to action on a page that lists several rows.
 */
export function OccurrenceActions({ occurrence }: { occurrence: OccurrenceDto }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  /**
   * Both buttons, one handler.
   *
   * `pending` disables both while either is in flight — not to guard the write
   * (the service is idempotent and never flips one answer into the other, so a
   * double click is harmless) but so the row cannot be told two different
   * things at once and leave the user unsure which one landed.
   */
  async function answer(kind: 'acknowledge' | 'dismiss') {
    setError(null)
    setPending(true)
    try {
      const result =
        kind === 'acknowledge'
          ? await acknowledgeOccurrenceAction(occurrence.id)
          : await dismissOccurrenceAction(occurrence.id)
      if (!result.ok) {
        setError(REMINDER_ERROR_MESSAGES[result.error])
        return
      }
      // The answered occurrence leaves the pending list on the next render, so
      // the refresh *is* the confirmation.
      router.refresh()
    } catch {
      console.error(`OccurrenceActions: ${kind} failed`)
      setError(GENERIC_ERROR_MESSAGE)
    } finally {
      setPending(false)
    }
  }

  /**
   * The title alone is not unique: a monthly bill can have an unanswered
   * occurrence from last month *and* one due this month, both listed on this
   * page, so a label of "Acknowledge Internet bill" would name two different
   * buttons. The due date is what tells them apart — for a screen reader and
   * for a test.
   */
  const rowName = `${occurrence.title} due ${occurrence.dueDate}`

  return (
    <div className="flex w-full flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-label={`Acknowledge ${rowName}`}
          onClick={() => answer('acknowledge')}
        >
          Acknowledge
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-label={`Dismiss ${rowName}`}
          onClick={() => answer('dismiss')}
        >
          Dismiss
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </div>
  )
}
