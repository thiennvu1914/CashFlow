-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "fromAmount" DECIMAL(18,2) NOT NULL,
    "toAmount" DECIMAL(18,2) NOT NULL,
    "exchangeRateUsed" DECIMAL(18,6),
    "date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transfer_userId_date_idx" ON "Transfer"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_userId_id_key" ON "Transfer"("userId", "id");

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_userId_fromAccountId_fkey" FOREIGN KEY ("userId", "fromAccountId") REFERENCES "FinancialAccount"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_userId_toAccountId_fkey" FOREIGN KEY ("userId", "toAccountId") REFERENCES "FinancialAccount"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money invariants that Prisma's schema language cannot express (ruling R-17).
-- `Transaction.amount` is a magnitude: the direction lives in `type` alone, so a
-- negative amount is meaningless and is refused by the database itself, not only
-- by Zod. Both transfer legs must be strictly positive: a zero or negative leg
-- would be a no-op or a reversed transfer wearing the wrong direction.
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_amount_nonnegative" CHECK ("amount" >= 0);
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_fromAmount_positive" CHECK ("fromAmount" > 0);
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_toAmount_positive" CHECK ("toAmount" > 0);
