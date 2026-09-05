-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "base" "Currency" NOT NULL,
    "quote" "Currency" NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeRate_base_quote_effectiveDate_idx" ON "ExchangeRate"("base", "quote", "effectiveDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_base_quote_effectiveDate_key" ON "ExchangeRate"("base", "quote", "effectiveDate");
