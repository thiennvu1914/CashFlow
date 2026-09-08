-- `RecurringReminder.timezone` — the IANA zone the schedule is anchored to, and
-- the fix for ruling R6-22.
--
-- Materialization derives each reminder's local start day from `startDate` and
-- writes every `dueAt` as local midnight. Doing that in the *request's* zone
-- re-phased the whole series whenever the user edited `User.timezone`: a
-- monthly reminder stored at 2025-12-31T17:00Z (1 January in
-- `Asia/Ho_Chi_Minh`) reads as 31 December in `America/New_York`, and the
-- re-derived `dueAt`s land on different instants from the stored ones — which
-- `ReminderOccurrence_reminderId_dueAt_key` cannot dedupe, so the user ended up
-- with two PENDING rows for one bill. The zone now travels with the reminder.
--
-- Added WITH a default so the column can be introduced on a populated database
-- (the app's own default zone is the only honest backfill for rows written
-- before it existed), then the default is dropped: every insert from here on
-- states the zone the user was actually in, and a code path that forgets to
-- must fail loudly rather than silently anchor a Vietnamese schedule.
ALTER TABLE "RecurringReminder" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh';
ALTER TABLE "RecurringReminder" ALTER COLUMN "timezone" DROP DEFAULT;
