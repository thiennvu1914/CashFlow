import { Prisma } from '@prisma/client'
import type { Currency, RecordStatus } from '@prisma/client'

/**
 * Row-level locking for FinancialAccount, and the one place the
 * archived-account freeze is actually enforced.
 *
 * ## Why `FOR UPDATE` at all
 *
 * Two invariants have to hold together, and neither survives a plain
 * read-check-write under READ COMMITTED:
 *
 * - an ARCHIVED account can never gain Transaction or Transfer activity;
 * - an account cannot be archived while activity is being written to it.
 *
 * Before this module, both `createTransaction` and `archiveFinancialAccount`
 * read the account (or its derived balance), decided, and then wrote. Under
 * READ COMMITTED each statement sees rows committed at the moment it runs, so
 * two sessions could both pass their check against the state before the other
 * one's write: the archive sees a zero balance while a transaction is being
 * inserted, the insert sees an ACTIVE account while it is being archived, and
 * both commit. The result is an archived account holding money — a balance the
 * rest of the app has stopped tracking and the UI can no longer show.
 *
 * `SELECT … FOR UPDATE` closes that window by taking an exclusive row lock on
 * every account a write depends on, *inside the same transaction as the write*.
 * The lock conflicts with any other `FOR UPDATE` and with `UPDATE`, so the
 * second session queues until the first commits and then re-reads the row's
 * real, post-commit `status`. Serialisation, not optimism: nothing is retried
 * and nothing is lost.
 *
 * ## Why the ids are sorted (and de-duplicated)
 *
 * A transfer locks two accounts and a transaction move locks two accounts, so
 * two concurrent writes can want the same pair in opposite orders — the classic
 * deadlock. Locking in a single statement ordered by `"id"`, from a caller-side
 * sorted id list, gives every writer in the system one global order, so one of
 * them always waits instead of both dying with a deadlock detection error.
 * De-duplication matters because callers legitimately pass the same id twice
 * (an edit that keeps the transaction on its current account), and the
 * "every requested id resolved" check below must not fail on a duplicate.
 *
 * ## Why FX is fetched *before* the transaction
 *
 * An interactive transaction holds a pooled connection and its row locks for
 * its whole duration, and Prisma's default 5s timeout aborts it. A provider
 * HTTP call inside that window would hold a lock across the network — one slow
 * FX response would stall every other writer touching the same account, and a
 * timeout would roll back work that had already succeeded. So every caller
 * resolves FX first (`getUsableCurrentRate`) and opens the transaction with the
 * snapshot already in hand; the transaction then contains only local queries
 * and comfortably fits the default timeout. No caller passes custom
 * transaction options.
 *
 * ## Why `updateTransaction` also re-reads its own row under the lock
 *
 * Locking the accounts does not lock the transaction row, and an edit computes
 * `economicChange` (and therefore whether to re-snapshot FX) from a copy read
 * *before* the transaction opened. If another session edited the same row in
 * between, that copy is stale and the FX decision was made against data that no
 * longer exists. So the row is re-read `FOR UPDATE` and its `updatedAt`
 * compared with the pre-read value; a difference is a `ConcurrentModification`
 * and the edit is refused rather than silently overwriting the other change.
 * `updatedAt` is Prisma's `@updatedAt` column at millisecond precision — two
 * edits landing inside the same millisecond would compare equal, which is
 * accepted: the account locks still make the write itself safe, and this check
 * exists to protect the *decision*, not to be a cryptographic version tag.
 */

/**
 * Exactly the columns the invariant checks need and nothing more: `id` to match
 * a row back to a requested id, `status` for the archived freeze, `currency`
 * for the "currency follows the account" rule. A caller that needs the rest of
 * the row re-reads it through the same transaction client
 * (`archiveFinancialAccount` does), which keeps this lock a narrow, obviously
 * safe projection rather than a second source of account data.
 */
export interface LockedAccountRow {
  id: string
  status: RecordStatus
  currency: Currency
}

/**
 * Thrown when a write targets an account that is not ACTIVE.
 *
 * Lives here rather than in `transaction.ts` because this module is what
 * enforces it and everything else imports from here; `transaction.ts`
 * re-exports it so existing importers (and the action error maps) are
 * unchanged. One error type for "this account is archived" keeps the code the
 * UI sees identical whether the frozen thing was a transaction, a transfer, or
 * the account row itself.
 */
export class ArchivedAccountError extends Error {
  constructor() {
    super('This account is archived and cannot receive new activity.')
    this.name = 'ArchivedAccountError'
  }
}

export interface LockAccountRowsOptions {
  /** When true (the norm), a row that is not ACTIVE throws `ArchivedAccountError`.
   *  `archiveFinancialAccount` passes false: an already-archived account is a
   *  no-op for it, not a failure. */
  requireActive: boolean
  /**
   * How a requested id that does not resolve to an account owned by `userId` is
   * reported. The default reproduces Prisma's own `P2025` — byte for byte the
   * error `findUniqueOrThrow` raised before this module existed — so the
   * ownership contract every caller, action error map and tenant-isolation test
   * already pins down is unchanged by the switch to a locking read.
   * `archiveFinancialAccount` overrides it with `AccountNotFoundError`, which is
   * what *its* callers and tests expect.
   */
  notFound?: (accountId: string) => Error
}

function prismaNotFound(accountId: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not found. Financial account ${accountId} was not found for this user.`,
    { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
  )
}

/**
 * Takes an exclusive row lock on each of `accountIds` and returns the locked
 * rows, in sorted id order.
 *
 * Must be called inside `prisma.$transaction` — the lock is released when that
 * transaction commits or rolls back, and taking it on the bare client would
 * release it immediately and prove nothing.
 *
 * Every requested id must resolve to an account owned by `userId`; the first
 * that does not throws (see `notFound`) and no partial result is returned, so a
 * caller can never proceed having locked only some of the accounts it depends
 * on.
 */
export async function lockAccountRows(
  tx: Prisma.TransactionClient,
  userId: string,
  accountIds: string[],
  options: LockAccountRowsOptions,
): Promise<LockedAccountRow[]> {
  const notFound = options.notFound ?? prismaNotFound
  // Sorted and de-duplicated: see the deadlock note in the module comment.
  const ids = [...new Set(accountIds)].sort()
  if (ids.length === 0) return []

  const rows = await tx.$queryRaw<LockedAccountRow[]>`
    SELECT "id", "status", "currency"
    FROM "FinancialAccount"
    WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE`

  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of ids) {
    if (!byId.has(id)) throw notFound(id)
  }
  if (options.requireActive) {
    for (const row of rows) {
      if (row.status !== 'ACTIVE') throw new ArchivedAccountError()
    }
  }
  return rows
}

/**
 * `lockAccountRows` with the rule every money-writing path needs: the accounts
 * must exist, belong to `userId`, and still be ACTIVE *at the moment the lock
 * is held* — which is what makes "an archived account never gains activity" a
 * guarantee rather than a hope.
 */
export async function lockAccountsForUpdate(
  tx: Prisma.TransactionClient,
  userId: string,
  accountIds: string[],
): Promise<LockedAccountRow[]> {
  return lockAccountRows(tx, userId, accountIds, { requireActive: true })
}
