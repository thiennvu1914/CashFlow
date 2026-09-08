-- CreateEnum
CREATE TYPE "ReminderType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('ONE_TIME', 'WEEKLY', 'MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "RecurringReminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "ReminderType" NOT NULL,
    "expectedAmount" DECIMAL(18,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "categoryId" TEXT,
    "accountId" TEXT,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER,
    "month" INTEGER,
    "startDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderOccurrence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'PENDING',
    "actionedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringReminder_userId_active_idx" ON "RecurringReminder"("userId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringReminder_userId_id_key" ON "RecurringReminder"("userId", "id");

-- CreateIndex
CREATE INDEX "ReminderOccurrence_userId_status_dueAt_idx" ON "ReminderOccurrence"("userId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderOccurrence_reminderId_dueAt_key" ON "ReminderOccurrence"("reminderId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderOccurrence_userId_id_key" ON "ReminderOccurrence"("userId", "id");

-- AddForeignKey
ALTER TABLE "RecurringReminder" ADD CONSTRAINT "RecurringReminder_userId_categoryId_fkey" FOREIGN KEY ("userId", "categoryId") REFERENCES "Category"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringReminder" ADD CONSTRAINT "RecurringReminder_userId_accountId_fkey" FOREIGN KEY ("userId", "accountId") REFERENCES "FinancialAccount"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderOccurrence" ADD CONSTRAINT "ReminderOccurrence_userId_reminderId_fkey" FOREIGN KEY ("userId", "reminderId") REFERENCES "RecurringReminder"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A reminder for an amount of zero is not a reminder, and an interval of zero
-- is not a schedule — it is a non-terminating loop in
-- `lib/server/services/recurrence.ts`, which refuses it with a RangeError for
-- exactly that reason. Prisma's schema language has no CHECK syntax, so these
-- live here by hand and are documented on the models in `prisma/schema.prisma`.
--
-- `dayOfMonth` and `month` are NULLABLE and their constraints say so
-- explicitly: a WEEKLY or ONE_TIME reminder has no day of the month and no
-- anchor month to store, and `lib/validation/reminder.ts` rejects them outright
-- on those two frequencies. A CHECK written without the `IS NULL` arm would
-- reject every one of those rows.
--
-- `dayOfMonth` is bounded 1–31 because it is a *calendar* day the reminder falls
-- on, not an offset: `lib/datetime/add-months-clamped.ts` clamps it down to each
-- target month's length (so 31 means "the 31st, or the last day of a shorter
-- month"), and a value outside the range could only ever come from a bug.
-- `month` is bounded 1–12 in the human numbering the column stores, not
-- JavaScript's 0–11 — an off-by-one here would silently shift a yearly reminder
-- by a month, so the range is asserted rather than trusted.
ALTER TABLE "RecurringReminder" ADD CONSTRAINT "RecurringReminder_expectedAmount_positive" CHECK ("expectedAmount" > 0);
ALTER TABLE "RecurringReminder" ADD CONSTRAINT "RecurringReminder_interval_min" CHECK ("interval" >= 1);
ALTER TABLE "RecurringReminder" ADD CONSTRAINT "RecurringReminder_dayOfMonth_range" CHECK ("dayOfMonth" IS NULL OR "dayOfMonth" BETWEEN 1 AND 31);
ALTER TABLE "RecurringReminder" ADD CONSTRAINT "RecurringReminder_month_range" CHECK ("month" IS NULL OR "month" BETWEEN 1 AND 12);

-- `ReminderOccurrence` deliberately carries no CHECK of its own. Its two
-- invariants are not expressible as one: "idempotent under concurrent reads" is
-- the `ReminderOccurrence_reminderId_dueAt_key` unique index above, and "an
-- actioned occurrence is never resurrected" is a property of the *writes* —
-- materialization only ever inserts, and `actionedAt` is set in the same
-- `update` as the status it belongs to (`lib/server/services/reminder.ts`).
