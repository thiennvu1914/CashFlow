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
 * delete, and the services refuse to change it with `LinkedTransactionError`
 * (reading the owner with the row itself, `OWNER_LINK_JOINS`).
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

/**
 * The owner of ONE transaction, read in the same statement as the row itself:
 * `OWNER_LINK_JOINS` after `FROM "Transaction" t`, `OWNER_LINK_COLUMNS` in its
 * select list, and `ownerLinkOf` on the row that comes back.
 *
 * This is how `updateTransaction` and `deleteTransaction` refuse a linked row
 * (final review F4): their pre-read already costs a round trip, and the link
 * rides on it instead of costing a second one inside their transaction while
 * the locks are held. Every join is on a `(userId, <link column>)` unique index
 * (and a payment to its agreement on the composite key), so each matches at
 * most one row and the statement still returns exactly one row per transaction.
 *
 * Reading the link outside the transaction is safe because a transaction's
 * link status never changes while the row exists: a link is only ever set to a
 * transaction created in the same database transaction (create, record a
 * payment, an edit that adds an account, "Record in an account"), and only ever
 * cleared in the database transaction that deletes that row (an edit that
 * removes the account, a payment delete, "Remove from account"). So a row read
 * here as owned is owned until it no longer exists — the write then fails on its
 * own row lock (P2025 / CONFLICT) — and a row read as not owned can never become
 * owned. Nothing ever points an existing link at another existing transaction.
 */
export const OWNER_LINK_JOINS = Prisma.sql`
  LEFT JOIN "Debt" od ON od."userId" = t."userId" AND od."openingTransactionId" = t."id"
  LEFT JOIN "DebtPayment" dp ON dp."userId" = t."userId" AND dp."transactionId" = t."id"
  LEFT JOIN "Debt" pd ON pd."userId" = dp."userId" AND pd."id" = dp."debtId"
  LEFT JOIN "Loan" dl ON dl."userId" = t."userId" AND dl."disbursementTransactionId" = t."id"
  LEFT JOIN "LoanPayment" pp ON pp."userId" = t."userId" AND pp."principalTransactionId" = t."id"
  LEFT JOIN "Loan" pl ON pl."userId" = pp."userId" AND pl."id" = pp."loanId"
  LEFT JOIN "LoanPayment" ip ON ip."userId" = t."userId" AND ip."interestTransactionId" = t."id"
  LEFT JOIN "Loan" il ON il."userId" = ip."userId" AND il."id" = ip."loanId"`

export const OWNER_LINK_COLUMNS = Prisma.sql`
  COALESCE(od."id", pd."id") AS "ownerDebtId",
  COALESCE(od."person", pd."person") AS "ownerPerson",
  COALESCE(dl."id", pl."id", il."id") AS "ownerLoanId",
  COALESCE(dl."lender", pl."lender", il."lender") AS "ownerLender"`

export interface OwnerLinkColumns {
  ownerDebtId: string | null
  ownerPerson: string | null
  ownerLoanId: string | null
  ownerLender: string | null
}

/** The debt or loan `OWNER_LINK_COLUMNS` found, or null for an ordinary row. */
export function ownerLinkOf(row: OwnerLinkColumns): TransactionLink | null {
  if (row.ownerDebtId !== null) {
    return { kind: 'debt', debtId: row.ownerDebtId, person: row.ownerPerson ?? '' }
  }
  if (row.ownerLoanId !== null) {
    return { kind: 'loan', loanId: row.ownerLoanId, lender: row.ownerLender ?? '' }
  }
  return null
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
 * The by-id form of the statement the ledger runs through
 * `listTransactionLinks` (`transaction.ts`), which re-selects its own page
 * instead of waiting for the ids; this one is what the tests check that
 * statement against. The services read a single row's owner in their pre-read
 * instead (`OWNER_LINK_JOINS`).
 */
export async function findTransactionLinks(
  userId: string,
  transactionIds: readonly string[],
): Promise<Map<string, TransactionLink>> {
  if (transactionIds.length === 0) return new Map()
  return findTransactionLinksAmong(userId, Prisma.join([...new Set(transactionIds)]))
}

/**
 * The statement behind both lookups: the debt or loan behind each transaction
 * id `wantedIds` yields — the inside of an `IN (…)`, either a list of bound ids
 * or a subquery selecting one `"id"` column. Built only from `Prisma.sql`
 * fragments by this module's callers, never from strings.
 *
 * Each source table is read once — one `SELECT` per link column, every one
 * scoped by `userId`, and a payment joined to its own agreement through the
 * composite `(userId, id)` key so a name can only ever come from the same
 * user's row — and the five are combined with `UNION ALL` into ONE statement.
 * That is deliberate: separate queries would cost a round trip each, and every
 * round trip to the production database is about 100 ms; one statement costs
 * one.
 *
 * Every link column is covered by a `(userId, <column>)` unique index, so each
 * branch is an index lookup per id rather than a scan.
 */
export async function findTransactionLinksAmong(
  userId: string,
  wantedIds: Prisma.Sql,
): Promise<Map<string, TransactionLink>> {
  const rows = await prisma.$queryRaw<LinkRow[]>`
    SELECT d."openingTransactionId" AS "transactionId", 'debt' AS "kind",
           d."id" AS "sourceId", d."person" AS "name"
      FROM "Debt" d
     WHERE d."userId" = ${userId} AND d."openingTransactionId" IN (${wantedIds})
    UNION ALL
    SELECT p."transactionId", 'debt', d."id", d."person"
      FROM "DebtPayment" p
      JOIN "Debt" d ON d."userId" = p."userId" AND d."id" = p."debtId"
     WHERE p."userId" = ${userId} AND p."transactionId" IN (${wantedIds})
    UNION ALL
    SELECT l."disbursementTransactionId", 'loan', l."id", l."lender"
      FROM "Loan" l
     WHERE l."userId" = ${userId} AND l."disbursementTransactionId" IN (${wantedIds})
    UNION ALL
    SELECT p."principalTransactionId", 'loan', l."id", l."lender"
      FROM "LoanPayment" p
      JOIN "Loan" l ON l."userId" = p."userId" AND l."id" = p."loanId"
     WHERE p."userId" = ${userId} AND p."principalTransactionId" IN (${wantedIds})
    UNION ALL
    SELECT p."interestTransactionId", 'loan', l."id", l."lender"
      FROM "LoanPayment" p
      JOIN "Loan" l ON l."userId" = p."userId" AND l."id" = p."loanId"
     WHERE p."userId" = ${userId} AND p."interestTransactionId" IN (${wantedIds})`

  const links = new Map<string, TransactionLink>()
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
