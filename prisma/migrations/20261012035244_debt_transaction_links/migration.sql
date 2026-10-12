-- Money-source linking for debts (spec 2026-10-12 §5, §6.2).
--
-- A debt recorded against one of the user's accounts points at the Transaction
-- that moved its opening money (`Debt.openingTransactionId`), and a payment
-- recorded in an account points at the Transaction that moved it
-- (`DebtPayment.transactionId`). Both stay NULL for "don't record in an
-- account", which is also every row written before this migration — nothing
-- is linked automatically (owner decision Q3).
--
-- Each link is a composite (userId, …) foreign key to Transaction(userId, id),
-- so a debt can never name another user's transaction, and it is ON DELETE
-- RESTRICT (not SET NULL, which would null "userId" too): a linked transaction
-- cannot be deleted out from under its debt, and the services remove the link
-- before the transaction inside one database transaction. The unique indexes
-- make each transaction the money movement of at most one debt or payment;
-- NULLs are distinct in a Postgres unique index, so any number of unlinked rows
-- coexist.
--
-- Additive only (two nullable columns, two indexes, two constraints), so it is
-- safe to apply before the code that writes the links ships.
--
-- Written out by hand in exactly the shape `prisma migrate dev` generates for
-- this schema change: migrate dev refuses to run non-interactively once it has
-- unique-constraint warnings to confirm, and the local wrapper then applied
-- this file and reported the schema in sync.

-- AlterTable
ALTER TABLE "Debt" ADD COLUMN     "openingTransactionId" TEXT;

-- AlterTable
ALTER TABLE "DebtPayment" ADD COLUMN     "transactionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Debt_userId_openingTransactionId_key" ON "Debt"("userId", "openingTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "DebtPayment_userId_transactionId_key" ON "DebtPayment"("userId", "transactionId");

-- AddForeignKey
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_userId_openingTransactionId_fkey" FOREIGN KEY ("userId", "openingTransactionId") REFERENCES "Transaction"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_userId_transactionId_fkey" FOREIGN KEY ("userId", "transactionId") REFERENCES "Transaction"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
