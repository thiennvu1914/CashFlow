import type { OccurrenceStatus } from '@prisma/client'
import type ExcelJS from 'exceljs'
import { prisma } from '@/lib/prisma'
import { listReminders } from '@/lib/server/services/reminder'
import { REMINDER_TYPE_LABELS, recurrenceLabel } from '@/lib/ui/reminder-view-model'
import { DATE_FMT, DATE_TIME_FMT, localDateCell, moneyCell, moneyFmt, writeHeader } from './cells'
import type { ExportContext } from './sheet-registry'

/** One reminder's occurrences, tallied by what the user did about them. A fresh
 *  object per reminder, so no two rows can share (and overwrite) a tally. */
type OccurrenceTally = Record<OccurrenceStatus, number>

function emptyTally(): OccurrenceTally {
  return { PENDING: 0, ACKNOWLEDGED: 0, DISMISSED: 0 }
}

/**
 * The Reminders sheet — every recurring reminder and bill the user has set,
 * with how its occurrences have been answered (spec §4.7, §12).
 *
 * ## History is never omitted
 *
 * `listReminders` is the unfiltered read, so a *paused* reminder is on this sheet
 * with `Active` reading "No". Pausing stops new occurrences being materialized
 * and does nothing else — the reminder and everything it already produced stay
 * exactly as they are — so dropping it from the workbook would lose a bill the
 * user may still owe. Rows come out active first, then oldest first, the order
 * the Reminders page renders.
 *
 * ## Counts, not a second sheet
 *
 * `Pending`, `Acknowledged` and `Dismissed` are the tally of this reminder's
 * `ReminderOccurrence` rows. There is no Occurrences sheet in spec §12, and the
 * counts are what a reader actually asks of a definition ("have I been dealing
 * with this one?"); the individual due dates are lazily materialized rows whose
 * existence depends on when the app was last opened, which would make an
 * occurrence-level sheet a record of page visits as much as of bills.
 *
 * **Nothing is materialized here.** `materializeDueOccurrences` is deliberately
 * not called: an export is a read-only snapshot, and writing occurrence rows on
 * a download would mean the very act of exporting changed what the workbook
 * reports. So the counts are of the rows the app's own reads have already
 * created, and a reminder whose next occurrence has not been viewed yet counts
 * zero rather than a number invented here.
 *
 * ## Each reminder in its OWN currency
 *
 * `Expected amount` is denominated in `reminder.currency` with a format from
 * `moneyFmt(reminder.currency)` — never `ctx.displayCurrency` (ruling R5-3) —
 * and `ctx.fx` is not read at all. An expected amount is not a recorded one:
 * no reminder ever creates a Transaction, so there is nothing here that a rate
 * could honestly convert.
 *
 * ## `Start date` is an instant, unlike every other date on the Phase 6 sheets
 *
 * `RecurringReminder.startDate` stores the *instant of local midnight* on the
 * chosen day, not a calendar-date carrier, because every `dueAt` derived from it
 * is compared against `now` to decide what is overdue. So it goes through
 * `localDateCell(…, ctx.timezone)` — which reads the instant in the user's zone
 * and hands ExcelJS the day they picked — and is then formatted as a date only:
 * a start date names a day, and 00:00 next to it would be noise. Writing the
 * bare instant would show 1 March as 28 February for a user in
 * `Asia/Ho_Chi_Minh`.
 *
 * Two queries, whatever the user's history looks like: the reminders, and ONE
 * `groupBy` that tallies every occurrence of every reminder at once — never a
 * count per row.
 */
export async function buildRemindersSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const [reminders, tallies] = await Promise.all([
    listReminders(ctx.userId),
    prisma.reminderOccurrence.groupBy({
      by: ['reminderId', 'status'],
      where: { userId: ctx.userId },
      _count: { _all: true },
    }),
  ])

  const tallyByReminder = new Map<string, OccurrenceTally>()
  for (const row of tallies) {
    const tally = tallyByReminder.get(row.reminderId) ?? emptyTally()
    tally[row.status] = row._count._all
    tallyByReminder.set(row.reminderId, tally)
  }

  const sheet = workbook.addWorksheet('Reminders')

  writeHeader(sheet, [
    { header: 'Title', width: 28 },
    { header: 'Type', width: 10 },
    { header: 'Expected amount', width: 18 },
    { header: 'Currency', width: 10 },
    { header: 'Frequency', width: 16 },
    { header: 'Start date', width: 14 },
    { header: 'Active', width: 10 },
    { header: 'Pending', width: 10 },
    { header: 'Acknowledged', width: 14 },
    { header: 'Dismissed', width: 12 },
    { header: 'Category', width: 20 },
    { header: 'Account', width: 20 },
    { header: 'Note', width: 40 },
    { header: 'Created', width: 18 },
  ])

  for (const reminder of reminders) {
    // A reminder with no occurrences yet reads zero, never blank: "none have
    // come due" is a fact, and an empty cell would read as "not known".
    const tally = tallyByReminder.get(reminder.id) ?? emptyTally()

    const written = sheet.addRow([
      reminder.title,
      // "Bill" rather than "Expense": nothing here has been recorded yet.
      REMINDER_TYPE_LABELS[reminder.type],
      moneyCell(reminder.expectedAmount),
      reminder.currency,
      recurrenceLabel(reminder.frequency, reminder.interval),
      localDateCell(reminder.startDate, ctx.timezone),
      // Words, not TRUE/FALSE: a spreadsheet boolean reads as a formula result,
      // and "paused" is a state the user set.
      reminder.active ? 'Yes' : 'No',
      tally.PENDING,
      tally.ACKNOWLEDGED,
      tally.DISMISSED,
      // Both optional on a reminder, and the account is only where the user
      // *expects* to pay from — a label, never a link that debits anything.
      reminder.category?.name ?? '',
      reminder.account?.name ?? '',
      reminder.note ?? '',
      localDateCell(reminder.createdAt, ctx.timezone),
    ])
    // Formatted by the REMINDER's currency, not the user's display currency.
    written.getCell(3).numFmt = moneyFmt(reminder.currency)
    // The local *day* the reminder starts on — see the doc comment.
    written.getCell(6).numFmt = DATE_FMT
    written.getCell(14).numFmt = DATE_TIME_FMT
  }
}
