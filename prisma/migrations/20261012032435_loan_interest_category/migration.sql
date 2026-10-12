-- Backfill the "Loan Interest & Fees" EXPENSE category for every existing user.
--
-- PURPOSE
-- Money-source linking (spec 2026-10-12, sections 4 and 5) records a loan
-- instalment in an account as a CASH_OUT for the principal plus an EXPENSE for
-- the interest, and that EXPENSE is filed under this category. New users get it
-- from `seedDefaultsForUser` (it is in DEFAULT_EXPENSE_CATEGORIES); this gives
-- every user who registered before that the same row, once, as ordinary
-- per-user data. Data only: no schema change.
--
-- IDEMPOTENCY RULE
-- Same rule as `backfill_default_taxonomy` and the seed hook: a category is
-- "already there" per (userId, name, type), whatever its `isDefault` or
-- `status`. So re-running this inserts nothing, a user who made their own
-- category with this name keeps it untouched and gets no near-duplicate, and an
-- archived one stays archived (the runtime safety net
-- `ensureLoanInterestCategoryId` creates an active one when a loan payment
-- actually needs it). Nothing here updates or deletes an existing row, and each
-- inserted row carries the userId it is created for.
--
-- SINGLE SOURCE OF TRUTH
-- The name is LOAN_INTEREST_CATEGORY_NAME in `lib/server/defaults.ts`;
-- `lib/server/defaults.migration.test.ts` asserts this file inserts exactly
-- that name, and `lib/server/services/linked-transaction.test.ts` runs this SQL
-- twice against the test database.
--
-- IDS
-- A "c"-prefixed uuid without dashes: lowercase alphanumeric and starting with
-- "c" like the cuids Prisma writes at runtime (though longer); `Category.id` is
-- an opaque TEXT key, so its length carries no meaning.
--
-- Columns: `Category` has no `updatedAt`; `status` is set to its ACTIVE
-- default explicitly, as the earlier backfill does. The user table is mapped to
-- lowercase "user" (`@@map("user")` in prisma/schema.prisma).

INSERT INTO "Category" (id, "userId", name, type, "isDefault", status, "createdAt")
SELECT 'c' || replace(gen_random_uuid()::text, '-', ''), u.id, 'Loan Interest & Fees', 'EXPENSE'::"CategoryType", true, 'ACTIVE', now()
FROM "user" u
WHERE NOT EXISTS (
    SELECT 1 FROM "Category" c
    WHERE c."userId" = u.id AND c.name = 'Loan Interest & Fees' AND c.type = 'EXPENSE'::"CategoryType"
);
