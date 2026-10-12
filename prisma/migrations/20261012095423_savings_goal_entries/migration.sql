-- Money-source linking for savings goals (spec 2026-10-12 §2 Q5, §5, §6.7).
--
-- A goal's progress stops being a figure the user overwrites
-- (`SavingsGoal.currentProgress`) and becomes derived on every read:
--
--   * linked (`SavingsGoal.linkedAccountId`): the account's current derived
--     balance. The link is a composite (userId, linkedAccountId) foreign key to
--     FinancialAccount(userId, id), so a goal can never follow another user's
--     account, and ON DELETE RESTRICT (not SET NULL, which would null "userId"
--     too). NULL for every goal written before this migration — nothing is
--     linked automatically.
--   * unlinked: Σ CONTRIBUTION − Σ WITHDRAWAL over the goal's
--     `SavingsGoalEntry` rows, each with a composite (userId, goalId) foreign
--     key to SavingsGoal(userId, id).
--
-- `currentProgress` stays in the table untouched (deprecated; a later release
-- drops it) — the backfill at the end of this file is what carries each
-- non-zero value over into the derived world.
--
-- Additive only (one nullable column, one new table and enum, one CHECK,
-- inserted rows), so it is safe to apply before the code that reads it ships.
-- The DDL below is exactly what `prisma migrate dev --create-only` generated for
-- the schema change; the CHECK and the backfill after it are hand-written,
-- since Prisma's schema language has neither.

-- CreateEnum
CREATE TYPE "SavingsGoalEntryKind" AS ENUM ('CONTRIBUTION', 'WITHDRAWAL');

-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "linkedAccountId" TEXT;

-- CreateTable
CREATE TABLE "SavingsGoalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "kind" "SavingsGoalEntryKind" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavingsGoalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavingsGoalEntry_userId_goalId_date_idx" ON "SavingsGoalEntry"("userId", "goalId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsGoalEntry_userId_id_key" ON "SavingsGoalEntry"("userId", "id");

-- AddForeignKey
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_userId_linkedAccountId_fkey" FOREIGN KEY ("userId", "linkedAccountId") REFERENCES "FinancialAccount"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsGoalEntry" ADD CONSTRAINT "SavingsGoalEntry_userId_goalId_fkey" FOREIGN KEY ("userId", "goalId") REFERENCES "SavingsGoal"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An entry's amount is never negative: its sign comes only from `kind`, the way
-- a Transaction's comes from its type. That the goal's running total never goes
-- below zero is a cross-row rule a CHECK cannot express; the service enforces it
-- under the goal's row lock (`lib/server/services/savings-goal.ts`), and it is
-- the only writer.
ALTER TABLE "SavingsGoalEntry" ADD CONSTRAINT "SavingsGoalEntry_amount_nonnegative" CHECK ("amount" >= 0);

-- DATA BACKFILL: one opening CONTRIBUTION per goal that had progress typed in.
--
-- Every goal with `currentProgress > 0` and no entries yet gets one
-- CONTRIBUTION of exactly that amount, so its derived progress equals the figure
-- the user last saw. Idempotent: a goal that already has any entry is skipped,
-- so re-running this inserts nothing (and `savings-goal.test.ts` runs it twice
-- against the test database).
--
-- The entry is dated the goal's `updatedAt` — the last time that figure was
-- written — as a calendar-date carrier like every entry date: the calendar day
-- of that instant in the owner's zone ("updatedAt" is a UTC wall time, so it is
-- read AT TIME ZONE 'UTC' first), at UTC midnight. A zone the database does not
-- recognise falls back to UTC instead of failing the migration (the left join
-- on pg_timezone_names leaves z.name NULL).
--
-- Ids are a "c"-prefixed uuid without dashes, as in `loan_interest_category`;
-- `createdAt` is the migration's own instant as a UTC wall time, whatever the
-- session's TimeZone setting.
INSERT INTO "SavingsGoalEntry" ("id", "userId", "goalId", "kind", "amount", "date", "note", "createdAt")
SELECT
    'c' || replace(gen_random_uuid()::text, '-', ''),
    g."userId",
    g."id",
    'CONTRIBUTION'::"SavingsGoalEntryKind",
    g."currentProgress",
    date_trunc('day', (g."updatedAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(z.name, 'UTC')),
    NULL,
    now() AT TIME ZONE 'UTC'
FROM "SavingsGoal" g
JOIN "user" u ON u.id = g."userId"
LEFT JOIN (SELECT DISTINCT name FROM pg_timezone_names) z ON z.name = u.timezone
WHERE g."currentProgress" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "SavingsGoalEntry" e
    WHERE e."userId" = g."userId" AND e."goalId" = g."id"
  );
