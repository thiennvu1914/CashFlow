/**
 * The one FK-safe order in which a user's owned rows may be deleted.
 *
 * This list used to live inline in `lib/server/export/test-fixtures.ts`, which
 * was the only code in the repository that had ever had to work it out. The
 * demo reset needs exactly the same sequence, and two copies of a delete order
 * are two copies that drift the moment a model is added — so the list moved
 * here and the export fixtures now import it. Its behaviour is unchanged:
 * the same models, in the same order, with the same `where`.
 *
 * Every one of these foreign keys is `ON DELETE RESTRICT`, so a wrong order is
 * a P2003 rather than a silent cascade — the failure is loud, which is why
 * this can be an ordered list rather than a graph walk.
 *
 * The `user` row itself is deliberately NOT in the list. The export fixtures
 * delete it separately afterwards (their users are throwaway), and the demo
 * reset never deletes it at all: clearing the demo user's data must leave the
 * account, its credentials and its sessions intact so `demo:seed` can refill
 * it without a second sign-up. There is no generic user-deletion path in this
 * codebase and this module does not add one.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

/** Either a Prisma client or an interactive transaction; both are accepted so
 *  the demo reset can run the whole sequence inside one transaction. */
export type OwnedRowClient = PrismaClient | Prisma.TransactionClient

/** One step of the sequence: the model's name, for reporting, and the delete. */
interface OwnedRowDeletion {
  readonly model: string
  readonly deleteMany: (client: OwnedRowClient, userIds: string[]) => Promise<{ count: number }>
}

/**
 * Children before their parent row throughout.
 *
 * Occurrences and reminders come first of all, ahead of the transactions,
 * because a reminder also references a Category and a FinancialAccount — both
 * deleted further down — so a reminder still standing would block those
 * deletions rather than its own.
 *
 * Budget comes before Category for the same reason: a CATEGORY budget
 * references one, so deleting the category first is a foreign-key violation.
 */
export const OWNED_ROW_DELETIONS: readonly OwnedRowDeletion[] = [
  {
    model: 'reminderOccurrence',
    deleteMany: (c, ids) => c.reminderOccurrence.deleteMany({ where: { userId: { in: ids } } }),
  },
  {
    model: 'recurringReminder',
    deleteMany: (c, ids) => c.recurringReminder.deleteMany({ where: { userId: { in: ids } } }),
  },
  // No children of its own, and referenced by nothing.
  {
    model: 'savingsGoal',
    deleteMany: (c, ids) => c.savingsGoal.deleteMany({ where: { userId: { in: ids } } }),
  },
  {
    model: 'transaction',
    deleteMany: (c, ids) => c.transaction.deleteMany({ where: { userId: { in: ids } } }),
  },
  {
    model: 'transfer',
    deleteMany: (c, ids) => c.transfer.deleteMany({ where: { userId: { in: ids } } }),
  },
  // Debts, loans and their payment histories.
  {
    model: 'debtPayment',
    deleteMany: (c, ids) => c.debtPayment.deleteMany({ where: { userId: { in: ids } } }),
  },
  { model: 'debt', deleteMany: (c, ids) => c.debt.deleteMany({ where: { userId: { in: ids } } }) },
  {
    model: 'loanPayment',
    deleteMany: (c, ids) => c.loanPayment.deleteMany({ where: { userId: { in: ids } } }),
  },
  { model: 'loan', deleteMany: (c, ids) => c.loan.deleteMany({ where: { userId: { in: ids } } }) },
  {
    model: 'financialAccount',
    deleteMany: (c, ids) => c.financialAccount.deleteMany({ where: { userId: { in: ids } } }),
  },
  {
    model: 'accountType',
    deleteMany: (c, ids) => c.accountType.deleteMany({ where: { userId: { in: ids } } }),
  },
  {
    model: 'budget',
    deleteMany: (c, ids) => c.budget.deleteMany({ where: { userId: { in: ids } } }),
  },
  {
    model: 'category',
    deleteMany: (c, ids) => c.category.deleteMany({ where: { userId: { in: ids } } }),
  },
]

/** How many rows each model contributed, keyed by model name. */
export type OwnedRowCounts = Record<string, number>

/**
 * Deletes every owned row of `userIds`, in the order above.
 *
 * Sequential on purpose — the order IS the correctness condition, so these
 * cannot be issued concurrently. `userIds` is always an explicit list: there is
 * no "delete everything" form, and no call site anywhere derives it from user
 * input.
 */
export async function deleteOwnedRows(
  client: OwnedRowClient,
  userIds: string[],
): Promise<OwnedRowCounts> {
  const counts: OwnedRowCounts = {}
  if (userIds.length === 0) return counts
  for (const step of OWNED_ROW_DELETIONS) {
    const { count } = await step.deleteMany(client, userIds)
    counts[step.model] = count
  }
  return counts
}
