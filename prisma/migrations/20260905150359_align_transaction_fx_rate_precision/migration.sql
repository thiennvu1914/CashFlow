/*
  Warnings:

  - You are about to alter the column `vndPerUsdAtEntry` on the `Transaction` table. The data in that column could be lost. The data in that column will be cast from `Decimal(18,4)` to `Decimal(18,6)`.

*/
-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "vndPerUsdAtEntry" SET DATA TYPE DECIMAL(18,6);
