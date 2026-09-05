-- Splits the single `fxRateTimestamp` into the two timestamps the FX snapshot
-- actually needs: `fxRateFetchedAt` (when we retrieved the rate) and
-- `fxRateEffectiveAt` (the UTC start of the day the rate is effective for,
-- which is the `ExchangeRate` cache's natural key).
--
-- Hand-written, replacing Prisma's generated DROP COLUMN + ADD COLUMN: a drop
-- would discard every existing snapshot's fetch instant, and the whole point of
-- the column is that the instant is real. RENAME preserves it.
--
-- The backfill is an APPROXIMATION and is only ever applied to pre-existing
-- development rows: no production data exists yet (Phase 2 is pre-launch). It
-- assumes the rate a row was recorded with was effective on the UTC day it was
-- fetched, which is true for every row the live path can produce but not for a
-- `cache-fallback:` row, where the original rate could be up to 48 hours older
-- (MAX_FALLBACK_STALENESS_MS). Those few dev rows get a date one or two days
-- late; every row written from here on carries the real `fx.effectiveDate`.

-- AlterTable
ALTER TABLE "Transaction" RENAME COLUMN "fxRateTimestamp" TO "fxRateFetchedAt";

ALTER TABLE "Transaction" ADD COLUMN "fxRateEffectiveAt" TIMESTAMP(3);

UPDATE "Transaction"
SET "fxRateEffectiveAt" = date_trunc('day', "fxRateFetchedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

ALTER TABLE "Transaction" ALTER COLUMN "fxRateEffectiveAt" SET NOT NULL;
