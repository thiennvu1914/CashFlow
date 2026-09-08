-- CreateEnum
CREATE TYPE "SavingsGoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "SavingsGoal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmount" DECIMAL(18,2) NOT NULL,
    "currentProgress" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL,
    "deadline" TIMESTAMP(3),
    "note" TEXT,
    "status" "SavingsGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavingsGoal_userId_status_idx" ON "SavingsGoal"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsGoal_userId_id_key" ON "SavingsGoal"("userId", "id");

-- A savings target of zero (or less) is not a target, and progress cannot be
-- negative. Prisma's schema language has no CHECK syntax, so both constraints
-- live here by hand and are documented on the model in `prisma/schema.prisma`.
--
-- There is deliberately NO `currentProgress <= targetAmount` constraint:
-- over-saving is legitimate, and is what makes the "120 %" label in
-- `lib/ui/savings-goal-view-model.ts` an honest reading rather than a bug.
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_targetAmount_positive" CHECK ("targetAmount" > 0);
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_currentProgress_nonnegative" CHECK ("currentProgress" >= 0);
