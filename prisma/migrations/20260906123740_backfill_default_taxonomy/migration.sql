-- Backfill the default taxonomy for users created before the seed hook existed.
--
-- PURPOSE
-- Phase 2 added `onUserCreated` (`lib/auth/create-auth.ts` ->
-- `lib/server/defaults.ts` `seedDefaultsForUser`), which gives every NEW user
-- the starter AccountType and Category rows. Users registered before that hook
-- landed have none: the Account Type selector on /accounts is empty and
-- /categories shows nothing. This migration gives those users the same starter
-- rows, once, as ordinary per-user data.
--
-- IDEMPOTENCY RULE
-- One row is considered "already there" per (userId, name) for account types
-- and per (userId, name, type) for categories. The `NOT EXISTS` guards ignore
-- `isDefault` and `status` on purpose:
--   * re-running this migration inserts nothing;
--   * a user who created their own row named e.g. "Cash" or their own
--     ("Salary", INCOME) keeps it untouched and gets no near-duplicate;
--   * a partially seeded user only receives the names they are missing.
-- Nothing here updates, renames or deletes an existing row, and every inserted
-- row carries the `userId` of the user it is being created for, so tenant
-- ownership is preserved by construction.
--
-- SINGLE SOURCE OF TRUTH
-- The canonical names live in `lib/server/defaults.ts`
-- (DEFAULT_ACCOUNT_TYPES / DEFAULT_EXPENSE_CATEGORIES /
-- DEFAULT_INCOME_CATEGORIES) and `lib/server/defaults.migration.test.ts` parses
-- the VALUES lists in this file and asserts they match those constants exactly.
-- If you change a name there, change it here in the same commit.
--
-- IDS
-- `gen_random_uuid()::text` (pgcrypto is built into PostgreSQL 13+) rather than
-- a cuid: the application never generates ids in SQL, and `AccountType.id` /
-- `Category.id` are opaque `TEXT` primary keys, so a uuid string sits happily
-- beside the cuids Prisma writes at runtime.
--
-- The user table is mapped to lowercase "user" (see `@@map("user")` in
-- prisma/schema.prisma); the domain tables keep their PascalCase names.

-- BEGIN DEFAULT_ACCOUNT_TYPES
INSERT INTO "AccountType" (id, "userId", name, "isDefault", status, "createdAt")
SELECT gen_random_uuid()::text, u.id, v.name, true, 'ACTIVE', now()
FROM "user" u
CROSS JOIN (
    VALUES
        ('Cash'),
        ('Bank Account'),
        ('E-wallet'),
        ('Savings Account'),
        ('Other')
) AS v(name)
WHERE NOT EXISTS (
    SELECT 1 FROM "AccountType" a WHERE a."userId" = u.id AND a.name = v.name
);
-- END DEFAULT_ACCOUNT_TYPES

-- BEGIN DEFAULT_EXPENSE_CATEGORIES
INSERT INTO "Category" (id, "userId", name, type, "isDefault", status, "createdAt")
SELECT gen_random_uuid()::text, u.id, v.name, 'EXPENSE'::"CategoryType", true, 'ACTIVE', now()
FROM "user" u
CROSS JOIN (
    VALUES
        ('Food & Dining'),
        ('Transportation'),
        ('Shopping'),
        ('Entertainment'),
        ('Bills & Utilities'),
        ('Health'),
        ('Education'),
        ('Family'),
        ('Travel'),
        ('Other')
) AS v(name)
WHERE NOT EXISTS (
    SELECT 1 FROM "Category" c
    WHERE c."userId" = u.id AND c.name = v.name AND c.type = 'EXPENSE'::"CategoryType"
);
-- END DEFAULT_EXPENSE_CATEGORIES

-- BEGIN DEFAULT_INCOME_CATEGORIES
INSERT INTO "Category" (id, "userId", name, type, "isDefault", status, "createdAt")
SELECT gen_random_uuid()::text, u.id, v.name, 'INCOME'::"CategoryType", true, 'ACTIVE', now()
FROM "user" u
CROSS JOIN (
    VALUES
        ('Salary'),
        ('Bonus'),
        ('Freelance'),
        ('Investment Income'),
        ('Gift'),
        ('Other')
) AS v(name)
WHERE NOT EXISTS (
    SELECT 1 FROM "Category" c
    WHERE c."userId" = u.id AND c.name = v.name AND c.type = 'INCOME'::"CategoryType"
);
-- END DEFAULT_INCOME_CATEGORIES
