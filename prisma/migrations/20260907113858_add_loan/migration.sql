-- CreateEnum
CREATE TYPE "LoanStoredStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "PaymentFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'YEARLY');

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "principal" DECIMAL(18,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "interestRate" DECIMAL(6,3) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "paymentFrequency" "PaymentFrequency" NOT NULL,
    "scheduledPaymentAmount" DECIMAL(18,2) NOT NULL,
    "nextDueDate" TIMESTAMP(3) NOT NULL,
    "dueDayOfMonth" INTEGER NOT NULL,
    "status" "LoanStoredStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "principalAmount" DECIMAL(18,2) NOT NULL,
    "interestAmount" DECIMAL(18,2) NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Loan_userId_status_idx" ON "Loan"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_userId_id_key" ON "Loan"("userId", "id");

-- CreateIndex
CREATE INDEX "LoanPayment_userId_loanId_paymentDate_idx" ON "LoanPayment"("userId", "loanId", "paymentDate");

-- CreateIndex
CREATE UNIQUE INDEX "LoanPayment_userId_id_key" ON "LoanPayment"("userId", "id");

-- AddForeignKey
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_userId_loanId_fkey" FOREIGN KEY ("userId", "loanId") REFERENCES "Loan"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A loan of zero is not a loan, a negative interest rate is not a rate, a term
-- of no months is not a term, and an instalment of zero is not an instalment.
-- Prisma's schema language has no CHECK syntax, so these live here by hand and
-- are documented on the models in `prisma/schema.prisma`.
--
-- `dueDayOfMonth` is bounded 1–31 because it is a *calendar* day the user's
-- instalments fall on, not an offset: `lib/datetime/add-months-clamped.ts`
-- clamps it down to each target month's length (so 31 means "the 31st, or the
-- last day of a shorter month"), and a value outside the range could only ever
-- come from a bug.
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_principal_positive" CHECK ("principal" > 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_interestRate_nonnegative" CHECK ("interestRate" >= 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_termMonths_positive" CHECK ("termMonths" > 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_scheduledPaymentAmount_positive" CHECK ("scheduledPaymentAmount" > 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_dueDayOfMonth_range" CHECK ("dueDayOfMonth" BETWEEN 1 AND 31);

-- The split invariant, at the layer nothing can bypass: every instalment is a
-- total made of a principal part and an interest part, and only the principal
-- part reduces what is owed. Zod checks it before the request is trusted and
-- `loan.ts` re-checks it in `Prisma.Decimal` inside the locked transaction; this
-- is the third layer, and the only one a direct `prisma.loanPayment.create`
-- still has to answer to.
--
-- `principalAmount` may be 0 (an interest-only instalment is a real product,
-- ruling R6-6) and so may `interestAmount` (a 0% loan, or a final principal
-- sweep), but the total may not: a zero-amount payment row would let a history
-- claim an instalment that never happened.
--
-- There is deliberately NO `sum(principalAmount) <= principal` constraint: a
-- cross-row invariant cannot be expressed as a CHECK, and the overpayment rule
-- is instead enforced inside the row-locked transaction in
-- `lib/server/services/loan.ts` (`recordLoanPayment`), which is the only writer.
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_total_matches_split" CHECK ("totalAmount" = "principalAmount" + "interestAmount");
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_principal_nonnegative" CHECK ("principalAmount" >= 0);
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_interest_nonnegative" CHECK ("interestAmount" >= 0);
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_total_positive" CHECK ("totalAmount" > 0);
