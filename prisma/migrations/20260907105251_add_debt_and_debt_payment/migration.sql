-- CreateEnum
CREATE TYPE "DebtDirection" AS ENUM ('RECEIVABLE', 'PAYABLE');

-- CreateEnum
CREATE TYPE "DebtStoredStatus" AS ENUM ('ACTIVE', 'WRITTEN_OFF');

-- CreateTable
CREATE TABLE "Debt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "DebtDirection" NOT NULL,
    "person" TEXT NOT NULL,
    "description" TEXT,
    "originalAmount" DECIMAL(18,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" "DebtStoredStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Debt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebtPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Debt_userId_status_idx" ON "Debt"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Debt_userId_id_key" ON "Debt"("userId", "id");

-- CreateIndex
CREATE INDEX "DebtPayment_userId_debtId_date_idx" ON "DebtPayment"("userId", "debtId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DebtPayment_userId_id_key" ON "DebtPayment"("userId", "id");

-- AddForeignKey
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_userId_debtId_fkey" FOREIGN KEY ("userId", "debtId") REFERENCES "Debt"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A debt of zero (or less) is not a debt, and a repayment of zero is not a
-- repayment — a zero-amount payment row would also make "outstanding" claim
-- progress that never happened. Prisma's schema language has no CHECK syntax,
-- so both constraints live here by hand and are documented on the models in
-- `prisma/schema.prisma`.
--
-- There is deliberately NO `sum(payments) <= originalAmount` constraint: a
-- cross-row invariant cannot be expressed as a CHECK, and the overpayment rule
-- is instead enforced inside the row-locked transaction in
-- `lib/server/services/debt.ts` (`recordDebtPayment`), which is the only writer.
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_originalAmount_positive" CHECK ("originalAmount" > 0);
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_amount_positive" CHECK ("amount" > 0);
