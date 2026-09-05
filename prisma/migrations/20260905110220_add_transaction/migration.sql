-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INCOME', 'EXPENSE', 'CASH_IN', 'CASH_OUT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE');

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "vndPerUsdAtEntry" DECIMAL(18,4) NOT NULL,
    "fxRateTimestamp" TIMESTAMP(3) NOT NULL,
    "fxRateSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_userId_date_idx" ON "Transaction"("userId", "date");

-- CreateIndex
CREATE INDEX "Transaction_userId_accountId_date_idx" ON "Transaction"("userId", "accountId", "date");

-- CreateIndex
CREATE INDEX "Transaction_userId_categoryId_date_idx" ON "Transaction"("userId", "categoryId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_userId_id_key" ON "Transaction"("userId", "id");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_accountId_fkey" FOREIGN KEY ("userId", "accountId") REFERENCES "FinancialAccount"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_categoryId_fkey" FOREIGN KEY ("userId", "categoryId") REFERENCES "Category"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
