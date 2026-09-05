-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('VND', 'USD');

-- CreateTable
CREATE TABLE "FinancialAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountTypeId" TEXT NOT NULL,
    "initialBalance" DECIMAL(18,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinancialAccount_userId_idx" ON "FinancialAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialAccount_userId_id_key" ON "FinancialAccount"("userId", "id");

-- AddForeignKey
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_userId_accountTypeId_fkey" FOREIGN KEY ("userId", "accountTypeId") REFERENCES "AccountType"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
