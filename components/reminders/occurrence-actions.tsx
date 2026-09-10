'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  acknowledgeOccurrenceAction,
  dismissOccurrenceAction,
} from '@/lib/server/actions/reminder-actions'
import { REMINDER_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatDate } from '@/lib/ui/format-date'
import type { Locale } from '@/lib/i18n/locale'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'
import { InlineAlert } from '@/components/common/inline-alert'
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
 * Takes a whole `OccurrenceDto` — already strings, enums and booleans only
 * (`lib/ui/reminder-view-model.ts` and its DTO-boundary case), because a
 * `Prisma.Decimal` or a `Date` cannot cross into this component.
 *
 * `Acknowledge` is `variant="outline"` and `Dismiss` is `variant="ghost"`: the
 * common answer is the one that gets a visible edge, and neither is a primary
 * call to action on a page that lists several rows.
 */
export function OccurrenceActions({
  occurrence,
  locale,
  timeZone,
}: {
  occurrence: OccurrenceDto
  /** For the accessible name's date — must read the same as the row's own
   *  VISIBLE date (`OccurrenceList`'s `formatDate(..., 'date')`), not the
   *  `yyyy-MM-dd` carrier, which no sighted reader ever sees on the page. */
  locale: Locale
  timeZone: string
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** Spec §9: one in-flight lock shared by every row action (Acknowledge,
   *  Dismiss, Pause/Resume) — not to guard the write (the service is
   *  idempotent and never flips one answer into the other, so a double click
   *  is harmless) but so the row cannot be told two different things at once
   *  and leave the user unsure which one landed. */
  const submit = useActionSubmit(t)

  async function answer(kind: 'acknowledge' | 'dismiss') {
    await submit.run({
      // The one interpolated `tag` in the product, and safe: `kind` is a
      // two-value union declared right above, never user input — so the log
      // line stays a fixed string from a closed vocabulary.
      tag: `OccurrenceActions: ${kind} failed`,
      action: () =>
        kind === 'acknowledge'
          ? acknowledgeOccurrenceAction(occurrence.id)
          : dismissOccurrenceAction(occurrence.id),
      errorKeys: REMINDER_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      // The answered occurrence leaves the pending list on the next render, so
      // the refresh *is* the confirmation.
      onSuccess: () => router.refresh(),
    })
  }

  /**
   * The title alone is not unique: a monthly bill can have an unanswered
   * occurrence from last month *and* one due this month, both listed on this
   * page, so a label of "Acknowledge Internet bill" would name two different
   * buttons. The due date is what tells them apart — for a screen reader and
   * for a test. Collapsing (spec §6.7) makes this *more* true, not less: the
   * row the user sees names only the next occurrence, but every occurrence in
   * the disclosure gets its own pair of buttons from this same component, and
   * each of THOSE needs the same disambiguation.
   *
   * Formatted with `formatDate` (fix round 1, finding 5), not the bare
   * `yyyy-MM-dd` carrier: the row's own visible date is
   * `formatDate(occurrence.dueDate, { locale, timeZone, style: 'date' })`
   * (`OccurrenceList`), so the accessible name has to read the same string a
   * sighted user sees, not the internal carrier format nobody looks at.
   */
  const rowName = `${occurrence.title} · ${formatDate(occurrence.dueDate, { locale, timeZone, style: 'date' })}`

  return (
    // No `w-full` (fix round 1, finding 6): this root renders in two flex
    // contexts — `PlanningRow`'s `inlineAction` slot (full width there
    // already comes from ordinary block flow at `<sm`, and from the actions
    // cell's own sizing at `sm`+) and, nested inside the collapse
    // disclosure's `<li className="flex ... justify-between">`, as a flex
    // ITEM beside the date span. `w-full` there forced this flex item to
    // consume the whole row width and wrap onto its own line below the date
    // even at `sm`+, which is what this fixes: an unconstrained flex item
    // sizes to its own content, letting the date and the button pair share
    // one line whenever there is room.
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          // Height only: `size="sm"`'s 36 px is a mouse target, and spec §8
          // wants 44 px under a thumb — so this inline row action is 44 px
          // below the icon rail and the compact 36 px from `md` up.
          className="h-11 md:h-9"
          disabled={submit.locked}
          aria-label={`${t('reminders.acknowledgeAction')} ${rowName}`}
          onClick={() => answer('acknowledge')}
        >
          {t('reminders.acknowledgeAction')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // Height only: `size="sm"`'s 36 px is a mouse target, and spec §8
          // wants 44 px under a thumb — so this inline row action is 44 px
          // below the icon rail and the compact 36 px from `md` up.
          className="h-11 md:h-9"
          disabled={submit.locked}
          aria-label={`${t('reminders.dismissAction')} ${rowName}`}
          onClick={() => answer('dismiss')}
        >
          {t('reminders.dismissAction')}
        </Button>
      </div>
      {error && <InlineAlert tone="negative">{error}</InlineAlert>}
    </div>
  )
}
