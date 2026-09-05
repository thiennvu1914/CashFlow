# CashFlow Phase 6: Planning Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recurring Reminders/Bills (lazily materialized, never duplicated, never resurrected after being actioned), Savings Goals (manual tracking only), Debts and Loans (outstanding always derived from payment history) — none of them ever touch a `FinancialAccount` balance. Net Worth is extended to include receivables/payables/loans. Dashboard gains its remaining three widgets; the full Excel export gains its remaining six sheets.

**Architecture:** Every module here is tracking/planning-only — none has a write path to `FinancialAccount` or `Transaction`. Debt's stored status is narrowed to `ACTIVE | WRITTEN_OFF` rather than the fuller `OPEN/PARTIALLY_PAID/PAID/WRITTEN_OFF` the spec's prose lists: since outstanding amount is explicitly derived from payment history (never stored, per spec §5's "never store what can drift" principle), storing OPEN/PARTIALLY_PAID/PAID as independent fields would let them silently disagree with the derived outstanding amount the moment a payment is recorded without also remembering to update the status by hand — precisely the class of bug the rest of the spec eliminates by construction. `WRITTEN_OFF` is the one genuinely independent decision (a human choice, not computable from payments), so it's the only thing stored; `OPEN`/`PARTIALLY_PAID`/`PAID`/`OVERDUE` are all computed from the outstanding amount and due date at read time, the same way "overdue" already was. The same reasoning is applied to Loan.

**Tech Stack:** Prisma (raw-SQL migration for the LoanPayment CHECK constraint), Zod, React Hook Form.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§4.7–§4.10, §5.4)

**Depends on:** Phase 2 (Category, FinancialAccount), Phase 4 (dashboard layout, `getNetWorth`, export registry), Phase 0 (`getPeriodBounds`, timezone utilities — reused conceptually for date math here).

## Global Constraints

- No stored balance column anywhere — balance is always derived from Transaction + Transfer.
- Every financial Prisma model is scoped by `userId`; cross-user relations use tenant-scoped composite foreign keys.
- Money fields are always Prisma `Decimal`, never `Float`.
- `Transaction.amount` is always ≥ 0; sign is determined solely by `type`.
- Every Transaction snapshots `vndPerUsdAtEntry`, `fxRateTimestamp`, `fxRateSource` regardless of its own currency.
- `historicalAmountIn()` is the only function permitted to do historical currency conversion; it must never read `User.baseCurrency` or call the live FX provider.
- `User.baseCurrency` is a display/aggregation preference only — never a stored unit of financial fact.
- `User.isDemo` must never appear in any client-facing Zod schema.
- No background jobs/cron — reminders and historical FX lookups are computed lazily on read.
- Every server action/query calls `requireUser()` and scopes every query by the resulting `userId` — a client-supplied user id is never trusted.
- Zod validates every mutation server-side, independent of client-side validation.
- Package manager: npm. No `src/` directory — `app/`, `components/`, `lib/`, `prisma/` at repo root. Import alias `@/*`. Node 20+ LTS.
- **Migration workflow**: `npx prisma migrate dev --name <description>` (or `--create-only` when raw SQL follows), never `db push`.
- **Nothing in this phase writes to `FinancialAccount` or `Transaction`, ever** — every module here is tracking/planning-only. If a task's UI ever tempts you to "just also create a transaction," that's a spec violation — don't.

---

## Task 1: Recurrence date computation (pure, TDD)

**Files:**
- Create: `lib/server/services/recurrence.ts`
- Test: `lib/server/services/recurrence.test.ts`

**Interfaces:**
- Consumes: nothing (pure function)
- Produces: `computeDueDates(rule, from, to): Date[]` — Task 2's materialization consumes this exclusively for generating occurrence dates

- [ ] **Step 1: Write the failing tests**

`lib/server/services/recurrence.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { computeDueDates, type RecurrenceRule } from './recurrence'

describe('computeDueDates', () => {
  it('returns a single date for ONE_TIME within range, none outside it', () => {
    const rule: RecurrenceRule = { frequency: 'ONE_TIME', interval: 1, startDate: new Date('2026-03-15') }
    expect(computeDueDates(rule, new Date('2026-01-01'), new Date('2026-12-31'))).toHaveLength(1)
    expect(computeDueDates(rule, new Date('2026-04-01'), new Date('2026-12-31'))).toHaveLength(0)
  })

  it('generates weekly occurrences on the correct interval', () => {
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 2, startDate: new Date('2026-01-05') }
    const dates = computeDueDates(rule, new Date('2026-01-01'), new Date('2026-02-01'))
    // 2026-01-05, 2026-01-19 (every 2 weeks)
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-01-05', '2026-01-19'])
  })

  it('clamps dayOfMonth to the last valid day for shorter months', () => {
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, dayOfMonth: 31, startDate: new Date('2026-01-31') }
    const dates = computeDueDates(rule, new Date('2026-01-01'), new Date('2026-04-01'))
    const days = dates.map((d) => d.getUTCDate())
    // Jan 31, Feb 28 (2026 is not a leap year), Mar 31
    expect(days).toEqual([31, 28, 31])
  })

  it('generates yearly occurrences on the specified month and day', () => {
    const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 1, month: 12, dayOfMonth: 25, startDate: new Date('2025-12-25') }
    const dates = computeDueDates(rule, new Date('2026-01-01'), new Date('2027-06-01'))
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-12-25'])
  })

  it('never returns a date before startDate', () => {
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, dayOfMonth: 1, startDate: new Date('2026-06-01') }
    const dates = computeDueDates(rule, new Date('2026-01-01'), new Date('2026-12-31'))
    expect(dates.every((d) => d >= rule.startDate)).toBe(true)
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/server/services/recurrence.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`lib/server/services/recurrence.ts`:
```ts
export type RecurrenceFrequency = 'ONE_TIME' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RecurrenceRule {
  frequency: RecurrenceFrequency
  interval: number
  dayOfMonth?: number
  month?: number
  startDate: Date
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

export function computeDueDates(rule: RecurrenceRule, from: Date, to: Date): Date[] {
  const dates: Date[] = []

  if (rule.frequency === 'ONE_TIME') {
    if (rule.startDate >= from && rule.startDate <= to && rule.startDate >= rule.startDate) {
      dates.push(rule.startDate)
    }
    return dates
  }

  if (rule.frequency === 'WEEKLY') {
    let cursor = new Date(rule.startDate)
    while (cursor <= to) {
      if (cursor >= from && cursor >= rule.startDate) dates.push(new Date(cursor))
      cursor = new Date(cursor.getTime() + 7 * rule.interval * 24 * 60 * 60 * 1000)
    }
    return dates
  }

  // MONTHLY and YEARLY both step by whole months, clamping the target day to that month's length.
  const stepMonths = rule.frequency === 'YEARLY' ? rule.interval * 12 : rule.interval
  const anchorDay = rule.dayOfMonth ?? rule.startDate.getUTCDate()
  let year = rule.startDate.getUTCFullYear()
  let monthIndex = rule.frequency === 'YEARLY' ? (rule.month ?? rule.startDate.getUTCMonth() + 1) - 1 : rule.startDate.getUTCMonth()

  while (true) {
    const clampedDay = Math.min(anchorDay, daysInMonth(year, monthIndex))
    const occurrence = new Date(Date.UTC(year, monthIndex, clampedDay))
    if (occurrence > to) break
    if (occurrence >= from && occurrence >= rule.startDate) dates.push(occurrence)

    monthIndex += stepMonths
    year += Math.floor(monthIndex / 12)
    monthIndex = ((monthIndex % 12) + 12) % 12
  }

  return dates
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/server/services/recurrence.test.ts`
Expected: PASS, all 5 tests, including the Feb 28 clamping case.

- [ ] **Step 5: Commit**

```bash
git add lib/server/services/recurrence.ts lib/server/services/recurrence.test.ts
git commit -m "feat: add pure recurrence date computation with month-length clamping"
```

---

## Task 2: RecurringReminder/ReminderOccurrence — schema, materialization (TDD), and UI

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/validation/reminder.ts`, `lib/server/services/reminder.ts`, `app/(app)/reminders/page.tsx`, `components/reminders/reminder-form.tsx`, `components/reminders/occurrence-list.tsx`, `lib/server/actions/reminder-actions.ts`
- Test: `lib/server/services/reminder.test.ts`

**Interfaces:**
- Consumes: `computeDueDates` (Task 1)
- Produces: `createReminder`, `listUpcomingOccurrences(userId)` (materializes as a side effect, then returns PENDING rows), `acknowledgeOccurrence`, `dismissOccurrence` — Task 7's "Upcoming reminders" dashboard widget consumes `listUpcomingOccurrences`

- [ ] **Step 1: Schema**

Append to `prisma/schema.prisma`:
```prisma
enum ReminderType {
  INCOME
  EXPENSE
}

enum OccurrenceStatus {
  PENDING
  ACKNOWLEDGED
  DISMISSED
}

model RecurringReminder {
  id             String              @id @default(cuid())
  userId         String
  title          String
  type           ReminderType
  expectedAmount Decimal             @db.Decimal(18, 2)
  currency       Currency
  categoryId     String?
  accountId      String?
  frequency      RecurrenceFrequency
  interval       Int                 @default(1)
  dayOfMonth     Int?
  month          Int?
  startDate      DateTime
  note           String?
  active         Boolean             @default(true)
  createdAt      DateTime            @default(now())

  category    Category?            @relation(fields: [userId, categoryId], references: [userId, id])
  account     FinancialAccount?    @relation(fields: [userId, accountId], references: [userId, id])
  occurrences ReminderOccurrence[]

  @@unique([userId, id])
  @@index([userId])
}

enum RecurrenceFrequency {
  ONE_TIME
  WEEKLY
  MONTHLY
  YEARLY
}

model ReminderOccurrence {
  id         String           @id @default(cuid())
  userId     String
  reminderId String
  dueAt      DateTime
  status     OccurrenceStatus @default(PENDING)
  actionedAt DateTime?

  reminder RecurringReminder @relation(fields: [userId, reminderId], references: [userId, id])

  @@unique([reminderId, dueAt])
  @@index([userId, status, dueAt])
}
```
```bash
npx prisma migrate dev --name add_recurring_reminder
```

- [ ] **Step 2: Write the failing tests**

`lib/server/services/reminder.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { createReminder, listUpcomingOccurrences, dismissOccurrence } from './reminder'

const TZ = 'Asia/Ho_Chi_Minh'

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false, timezone: TZ },
  })
  return { userId: user.id }
}

async function cleanup(userId: string) {
  await prisma.reminderOccurrence.deleteMany({ where: { userId } })
  await prisma.recurringReminder.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('materialization via listUpcomingOccurrences', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('is idempotent: calling it twice produces no duplicate occurrences', async () => {
    const s = await setup()
    userId = s.userId
    await createReminder(userId, {
      title: 'Rent', type: 'EXPENSE', expectedAmount: 5_000_000, currency: 'VND',
      frequency: 'MONTHLY', interval: 1, dayOfMonth: 1, startDate: new Date('2020-01-01'),
    })
    const first = await listUpcomingOccurrences(userId, TZ)
    const second = await listUpcomingOccurrences(userId, TZ)
    expect(second).toHaveLength(first.length)
    const allOccurrences = await prisma.reminderOccurrence.findMany({ where: { userId } })
    const uniqueDueAts = new Set(allOccurrences.map((o) => o.dueAt.toISOString()))
    expect(uniqueDueAts.size).toBe(allOccurrences.length)
  })

  it('never resurrects a dismissed occurrence as PENDING on the next materialization', async () => {
    const s = await setup()
    userId = s.userId
    await createReminder(userId, {
      title: 'Subscription', type: 'EXPENSE', expectedAmount: 100_000, currency: 'VND',
      frequency: 'MONTHLY', interval: 1, dayOfMonth: 1, startDate: new Date('2020-01-01'),
    })
    const occurrences = await listUpcomingOccurrences(userId, TZ)
    await dismissOccurrence(userId, occurrences[0].id)

    const afterDismiss = await listUpcomingOccurrences(userId, TZ)
    expect(afterDismiss.find((o) => o.id === occurrences[0].id)).toBeUndefined()

    const stillDismissed = await prisma.reminderOccurrence.findUniqueOrThrow({ where: { userId_id: { userId, id: occurrences[0].id } } })
    expect(stillDismissed.status).toBe('DISMISSED')
  })

  it('resolves "day 1" in the user\'s own timezone, not UTC — a naive UTC-only implementation would shift this by a day for zones behind UTC', async () => {
    const s = await setup()
    userId = s.userId
    // America/New_York is UTC-4/UTC-5. If due-date computation used raw UTC arithmetic,
    // "day 1 at local midnight" would incorrectly resolve to a dueAt instant still on the
    // previous UTC calendar day.
    await prisma.user.update({ where: { id: userId }, data: { timezone: 'America/New_York' } })
    await createReminder(userId, {
      title: 'Rent', type: 'EXPENSE', expectedAmount: 1000, currency: 'USD',
      frequency: 'MONTHLY', interval: 1, dayOfMonth: 1, startDate: new Date('2020-01-01'),
    })
    const occurrences = await listUpcomingOccurrences(userId, 'America/New_York')
    // Every stored dueAt, when viewed in America/New_York, must land on the 1st of its month —
    // never the last day of the previous month, which is what naive UTC-midnight math would produce.
    for (const o of occurrences) {
      const localDay = new Date(o.dueAt.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDate()
      expect(localDay).toBe(1)
    }
  })

  it('still surfaces a ONE_TIME reminder whose startDate is long past, unlike a recurring one', async () => {
    const s = await setup()
    userId = s.userId
    await createReminder(userId, {
      title: 'Annual fee', type: 'EXPENSE', expectedAmount: 200_000, currency: 'VND',
      frequency: 'ONE_TIME', interval: 1, startDate: new Date('2020-01-01'),
    })
    const occurrences = await listUpcomingOccurrences(userId, TZ)
    expect(occurrences).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run lib/server/services/reminder.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement**

`lib/validation/reminder.ts`:
```ts
import { z } from 'zod'

export const createReminderSchema = z.object({
  title: z.string().min(1).max(100),
  type: z.enum(['INCOME', 'EXPENSE']),
  expectedAmount: z.number().positive(),
  currency: z.enum(['VND', 'USD']),
  categoryId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  frequency: z.enum(['ONE_TIME', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  interval: z.number().int().min(1).default(1),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  month: z.number().int().min(1).max(12).optional(),
  startDate: z.coerce.date(),
  note: z.string().max(500).optional(),
})

export type CreateReminderInput = z.infer<typeof createReminderSchema>
```

`lib/server/services/reminder.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { createReminderSchema, type CreateReminderInput } from '@/lib/validation/reminder'
import { computeDueDates } from './recurrence'

const LOOKAHEAD_DAYS = 30

/**
 * computeDueDates (Task 1) is deliberately timezone-agnostic — it only does calendar
 * arithmetic on abstract year/month/day components. Due dates must be computed in the
 * user's timezone per spec §7 (a reminder "due on the 1st" means the 1st locally, not in
 * UTC), so this function converts a real UTC instant into the equivalent "local calendar
 * date," expressed as a UTC-midnight Date purely as a carrier for those three components —
 * it has no further timezone meaning until convertLocalCalendarDateToInstant reverses it.
 */
function toLocalCalendarDate(instant: Date, timezone: string): Date {
  const zoned = toZonedTime(instant, timezone)
  return new Date(Date.UTC(zoned.getFullYear(), zoned.getMonth(), zoned.getDate()))
}

function localCalendarDateToInstant(localCalendarDate: Date, timezone: string): Date {
  return fromZonedTime(localCalendarDate, timezone)
}

function oneIntervalAgo(frequency: string, interval: number, from: Date): Date {
  const d = new Date(from)
  if (frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate() - 7 * interval)
  else if (frequency === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() - interval)
  else if (frequency === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() - interval)
  return d
}

export async function createReminder(userId: string, input: CreateReminderInput) {
  const parsed = createReminderSchema.parse(input)
  return prisma.recurringReminder.create({ data: { userId, ...parsed } })
}

async function materializeDueOccurrences(userId: string, timezone: string): Promise<void> {
  const reminders = await prisma.recurringReminder.findMany({ where: { userId, active: true } })
  const nowLocal = toLocalCalendarDate(new Date(), timezone)
  const lookaheadEndLocal = new Date(nowLocal.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000)

  for (const reminder of reminders) {
    const startDateLocal = toLocalCalendarDate(reminder.startDate, timezone)
    // The "don't backfill further than one interval back" clamp exists to avoid flooding a
    // long-running recurring reminder with years of missed occurrences. A ONE_TIME reminder
    // has at most one occurrence ever, so there's no flood to guard against — clamping it
    // the same way would wrongly suppress a one-time reminder that's overdue by more than
    // one synthetic "interval," so it always uses its own startDate as the lower bound.
    const from = reminder.frequency === 'ONE_TIME'
      ? startDateLocal
      : (() => {
          const oneIntervalAgoLocal = oneIntervalAgo(reminder.frequency, reminder.interval, nowLocal)
          return startDateLocal > oneIntervalAgoLocal ? startDateLocal : oneIntervalAgoLocal
        })()

    const localDueDates = computeDueDates(
      {
        frequency: reminder.frequency,
        interval: reminder.interval,
        dayOfMonth: reminder.dayOfMonth ?? undefined,
        month: reminder.month ?? undefined,
        startDate: startDateLocal,
      },
      from,
      lookaheadEndLocal,
    )
    if (localDueDates.length === 0) continue

    await prisma.reminderOccurrence.createMany({
      data: localDueDates.map((localDate) => ({
        userId,
        reminderId: reminder.id,
        dueAt: localCalendarDateToInstant(localDate, timezone),
      })),
      skipDuplicates: true,
    })
  }
}

export async function listUpcomingOccurrences(userId: string, timezone: string) {
  await materializeDueOccurrences(userId, timezone)
  return prisma.reminderOccurrence.findMany({
    where: { userId, status: 'PENDING' },
    include: { reminder: true },
    orderBy: { dueAt: 'asc' },
  })
}

export async function acknowledgeOccurrence(userId: string, occurrenceId: string) {
  return prisma.reminderOccurrence.update({
    where: { userId_id: { userId, id: occurrenceId } },
    data: { status: 'ACKNOWLEDGED', actionedAt: new Date() },
  })
}

export async function dismissOccurrence(userId: string, occurrenceId: string) {
  return prisma.reminderOccurrence.update({
    where: { userId_id: { userId, id: occurrenceId } },
    data: { status: 'DISMISSED', actionedAt: new Date() },
  })
}
```

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run lib/server/services/reminder.test.ts`
Expected: PASS, all 4 tests, including the America/New_York timezone-correctness case and the overdue-ONE_TIME case. `date-fns-tz` is already a dependency from Phase 0 Task 6 — no new install needed here.

- [ ] **Step 6: UI**

`lib/server/actions/reminder-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as reminderService from '@/lib/server/services/reminder'
import type { CreateReminderInput } from '@/lib/validation/reminder'

export async function createReminderAction(input: CreateReminderInput) {
  const user = await requireUser()
  await reminderService.createReminder(user.id, input)
  revalidatePath('/reminders')
}

export async function acknowledgeOccurrenceAction(id: string) {
  const user = await requireUser()
  await reminderService.acknowledgeOccurrence(user.id, id)
  revalidatePath('/reminders')
}

export async function dismissOccurrenceAction(id: string) {
  const user = await requireUser()
  await reminderService.dismissOccurrence(user.id, id)
  revalidatePath('/reminders')
}
```

`components/reminders/occurrence-list.tsx`:
```tsx
'use client'

import { acknowledgeOccurrenceAction, dismissOccurrenceAction } from '@/lib/server/actions/reminder-actions'

type Row = { id: string; dueAt: Date; reminder: { title: string; expectedAmount: unknown; currency: string; type: string } }

export function OccurrenceList({ occurrences, filterType }: { occurrences: Row[]; filterType?: 'INCOME' | 'EXPENSE' }) {
  const filtered = filterType ? occurrences.filter((o) => o.reminder.type === filterType) : occurrences
  return (
    <ul className="flex flex-col gap-2">
      {filtered.map((o) => (
        <li key={o.id} className="flex items-center justify-between rounded-md border p-3">
          <div>
            <p className="font-medium">{o.reminder.title}</p>
            <p className="text-sm text-foreground/60">
              Due {new Date(o.dueAt).toLocaleDateString()} · {String(o.reminder.expectedAmount)} {o.reminder.currency}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => acknowledgeOccurrenceAction(o.id)} className="text-sm text-positive">Acknowledge</button>
            <button onClick={() => dismissOccurrenceAction(o.id)} className="text-sm text-negative">Dismiss</button>
          </div>
        </li>
      ))}
    </ul>
  )
}
```

`components/reminders/reminder-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createReminderSchema, type CreateReminderInput } from '@/lib/validation/reminder'
import { createReminderAction } from '@/lib/server/actions/reminder-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ReminderForm() {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<CreateReminderInput>({
    resolver: zodResolver(createReminderSchema),
    defaultValues: { currency: 'VND', frequency: 'MONTHLY', interval: 1 },
  })

  async function onSubmit(values: CreateReminderInput) {
    await createReminderAction(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <Input placeholder="Title (e.g. Rent, Salary)" {...register('title')} />
      <select {...register('type')} className="rounded-md border p-2">
        <option value="EXPENSE">Expense (Bill)</option>
        <option value="INCOME">Income</option>
      </select>
      <Input type="number" step="0.01" placeholder="Expected amount" {...register('expectedAmount', { valueAsNumber: true })} />
      <select {...register('frequency')} className="rounded-md border p-2">
        <option value="ONE_TIME">One time</option>
        <option value="WEEKLY">Weekly</option>
        <option value="MONTHLY">Monthly</option>
        <option value="YEARLY">Yearly</option>
      </select>
      <Input type="number" placeholder="Day of month (1-31)" {...register('dayOfMonth', { valueAsNumber: true })} />
      <Input type="date" {...register('startDate', { valueAsDate: true })} />
      <Button type="submit" disabled={isSubmitting}>Add reminder</Button>
    </form>
  )
}
```

`app/(app)/reminders/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listUpcomingOccurrences } from '@/lib/server/services/reminder'
import { OccurrenceList } from '@/components/reminders/occurrence-list'
import { ReminderForm } from '@/components/reminders/reminder-form'

export default async function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const user = await requireUser()
  const timezone = (user as typeof user & { timezone: string }).timezone
  const { tab } = await searchParams
  const occurrences = await listUpcomingOccurrences(user.id, timezone)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex gap-2">
        <a href="/reminders?tab=reminders" className="text-sm underline">Reminders</a>
        <a href="/reminders?tab=bills" className="text-sm underline">Bills</a>
      </div>
      <OccurrenceList occurrences={occurrences} filterType={tab === 'bills' ? 'EXPENSE' : tab === 'reminders' ? 'INCOME' : undefined} />
      <ReminderForm />
    </div>
  )
}
```

- [ ] **Step 7: Manual verification**

Run `npm run dev`, visit `/reminders`, create a monthly rent reminder with `startDate` in the past — confirm an occurrence appears due immediately. Acknowledge it, reload the page, confirm it's gone and doesn't reappear. Confirm no `Transaction` row was created anywhere as a side effect of acknowledging.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma lib/validation/reminder.ts lib/server/services/reminder.ts lib/server/services/reminder.test.ts "app/(app)/reminders" components/reminders lib/server/actions/reminder-actions.ts
git commit -m "feat: add RecurringReminder/ReminderOccurrence with idempotent lazy materialization"
```

---

## Task 3: Savings Goals

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/validation/savings-goal.ts`, `lib/server/services/savings-goal.ts`, `app/(app)/goals/page.tsx`, `components/goals/goal-form.tsx`, `components/goals/goal-progress-card.tsx`, `lib/server/actions/savings-goal-actions.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `createSavingsGoal`, `updateSavingsGoalProgress`, `listSavingsGoals` — Task 7's dashboard widget consumes `listSavingsGoals`

- [ ] **Step 1: Schema**

```prisma
enum SavingsGoalStatus {
  ACTIVE
  ACHIEVED
  ARCHIVED
}

model SavingsGoal {
  id              String            @id @default(cuid())
  userId          String
  name            String
  targetAmount    Decimal           @db.Decimal(18, 2)
  currentProgress Decimal           @db.Decimal(18, 2) @default(0)
  currency        Currency
  deadline        DateTime?
  note            String?
  status          SavingsGoalStatus @default(ACTIVE)
  createdAt       DateTime          @default(now())

  @@unique([userId, id])
  @@index([userId])
}
```
```bash
npx prisma migrate dev --name add_savings_goal
```

- [ ] **Step 2: Validation and service**

`lib/validation/savings-goal.ts`:
```ts
import { z } from 'zod'

export const createSavingsGoalSchema = z.object({
  name: z.string().min(1).max(100),
  targetAmount: z.number().positive(),
  currency: z.enum(['VND', 'USD']),
  deadline: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
})

export const updateProgressSchema = z.object({ currentProgress: z.number().min(0) })

export type CreateSavingsGoalInput = z.infer<typeof createSavingsGoalSchema>
export type UpdateProgressInput = z.infer<typeof updateProgressSchema>
```

`lib/server/services/savings-goal.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { createSavingsGoalSchema, updateProgressSchema, type CreateSavingsGoalInput, type UpdateProgressInput } from '@/lib/validation/savings-goal'

export async function listSavingsGoals(userId: string) {
  return prisma.savingsGoal.findMany({ where: { userId, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'asc' } })
}

export async function createSavingsGoal(userId: string, input: CreateSavingsGoalInput) {
  const parsed = createSavingsGoalSchema.parse(input)
  return prisma.savingsGoal.create({ data: { userId, ...parsed, currentProgress: 0 } })
}

export async function updateSavingsGoalProgress(userId: string, goalId: string, input: UpdateProgressInput) {
  const parsed = updateProgressSchema.parse(input)
  const goal = await prisma.savingsGoal.findUniqueOrThrow({ where: { userId_id: { userId, id: goalId } } })
  const status = parsed.currentProgress >= goal.targetAmount.toNumber() ? 'ACHIEVED' : 'ACTIVE'
  return prisma.savingsGoal.update({
    where: { userId_id: { userId, id: goalId } },
    data: { currentProgress: parsed.currentProgress, status },
  })
}
```

- [ ] **Step 3: UI**

`lib/server/actions/savings-goal-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as goalService from '@/lib/server/services/savings-goal'
import type { CreateSavingsGoalInput, UpdateProgressInput } from '@/lib/validation/savings-goal'

export async function createSavingsGoalAction(input: CreateSavingsGoalInput) {
  const user = await requireUser()
  await goalService.createSavingsGoal(user.id, input)
  revalidatePath('/goals')
}

export async function updateSavingsGoalProgressAction(goalId: string, input: UpdateProgressInput) {
  const user = await requireUser()
  await goalService.updateSavingsGoalProgress(user.id, goalId, input)
  revalidatePath('/goals')
  revalidatePath('/dashboard')
}
```

`components/goals/goal-progress-card.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { updateSavingsGoalProgressAction } from '@/lib/server/actions/savings-goal-actions'

export function GoalProgressCard({
  id, name, target, progress, currency,
}: { id: string; name: string; target: number; progress: number; currency: string }) {
  const [value, setValue] = useState(progress)
  const percentage = Math.min((progress / target) * 100, 100)

  return (
    <div className="rounded-md border p-4">
      <div className="mb-2 flex justify-between text-sm">
        <span>{name}</span>
        <span className="tabular-nums">{progress.toLocaleString('vi-VN')} / {target.toLocaleString('vi-VN')} {currency}</span>
      </div>
      <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-foreground/10">
        <div className="h-full bg-brand" style={{ width: `${percentage}%` }} />
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-32 rounded-md border p-1 text-sm"
        />
        <button
          onClick={() => updateSavingsGoalProgressAction(id, { currentProgress: value })}
          className="text-sm text-brand underline"
        >
          Update progress
        </button>
      </div>
    </div>
  )
}
```

`components/goals/goal-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createSavingsGoalSchema, type CreateSavingsGoalInput } from '@/lib/validation/savings-goal'
import { createSavingsGoalAction } from '@/lib/server/actions/savings-goal-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function GoalForm() {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<CreateSavingsGoalInput>({
    resolver: zodResolver(createSavingsGoalSchema),
    defaultValues: { currency: 'VND' },
  })

  async function onSubmit(values: CreateSavingsGoalInput) {
    await createSavingsGoalAction(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <Input placeholder="Goal name (e.g. MacBook)" {...register('name')} />
      <Input type="number" step="0.01" placeholder="Target amount" {...register('targetAmount', { valueAsNumber: true })} />
      <select {...register('currency')} className="rounded-md border p-2">
        <option value="VND">VND</option>
        <option value="USD">USD</option>
      </select>
      <Input type="date" {...register('deadline', { valueAsDate: true })} />
      <Button type="submit" disabled={isSubmitting}>Add goal</Button>
    </form>
  )
}
```

`app/(app)/goals/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listSavingsGoals } from '@/lib/server/services/savings-goal'
import { GoalProgressCard } from '@/components/goals/goal-progress-card'
import { GoalForm } from '@/components/goals/goal-form'

export default async function GoalsPage() {
  const user = await requireUser()
  const goals = await listSavingsGoals(user.id)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-3">
        {goals.map((g) => (
          <GoalProgressCard key={g.id} id={g.id} name={g.name} target={g.targetAmount.toNumber()} progress={g.currentProgress.toNumber()} currency={g.currency} />
        ))}
      </div>
      <GoalForm />
    </div>
  )
}
```

- [ ] **Step 4: Manual verification**

Run `npm run dev`, visit `/goals`, create a goal, update its progress manually, confirm the bar updates and no `FinancialAccount`/`Transaction` row is touched.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma lib/validation/savings-goal.ts lib/server/services/savings-goal.ts "app/(app)/goals" components/goals lib/server/actions/savings-goal-actions.ts
git commit -m "feat: add Savings Goals with manual progress tracking"
```

---

## Task 4: Debts and DebtPayments (TDD)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/validation/debt.ts`, `lib/server/services/debt.ts`, `app/(app)/debts/page.tsx`, `components/debts/debt-form.tsx`, `components/debts/debt-payment-form.tsx`, `lib/server/actions/debt-actions.ts`
- Test: `lib/server/services/debt.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `createDebt`, `recordDebtPayment` (rejects an amount exceeding outstanding via `DebtOverpaymentError`, safe against concurrent requests via a Serializable transaction), `getDebtOutstanding(userId, debtId): Promise<Decimal>`, `getDebtDisplayStatus(userId, debtId): Promise<'OPEN'|'PARTIALLY_PAID'|'PAID'|'OVERDUE'|'WRITTEN_OFF'>`, `ConcurrentModificationError` (also imported by Task 5's `loan.ts`) — Task 6 (Net Worth) and Task 7 (dashboard) both consume `getDebtOutstanding`

- [ ] **Step 1: Schema**

```prisma
enum DebtDirection {
  RECEIVABLE
  PAYABLE
}

enum DebtStoredStatus {
  ACTIVE
  WRITTEN_OFF
}

model Debt {
  id             String           @id @default(cuid())
  userId         String
  direction      DebtDirection
  person         String
  description    String?
  originalAmount Decimal          @db.Decimal(18, 2)
  currency       Currency
  dueDate        DateTime?
  status         DebtStoredStatus @default(ACTIVE)
  notes          String?
  createdAt      DateTime         @default(now())

  payments DebtPayment[]

  @@unique([userId, id])
  @@index([userId])
}

model DebtPayment {
  id     String   @id @default(cuid())
  userId String
  debtId String
  amount Decimal  @db.Decimal(18, 2)
  date   DateTime
  note   String?

  debt Debt @relation(fields: [userId, debtId], references: [userId, id])

  @@unique([userId, id])
  @@index([userId, debtId, date])
}
```
```bash
npx prisma migrate dev --name add_debt_and_debt_payment
```

- [ ] **Step 2: Write the failing tests**

`lib/server/services/debt.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { createDebt, recordDebtPayment, getDebtOutstanding, getDebtDisplayStatus, DebtOverpaymentError } from './debt'

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  return { userId: user.id }
}

async function cleanup(userId: string) {
  await prisma.debtPayment.deleteMany({ where: { userId } })
  await prisma.debt.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('Debt outstanding and status derivation', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('derives outstanding from original amount minus recorded payments, never from a stored field', async () => {
    const s = await setup()
    userId = s.userId
    const debt = await createDebt(userId, {
      direction: 'RECEIVABLE', person: 'An', originalAmount: 5_000_000, currency: 'VND',
    })
    expect((await getDebtOutstanding(userId, debt.id)).toNumber()).toBe(5_000_000)
    expect(await getDebtDisplayStatus(userId, debt.id)).toBe('OPEN')

    await recordDebtPayment(userId, debt.id, { amount: 2_000_000, date: new Date() })
    expect((await getDebtOutstanding(userId, debt.id)).toNumber()).toBe(3_000_000)
    expect(await getDebtDisplayStatus(userId, debt.id)).toBe('PARTIALLY_PAID')

    await recordDebtPayment(userId, debt.id, { amount: 3_000_000, date: new Date() })
    expect((await getDebtOutstanding(userId, debt.id)).toNumber()).toBe(0)
    expect(await getDebtDisplayStatus(userId, debt.id)).toBe('PAID')
  })

  it('never touches FinancialAccount or Transaction when a payment is recorded', async () => {
    const s = await setup()
    userId = s.userId
    const debt = await createDebt(userId, { direction: 'PAYABLE', person: 'Binh', originalAmount: 1_000_000, currency: 'VND' })
    await recordDebtPayment(userId, debt.id, { amount: 500_000, date: new Date() })
    const accountCount = await prisma.financialAccount.count({ where: { userId } })
    const txCount = await prisma.transaction.count({ where: { userId } })
    expect(accountCount).toBe(0)
    expect(txCount).toBe(0)
  })

  it('accepts a payment that exactly matches the remaining outstanding amount', async () => {
    const s = await setup()
    userId = s.userId
    const debt = await createDebt(userId, { direction: 'RECEIVABLE', person: 'An', originalAmount: 1_000_000, currency: 'VND' })
    await recordDebtPayment(userId, debt.id, { amount: 1_000_000, date: new Date() })
    expect((await getDebtOutstanding(userId, debt.id)).toNumber()).toBe(0)
  })

  it('rejects a payment exceeding the currently derived outstanding amount', async () => {
    const s = await setup()
    userId = s.userId
    const debt = await createDebt(userId, { direction: 'RECEIVABLE', person: 'An', originalAmount: 1_000_000, currency: 'VND' })
    await recordDebtPayment(userId, debt.id, { amount: 600_000, date: new Date() })
    await expect(
      recordDebtPayment(userId, debt.id, { amount: 500_000, date: new Date() }),
    ).rejects.toThrow(DebtOverpaymentError)
    // The rejected attempt must not have partially applied — outstanding is exactly what the
    // first, accepted payment left behind.
    expect((await getDebtOutstanding(userId, debt.id)).toNumber()).toBe(400_000)
  })

  it('writeOffDebt sets WRITTEN_OFF, reports it as the display status, and rejects further payments', async () => {
    const s = await setup()
    userId = s.userId
    const debt = await createDebt(userId, { direction: 'RECEIVABLE', person: 'An', originalAmount: 1_000_000, currency: 'VND' })
    await writeOffDebt(userId, debt.id)
    expect(await getDebtDisplayStatus(userId, debt.id)).toBe('WRITTEN_OFF')
    await expect(recordDebtPayment(userId, debt.id, { amount: 1, date: new Date() })).rejects.toThrow(DebtWrittenOffError)
  })
})
```
Update the test file's import to `import { createDebt, recordDebtPayment, getDebtOutstanding, getDebtDisplayStatus, writeOffDebt, DebtOverpaymentError, DebtWrittenOffError } from './debt'`.

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run lib/server/services/debt.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement**

`lib/validation/debt.ts`:
```ts
import { z } from 'zod'

export const createDebtSchema = z.object({
  direction: z.enum(['RECEIVABLE', 'PAYABLE']),
  person: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  originalAmount: z.number().positive(),
  currency: z.enum(['VND', 'USD']),
  dueDate: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
})

export const recordDebtPaymentSchema = z.object({
  amount: z.number().positive(),
  date: z.coerce.date(),
  note: z.string().max(500).optional(),
})

export type CreateDebtInput = z.infer<typeof createDebtSchema>
export type RecordDebtPaymentInput = z.infer<typeof recordDebtPaymentSchema>
```

`lib/server/services/debt.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createDebtSchema, recordDebtPaymentSchema, type CreateDebtInput, type RecordDebtPaymentInput } from '@/lib/validation/debt'

export class DebtOverpaymentError extends Error {
  constructor(outstanding: number) {
    super(`Payment exceeds the outstanding amount (${outstanding}). Enter an amount at or below what's still owed.`)
    this.name = 'DebtOverpaymentError'
  }
}

export class ConcurrentModificationError extends Error {
  constructor() {
    super('This record was updated concurrently by another request. Please try again.')
    this.name = 'ConcurrentModificationError'
  }
}

export async function listDebts(userId: string) {
  return prisma.debt.findMany({ where: { userId }, include: { payments: true }, orderBy: { createdAt: 'asc' } })
}

export async function createDebt(userId: string, input: CreateDebtInput) {
  const parsed = createDebtSchema.parse(input)
  return prisma.debt.create({ data: { userId, ...parsed } })
}

export async function getDebtOutstanding(userId: string, debtId: string): Promise<Decimal> {
  const debt = await prisma.debt.findUniqueOrThrow({ where: { userId_id: { userId, id: debtId } } })
  const paid = await prisma.debtPayment.aggregate({ where: { userId, debtId }, _sum: { amount: true } })
  return debt.originalAmount.sub(paid._sum.amount ?? new Decimal(0))
}

/**
 * Rejects a payment exceeding the currently derived outstanding amount, and is safe against
 * concurrent requests: the check-then-write runs inside a single Serializable transaction, so
 * two simultaneous payments against the same debt cannot both read the same "outstanding" value
 * and both succeed — Postgres aborts one with a serialization failure, surfaced here as
 * ConcurrentModificationError so the caller can retry rather than silently double-spend the
 * remaining balance.
 */
export async function recordDebtPayment(userId: string, debtId: string, input: RecordDebtPaymentInput) {
  const parsed = recordDebtPaymentSchema.parse(input)
  try {
    return await prisma.$transaction(
      async (tx) => {
        const debt = await tx.debt.findUniqueOrThrow({ where: { userId_id: { userId, id: debtId } } })
        if (debt.status !== 'ACTIVE') throw new DebtWrittenOffError()
        const paidSoFar = await tx.debtPayment.aggregate({ where: { userId, debtId }, _sum: { amount: true } })
        const outstanding = debt.originalAmount.sub(paidSoFar._sum.amount ?? new Decimal(0))
        if (new Decimal(parsed.amount).gt(outstanding)) {
          throw new DebtOverpaymentError(outstanding.toNumber())
        }
        // Tracking only — this intentionally has no interaction with FinancialAccount or Transaction.
        return tx.debtPayment.create({ data: { userId, debtId, ...parsed } })
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      // Verify this exact error code (Prisma's mapping of a Postgres serialization failure)
      // against the installed Prisma version's docs — it has been stable across recent major
      // versions but confirm before treating it as final.
      throw new ConcurrentModificationError()
    }
    throw err
  }
}

export async function getDebtDisplayStatus(
  userId: string,
  debtId: string,
): Promise<'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'WRITTEN_OFF'> {
  const debt = await prisma.debt.findUniqueOrThrow({ where: { userId_id: { userId, id: debtId } } })
  if (debt.status === 'WRITTEN_OFF') return 'WRITTEN_OFF'

  const outstanding = await getDebtOutstanding(userId, debtId)
  if (outstanding.lte(0)) return 'PAID'
  if (debt.dueDate && debt.dueDate < new Date()) return 'OVERDUE'
  if (outstanding.lt(debt.originalAmount)) return 'PARTIALLY_PAID'
  return 'OPEN'
}

export class DebtWrittenOffError extends Error {
  constructor() {
    super('This debt has been written off and cannot receive further payments.')
    this.name = 'DebtWrittenOffError'
  }
}

/** Marks a debt WRITTEN_OFF — the one status that is a genuine human decision rather than
 *  derivable from payments. Written-off debts are excluded from Net Worth and the dashboard
 *  overview; further payments against them are rejected. Tracking-only. */
export async function writeOffDebt(userId: string, debtId: string) {
  return prisma.debt.update({ where: { userId_id: { userId, id: debtId } }, data: { status: 'WRITTEN_OFF' } })
}
```

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run lib/server/services/debt.test.ts`
Expected: PASS, all 5 tests, including exact-final-payment, overpayment rejection, and write-off.

- [ ] **Step 6: UI**

`lib/server/actions/debt-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as debtService from '@/lib/server/services/debt'
import type { CreateDebtInput, RecordDebtPaymentInput } from '@/lib/validation/debt'

export async function createDebtAction(input: CreateDebtInput) {
  const user = await requireUser()
  await debtService.createDebt(user.id, input)
  revalidatePath('/debts')
}

export async function recordDebtPaymentAction(debtId: string, input: RecordDebtPaymentInput) {
  const user = await requireUser()
  await debtService.recordDebtPayment(user.id, debtId, input)
  revalidatePath('/debts')
  revalidatePath('/dashboard')
}

export async function writeOffDebtAction(debtId: string) {
  const user = await requireUser()
  await debtService.writeOffDebt(user.id, debtId)
  revalidatePath('/debts')
  revalidatePath('/dashboard')
}
```

`components/debts/debt-payment-form.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { recordDebtPaymentAction } from '@/lib/server/actions/debt-actions'

export function DebtPaymentForm({ debtId }: { debtId: string }) {
  const [amount, setAmount] = useState(0)

  return (
    <div className="flex gap-2">
      <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="w-32 rounded-md border p-1 text-sm" />
      <button
        onClick={() => recordDebtPaymentAction(debtId, { amount, date: new Date() })}
        className="text-sm text-brand underline"
      >
        Record payment
      </button>
    </div>
  )
}
```

`components/debts/debt-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createDebtSchema, type CreateDebtInput } from '@/lib/validation/debt'
import { createDebtAction } from '@/lib/server/actions/debt-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function DebtForm() {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<CreateDebtInput>({
    resolver: zodResolver(createDebtSchema),
    defaultValues: { currency: 'VND', direction: 'RECEIVABLE' },
  })

  async function onSubmit(values: CreateDebtInput) {
    await createDebtAction(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <select {...register('direction')} className="rounded-md border p-2">
        <option value="RECEIVABLE">Someone owes me</option>
        <option value="PAYABLE">I owe someone</option>
      </select>
      <Input placeholder="Person" {...register('person')} />
      <Input type="number" step="0.01" placeholder="Original amount" {...register('originalAmount', { valueAsNumber: true })} />
      <select {...register('currency')} className="rounded-md border p-2">
        <option value="VND">VND</option>
        <option value="USD">USD</option>
      </select>
      <Input type="date" {...register('dueDate', { valueAsDate: true })} />
      <Button type="submit" disabled={isSubmitting}>Add debt</Button>
    </form>
  )
}
```

`app/(app)/debts/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listDebts, getDebtOutstanding, getDebtDisplayStatus } from '@/lib/server/services/debt'
import { DebtForm } from '@/components/debts/debt-form'
import { DebtPaymentForm } from '@/components/debts/debt-payment-form'
import { writeOffDebtAction } from '@/lib/server/actions/debt-actions'

export default async function DebtsPage() {
  const user = await requireUser()
  const debts = await listDebts(user.id)
  const withStatus = await Promise.all(
    debts.map(async (d) => ({
      ...d,
      outstanding: await getDebtOutstanding(user.id, d.id),
      displayStatus: await getDebtDisplayStatus(user.id, d.id),
    })),
  )

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <ul className="flex flex-col gap-2">
        {withStatus.map((d) => (
          <li key={d.id} className="rounded-md border p-3">
            <p className="font-medium">{d.person} · {d.direction} · {d.displayStatus}</p>
            <p className="tabular-nums text-sm">{d.outstanding.toString()} / {d.originalAmount.toString()} {d.currency}</p>
            {d.status === 'ACTIVE' && <DebtPaymentForm debtId={d.id} />}
            {d.status === 'ACTIVE' && (
              <form action={async () => { 'use server'; await writeOffDebtAction(d.id) }}>
                <button type="submit" className="text-sm text-negative underline">Write off</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <DebtForm />
    </div>
  )
}
```

- [ ] **Step 7: Manual verification**

Run `npm run dev`, visit `/debts`, create a receivable and a payable, record partial and full payments, confirm the derived status and outstanding amount update correctly and no account/transaction is affected.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma lib/validation/debt.ts lib/server/services/debt.ts lib/server/services/debt.test.ts "app/(app)/debts" components/debts lib/server/actions/debt-actions.ts
git commit -m "feat: add Debts with derived outstanding and status"
```

---

## Task 5: Loans and LoanPayments (TDD)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/datetime/add-months-clamped.ts`, `lib/datetime/add-months-clamped.test.ts`, `lib/validation/loan.ts`, `lib/server/services/loan.ts`, `lib/server/services/loan.test.ts`, `app/(app)/loans/page.tsx`, `components/loans/loan-form.tsx`, `components/loans/loan-payment-form.tsx`, `lib/server/actions/loan-actions.ts`

**Interfaces:**
- Consumes: `ConcurrentModificationError` (Task 4, `./debt`)
- Produces: `createLoan`, `recordLoanPayment` (validates `totalAmount = principalAmount + interestAmount`, rejects `principalAmount` exceeding outstanding principal via `LoanOverpaymentError`, and atomically advances `nextDueDate` by one payment-frequency interval — all inside one Serializable transaction), `getLoanOutstandingPrincipal(userId, loanId): Promise<Decimal>` — Task 6/7 consume `getLoanOutstandingPrincipal`

- [ ] **Step 1: Schema, including the CHECK constraint via raw-SQL migration**

```prisma
enum LoanStoredStatus {
  ACTIVE
  CLOSED
}

enum PaymentFrequency {
  WEEKLY
  MONTHLY
  YEARLY
}

model Loan {
  id                     String           @id @default(cuid())
  userId                 String
  lender                 String
  principal              Decimal          @db.Decimal(18, 2)
  currency               Currency
  interestRate           Decimal          @db.Decimal(6, 3)
  startDate              DateTime
  termMonths             Int
  paymentFrequency       PaymentFrequency
  scheduledPaymentAmount Decimal          @db.Decimal(18, 2)
  nextDueDate            DateTime
  status                 LoanStoredStatus @default(ACTIVE)
  notes                  String?
  createdAt              DateTime         @default(now())

  payments LoanPayment[]

  @@unique([userId, id])
  @@index([userId])
}

model LoanPayment {
  id              String   @id @default(cuid())
  userId          String
  loanId          String
  totalAmount     Decimal  @db.Decimal(18, 2)
  principalAmount Decimal  @db.Decimal(18, 2)
  interestAmount  Decimal  @db.Decimal(18, 2)
  paymentDate     DateTime
  note            String?

  loan Loan @relation(fields: [userId, loanId], references: [userId, id])

  @@unique([userId, id])
  @@index([userId, loanId, paymentDate])
}
```
```bash
npx prisma migrate dev --name add_loan --create-only
```
Append to the generated migration SQL:
```sql
ALTER TABLE "LoanPayment" ADD CONSTRAINT "loan_payment_total_matches_split"
  CHECK ("totalAmount" = "principalAmount" + "interestAmount");
```
```bash
npx prisma migrate dev
npx prisma generate
```

- [ ] **Step 2: Verify the CHECK constraint (manual, one-time)**

```bash
npx tsx -e "
import { prisma } from './lib/prisma'
async function main() {
  const user = await prisma.user.create({ data: { id: crypto.randomUUID(), email: 'check-test@example.com', name: 'Test', emailVerified: false } })
  const loan = await prisma.loan.create({ data: { userId: user.id, lender: 'Bank', principal: 100000000, currency: 'VND', interestRate: 8.5, startDate: new Date(), termMonths: 12, paymentFrequency: 'MONTHLY', scheduledPaymentAmount: 9000000, nextDueDate: new Date() } })
  try {
    await prisma.loanPayment.create({ data: { userId: user.id, loanId: loan.id, totalAmount: 9000000, principalAmount: 8000000, interestAmount: 500000, paymentDate: new Date() } })
    console.error('FAIL: mismatched total/principal/interest split was accepted')
  } catch {
    console.log('PASS: mismatched split was correctly rejected by the CHECK constraint')
  }
  await prisma.loan.delete({ where: { id: loan.id } })
  await prisma.user.delete({ where: { id: user.id } })
}
main()
"
```
Expected: `PASS: ...`.

- [ ] **Step 3: Validation and service**

`lib/validation/loan.ts`:
```ts
import { z } from 'zod'

export const createLoanSchema = z.object({
  lender: z.string().min(1).max(100),
  principal: z.number().positive(),
  currency: z.enum(['VND', 'USD']),
  interestRate: z.number().min(0).max(100),
  startDate: z.coerce.date(),
  termMonths: z.number().int().positive(),
  paymentFrequency: z.enum(['WEEKLY', 'MONTHLY', 'YEARLY']),
  scheduledPaymentAmount: z.number().positive(),
  nextDueDate: z.coerce.date(),
  notes: z.string().max(500).optional(),
})

export const recordLoanPaymentSchema = z
  .object({
    totalAmount: z.number().positive(),
    principalAmount: z.number().positive(),
    interestAmount: z.number().min(0),
    paymentDate: z.coerce.date(),
    note: z.string().max(500).optional(),
  })
  .refine((d) => Math.abs(d.totalAmount - (d.principalAmount + d.interestAmount)) < 0.01, {
    message: 'Total amount must equal principal plus interest',
    path: ['totalAmount'],
  })

export type CreateLoanInput = z.infer<typeof createLoanSchema>
export type RecordLoanPaymentInput = z.infer<typeof recordLoanPaymentSchema>
```
Zod validates the split before the database ever sees it — the CHECK constraint from Step 1 is the second, defense-in-depth layer, matching the pattern already used for `isDemo`.

- [ ] **Step 3a: Calendar-safe schedule advancement (TDD)**

Raw `Date.setUTCMonth`/`setUTCFullYear` overflow on month-end dates (Jan 31 + 1 month → "Feb 31" → Mar 3). Payment schedules need clamping to the last valid day of the target month.

`lib/datetime/add-months-clamped.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { addMonthsUtcClamped, advanceByFrequency } from './add-months-clamped'

const d = (iso: string) => new Date(iso)
const day = (x: Date) => x.toISOString().slice(0, 10)

describe('addMonthsUtcClamped', () => {
  it('Jan 31 2026 + 1 month → Feb 28 2026', () => {
    expect(day(addMonthsUtcClamped(d('2026-01-31T00:00:00Z'), 1))).toBe('2026-02-28')
  })
  it('Jan 31 2028 + 1 month → Feb 29 2028 (leap year)', () => {
    expect(day(addMonthsUtcClamped(d('2028-01-31T00:00:00Z'), 1))).toBe('2028-02-29')
  })
  it('Feb 29 2028 + 12 months → Feb 28 2029', () => {
    expect(day(addMonthsUtcClamped(d('2028-02-29T00:00:00Z'), 12))).toBe('2029-02-28')
  })
  it('preserves the time-of-day component', () => {
    expect(addMonthsUtcClamped(d('2026-01-31T09:30:00Z'), 1).toISOString()).toBe('2026-02-28T09:30:00.000Z')
  })
})

describe('advanceByFrequency', () => {
  it('WEEKLY adds 7 days', () => expect(day(advanceByFrequency(d('2026-01-31T00:00:00Z'), 'WEEKLY'))).toBe('2026-02-07'))
  it('MONTHLY clamps', () => expect(day(advanceByFrequency(d('2026-01-31T00:00:00Z'), 'MONTHLY'))).toBe('2026-02-28'))
  it('YEARLY clamps', () => expect(day(advanceByFrequency(d('2028-02-29T00:00:00Z'), 'YEARLY'))).toBe('2029-02-28'))
})
```
Run: `npx vitest run lib/datetime/add-months-clamped.test.ts` — expected FAIL, module does not exist.

`lib/datetime/add-months-clamped.ts`:
```ts
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/** Adds whole months, clamping the day-of-month to the target month's length. Time of day is preserved. */
export function addMonthsUtcClamped(date: Date, months: number): Date {
  const totalMonths = date.getUTCMonth() + months
  const year = date.getUTCFullYear() + Math.floor(totalMonths / 12)
  const monthIndex = ((totalMonths % 12) + 12) % 12
  const day = Math.min(date.getUTCDate(), daysInUtcMonth(year, monthIndex))
  return new Date(Date.UTC(
    year, monthIndex, day,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ))
}

export type PaymentFrequency = 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export function advanceByFrequency(date: Date, frequency: PaymentFrequency): Date {
  switch (frequency) {
    case 'WEEKLY':
      return new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000)
    case 'MONTHLY':
      return addMonthsUtcClamped(date, 1)
    case 'YEARLY':
      return addMonthsUtcClamped(date, 12)
  }
}
```
Run: `npx vitest run lib/datetime/add-months-clamped.test.ts` — expected PASS, all 7 tests.

- [ ] **Step 4: Write the failing tests**

`lib/server/services/loan.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { createLoan, recordLoanPayment, getLoanOutstandingPrincipal, LoanOverpaymentError } from './loan'

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  return { userId: user.id }
}

async function cleanup(userId: string) {
  await prisma.loanPayment.deleteMany({ where: { userId } })
  await prisma.loan.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

function loanInput(overrides: Partial<Parameters<typeof createLoan>[1]> = {}) {
  return {
    lender: 'Bank', principal: 1_000_000, currency: 'VND' as const, interestRate: 5,
    startDate: new Date('2026-01-01'), termMonths: 12, paymentFrequency: 'MONTHLY' as const,
    scheduledPaymentAmount: 90_000, nextDueDate: new Date('2026-02-01'),
    ...overrides,
  }
}

describe('recordLoanPayment', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('accepts a principal payment that exactly matches outstanding principal', async () => {
    const s = await setup()
    userId = s.userId
    const loan = await createLoan(userId, loanInput())
    await recordLoanPayment(userId, loan.id, { totalAmount: 1_000_000, principalAmount: 1_000_000, interestAmount: 0, paymentDate: new Date() })
    expect((await getLoanOutstandingPrincipal(userId, loan.id)).toNumber()).toBe(0)
  })

  it('rejects a principal payment exceeding outstanding principal, and does not advance nextDueDate', async () => {
    const s = await setup()
    userId = s.userId
    const loan = await createLoan(userId, loanInput())
    const before = await prisma.loan.findUniqueOrThrow({ where: { userId_id: { userId, id: loan.id } } })

    await expect(
      recordLoanPayment(userId, loan.id, { totalAmount: 1_100_000, principalAmount: 1_100_000, interestAmount: 0, paymentDate: new Date() }),
    ).rejects.toThrow(LoanOverpaymentError)

    const after = await prisma.loan.findUniqueOrThrow({ where: { userId_id: { userId, id: loan.id } } })
    // Proves atomicity without simulating a mid-transaction crash: if the rejected payment had
    // partially applied, nextDueDate would have advanced anyway. It must not have.
    expect(after.nextDueDate.getTime()).toBe(before.nextDueDate.getTime())
    expect(await prisma.loanPayment.count({ where: { userId, loanId: loan.id } })).toBe(0)
  })

  it('advances nextDueDate by one payment-frequency interval on a successful payment', async () => {
    const s = await setup()
    userId = s.userId
    const loan = await createLoan(userId, loanInput())
    await recordLoanPayment(userId, loan.id, { totalAmount: 90_000, principalAmount: 80_000, interestAmount: 10_000, paymentDate: new Date() })
    const after = await prisma.loan.findUniqueOrThrow({ where: { userId_id: { userId, id: loan.id } } })
    expect(after.nextDueDate.toISOString().slice(0, 10)).toBe('2026-03-01')
  })

  it('clamps month-end due dates when advancing (Jan 31 → Feb 28)', async () => {
    const s = await setup()
    userId = s.userId
    const loan = await createLoan(userId, loanInput({ nextDueDate: new Date('2026-01-31T00:00:00Z') }))
    await recordLoanPayment(userId, loan.id, { totalAmount: 90_000, principalAmount: 80_000, interestAmount: 10_000, paymentDate: new Date() })
    const after = await prisma.loan.findUniqueOrThrow({ where: { userId_id: { userId, id: loan.id } } })
    expect(after.nextDueDate.toISOString().slice(0, 10)).toBe('2026-02-28')
  })

  it('closeLoan marks the loan CLOSED and further payments are rejected', async () => {
    const s = await setup()
    userId = s.userId
    const loan = await createLoan(userId, loanInput())
    const closed = await closeLoan(userId, loan.id)
    expect(closed.status).toBe('CLOSED')
    await expect(
      recordLoanPayment(userId, loan.id, { totalAmount: 90_000, principalAmount: 80_000, interestAmount: 10_000, paymentDate: new Date() }),
    ).rejects.toThrow(LoanClosedError)
  })
})
```
Update the test file's import to `import { createLoan, recordLoanPayment, getLoanOutstandingPrincipal, closeLoan, LoanOverpaymentError, LoanClosedError } from './loan'`.

- [ ] **Step 5: Run and verify they fail**

Run: `npx vitest run lib/server/services/loan.test.ts`
Expected: FAIL — `./loan` does not exist yet.

- [ ] **Step 6: Implement the service**

`lib/server/services/loan.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createLoanSchema, recordLoanPaymentSchema, type CreateLoanInput, type RecordLoanPaymentInput } from '@/lib/validation/loan'
import { ConcurrentModificationError } from './debt'
import { advanceByFrequency } from '@/lib/datetime/add-months-clamped'

export class LoanClosedError extends Error {
  constructor() {
    super('This loan is closed and cannot receive further payments.')
    this.name = 'LoanClosedError'
  }
}

export class LoanOverpaymentError extends Error {
  constructor(outstandingPrincipal: number) {
    super(`Principal payment exceeds the outstanding principal (${outstandingPrincipal}).`)
    this.name = 'LoanOverpaymentError'
  }
}

export async function listLoans(userId: string) {
  return prisma.loan.findMany({ where: { userId }, include: { payments: true }, orderBy: { createdAt: 'asc' } })
}

export async function createLoan(userId: string, input: CreateLoanInput) {
  const parsed = createLoanSchema.parse(input)
  return prisma.loan.create({ data: { userId, ...parsed } })
}

/** Marks a loan CLOSED. Closed loans are excluded from Net Worth and the dashboard overview;
 *  recording further payments against a closed loan is rejected. Tracking-only — never touches
 *  FinancialAccount or Transaction. */
export async function closeLoan(userId: string, loanId: string) {
  return prisma.loan.update({ where: { userId_id: { userId, id: loanId } }, data: { status: 'CLOSED' } })
}

export async function getLoanOutstandingPrincipal(userId: string, loanId: string): Promise<Decimal> {
  const loan = await prisma.loan.findUniqueOrThrow({ where: { userId_id: { userId, id: loanId } } })
  const paid = await prisma.loanPayment.aggregate({ where: { userId, loanId }, _sum: { principalAmount: true } })
  return loan.principal.sub(paid._sum.principalAmount ?? new Decimal(0))
}

/**
 * Rejects a principalAmount exceeding the currently derived outstanding principal, and creates
 * the LoanPayment together with advancing nextDueDate atomically — one cannot succeed without
 * the other, so a rejected/failed payment never leaves nextDueDate advanced with no payment
 * behind it. The check-then-write and the two writes together run inside one Serializable
 * transaction, safe against concurrent requests the same way recordDebtPayment is.
 */
export async function recordLoanPayment(userId: string, loanId: string, input: RecordLoanPaymentInput) {
  const parsed = recordLoanPaymentSchema.parse(input)
  try {
    return await prisma.$transaction(
      async (tx) => {
        const loan = await tx.loan.findUniqueOrThrow({ where: { userId_id: { userId, id: loanId } } })
        if (loan.status !== 'ACTIVE') throw new LoanClosedError()
        const paidSoFar = await tx.loanPayment.aggregate({ where: { userId, loanId }, _sum: { principalAmount: true } })
        const outstandingPrincipal = loan.principal.sub(paidSoFar._sum.principalAmount ?? new Decimal(0))
        if (new Decimal(parsed.principalAmount).gt(outstandingPrincipal)) {
          throw new LoanOverpaymentError(outstandingPrincipal.toNumber())
        }

        // Tracking only — no interaction with FinancialAccount or Transaction.
        const payment = await tx.loanPayment.create({ data: { userId, loanId, ...parsed } })
        await tx.loan.update({
          where: { userId_id: { userId, id: loanId } },
          data: { nextDueDate: advanceByFrequency(loan.nextDueDate, loan.paymentFrequency) },
        })
        return payment
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new ConcurrentModificationError()
    }
    throw err
  }
}
```
`ConcurrentModificationError` is imported from `./debt` rather than redefined here, since it's the same concurrency-conflict concept for either model — one shared error class, not two identical ones.

- [ ] **Step 7: Run and verify they pass**

Run: `npx vitest run lib/server/services/loan.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 8: UI**

`lib/server/actions/loan-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as loanService from '@/lib/server/services/loan'
import type { CreateLoanInput, RecordLoanPaymentInput } from '@/lib/validation/loan'

export async function createLoanAction(input: CreateLoanInput) {
  const user = await requireUser()
  await loanService.createLoan(user.id, input)
  revalidatePath('/loans')
}

export async function recordLoanPaymentAction(loanId: string, input: RecordLoanPaymentInput) {
  const user = await requireUser()
  await loanService.recordLoanPayment(user.id, loanId, input)
  revalidatePath('/loans')
  revalidatePath('/dashboard')
}

export async function closeLoanAction(loanId: string) {
  const user = await requireUser()
  await loanService.closeLoan(user.id, loanId)
  revalidatePath('/loans')
  revalidatePath('/dashboard')
}
```

`components/loans/loan-payment-form.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { recordLoanPaymentAction } from '@/lib/server/actions/loan-actions'

export function LoanPaymentForm({ loanId }: { loanId: string }) {
  const [principal, setPrincipal] = useState(0)
  const [interest, setInterest] = useState(0)

  return (
    <div className="flex items-center gap-2">
      <input type="number" placeholder="Principal" value={principal} onChange={(e) => setPrincipal(Number(e.target.value))} className="w-28 rounded-md border p-1 text-sm" />
      <input type="number" placeholder="Interest" value={interest} onChange={(e) => setInterest(Number(e.target.value))} className="w-28 rounded-md border p-1 text-sm" />
      <button
        onClick={() => recordLoanPaymentAction(loanId, { totalAmount: principal + interest, principalAmount: principal, interestAmount: interest, paymentDate: new Date() })}
        className="text-sm text-brand underline"
      >
        Record payment
      </button>
    </div>
  )
}
```

`components/loans/loan-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createLoanSchema, type CreateLoanInput } from '@/lib/validation/loan'
import { createLoanAction } from '@/lib/server/actions/loan-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoanForm() {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<CreateLoanInput>({
    resolver: zodResolver(createLoanSchema),
    defaultValues: { currency: 'VND', paymentFrequency: 'MONTHLY' },
  })

  async function onSubmit(values: CreateLoanInput) {
    await createLoanAction(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <Input placeholder="Lender" {...register('lender')} />
      <Input type="number" step="0.01" placeholder="Principal" {...register('principal', { valueAsNumber: true })} />
      <Input type="number" step="0.01" placeholder="Interest rate (%)" {...register('interestRate', { valueAsNumber: true })} />
      <Input type="date" {...register('startDate', { valueAsDate: true })} />
      <Input type="number" placeholder="Term (months)" {...register('termMonths', { valueAsNumber: true })} />
      <select {...register('paymentFrequency')} className="rounded-md border p-2">
        <option value="MONTHLY">Monthly</option>
        <option value="WEEKLY">Weekly</option>
        <option value="YEARLY">Yearly</option>
      </select>
      <Input type="number" step="0.01" placeholder="Scheduled payment amount" {...register('scheduledPaymentAmount', { valueAsNumber: true })} />
      <Input type="date" {...register('nextDueDate', { valueAsDate: true })} />
      <Button type="submit" disabled={isSubmitting}>Add loan</Button>
    </form>
  )
}
```

`app/(app)/loans/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listLoans, getLoanOutstandingPrincipal } from '@/lib/server/services/loan'
import { LoanForm } from '@/components/loans/loan-form'
import { LoanPaymentForm } from '@/components/loans/loan-payment-form'
import { closeLoanAction } from '@/lib/server/actions/loan-actions'

export default async function LoansPage() {
  const user = await requireUser()
  const loans = await listLoans(user.id)
  const withOutstanding = await Promise.all(
    loans.map(async (l) => ({ ...l, outstanding: await getLoanOutstandingPrincipal(user.id, l.id) })),
  )

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <ul className="flex flex-col gap-2">
        {withOutstanding.map((l) => (
          <li key={l.id} className="rounded-md border p-3">
            <p className="font-medium">{l.lender}</p>
            <p className="tabular-nums text-sm">
              Outstanding: {l.outstanding.toString()} / {l.principal.toString()} {l.currency} · Next due {new Date(l.nextDueDate).toLocaleDateString()}
            </p>
            {l.status === 'ACTIVE' && <LoanPaymentForm loanId={l.id} />}
            {l.status === 'ACTIVE' && (
              <form action={async () => { 'use server'; await closeLoanAction(l.id) }}>
                <button type="submit" className="text-sm text-negative underline">Close loan</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <LoanForm />
    </div>
  )
}
```

- [ ] **Step 9: Manual verification**

Run `npm run dev`, visit `/loans`, create a loan, record a payment with a valid principal/interest split, confirm outstanding principal decreases and `nextDueDate` advances. Attempt a payment via `recordLoanPaymentAction` with a mismatched split (e.g., by temporarily editing the form to send `totalAmount` unequal to the sum) — confirm Zod rejects it before it reaches the database. Attempt a principal payment larger than the outstanding principal — confirm it's rejected with a clear message and `nextDueDate` is unchanged.

- [ ] **Step 10: Verification before commit**

```bash
npx prisma validate
npm run lint
npm run build
```

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/datetime/add-months-clamped.ts lib/datetime/add-months-clamped.test.ts lib/validation/loan.ts lib/server/services/loan.ts lib/server/services/loan.test.ts "app/(app)/loans" components/loans lib/server/actions/loan-actions.ts
git commit -m "feat: add Loans with derived outstanding principal, overpayment rejection, calendar-safe due-date advancement, and close action"
```

---

## Task 6: Extend Net Worth (TDD)

**Files:**
- Modify: `lib/server/services/net-worth.ts`
- Test: `lib/server/services/net-worth.test.ts`

**Interfaces:**
- Consumes: `getDebtOutstanding` (Task 4), `getLoanOutstandingPrincipal` (Task 5)
- Produces: `getNetWorth` (same signature as Phase 4, extended body) — Phase 4's dashboard already calls this, so the dashboard picks up the extension automatically once this task lands

**Semantics note (deliberate, not an oversight):** after this task the Net Worth *KPI* = accounts + active receivables − active payables − active outstanding loan principal, all converted at the current rate. The historical chart built in Phase 4 remains **"Account Balance Over Time"** and reconstructs account balances only. It is intentionally *not* renamed "Net Worth Over Time": Debt/Loan have no temporal status history, so their past state cannot be reconstructed, and approximating it with today's outstanding values would fabricate history. True historical Net Worth is documented as deferred in the spec (§17). Do not change the chart's label or formula in this task.

- [ ] **Step 1: Add the failing test case to the existing suite**

Add to `lib/server/services/net-worth.test.ts`:
```ts
it('adds receivables, subtracts payables and outstanding loan principal', async () => {
  const s = await setup()
  userId = s.userId
  await prisma.debt.create({ data: { userId, direction: 'RECEIVABLE', person: 'An', originalAmount: 2_000_000, currency: 'VND' } })
  await prisma.debt.create({ data: { userId, direction: 'PAYABLE', person: 'Binh', originalAmount: 500_000, currency: 'VND' } })
  const accountType = await prisma.accountType.findFirstOrThrow({ where: { userId } })
  await prisma.loan.create({
    data: { userId, lender: 'Bank', principal: 1_000_000, currency: 'VND', interestRate: 5, startDate: new Date(), termMonths: 12, paymentFrequency: 'MONTHLY', scheduledPaymentAmount: 90000, nextDueDate: new Date() },
  })

  const totalBalance = await getTotalAccountBalance(userId, 'VND', fakeProvider)
  const netWorth = await getNetWorth(userId, 'VND', fakeProvider)
  // totalBalance + 2,000,000 (receivable) − 500,000 (payable) − 1,000,000 (loan principal)
  expect(netWorth.toNumber()).toBe(totalBalance.toNumber() + 2_000_000 - 500_000 - 1_000_000)
})
```
Import `getDebtOutstanding` isn't needed directly in the test — it's exercised indirectly through `getNetWorth`.

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run lib/server/services/net-worth.test.ts`
Expected: FAIL on the new case — the current `getNetWorth` body ignores debts/loans entirely.

- [ ] **Step 3: Extend the implementation**

Replace `getNetWorth` in `lib/server/services/net-worth.ts`:
```ts
export async function getNetWorth(
  userId: string,
  displayCurrency: Currency,
  providerOverride?: ExchangeRateProvider,
): Promise<Decimal> {
  const accountTotal = await getTotalAccountBalance(userId, displayCurrency, providerOverride)

  const [receivables, payables, loans] = await Promise.all([
    prisma.debt.findMany({ where: { userId, direction: 'RECEIVABLE', status: 'ACTIVE' } }),
    prisma.debt.findMany({ where: { userId, direction: 'PAYABLE', status: 'ACTIVE' } }),
    prisma.loan.findMany({ where: { userId, status: 'ACTIVE' } }),
  ])

  let total = accountTotal

  for (const debt of receivables) {
    const outstanding = await getDebtOutstanding(userId, debt.id)
    total = total.add(await convertToCurrentAmount(outstanding, debt.currency, displayCurrency, providerOverride))
  }
  for (const debt of payables) {
    const outstanding = await getDebtOutstanding(userId, debt.id)
    total = total.sub(await convertToCurrentAmount(outstanding, debt.currency, displayCurrency, providerOverride))
  }
  for (const loan of loans) {
    const outstanding = await getLoanOutstandingPrincipal(userId, loan.id)
    total = total.sub(await convertToCurrentAmount(outstanding, loan.currency, displayCurrency, providerOverride))
  }

  return total
}
```
Add the two new imports: `import { getDebtOutstanding } from './debt'` and `import { getLoanOutstandingPrincipal } from './loan'`.

- [ ] **Step 4: Run and verify all Net Worth tests pass**

Run: `npx vitest run lib/server/services/net-worth.test.ts`
Expected: PASS, including the original "equals total account balance" test from Phase 4 — re-check that one specifically, since it asserted equality when no debts/loans/receivables exist at all, which still holds (each of the three loops iterates over an empty list).

- [ ] **Step 5: Commit**

```bash
git add lib/server/services/net-worth.ts lib/server/services/net-worth.test.ts
git commit -m "feat: extend Net Worth to include receivables, payables, and outstanding loan principal"
```

---

## Task 7: Remaining dashboard widgets and export sheets

**Files:**
- Create: `lib/server/services/debt-loan-overview.ts`, `lib/server/services/debt-loan-overview.test.ts`
- Modify: `app/(app)/dashboard/page.tsx`, `app/api/reports/export/route.ts`
- Create: `components/dashboard/upcoming-reminders.tsx`, `components/dashboard/debt-loan-overview.tsx`, `lib/server/export/build-savings-goals-sheet.ts`, `lib/server/export/build-debts-sheet.ts`, `lib/server/export/build-debt-payments-sheet.ts`, `lib/server/export/build-loans-sheet.ts`, `lib/server/export/build-loan-payments-sheet.ts`, `lib/server/export/build-reminders-sheet.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5, `registerExportSheet` (Phase 4)
- Produces: nothing new — this closes out the dashboard (all ten widgets now present) and the full export (all eleven sheets now present)

- [ ] **Step 1: Dashboard widget components**

`components/dashboard/upcoming-reminders.tsx`:
```tsx
type Row = { id: string; dueAt: Date; reminder: { title: string; expectedAmount: unknown; currency: string } }

export function UpcomingReminders({ occurrences }: { occurrences: Row[] }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Upcoming Reminders</h3>
      <ul className="flex flex-col gap-1">
        {occurrences.slice(0, 5).map((o) => (
          <li key={o.id} className="flex justify-between text-sm">
            <span>{o.reminder.title}</span>
            <span className="tabular-nums">{new Date(o.dueAt).toLocaleDateString()} · {String(o.reminder.expectedAmount)} {o.reminder.currency}</span>
          </li>
        ))}
        {occurrences.length === 0 && <li className="text-sm text-foreground/60">Nothing due soon.</li>}
      </ul>
    </div>
  )
}
```

`components/dashboard/debt-loan-overview.tsx`:
```tsx
export function DebtLoanOverview({
  receivables, payables, loanOutstanding, currency,
}: { receivables: number; payables: number; loanOutstanding: number; currency: string }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Debt / Loan Overview</h3>
      <ul className="flex flex-col gap-1 text-sm">
        <li className="flex justify-between"><span>Receivables</span><span className="tabular-nums text-positive">{receivables.toLocaleString('vi-VN')} {currency}</span></li>
        <li className="flex justify-between"><span>Payables</span><span className="tabular-nums text-negative">{payables.toLocaleString('vi-VN')} {currency}</span></li>
        <li className="flex justify-between"><span>Outstanding Loans</span><span className="tabular-nums text-negative">{loanOutstanding.toLocaleString('vi-VN')} {currency}</span></li>
      </ul>
    </div>
  )
}
```

- [ ] **Step 1a: Currency-correct Debt/Loan overview service (TDD)**

Debts and loans each carry their own currency. Summing their native `Decimal` outstanding values and labeling the result with `displayCurrency` would be wrong the moment one record is in a different currency. Each record is converted through the shared current-rate policy (`convertToCurrentAmount`, Phase 3) *before* aggregation, exactly as `getNetWorth` (Task 6) already does. Only `ACTIVE` records count — written-off debts and closed loans are excluded.

`lib/server/services/debt-loan-overview.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { getDebtLoanOverview } from './debt-loan-overview'
import type { ExchangeRateProvider } from '@/lib/currency/provider'

const fakeProvider: ExchangeRateProvider = {
  getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
  getHistoricalRate: async () => null,
}

describe('getDebtLoanOverview', () => {
  let userId: string
  afterEach(async () => {
    await prisma.loan.deleteMany({ where: { userId } })
    await prisma.debt.deleteMany({ where: { userId } })
    await prisma.exchangeRate.deleteMany({ where: { source: 'fake' } })
    await prisma.user.delete({ where: { id: userId } })
  })

  it('converts each record to the display currency before aggregating, and ignores non-ACTIVE records', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
    })
    userId = user.id
    await prisma.debt.create({ data: { userId, direction: 'RECEIVABLE', person: 'An', originalAmount: 100, currency: 'USD' } })
    await prisma.debt.create({ data: { userId, direction: 'PAYABLE', person: 'Binh', originalAmount: 1_000_000, currency: 'VND' } })
    await prisma.debt.create({ data: { userId, direction: 'PAYABLE', person: 'Ignored', originalAmount: 999_999_999, currency: 'VND', status: 'WRITTEN_OFF' } })
    await prisma.loan.create({
      data: { userId, lender: 'Bank', principal: 200, currency: 'USD', interestRate: 5, startDate: new Date(), termMonths: 12, paymentFrequency: 'MONTHLY', scheduledPaymentAmount: 20, nextDueDate: new Date() },
    })
    await prisma.loan.create({
      data: { userId, lender: 'Closed', principal: 999_999_999, currency: 'VND', interestRate: 5, startDate: new Date(), termMonths: 12, paymentFrequency: 'MONTHLY', scheduledPaymentAmount: 1, nextDueDate: new Date(), status: 'CLOSED' },
    })

    const overview = await getDebtLoanOverview(userId, 'VND', fakeProvider)
    expect(overview.receivables.toNumber()).toBe(2_500_000)   // 100 USD × 25,000
    expect(overview.payables.toNumber()).toBe(1_000_000)      // native VND, written-off one excluded
    expect(overview.loanOutstanding.toNumber()).toBe(5_000_000) // 200 USD × 25,000, closed one excluded
  })
})
```
Run: `npx vitest run lib/server/services/debt-loan-overview.test.ts` — expected FAIL, module does not exist.

`lib/server/services/debt-loan-overview.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/prisma'
import { getDebtOutstanding } from './debt'
import { getLoanOutstandingPrincipal } from './loan'
import { convertToCurrentAmount } from '@/lib/currency/current-amount'
import type { Currency, ExchangeRateProvider } from '@/lib/currency/provider'

export async function getDebtLoanOverview(
  userId: string,
  displayCurrency: Currency,
  providerOverride?: ExchangeRateProvider,
) {
  const [debts, loans] = await Promise.all([
    prisma.debt.findMany({ where: { userId, status: 'ACTIVE' } }),
    prisma.loan.findMany({ where: { userId, status: 'ACTIVE' } }),
  ])

  let receivables = new Decimal(0)
  let payables = new Decimal(0)
  let loanOutstanding = new Decimal(0)

  for (const debt of debts) {
    const native = await getDebtOutstanding(userId, debt.id)
    const converted = await convertToCurrentAmount(native, debt.currency, displayCurrency, providerOverride)
    if (debt.direction === 'RECEIVABLE') receivables = receivables.add(converted)
    else payables = payables.add(converted)
  }
  for (const loan of loans) {
    const native = await getLoanOutstandingPrincipal(userId, loan.id)
    loanOutstanding = loanOutstanding.add(await convertToCurrentAmount(native, loan.currency, displayCurrency, providerOverride))
  }

  return { receivables, payables, loanOutstanding }
}
```
Run: `npx vitest run lib/server/services/debt-loan-overview.test.ts` — expected PASS.

- [ ] **Step 2: Wire the widgets into the dashboard, plus Savings Goal progress reusing Task 3's card**

In `app/(app)/dashboard/page.tsx`, add to the data-fetching:
```tsx
import { listUpcomingOccurrences } from '@/lib/server/services/reminder'
import { listSavingsGoals } from '@/lib/server/services/savings-goal'
import { getDebtLoanOverview } from '@/lib/server/services/debt-loan-overview'
import { UpcomingReminders } from '@/components/dashboard/upcoming-reminders'
import { DebtLoanOverview } from '@/components/dashboard/debt-loan-overview'
import { GoalProgressCard } from '@/components/goals/goal-progress-card'

// ...inside the component, alongside the existing Promise.all (reuses `timezone`, `displayCurrency`
// and the `orNull` helper Phase 4 Task 5 already defined — the overview is a current-position
// figure, so it degrades to null under an FX outage like Total Balance does):
const [occurrences, goals, overview] = await Promise.all([
  listUpcomingOccurrences(user.id, timezone),
  listSavingsGoals(user.id),
  orNull(getDebtLoanOverview(user.id, displayCurrency)),
])
```

Render, after the existing charts grid:
```tsx
<div className="grid gap-4 md:grid-cols-2">
  <UpcomingReminders occurrences={occurrences} />
  {overview && (
    <DebtLoanOverview
      receivables={overview.receivables.toNumber()}
      payables={overview.payables.toNumber()}
      loanOutstanding={overview.loanOutstanding.toNumber()}
      currency={displayCurrency}
    />
  )}
</div>
{goals.length > 0 && (
  <div className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">Savings Goals</h3>
    {goals.map((g) => (
      <GoalProgressCard key={g.id} id={g.id} name={g.name} target={g.targetAmount.toNumber()} progress={g.currentProgress.toNumber()} currency={g.currency} />
    ))}
  </div>
)}
```

- [ ] **Step 3: Export sheet builders**

`lib/server/export/build-savings-goals-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { listSavingsGoals } from '@/lib/server/services/savings-goal'

registerExportSheet(async (workbook, userId) => {
  const goals = await listSavingsGoals(userId)
  const sheet = workbook.addWorksheet('Savings Goals')
  sheet.addRow(['Name', 'Target', 'Progress', 'Currency', 'Deadline', 'Status'])
  for (const g of goals) {
    sheet.addRow([g.name, g.targetAmount.toNumber(), g.currentProgress.toNumber(), g.currency, g.deadline ?? '', g.status])
  }
})
```

`lib/server/export/build-debts-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { listDebts, getDebtOutstanding, getDebtDisplayStatus } from '@/lib/server/services/debt'

registerExportSheet(async (workbook, userId) => {
  const debts = await listDebts(userId)
  const sheet = workbook.addWorksheet('Debts')
  sheet.addRow(['Direction', 'Person', 'Original Amount', 'Outstanding', 'Currency', 'Due Date', 'Status'])
  for (const d of debts) {
    const outstanding = await getDebtOutstanding(userId, d.id)
    const status = await getDebtDisplayStatus(userId, d.id)
    sheet.addRow([d.direction, d.person, d.originalAmount.toNumber(), outstanding.toNumber(), d.currency, d.dueDate ?? '', status])
  }
})
```

`lib/server/export/build-debt-payments-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { prisma } from '@/lib/prisma'

registerExportSheet(async (workbook, userId) => {
  const payments = await prisma.debtPayment.findMany({ where: { userId }, include: { debt: true } })
  const sheet = workbook.addWorksheet('Debt Payments')
  sheet.addRow(['Debt (Person)', 'Amount', 'Currency', 'Date', 'Note'])
  for (const p of payments) {
    sheet.addRow([p.debt.person, p.amount.toNumber(), p.debt.currency, p.date, p.note ?? ''])
  }
})
```

`lib/server/export/build-loans-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { listLoans, getLoanOutstandingPrincipal } from '@/lib/server/services/loan'

registerExportSheet(async (workbook, userId) => {
  const loans = await listLoans(userId)
  const sheet = workbook.addWorksheet('Loans')
  sheet.addRow(['Lender', 'Principal', 'Outstanding', 'Currency', 'Interest Rate', 'Next Due Date', 'Status'])
  for (const l of loans) {
    const outstanding = await getLoanOutstandingPrincipal(userId, l.id)
    sheet.addRow([l.lender, l.principal.toNumber(), outstanding.toNumber(), l.currency, l.interestRate.toNumber(), l.nextDueDate, l.status])
  }
})
```

`lib/server/export/build-loan-payments-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { prisma } from '@/lib/prisma'

registerExportSheet(async (workbook, userId) => {
  const payments = await prisma.loanPayment.findMany({ where: { userId }, include: { loan: true } })
  const sheet = workbook.addWorksheet('Loan Payments')
  sheet.addRow(['Loan (Lender)', 'Total', 'Principal', 'Interest', 'Currency', 'Date'])
  for (const p of payments) {
    sheet.addRow([p.loan.lender, p.totalAmount.toNumber(), p.principalAmount.toNumber(), p.interestAmount.toNumber(), p.loan.currency, p.paymentDate])
  }
})
```

`lib/server/export/build-reminders-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { prisma } from '@/lib/prisma'

registerExportSheet(async (workbook, userId) => {
  const reminders = await prisma.recurringReminder.findMany({ where: { userId } })
  const sheet = workbook.addWorksheet('Reminders')
  sheet.addRow(['Title', 'Type', 'Expected Amount', 'Currency', 'Frequency', 'Start Date', 'Active'])
  for (const r of reminders) {
    sheet.addRow([r.title, r.type, r.expectedAmount.toNumber(), r.currency, r.frequency, r.startDate, r.active])
  }
})
```

In `app/api/reports/export/route.ts`, add the six new registration imports alongside the existing ones:
```ts
import '@/lib/server/export/build-savings-goals-sheet'
import '@/lib/server/export/build-debts-sheet'
import '@/lib/server/export/build-debt-payments-sheet'
import '@/lib/server/export/build-loans-sheet'
import '@/lib/server/export/build-loan-payments-sheet'
import '@/lib/server/export/build-reminders-sheet'
```

- [ ] **Step 4: Manual verification**

Run `npm run dev`, confirm the dashboard now shows all ten widgets from the product spec with real data. Download the full export and confirm all eleven sheets from spec §12 are present with correct data.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/dashboard/page.tsx" components/dashboard lib/server/export app/api/reports/export/route.ts
git commit -m "feat: complete the dashboard's remaining widgets and the full export's remaining sheets"
```

---

## Phase 6 Acceptance Check

- [ ] Reminders/Bills surface when due, can be acknowledged or dismissed, never create a Transaction, never duplicate, and never resurface after being actioned — proven by Task 2's test suite.
- [ ] Recurrence correctly clamps to the last valid day of shorter months (Feb 28/29) — proven by Task 1's test suite.
- [ ] Savings Goals track manually with no automatic account interaction.
- [ ] Debt/Loan outstanding amounts are always derived from payment history, never stored, never able to drift — proven by Task 4/5's test suites, including an explicit check that no `FinancialAccount`/`Transaction` row is ever touched by recording a payment.
- [ ] A payment exceeding the currently derived outstanding amount is rejected for both Debt and Loan, an exact-final-payment is accepted, and the check-then-write is safe under concurrent requests via a Serializable transaction (proven by the atomicity test showing `nextDueDate` doesn't advance on a rejected Loan payment).
- [ ] Loan schedule advancement clamps month-end dates (Jan 31 → Feb 28/29, Feb 29 → Feb 28 next year) — proven by `add-months-clamped.test.ts`.
- [ ] The Debt / Loan Overview converts every record from its own currency to the display currency before aggregating and counts only ACTIVE records — proven by the mixed USD/VND test in `debt-loan-overview.test.ts`.
- [ ] `WRITTEN_OFF` (Debt) and `CLOSED` (Loan) each have an explicit service + action + button; non-ACTIVE records reject further payments and are excluded from Net Worth and the overview — no dead state transitions remain.
- [ ] Current Net Worth (accounts + receivables − payables − loans) and the "Account Balance Over Time" chart (accounts only) are deliberately different measures and are labeled as such; true historical Net Worth is documented as deferred.
- [ ] `LoanPayment.totalAmount = principalAmount + interestAmount` is enforced by both Zod and a database CHECK constraint.
- [ ] Net Worth now correctly includes receivables, payables, and outstanding loan principal, without double-counting — proven by Task 6's extended test.
- [ ] All ten dashboard widgets from the product spec are present and correctly labeled.
- [ ] The full Excel export contains all eleven sheets from spec §12.
- [ ] `npm run test`, `npm run lint`, and `npm run build` all succeed.
