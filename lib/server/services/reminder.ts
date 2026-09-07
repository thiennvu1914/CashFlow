import { Prisma } from '@prisma/client'
import type { OccurrenceStatus } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { computeDueDates, oneIntervalBefore, type RecurrenceRule } from './recurrence'
import { createReminderSchema, type CreateReminderInput } from '@/lib/validation/reminder'

/**
 * Recurring reminder service (spec §4.7) — the bills and expected income a user
 * wants to be told about, and the individual due instances they act on.
 *
 * Five invariants live here and are never delegated to the UI:
 *
 * 1. **A reminder is NOT a Transaction** (directive M). Nothing in this file
 *    creates a Transaction or a Transfer, reads or writes a FinancialAccount, or
 *    changes a balance — it imports none of `transaction.ts`, `transfer.ts`,
 *    `balance.ts` or `financial-account.ts`, and `reminder.test.ts` proves the
 *    absence twice over: structurally (no such import specifier appears in this
 *    source) and behaviourally (the account/transaction/transfer counts, the
 *    seeded rows and the derived balance are re-asserted after *every* case).
 *    A reminder is a note about money the user expects to move; whether it
 *    actually moved is a separate fact they record separately, and no automatic
 *    rule can tell the two apart. `accountId` is which account they *expect* to
 *    pay from — a label, not a link that debits anything.
 * 2. **Occurrences are materialized lazily on read, with no cron.** Reading the
 *    upcoming list computes each active reminder's due dates for a window around
 *    today and inserts the missing rows. There is no background job in this
 *    project at all, so a reminder that has never been looked at has no rows —
 *    and looking at it is exactly when its rows are needed.
 * 3. **Materialization is idempotent, and the database is what makes it so.**
 *    `createMany({ skipDuplicates: true })` over `@@unique([reminderId, dueAt])`
 *    is the whole mechanism: there is no "which of these already exist?" query,
 *    because any such check would be a read-then-write with a window between the
 *    two that two simultaneous page loads would both walk through. The unique
 *    index has no window. `reminder.test.ts` proves it with three genuinely
 *    concurrent reads against the real database.
 * 4. **Nothing here ever updates an existing occurrence.** Materialization only
 *    inserts, so an ACKNOWLEDGED or DISMISSED row can never be resurrected as
 *    PENDING by a later read — the property that makes "I have dealt with this"
 *    stick. The only writes to an existing row are `acknowledgeOccurrence` and
 *    `dismissOccurrence`, which change the status and `actionedAt` and nothing
 *    else.
 * 5. **Money is `Prisma.Decimal` end to end.** `expectedAmount` is built with
 *    `new Prisma.Decimal(String(...))` so a 2-decimal input is exact, and there
 *    is no `toNumber()` anywhere in this file. Each reminder keeps its own
 *    currency and nothing here converts one (`User.baseCurrency` is display-only,
 *    ledger ruling R5-3), so there is no FX import at all.
 *
 * ## Timezone: the one thing this service exists to get right
 *
 * "Rent is due on the 1st" means the 1st *where the user lives*. So every
 * `startDate` and every `dueAt` is the instant of **local midnight** in
 * `User.timezone` on the day in question — 17:00Z of the previous UTC day for
 * `Asia/Ho_Chi_Minh`, 05:00Z or 04:00Z for `America/New_York` depending on the
 * season — and the recurrence arithmetic itself happens on timezone-blind
 * *calendar date carriers* (`lib/server/services/recurrence.ts`,
 * `lib/datetime/calendar-date.ts`).
 *
 * This module is therefore the only place the user's zone enters, and it does so
 * at exactly two functions: `toLocalCalendarCarrier` on the way in and
 * `localCarrierToInstant` on the way out. Everything between them is pure
 * calendar arithmetic. The host's own zone is never read — no `new Date(y, m, d)`
 * and no local getter appears in this file, and `reminder.test.ts` asserts that
 * from the source — because a service that used it would pass every test on a
 * `TZ=UTC` CI box and ship the wrong day to half the world.
 *
 * `now` is injectable on every function that needs it, so none of this depends
 * on the clock: the tests pin a single instant and assert real UTC values
 * against it.
 *
 * ## No transaction, and no lock
 *
 * Materialization deliberately runs *outside* any interactive transaction. It is
 * one read followed by up to one insert per reminder, each insert atomic and
 * self-idempotent, and wrapping the lot in a transaction would hold a pooled
 * connection for the whole of a page render's worth of round trips to protect an
 * invariant the unique index already protects (the reasoning `account-lock.ts`
 * sets out at length). Nor is there a row lock anywhere: no invariant here spans
 * rows. The one write that reads first — acknowledge/dismiss — is idempotent by
 * construction, and its worst race is the user's own two clicks arriving
 * together, where either outcome is a state they asked for.
 */

/** Milliseconds in a day — exact in UTC, where no DST shift can shorten one.
 *  Only ever added to a *carrier*, never to an instant. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * How far ahead materialization looks (spec §4.7).
 *
 * Thirty days is what makes the list useful without making it a calendar: the
 * user sees this month's bills and the start of next month's, which is the
 * horizon a personal budget is actually planned over. Exported because Group 7's
 * page and Group 8's dashboard widget both describe the window to the user, and
 * two different numbers in two places would be a lie in one of them.
 */
export const OCCURRENCE_LOOKAHEAD_DAYS = 30

/** How many occurrences the history view loads when no caller says otherwise. A
 *  weekly reminder produces 52 rows a year, so an unbounded history is a page
 *  that gets slower every month it is used. */
const DEFAULT_OCCURRENCE_HISTORY_LIMIT = 200

/** The most any caller may ask for, clamped rather than trusted so no caller can
 *  opt out of the bound. */
const MAX_OCCURRENCE_HISTORY_LIMIT = 500

/**
 * Thrown when a reminder's category is not the user's own, or does not match the
 * reminder's type.
 *
 * One class for both, deliberately: "no such category", "not your category" and
 * "wrong type of category" must be indistinguishable from outside, or the error
 * itself becomes an oracle for which category ids exist. The `reason` is for the
 * server log and the developer, and the action layer maps the class — not the
 * message — to the sentence the user sees.
 */
export class InvalidReminderCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid reminder category: ${reason}`)
    this.name = 'InvalidReminderCategoryError'
  }
}

/**
 * Thrown when a reminder's account is not the user's own, or is not ACTIVE.
 *
 * Checked at creation only. Archiving an account later does *not* invalidate the
 * reminders that name it — the same rule `transaction.ts` applies to categories:
 * retiring an account must not freeze the records already filed against it.
 */
export class InvalidReminderAccountError extends Error {
  constructor(reason: string) {
    super(`Invalid reminder account: ${reason}`)
    this.name = 'InvalidReminderAccountError'
  }
}

/**
 * The two labels every reminder read carries.
 *
 * Projected to `name` alone rather than `include: { category: true }`: the UI
 * shows a name, and a full join would ship the category's `userId`, `status` and
 * `isDefault` — and the account's `initialBalance` — to a client component that
 * has no use for any of them.
 */
const REMINDER_LABELS = {
  category: { select: { name: true } },
  account: { select: { name: true } },
} satisfies Prisma.RecurringReminderInclude

/**
 * The one include every occurrence read uses.
 *
 * The reminder always travels with its occurrence, and its labels with it,
 * because an occurrence on its own is unreadable — "something is due on the 1st"
 * is not a reminder. Group 7's list and Group 8's dashboard widget therefore
 * render a row from one query, with no follow-up read per row.
 */
const OCCURRENCE_INCLUDE = {
  reminder: { include: REMINDER_LABELS },
} satisfies Prisma.ReminderOccurrenceInclude

/**
 * A reminder with the names of its optional category and account. Written as a
 * `GetPayload` so a later phase that widens the include widens every caller with
 * it, rather than silently not seeing the new relation.
 */
export type ReminderRow = Prisma.RecurringReminderGetPayload<{
  include: { category: { select: { name: true } }; account: { select: { name: true } } }
}>

/** One due instance with the reminder it belongs to, labels included. */
export type OccurrenceRow = Prisma.ReminderOccurrenceGetPayload<{
  include: {
    reminder: {
      include: { category: { select: { name: true } }; account: { select: { name: true } } }
    }
  }
}>

/**
 * Soonest first — and because every overdue occurrence has a `dueAt` in the
 * past, that puts the ones the user is late for at the top by construction
 * rather than by a second sort.
 *
 * `id` breaks the tie so the order is total: two reminders can fall due on the
 * same local midnight, and without the tie-break the same list could render in
 * one order on one request and another on the next.
 */
const UPCOMING_ORDER = [
  { dueAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.ReminderOccurrenceOrderByWithRelationInput[]

/** Newest first — the order a history reads in, and the opposite of the upcoming
 *  list for the opposite reason: there, the next thing to do comes first; here,
 *  the most recent thing done. */
const HISTORY_ORDER = [
  { dueAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.ReminderOccurrenceOrderByWithRelationInput[]

/**
 * An instant read as the calendar day it falls on in `timezone`, as a
 * UTC-midnight carrier.
 *
 * Goes through `formatInTimeZone(instant, timezone, 'yyyy-MM-dd')` rather than
 * `toZonedTime(...)` plus local getters, and that is the whole point: the getter
 * route builds an intermediate `Date` whose *host-local* components are the
 * target zone's wall clock, so reading them back depends on the host's own zone
 * being able to represent that wall clock — which it cannot during its own DST
 * gap. Formatting to a string and parsing it as a carrier has no such
 * intermediate and no host-zone involvement at all: `TZ` may be anything.
 *
 * `calendarDateToUtcCarrier` does the parse, so a carrier built here is the same
 * kind of value as one built from a user's `<input type="date">` — one
 * definition of "a calendar day", not two.
 */
export function toLocalCalendarCarrier(instant: Date, timezone: string): Date {
  return calendarDateToUtcCarrier(formatInTimeZone(instant, timezone, 'yyyy-MM-dd'))
}

/**
 * The inverse: the instant at which that calendar day *starts* in `timezone`.
 *
 * `fromZonedTime` is handed the day as a `yyyy-MM-ddT00:00:00` **string**, not a
 * `Date`. Passing a `Date` would make it a wall-clock reading of the host's zone
 * (`fromZonedTime(new Date(2026, 0, 1), tz)` means "1 January as this server
 * sees it"), so the stored instant would depend on where the server runs. The
 * string form is unambiguous.
 *
 * DST is handled by `date-fns-tz` and not papered over here: in the rare zones
 * that shift *at* midnight, a local midnight that does not exist resolves
 * forward to 01:00, the way every calendar application does — see the reasoning
 * in `lib/datetime/local-date-time.ts`. Two consecutive local days can never map
 * to the same instant, so `@@unique([reminderId, dueAt])` stays an honest key
 * either way.
 */
export function localCarrierToInstant(carrier: Date, timezone: string): Date {
  return fromZonedTime(`${formatCalendarDate(carrier)}T00:00:00`, timezone)
}

/** The later of two carriers. */
function maxCarrier(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}

/**
 * Which anchors a frequency actually gives meaning to, defaulted from the local
 * start day where the user did not name one.
 *
 * The defaults are what make "monthly from the 20th" mean what it looks like: a
 * user who picks a start date and Monthly has already said which day of the
 * month they mean, and asking them to repeat it in a second field would be a
 * form that can contradict itself. YEARLY takes both, for the same reason.
 *
 * WEEKLY and ONE_TIME store NULL for both. Neither has a day of the month to
 * hold on to, so a stored value would be a number nothing reads — and the row
 * would then disagree with the `RecurringReminder_dayOfMonth_range` /
 * `_month_range` CHECKs' intent that these are NULL exactly when they are
 * meaningless. `month` is NULL for MONTHLY too: every month is a candidate for a
 * monthly reminder, so there is no anchor month to record even if the client
 * sent one.
 *
 * Read with `getUTCDate` / `getUTCMonth` because the argument is a *carrier*,
 * whose UTC components are the calendar date; a local getter here would be the
 * bug, not the fix. `+ 1` on the month because the column stores the human 1–12
 * and JavaScript counts from 0 — an off-by-one that would move every yearly
 * reminder back a month.
 */
function resolveAnchors(
  frequency: CreateReminderInput['frequency'],
  dayOfMonth: number | undefined,
  month: number | undefined,
  startCarrier: Date,
): { dayOfMonth: number | null; month: number | null } {
  switch (frequency) {
    case 'MONTHLY':
      return { dayOfMonth: dayOfMonth ?? startCarrier.getUTCDate(), month: null }
    case 'YEARLY':
      return {
        dayOfMonth: dayOfMonth ?? startCarrier.getUTCDate(),
        month: month ?? startCarrier.getUTCMonth() + 1,
      }
    case 'WEEKLY':
    case 'ONE_TIME':
      return { dayOfMonth: null, month: null }
  }
}

/**
 * Records a new reminder, active, with no occurrences.
 *
 * Fields are listed explicitly rather than spread, so the authenticated `userId`
 * can never be overridden regardless of Zod's stripping behaviour and a
 * client-supplied `active` is ignored rather than obeyed — a new reminder is
 * active, and only `setReminderActive` changes that.
 *
 * `timezone` is a parameter rather than read from the `User` row here: the
 * action layer already has `resolveProfileDefaults(user).timezone`, and taking
 * it explicitly keeps this service free of an assumption about whose request it
 * is serving (the convention `lib/datetime/local-date-time.ts` sets out).
 *
 * The category and account lookups run together in one round trip and are
 * *checked* in a fixed order afterwards, so the error a caller gets does not
 * depend on which query happened to resolve first. Both are skipped entirely
 * when the field is absent, which is the common case.
 *
 * Nothing is materialized here. A reminder created for next January should not
 * write a row until something asks to see it, and a reminder created for
 * *yesterday* gets its occurrence on the very next read — so there is nothing an
 * eager insert here would add except a second code path doing the same work.
 */
export async function createReminder(
  userId: string,
  timezone: string,
  input: CreateReminderInput,
): Promise<ReminderRow> {
  const parsed = createReminderSchema.parse(input)
  // The day the user picked, as a carrier — then the instant that day starts in
  // their own zone. Never `localDateTimeToInstant`: a start date has no time of
  // day, it names a day (ruling R6-7).
  const startCarrier = calendarDateToUtcCarrier(parsed.startDate)
  const startDate = localCarrierToInstant(startCarrier, timezone)

  const [category, account] = await Promise.all([
    parsed.categoryId
      ? // `userId_id`, the composite key, is what makes another user's category
        // id resolve to nothing rather than to a usable reference.
        prisma.category.findUnique({ where: { userId_id: { userId, id: parsed.categoryId } } })
      : null,
    parsed.accountId
      ? prisma.financialAccount.findUnique({
          where: { userId_id: { userId, id: parsed.accountId } },
        })
      : null,
  ])

  if (parsed.categoryId) {
    if (!category) throw new InvalidReminderCategoryError('category not found')
    // The type match is the rule that stops a salary reminder being filed under
    // Groceries: `ReminderType` and `CategoryType` share their members exactly
    // so this is a direct comparison.
    if (category.type !== parsed.type) {
      throw new InvalidReminderCategoryError(
        `expected a ${parsed.type} category, got ${category.type}`,
      )
    }
  }
  if (parsed.accountId) {
    if (!account) throw new InvalidReminderAccountError('account not found')
    // ACTIVE at creation: pointing a *new* reminder at an account the user has
    // retired is a mistake worth catching, even though an existing reminder
    // survives its account being archived.
    if (account.status !== 'ACTIVE') throw new InvalidReminderAccountError('account is archived')
  }

  const anchors = resolveAnchors(parsed.frequency, parsed.dayOfMonth, parsed.month, startCarrier)

  return prisma.recurringReminder.create({
    data: {
      userId,
      title: parsed.title,
      type: parsed.type,
      // `String()` first: that is the exact representation
      // `lib/validation/money.ts` inspected when it accepted the value as
      // having at most 2 decimal places (and the one the pg adapter
      // serialises), so what is stored is precisely what was validated —
      // rather than whatever the Decimal constructor makes of a raw double.
      expectedAmount: new Prisma.Decimal(String(parsed.expectedAmount)),
      currency: parsed.currency,
      categoryId: parsed.categoryId ?? null,
      accountId: parsed.accountId ?? null,
      frequency: parsed.frequency,
      interval: parsed.interval,
      dayOfMonth: anchors.dayOfMonth,
      month: anchors.month,
      startDate,
      note: parsed.note ?? null,
    },
    include: REMINDER_LABELS,
  })
}

/**
 * Every reminder the user has, paused ones included, active first and then
 * oldest first.
 *
 * Ordered in SQL rather than in memory — unlike `debt.ts` and `loan.ts`, which
 * sort their status ranks by hand. Their reason does not apply here: `active` is
 * a boolean, and `desc` on a boolean is unambiguously true-before-false, whereas
 * `orderBy` on an *enum* would order by its declaration order in Postgres and so
 * make the page's display order an invisible consequence of how the enum happens
 * to be written.
 *
 * Unbounded by design, like `listDebts` and `listLoans`: a cap on a user's
 * complete list of reminders is silent data loss rather than a safeguard.
 */
export async function listReminders(userId: string): Promise<ReminderRow[]> {
  return prisma.recurringReminder.findMany({
    where: { userId },
    include: REMINDER_LABELS,
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
}

/**
 * Pauses or resumes a reminder.
 *
 * A boolean switch rather than a status enum, and rather than a delete: pausing
 * stops *new* occurrences being materialized and does nothing else. The
 * occurrences the reminder already has stay exactly as they are, because they
 * really were due — hiding them would lose a bill the user still has to deal
 * with. Resuming picks the schedule back up from the current window, so a
 * reminder paused for six months does not flood the user on the day it comes
 * back.
 *
 * The composite `userId_id` key is what makes another user's reminder id a
 * P2025 (propagated untouched, as every service here does) rather than a usable
 * reference.
 */
export async function setReminderActive(
  userId: string,
  reminderId: string,
  active: boolean,
): Promise<ReminderRow> {
  return prisma.recurringReminder.update({
    where: { userId_id: { userId, id: reminderId } },
    data: { active },
    include: REMINDER_LABELS,
  })
}

/**
 * Creates the PENDING occurrence rows that are missing for every *active*
 * reminder, and returns how many rows were actually inserted.
 *
 * The window is `[from, nowLocal + 30 days]` in the user's local calendar, where
 * `from` is:
 *
 * - **ONE_TIME: the reminder's own `startDate`, never clamped** (directive O).
 *   The one-interval clamp below exists to stop a years-old *recurring* reminder
 *   flooding the user with historical rows on its first view. A one-time
 *   reminder has at most one occurrence ever, so there is no flood to guard
 *   against — and clamping it would hide precisely the reminder the user most
 *   needs to see: the one-off payment they are already late for. A ONE_TIME
 *   reminder dated 2020, read in 2026, must still produce its single occurrence.
 * - **otherwise: `max(startDate, one interval before nowLocal)`.** One interval
 *   back is enough to surface the occurrence the user may genuinely have missed,
 *   and no more (spec §4.7).
 *
 * Three properties of *how* it writes matter as much as what it writes:
 *
 * 1. **`skipDuplicates` over the unique index is the whole idempotency
 *    mechanism.** There is deliberately no "which of these already exist?" read
 *    first: that would be a read-then-write with a window in the middle that two
 *    simultaneous page loads would both pass through, and the second insert would
 *    then fail with P2002 (or, worse, succeed against a nonexistent constraint).
 *    `INSERT … ON CONFLICT DO NOTHING` has no window. Dates go in ascending order
 *    on every call, so concurrent callers take their row locks in the same order
 *    and cannot deadlock.
 * 2. **It only ever inserts.** Nothing in this function updates or deletes an
 *    occurrence, which is what makes an ACKNOWLEDGED or DISMISSED row permanent:
 *    a later read recomputes the same `dueAt`, the conflict is skipped, and the
 *    user's answer stands. An `upsert` here — the obvious-looking alternative —
 *    would silently reset every actioned row to PENDING.
 * 3. **No transaction wraps the loop.** Each `createMany` is atomic and
 *    self-idempotent on its own, so a transaction would add nothing but a pooled
 *    connection held across every round trip of a page render. A partially
 *    materialized user is not an inconsistent state — it is a user whose next
 *    read finishes the job.
 *
 * The query cost is one reminder `findMany` plus at most one `createMany` per
 * reminder that has dates (the call is skipped entirely when it has none), never
 * a query per date.
 */
export async function materializeDueOccurrences(
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<number> {
  const reminders = await prisma.recurringReminder.findMany({ where: { userId, active: true } })

  const nowLocal = toLocalCalendarCarrier(now, timezone)
  // Days added to a *carrier*, where a day is exactly 24 hours because UTC has
  // no DST — the arithmetic that would be wrong on an instant in a local zone.
  const to = new Date(nowLocal.getTime() + OCCURRENCE_LOOKAHEAD_DAYS * MS_PER_DAY)

  let created = 0
  for (const reminder of reminders) {
    const startLocal = toLocalCalendarCarrier(reminder.startDate, timezone)
    const rule: RecurrenceRule = {
      frequency: reminder.frequency,
      interval: reminder.interval,
      // `?? undefined` because the columns are nullable and the rule's fields
      // are optional: a stored NULL means "no anchor", which is what `undefined`
      // means to `computeDueDates`.
      dayOfMonth: reminder.dayOfMonth ?? undefined,
      month: reminder.month ?? undefined,
      startDate: startLocal,
    }
    const from =
      reminder.frequency === 'ONE_TIME'
        ? startLocal
        : maxCarrier(startLocal, oneIntervalBefore(rule, nowLocal))

    const dueDates = computeDueDates(rule, from, to)
    // Skipped rather than called with an empty array: a reminder whose start
    // date is beyond the lookahead has nothing due, and an empty `createMany` is
    // a round trip that inserts nothing.
    if (dueDates.length === 0) continue

    const result = await prisma.reminderOccurrence.createMany({
      data: dueDates.map((dueDate) => ({
        userId,
        reminderId: reminder.id,
        // Each local calendar day back to the instant it starts in the user's
        // zone — the only place the conversion happens.
        dueAt: localCarrierToInstant(dueDate, timezone),
      })),
      skipDuplicates: true,
    })
    created += result.count
  }

  return created
}

/**
 * What the user still has to deal with: every PENDING occurrence, soonest first,
 * materializing the missing ones first.
 *
 * Overdue occurrences come first by construction — their `dueAt` is in the past,
 * so ascending order puts them at the top — which is why nothing here stores or
 * computes an "overdue" flag. It is `dueAt < now && status = PENDING`, and the
 * view decides that against the user's own clock (spec §4.7).
 *
 * Deliberately *not* limited to the lookahead window: a PENDING occurrence from
 * three months ago is a bill the user never answered, and dropping it out of the
 * list because it is old would be the app quietly forgetting it on their behalf.
 * It stays until they acknowledge or dismiss it.
 */
export async function listUpcomingOccurrences(
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<OccurrenceRow[]> {
  await materializeDueOccurrences(userId, timezone, now)

  return prisma.reminderOccurrence.findMany({
    where: { userId, status: 'PENDING' },
    include: OCCURRENCE_INCLUDE,
    orderBy: UPCOMING_ORDER,
  })
}

/**
 * The history view: occurrences in any state, newest due first.
 *
 * Materializes nothing, on purpose. Looking back at what has already happened
 * must not create rows — a filter for DISMISSED occurrences is a question about
 * the past, and answering it by writing to the future would make the same page
 * show different data each time it was opened.
 *
 * Bounded, and the limit is clamped rather than trusted, for the reason
 * `listTransactions` gives: a weekly reminder produces 52 rows a year, so an
 * unbounded history is a page that gets slower every month it is used.
 */
export async function listOccurrences(
  userId: string,
  options?: { status?: OccurrenceStatus; limit?: number },
): Promise<OccurrenceRow[]> {
  const requested = options?.limit ?? DEFAULT_OCCURRENCE_HISTORY_LIMIT
  const take = Math.max(1, Math.min(requested, MAX_OCCURRENCE_HISTORY_LIMIT))

  return prisma.reminderOccurrence.findMany({
    where: { userId, ...(options?.status ? { status: options.status } : {}) },
    include: OCCURRENCE_INCLUDE,
    orderBy: HISTORY_ORDER,
    take,
  })
}

/**
 * Records the user's answer to one occurrence, and only that.
 *
 * Two things and no more change: the status, and `actionedAt`. No Transaction, no
 * account, no balance — and nothing about the reminder itself, whose schedule
 * carries on regardless (invariant 1, directive M).
 *
 * **Idempotent, and it never flips one answer into the other.** An occurrence
 * that is already ACKNOWLEDGED or DISMISSED is returned exactly as it stands,
 * with no write at all, so `actionedAt` still records when the user actually
 * decided. That is deliberately not an error: a double-clicked button or a stale
 * tab produces the same request as the one that succeeded, and answering it with
 * a failure would report a problem for a state the user already has. But it must
 * not *change* their answer either — "Dismiss" then "Acknowledge" from a page
 * rendered before the dismiss would otherwise silently overwrite the newer
 * decision with the older one.
 *
 * No row lock: the only race is the user's own two clicks arriving together, and
 * every interleaving lands on a state they asked for. There is no cross-row
 * invariant to protect, which is what makes this different from `debt.ts` and
 * `loan.ts`, where a payment has to be checked against a sum.
 *
 * `findUniqueOrThrow` on the composite `userId_id` key is what makes another
 * user's occurrence id a P2025 (propagated untouched) rather than a usable
 * reference.
 */
async function actionOccurrence(
  userId: string,
  occurrenceId: string,
  status: Extract<OccurrenceStatus, 'ACKNOWLEDGED' | 'DISMISSED'>,
  now: Date,
): Promise<OccurrenceRow> {
  const existing = await prisma.reminderOccurrence.findUniqueOrThrow({
    where: { userId_id: { userId, id: occurrenceId } },
    include: OCCURRENCE_INCLUDE,
  })
  if (existing.status !== 'PENDING') return existing

  return prisma.reminderOccurrence.update({
    where: { userId_id: { userId, id: occurrenceId } },
    data: { status, actionedAt: now },
    include: OCCURRENCE_INCLUDE,
  })
}

/** "I have dealt with this" — the bill is paid, the salary arrived. */
export async function acknowledgeOccurrence(
  userId: string,
  occurrenceId: string,
  now: Date = new Date(),
): Promise<OccurrenceRow> {
  return actionOccurrence(userId, occurrenceId, 'ACKNOWLEDGED', now)
}

/** "This one does not apply" — the subscription was cancelled, the month was
 *  skipped. A distinct state from acknowledged because the two mean different
 *  things about the same due date, and a history that conflated them would tell
 *  the user they paid something they did not. */
export async function dismissOccurrence(
  userId: string,
  occurrenceId: string,
  now: Date = new Date(),
): Promise<OccurrenceRow> {
  return actionOccurrence(userId, occurrenceId, 'DISMISSED', now)
}
