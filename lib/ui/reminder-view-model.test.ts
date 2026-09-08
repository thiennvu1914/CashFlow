import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import type { OccurrenceRow, ReminderRow } from '@/lib/server/services/reminder'
import { toOccurrenceDto, toReminderDto } from './reminder-view-model'

/**
 * Pure mapping — no database, no session, no renderer.
 *
 * Two properties are what this module exists for, and both are pinned below at
 * their edges:
 *
 * 1. **Every instant is read in the USER's zone, never the server's.**
 *    `dueAt` and `startDate` are instants of *local* midnight, so the same
 *    stored `2026-04-14T17:00:00.000Z` is the 15th in `Asia/Ho_Chi_Minh` and
 *    the 14th in UTC. A `toISOString().slice(0, 10)` here would tell a
 *    Vietnamese user their bill was due yesterday.
 * 2. **`daysToDue` counts calendar days, not milliseconds.** "3 days out" has
 *    to survive a month boundary and a DST shift, so the difference is taken
 *    between two UTC-midnight carriers built from the two calendar strings —
 *    never `(dueAt - now) / 86_400_000`, which answers "0 days" for a bill due
 *    tomorrow morning.
 *
 * Nothing here is alarmist: an overdue occurrence gets a boolean the row can
 * style on and a `daysToDue` that is merely negative — no pre-baked "Overdue"
 * string, and no count of how late it is. The component
 * (`components/reminders/occurrence-list.tsx`) is what turns `daysToDue` into
 * one of `reminders.overdue`/`dueToday`/`dueTomorrow`/`dueInDays`, and the enum
 * type/frequency into a label through `reminderTypeLabelKey`/
 * `recurrenceLabelKey` (`lib/ui/labels.ts`) — this module never renders English.
 */

const CREATED_AT = new Date('2026-03-01T04:05:06.000Z')

/** The user's zone for every case below. UTC+7, so a local midnight is 17:00Z
 *  on the *previous* day — the offset that makes case 1 above observable. */
const TIMEZONE = 'Asia/Ho_Chi_Minh'

/** The user's own calendar day, as the page passes it in. */
const TODAY = '2026-04-15'

/** The instant of local midnight on `date` in `Asia/Ho_Chi_Minh` — how the
 *  service stores a due date, written out rather than hand-computed per case. */
function localMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000+07:00`)
}

function reminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 'rem_1',
    userId: 'user_1',
    title: 'Internet bill',
    type: 'EXPENSE',
    expectedAmount: new Prisma.Decimal('350000'),
    currency: 'VND',
    categoryId: null,
    accountId: null,
    frequency: 'MONTHLY',
    interval: 1,
    dayOfMonth: 15,
    month: null,
    startDate: localMidnight('2026-03-15'),
    // The zone the schedule is anchored to (ruling R6-22). This module never
    // reads it: a due date is rendered in the *viewer's* zone, which is what
    // `TIMEZONE` is passed in as.
    timezone: TIMEZONE,
    note: null,
    active: true,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    category: null,
    account: null,
    ...overrides,
  }
}

function occurrence(overrides: Partial<OccurrenceRow> = {}): OccurrenceRow {
  return {
    id: 'occ_1',
    userId: 'user_1',
    reminderId: 'rem_1',
    dueAt: localMidnight(TODAY),
    status: 'PENDING',
    actionedAt: null,
    createdAt: CREATED_AT,
    reminder: reminder(),
    ...overrides,
  }
}

/**
 * True only for an object literal — the kind of value the leaf walk should
 * descend *into*. A `Date` and a `Prisma.Decimal` are objects too, but their
 * prototypes are their own, so they come back false and are treated as leaves:
 * they are precisely what the case has to inspect rather than recurse through.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Every leaf inside a DTO as `[path, value]` pairs, recursing through arrays and
 * object literals so a nested value is reached rather than skipped. The path is
 * carried along purely so a failure names the field that leaked
 * ("dto.amount is a Prisma.Decimal") instead of leaving the reader to find it.
 */
function leafValues(value: unknown, path = 'dto'): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leafValues(item, `${path}[${index}]`))
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => leafValues(item, `${path}.${key}`))
  }
  return [[path, value]]
}

/** The assertion both DTO-boundary cases run: a client component may receive
 *  primitives and `null`, and nothing else. */
function expectOnlyPrimitiveLeaves(dto: unknown, requiredPaths: string[]): void {
  const leaves = leafValues(dto)
  const paths = leaves.map(([path]) => path)

  // First: the walk really reached the places a leak would hide in — otherwise
  // the loop below could pass over an empty list and assert nothing at all.
  for (const required of requiredPaths) {
    expect(paths).toContain(required)
  }

  for (const [path, value] of leaves) {
    // Asserted by *identity*, never by `typeof`: `typeof new Date()` and
    // `typeof new Prisma.Decimal(0)` are both `'object'`, so a `typeof` check is
    // exactly the one that cannot see either leak.
    expect(value instanceof Date, `${path} is a Date`).toBe(false)
    expect(Prisma.Decimal.isDecimal(value), `${path} is a Prisma.Decimal`).toBe(false)
    // And the positive statement, so a leak of some *other* non-serialisable
    // object (a `Map`, a class instance a later field introduces) is caught
    // too: a primitive or `null` is the only thing a leaf may be.
    if (value !== null) {
      expect(['string', 'number', 'boolean'], `${path} is a ${typeof value}`).toContain(
        typeof value,
      )
    }
  }
}

describe('toOccurrenceDto', () => {
  it('maps a bill due today: own currency, whole dong, no category or account', () => {
    const dto = toOccurrenceDto(occurrence(), TIMEZONE, TODAY)

    expect(dto.id).toBe('occ_1')
    expect(dto.reminderId).toBe('rem_1')
    expect(dto.title).toBe('Internet bill')
    expect(dto.type).toBe('EXPENSE')
    expect(dto.amount).toBe('350.000')
    expect(dto.currency).toBe('VND')
    expect(dto.dueDate).toBe(TODAY)
    expect(dto.daysToDue).toBe(0)
    expect(dto.overdue).toBe(false)
    expect(dto.frequency).toBe('MONTHLY')
    expect(dto.interval).toBe(1)
    expect(dto.categoryName).toBeNull()
    expect(dto.accountName).toBeNull()
    expect(dto.status).toBe('PENDING')
  })

  it("formats a USD amount with cents, in the reminder's own currency", () => {
    const dto = toOccurrenceDto(
      occurrence({
        reminder: reminder({
          type: 'INCOME',
          title: 'Contract invoice',
          expectedAmount: new Prisma.Decimal('1250.5'),
          currency: 'USD',
        }),
      }),
      TIMEZONE,
      TODAY,
    )

    // Vietnamese grouping (the reader's locale) with USD precision (the money's
    // own), and never converted to `User.baseCurrency`, which is display-only.
    expect(dto.amount).toBe('1.250,50')
    expect(dto.currency).toBe('USD')
    expect(dto.type).toBe('INCOME')
  })

  it("formats with English grouping when the reader's locale is en", () => {
    const dto = toOccurrenceDto(
      occurrence({
        reminder: reminder({ expectedAmount: new Prisma.Decimal('1250000') }),
      }),
      TIMEZONE,
      TODAY,
      'en',
    )

    expect(dto.amount).toBe('1,250,000')
  })

  it("reads the due instant as the day it falls on in the USER's zone", () => {
    // 17:00Z is local midnight of the *next* day at UTC+7 — the case this
    // module exists for. A server reading the same row in UTC must not be able
    // to tell the user their bill was due yesterday.
    const row = occurrence({ dueAt: new Date('2026-04-14T17:00:00.000Z') })

    expect(toOccurrenceDto(row, TIMEZONE, TODAY).dueDate).toBe('2026-04-15')
    expect(toOccurrenceDto(row, 'UTC', TODAY).dueDate).toBe('2026-04-14')
  })

  it('lets the zone decide whether the same instant is overdue', () => {
    const row = occurrence({ dueAt: new Date('2026-04-14T17:00:00.000Z') })

    // Same instant, same `today`, two zones: due today for the user it belongs
    // to, a day late for a reader in UTC. `daysToDue` follows the zone because
    // it is computed from `dueDate`, which is already in it.
    expect(toOccurrenceDto(row, TIMEZONE, TODAY).daysToDue).toBe(0)
    expect(toOccurrenceDto(row, 'UTC', TODAY).daysToDue).toBe(-1)
    expect(toOccurrenceDto(row, 'UTC', TODAY).overdue).toBe(true)
  })

  it('marks yesterday overdue with a negative daysToDue, and nothing more', () => {
    const dto = toOccurrenceDto(occurrence({ dueAt: localMidnight('2026-04-14') }), TIMEZONE, TODAY)

    expect(dto.dueDate).toBe('2026-04-14')
    expect(dto.daysToDue).toBe(-1)
    expect(dto.overdue).toBe(true)
  })

  it('keeps daysToDue exact for a bill months late — no pre-baked "Overdue" string here', () => {
    // The upcoming list is unbounded by design — an unanswered bill from
    // January is still the user's to deal with. This module reports the exact
    // count; the component decides whether to show it (spec §6.7: "Overdue"
    // carries no count, on purpose).
    const dto = toOccurrenceDto(occurrence({ dueAt: localMidnight('2026-01-05') }), TIMEZONE, TODAY)

    expect(dto.daysToDue).toBeLessThan(-1)
    expect(dto.overdue).toBe(true)
  })

  it('reports tomorrow as daysToDue 1', () => {
    const dto = toOccurrenceDto(occurrence({ dueAt: localMidnight('2026-04-16') }), TIMEZONE, TODAY)

    expect(dto.daysToDue).toBe(1)
    expect(dto.overdue).toBe(false)
  })

  it('counts calendar days from two days out', () => {
    expect(
      toOccurrenceDto(occurrence({ dueAt: localMidnight('2026-04-17') }), TIMEZONE, TODAY)
        .daysToDue,
    ).toBe(2)
    expect(
      toOccurrenceDto(occurrence({ dueAt: localMidnight('2026-04-20') }), TIMEZONE, TODAY)
        .daysToDue,
    ).toBe(5)
    expect(
      toOccurrenceDto(occurrence({ dueAt: localMidnight('2026-05-15') }), TIMEZONE, TODAY)
        .daysToDue,
    ).toBe(30)
  })

  it('counts across a month boundary rather than subtracting day numbers', () => {
    // 30 April + 1 is 1 May, not "31 April". A count built from the day
    // numbers would answer -29 here; the difference is taken between two
    // UTC-midnight carriers, where a day is exactly 24 hours.
    const dto = toOccurrenceDto(
      occurrence({ dueAt: localMidnight('2026-05-01') }),
      TIMEZONE,
      '2026-04-30',
    )

    expect(dto.daysToDue).toBe(1)
  })

  it("counts across a DST change in the reader's zone", () => {
    // `America/Los_Angeles` springs forward on 8 March 2026, so 7 March to 10
    // March is 71 hours and three calendar days. Milliseconds would answer 2
    // days for the second of these.
    const zone = 'America/Los_Angeles'
    const dueAt = new Date('2026-03-10T08:00:00.000Z') // local midnight, PDT

    expect(toOccurrenceDto(occurrence({ dueAt }), zone, '2026-03-07').dueDate).toBe('2026-03-10')
    expect(toOccurrenceDto(occurrence({ dueAt }), zone, '2026-03-07').daysToDue).toBe(3)
    expect(toOccurrenceDto(occurrence({ dueAt }), zone, '2026-03-09').daysToDue).toBe(1)
  })

  it('carries the category and account names the row already brought with it', () => {
    const dto = toOccurrenceDto(
      occurrence({
        reminder: reminder({
          category: { name: 'Utilities' },
          account: { name: 'Techcombank' },
        }),
      }),
      TIMEZONE,
      TODAY,
    )

    // Projected `name`s from the service's own include, so a row renders with
    // no follow-up query — and with none of the category's `userId`/`status` or
    // the account's `initialBalance` reaching a client component.
    expect(dto.categoryName).toBe('Utilities')
    expect(dto.accountName).toBe('Techcombank')
  })

  it("reports an actioned occurrence's own status rather than assuming PENDING", () => {
    const acknowledged = toOccurrenceDto(
      occurrence({ status: 'ACKNOWLEDGED', actionedAt: CREATED_AT }),
      TIMEZONE,
      TODAY,
    )
    const dismissed = toOccurrenceDto(occurrence({ status: 'DISMISSED' }), TIMEZONE, TODAY)

    expect(acknowledged.status).toBe('ACKNOWLEDGED')
    expect(dismissed.status).toBe('DISMISSED')
  })

  it('describes the schedule the occurrence came from as an enum, not a label', () => {
    const dto = toOccurrenceDto(
      occurrence({ reminder: reminder({ frequency: 'WEEKLY', interval: 2, dayOfMonth: null }) }),
      TIMEZONE,
      TODAY,
    )

    expect(dto.frequency).toBe('WEEKLY')
    expect(dto.interval).toBe(2)
  })

  it('lets nothing but strings, numbers, booleans and nulls cross to a client component', () => {
    // `OccurrenceActions` is a client component taking a whole `OccurrenceDto`,
    // and neither a `Prisma.Decimal` (`expectedAmount`) nor a `Date` (`dueAt`,
    // `startDate`, `actionedAt`, `createdAt`) can survive that boundary.
    const dto = toOccurrenceDto(
      occurrence({
        reminder: reminder({
          note: 'Autopay is off',
          category: { name: 'Utilities' },
          account: { name: 'Techcombank' },
        }),
      }),
      TIMEZONE,
      TODAY,
    )

    expectOnlyPrimitiveLeaves(dto, [
      'dto.amount',
      'dto.dueDate',
      'dto.daysToDue',
      'dto.frequency',
      'dto.interval',
      'dto.categoryName',
      'dto.accountName',
      'dto.status',
    ])
  })
})

describe('toReminderDto', () => {
  it('maps an active monthly bill', () => {
    const dto = toReminderDto(reminder(), TIMEZONE)

    expect(dto.id).toBe('rem_1')
    expect(dto.title).toBe('Internet bill')
    expect(dto.type).toBe('EXPENSE')
    expect(dto.amount).toBe('350.000')
    expect(dto.currency).toBe('VND')
    expect(dto.frequency).toBe('MONTHLY')
    expect(dto.interval).toBe(1)
    expect(dto.startDate).toBe('2026-03-15')
    expect(dto.active).toBe(true)
    expect(dto.note).toBeNull()
    expect(dto.categoryName).toBeNull()
    expect(dto.accountName).toBeNull()
  })

  it("reads the start instant as the day it falls on in the USER's zone", () => {
    // Stored as the instant of local midnight, so the same row is the 15th in
    // `Asia/Ho_Chi_Minh` and the 14th in UTC — and the user must see the day
    // they picked, not the server's reading of it.
    const row = reminder({ startDate: new Date('2026-03-14T17:00:00.000Z') })

    expect(toReminderDto(row, TIMEZONE).startDate).toBe('2026-03-15')
    expect(toReminderDto(row, 'UTC').startDate).toBe('2026-03-14')
  })

  it('reports a paused reminder as paused, and keeps everything else about it', () => {
    const dto = toReminderDto(
      reminder({ active: false, note: 'Cancelled after the move', frequency: 'ONE_TIME' }),
      TIMEZONE,
    )

    // Pausing stops new occurrences being materialized and does nothing else,
    // so the definition still reads in full.
    expect(dto.active).toBe(false)
    expect(dto.note).toBe('Cancelled after the move')
    expect(dto.frequency).toBe('ONE_TIME')
  })

  it('carries the category and account names, and an income type', () => {
    const dto = toReminderDto(
      reminder({
        type: 'INCOME',
        title: 'Salary',
        expectedAmount: new Prisma.Decimal('25000000'),
        frequency: 'MONTHLY',
        interval: 1,
        category: { name: 'Salary' },
        account: { name: 'Vietcombank' },
      }),
      TIMEZONE,
    )

    expect(dto.type).toBe('INCOME')
    expect(dto.amount).toBe('25.000.000')
    expect(dto.categoryName).toBe('Salary')
    expect(dto.accountName).toBe('Vietcombank')
  })

  it("formats with English grouping when the reader's locale is en", () => {
    const dto = toReminderDto(
      reminder({ expectedAmount: new Prisma.Decimal('25000000') }),
      TIMEZONE,
      'en',
    )

    expect(dto.amount).toBe('25,000,000')
  })

  it('lets nothing but strings, numbers, booleans and nulls cross to a client component', () => {
    const dto = toReminderDto(
      reminder({
        note: 'Autopay is off',
        category: { name: 'Utilities' },
        account: { name: 'Techcombank' },
      }),
      TIMEZONE,
    )

    // `ReminderToggle` is a client component taking the row's id, title and
    // active flag from this DTO.
    expectOnlyPrimitiveLeaves(dto, [
      'dto.amount',
      'dto.startDate',
      'dto.frequency',
      'dto.interval',
      'dto.note',
      'dto.categoryName',
      'dto.accountName',
    ])
  })
})

describe('DTOs carry no pre-baked English literal (owner requirement N)', () => {
  it('rejects any Today/Tomorrow/In N days/Overdue/Bill/Income/Weekly/Monthly/Yearly/Active/Paused literal, and no *Label key', () => {
    const occurrenceDto = toOccurrenceDto(
      occurrence({
        reminder: reminder({
          category: { name: 'Utilities' },
          account: { name: 'Techcombank' },
        }),
      }),
      TIMEZONE,
      TODAY,
    )
    const reminderDto = toReminderDto(
      reminder({ category: { name: 'Salary' }, account: { name: 'Vietcombank' } }),
      TIMEZONE,
    )

    const forbidden =
      /Today|Tomorrow|In \d+ days|Overdue|Bill|Income|Weekly|Monthly|Yearly|Active|Paused/

    for (const dto of [occurrenceDto, reminderDto]) {
      for (const [key, value] of Object.entries(dto)) {
        expect(key.endsWith('Label'), `${key} is a *Label key`).toBe(false)
        if (typeof value === 'string') {
          expect(value, `dto.${key} = ${JSON.stringify(value)}`).not.toMatch(forbidden)
        }
      }
    }
  })
})
