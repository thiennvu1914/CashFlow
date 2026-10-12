-- Money-source linking for reminders (spec 2026-10-12 §2 Q6, §5, §6.6).
--
-- "Đã trả / Paid" on a due reminder occurrence records the INCOME or EXPENSE it
-- reminds the user of, and the occurrence points at that Transaction
-- (`ReminderOccurrence.transactionId`) — written in the same database
-- transaction, whether by the one-tap path or by the pre-filled create form.
-- It stays NULL for every other occurrence, which is also every row written
-- before this migration: nothing is linked automatically.
--
-- The link is a composite (userId, transactionId) foreign key to
-- Transaction(userId, id), so an occurrence can never name another user's
-- transaction, and it is ON DELETE RESTRICT (not SET NULL, which would null
-- "userId" too): deleting a paid transaction clears the link and returns the
-- occurrence to PENDING in application code, inside the delete's own database
-- transaction, and the constraint is the backstop. The unique index makes each
-- transaction the payment of at most one occurrence; NULLs are distinct in a
-- Postgres unique index, so any number of unlinked occurrences coexist.
--
-- Additive only (one nullable column, one index, one constraint), so it is safe
-- to apply before the code that writes the link ships.
--
-- Written out by hand in exactly the shape `prisma migrate dev` generates for
-- this schema change: migrate dev refuses to run non-interactively once it has
-- a unique-constraint warning to confirm (the same reason as the
-- debt_transaction_links and loan_transaction_links migrations), and the local
-- wrapper then applied this file and reported the schema in sync.

-- AlterTable
ALTER TABLE "ReminderOccurrence" ADD COLUMN     "transactionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ReminderOccurrence_userId_transactionId_key" ON "ReminderOccurrence"("userId", "transactionId");

-- AddForeignKey
ALTER TABLE "ReminderOccurrence" ADD CONSTRAINT "ReminderOccurrence_userId_transactionId_fkey" FOREIGN KEY ("userId", "transactionId") REFERENCES "Transaction"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
