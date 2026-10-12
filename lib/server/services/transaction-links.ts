import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

/**
 * Which transactions a debt or a loan owns (money-source linking spec
 * 2026-10-12 §2 Q4, §6.5).
 *
 * A debt or loan recorded in an account writes the Transaction that moved its
 * money and keeps a composite `(userId, id)` link to it: `Debt.openingTransactionId`,
 * `DebtPayment.transactionId`, `Loan.disbursementTransactionId`, and
 * `LoanPayment.principalTransactionId` / `interestTransactionId`. The link
 * lives on the source side only, so "is this transaction owned, and by what?"
 * is a question asked of those four tables.
 *
 * An owned transaction is locked on the Transactions page (owner decision Q4):
 * the row names its debt or loan and offers to open it instead of edit or
 * delete, and the services refuse to change it with `LinkedTransactionError`.
 * The source record's own edit updates both sides in one database transaction;
 * an edit made here would silently disagree with the agreement it records.
 * The `ON DELETE RESTRICT` foreign keys are the backstop for a delete, but
 * nothing in the schema stops an update, which is why the check exists.
 *
 * Reminder-linked transactions (Task 8) are deliberately not covered: they stay
 * ordinary, editable and deletable rows.
 */

export type TransactionLink =
  | { kind: 'debt'; debtId: string; person: string }
  | { kind: 'loan'; loanId: string; lender: string }

/**
 * Thrown when the Transactions page tries to edit or delete a transaction a
 * debt or loan owns. The action layer maps it to `LINKED_TRANSACTION`, whose
 * copy sends the user to the debt or loan.
 */
export class LinkedTransactionError extends Error {
  constructor(readonly link: TransactionLink) {
    super('This transaction belongs to a debt or loan. Change it from there.')
    this.name = 'LinkedTransactionError'
  }
}

interface LinkRow {
  transactionId: string
  kind: 'debt' | 'loan'
  sourceId: string
  name: string
}

/**
 * The debt or loan behind each of `transactionIds`, keyed by transaction id;
 * an id nothing owns is simply absent from the map.
 *
 * Each source table is read once — one `SELECT` per link column, every one
 * scoped by `userId`, and a payment joined to its own agreement through the
 * composite `(userId, id)` key so a name can only ever come from the same
 * user's row — and the five are combined with `UNION ALL` into ONE statement.
 * That is deliberate: four separate queries cost four round trips inside an
 * interactive transaction, where they queue one after another on its single
 * connection (`updateTransaction`/`deleteTransaction` call this while holding
 * their row locks), and every round trip to the production database is about
 * 100 ms. One statement costs one, from the pool or from a transaction alike.
 *
 * `db` is the caller's transaction client when the answer must be read under
 * the caller's locks; the ledger passes nothing and reads from the pool.
 *
 * Every link column is covered by a `(userId, <column>)` unique index, so each
 * branch is an index lookup per id rather than a scan.
 */
export async function findTransactionLinks(
  userId: string,
  transactionIds: readonly string[],
  db: Prisma.TransactionClient = prisma,
): Promise<Map<string, TransactionLink>> {
  const links = new Map<string, TransactionLink>()
  if (transactionIds.length === 0) return links

  const ids = Prisma.join([...new Set(transactionIds)])
  const rows = await db.$queryRaw<LinkRow[]>`
    SELECT d."openingTransactionId" AS "transactionId", 'debt' AS "kind",
           d."id" AS "sourceId", d."person" AS "name"
      FROM "Debt" d
     WHERE d."userId" = ${userId} AND d."openingTransactionId" IN (${ids})
    UNION ALL
    SELECT p."transactionId", 'debt', d."id", d."person"
      FROM "DebtPayment" p
      JOIN "Debt" d ON d."userId" = p."userId" AND d."id" = p."debtId"
     WHERE p."userId" = ${userId} AND p."transactionId" IN (${ids})
    UNION ALL
    SELECT l."disbursementTransactionId", 'loan', l."id", l."lender"
      FROM "Loan" l
     WHERE l."userId" = ${userId} AND l."disbursementTransactionId" IN (${ids})
    UNION ALL
    SELECT p."principalTransactionId", 'loan', l."id", l."lender"
      FROM "LoanPayment" p
      JOIN "Loan" l ON l."userId" = p."userId" AND l."id" = p."loanId"
     WHERE p."userId" = ${userId} AND p."principalTransactionId" IN (${ids})
    UNION ALL
    SELECT p."interestTransactionId", 'loan', l."id", l."lender"
      FROM "LoanPayment" p
      JOIN "Loan" l ON l."userId" = p."userId" AND l."id" = p."loanId"
     WHERE p."userId" = ${userId} AND p."interestTransactionId" IN (${ids})`

  for (const row of rows) {
    links.set(
      row.transactionId,
      row.kind === 'debt'
        ? { kind: 'debt', debtId: row.sourceId, person: row.name }
        : { kind: 'loan', loanId: row.sourceId, lender: row.name },
    )
  }
  return links
}
