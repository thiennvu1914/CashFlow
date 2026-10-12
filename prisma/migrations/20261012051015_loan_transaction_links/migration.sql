-- Money-source linking for loans (spec 2026-10-12 §5, §6.3).
--
-- A loan recorded as received into one of the user's accounts points at the
-- CASH_IN Transaction that moved its principal (`Loan.disbursementTransactionId`),
-- and an instalment paid from an account points at the CASH_OUT that paid its
-- principal part (`LoanPayment.principalTransactionId`) and the EXPENSE that
-- paid its interest part (`LoanPayment.interestTransactionId`). A part of zero
-- has no transaction, so either payment link may be NULL on its own; all three
-- stay NULL for "don't record in an account", which is also every row written
-- before this migration — nothing is linked automatically (owner decision Q3).
--
-- Each link is a composite (userId, …) foreign key to Transaction(userId, id),
-- so a loan can never name another user's transaction, and it is ON DELETE
-- RESTRICT (not SET NULL, which would null "userId" too): a linked transaction
-- cannot be deleted out from under its loan, and the services remove the link
-- before the transaction inside one database transaction. The unique indexes
-- make each transaction the money movement of at most one loan or instalment
-- part; NULLs are distinct in a Postgres unique index, so any number of
-- unlinked rows coexist.
--
-- Additive only (three nullable columns, three indexes, three constraints), so
-- it is safe to apply before the code that writes the links ships.
--
-- Written out by hand in exactly the shape `prisma migrate dev` generates for
-- this schema change: migrate dev refuses to run non-interactively once it has
-- unique-constraint warnings to confirm. The ALTER TABLE and foreign-key
-- statements below are verbatim what it generated for the same change without
-- the unique constraints; the three CREATE UNIQUE INDEX statements follow the
-- debt_transaction_links migration's shape, in schema order.

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "disbursementTransactionId" TEXT;

-- AlterTable
ALTER TABLE "LoanPayment" ADD COLUMN     "interestTransactionId" TEXT,
ADD COLUMN     "principalTransactionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Loan_userId_disbursementTransactionId_key" ON "Loan"("userId", "disbursementTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanPayment_userId_principalTransactionId_key" ON "LoanPayment"("userId", "principalTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanPayment_userId_interestTransactionId_key" ON "LoanPayment"("userId", "interestTransactionId");

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_userId_disbursementTransactionId_fkey" FOREIGN KEY ("userId", "disbursementTransactionId") REFERENCES "Transaction"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_userId_principalTransactionId_fkey" FOREIGN KEY ("userId", "principalTransactionId") REFERENCES "Transaction"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_userId_interestTransactionId_fkey" FOREIGN KEY ("userId", "interestTransactionId") REFERENCES "Transaction"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
