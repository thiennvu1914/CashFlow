-- CreateEnum
CREATE TYPE "BudgetScope" AS ENUM ('OVERALL', 'CATEGORY');

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "scope" "BudgetScope" NOT NULL,
    "categoryId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_userId_year_month_idx" ON "Budget"("userId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_userId_id_key" ON "Budget"("userId", "id");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_categoryId_fkey" FOREIGN KEY ("userId", "categoryId") REFERENCES "Category"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One OVERALL budget per user per month, and one CATEGORY budget per category
-- per user per month. Partial indexes: a plain unique index over
-- (userId, scope, categoryId, year, month) would let two OVERALL rows through,
-- because Postgres treats each NULL categoryId as distinct.
CREATE UNIQUE INDEX "budget_overall_per_month" ON "Budget" ("userId", "year", "month") WHERE "scope" = 'OVERALL';
CREATE UNIQUE INDEX "budget_category_per_month" ON "Budget" ("userId", "categoryId", "year", "month") WHERE "scope" = 'CATEGORY';
-- month is a calendar month number; year is bounded to the range the app's Zod schema accepts.
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_month_range" CHECK ("month" BETWEEN 1 AND 12);
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_amount_positive" CHECK ("amount" > 0);
-- A CATEGORY budget must name a category; an OVERALL budget must not.
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_scope_category_consistent" CHECK (("scope" = 'CATEGORY') = ("categoryId" IS NOT NULL));
