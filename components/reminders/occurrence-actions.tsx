'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  acknowledgeOccurrenceAction,
  dismissOccurrenceAction,
  payOccurrenceAction,
} from '@/lib/server/actions/reminder-actions'
import type { PayOccurrenceResult } from '@/lib/server/services/reminder'
import { REMINDER_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatDate } from '@/lib/ui/format-date'
import type { Locale } from '@/lib/i18n/locale'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { useAnnouncePaid } from './occurrence-paid-notice'

/**
 * The user's answer to one due occurrence: "Đã trả / Paid", "Chỉ đánh dấu /
 * Mark only", or "Bỏ qua / Dismiss" (money-source linking spec 2026-10-12 §2
 * Q6, §6.6).
 *
 * **Paid** is the answer that records the money. When the reminder names an
 * account and a category that can take the transaction, one tap records it —
 * its type, expected amount, category and account, on the due day — and the
 * page says so above the list with an Edit link (`OccurrencePaidNotice`; the
 * row itself leaves the list in the same response). When it cannot, nothing is
 * written and the user is taken to the Transactions page's create form,
 * pre-filled from the occurrence (`/transactions?occurrence=<id>#new` — only
 * the id travels; the page reads the rest on the server), and saving that form
 * marks the occurrence paid.
 *
 * **Mark only** is the old Acknowledge: the bill is dealt with and no
 * transaction is recorded here (paid from an untracked wallet, or recorded
 * already). **Dismiss**: this one does not apply. Distinct answers rather than
 * one "Done", because a cancelled subscription and a paid bill mean different
 * things about the same due date.
 *
 * No confirmation dialog on any of them: nothing is destroyed, and a Paid
 * transaction is an ordinary row the user can edit or delete (deleting it puts
 * the bill back on this list).
 *
 * Takes a whole `OccurrenceDto` — already strings, enums and booleans only
 * (`lib/ui/reminder-view-model.ts` and its DTO-boundary case), because a
 * `Prisma.Decimal` or a `Date` cannot cross into this component.
 *
 * Paid comes first and is `variant="outline"`, Mark only and Dismiss are
 * `variant="ghost"`: the row's main answer gets the visible edge, and none is
 * filled — the header's "Thêm nhắc nhở" is the page's one primary action, as
 * on every other list page (`DebtPaymentButton`'s reasoning).
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
  const t = useTranslations()
  const router = useRouter()
  const announcePaid = useAnnouncePaid()
  const [error, setError] = useState<string | null>(null)
  /** Spec §9: one in-flight lock shared by the row's three answers — so the
   *  row cannot be told two different things at once and leave the user
   *  unsure which one landed. (The services also refuse a second answer: Mark
   *  only and Dismiss never flip an answered occurrence, and Paid refuses one
   *  with `OCCURRENCE_NOT_PENDING` rather than record the bill twice.) */
  const submit = useActionSubmit(t)
  /** Which answer is in flight, for Paid's own "Đang ghi…" — `submit.pending`
   *  is shared by all three buttons. Paid is the slow one (a rate lookup and a
   *  locked write), and the only one whose label says what is happening. */
  const [paying, setPaying] = useState(false)

  async function pay() {
    // Read in `onSuccess`, after the action resolved `ok`: the hook reports
    // success and failure, and this is the one action whose success has two
    // outcomes.
    let outcome: PayOccurrenceResult | null = null
    setPaying(true)
    await submit.run({
      tag: 'OccurrenceActions: pay failed',
      action: async () => {
        const result = await payOccurrenceAction(occurrence.id)
        if (result.ok) outcome = result.data
        return result
      },
      errorKeys: REMINDER_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        if (outcome?.status === 'created') {
          announcePaid({ title: occurrence.title, transactionId: outcome.transactionId })
        } else if (outcome?.status === 'needs-form') {
          // `#new` opens the create sheet below `md` and focuses the inline
          // panel up to `xl` (`TransactionCreatePanelProvider`).
          router.push(`/transactions?occurrence=${encodeURIComponent(occurrence.id)}#new`)
        }
      },
    })
    // `run` never rejects, so this always runs.
    setPaying(false)
  }

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
      // The answered occurrence leaves the pending list when the action's own
      // response re-renders the route (it `revalidatePath`s), so that re-render
      // *is* the confirmation — no client-side refresh is needed.
    })
  }

  /**
   * The title alone is not unique: a monthly bill can have an unanswered
   * occurrence from last month *and* one due this month, both listed on this
   * page, so a label of "Paid Internet bill" would name two different
   * buttons. The due date is what tells them apart — for a screen reader and
   * for a test. Collapsing (spec §6.7) makes this *more* true, not less: the
   * row the user sees names only the next occurrence, but every occurrence in
   * the disclosure gets its own buttons from this same component, and
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
          aria-label={`${t('reminders.payAction')} ${rowName}`}
          onClick={pay}
        >
          {paying ? t('reminders.payPending') : t('reminders.payAction')}
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
