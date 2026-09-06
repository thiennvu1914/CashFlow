import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { createTransferSchema, type CreateTransferInput } from '@/lib/validation/transfer'
import { lockAccountsForUpdate } from './account-lock'

/**
 * Transfer service (spec §4.5).
 *
 * A transfer moves money between two of the user's own accounts. It is its own
 * entity, never a pair of transactions: it has no category, never counts as
 * income or expense, and carries no FX snapshot — the only rate that matters is
 * the one actually applied between the two accounts.
 *
 * Three invariants live here and are never delegated to the UI:
 *
 * 1. **A same-currency transfer conserves money.** When both accounts hold the
 *    same currency the server derives `toAmount` from `fromAmount` and ignores
 *    the client's value, so a crafted request cannot take 100 out of one
 *    account and put 500 into another. Only a genuine cross-currency transfer
 *    uses both amounts, and it records the effective rate for the audit trail.
 * 2. **Both ends must be ACTIVE, checked under a row lock.**
 *    `lockAccountsForUpdate` takes `SELECT … FOR UPDATE` on both accounts
 *    inside the same transaction as the write, so an archived account can
 *    neither fund a transfer nor regain a hidden balance through one — not even
 *    when the archive lands in the same instant (see `account-lock.ts`).
 * 3. **Both ends must belong to the caller, and they must differ.** Ownership
 *    comes from the composite `(userId, id)` lookup — another user's account is
 *    a NotFound, never a usable reference.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — there is no ambient user here.
 */

/**
 * Thrown when both legs of a transfer resolve to the same account. The Zod
 * refine in `createTransferSchema` normally catches this first; this is the
 * service-level second line, so the invariant does not depend on validation
 * having been reached.
 */
export class SameAccountTransferError extends Error {
  constructor() {
    super('Cannot transfer to the same account.')
    this.name = 'SameAccountTransferError'
  }
}

export async function listTransfers(userId: string) {
  return prisma.transfer.findMany({
    where: { userId },
    include: { fromAccount: true, toAccount: true },
    // `date` alone is not a total order — several transfers a day is the normal
    // case, and a paged or re-rendered list must not shuffle. `createdAt`
    // breaks the tie by entry order, and `id` breaks a same-millisecond tie so
    // the sort is fully deterministic. Same rule as `listTransactions`.
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  })
}

/**
 * Every transfer the full export writes — export/report data source; unbounded
 * by design, the way `listTransactionsForExport` is, and for the same reason: a
 * workbook that quietly stops short is indistinguishable from a workbook of a
 * user who made that many transfers.
 *
 * Both accounts are projected down to the two facts a sheet shows — the name
 * that identifies the leg and the currency its amount is denominated in — so
 * the joined rows carry no `userId`, no opening balance and no status. Ordered
 * oldest first, with the same total tie-break as everywhere else.
 */
export async function listTransfersForExport(userId: string) {
  return prisma.transfer.findMany({
    where: { userId },
    select: {
      id: true,
      date: true,
      fromAmount: true,
      toAmount: true,
      exchangeRateUsed: true,
      note: true,
      fromAccount: { select: { name: true, currency: true } },
      toAccount: { select: { name: true, currency: true } },
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
}

export async function createTransfer(userId: string, input: CreateTransferInput) {
  const parsed = createTransferSchema.parse(input)

  return prisma.$transaction(async (tx) => {
    // One statement locks both ends in sorted id order, so two concurrent
    // transfers over the same pair queue rather than deadlock.
    const accounts = await lockAccountsForUpdate(tx, userId, [
      parsed.fromAccountId,
      parsed.toAccountId,
    ])
    const fromAccount = accounts.find((row) => row.id === parsed.fromAccountId)
    const toAccount = accounts.find((row) => row.id === parsed.toAccountId)
    // Both are guaranteed present — `lockAccountsForUpdate` throws unless every
    // requested id resolved — so a missing one here can only mean both legs are
    // the same account, which is the error below.
    if (!fromAccount || !toAccount || fromAccount.id === toAccount.id) {
      throw new SameAccountTransferError()
    }

    // Derived from the LOCKED rows' currencies, not from a copy read earlier:
    // the currency lock (`AccountLockedError`) already prevents a currency
    // change once activity exists, and reading it under the lock closes the
    // remaining window on the very first transfer.
    const sameCurrency = fromAccount.currency === toAccount.currency
    // Same currency: money is conserved by construction — `toAmount` is
    // derived, never trusted from the client. Cross-currency: the client's
    // explicit `toAmount` is the amount actually received, and the effective
    // rate is recorded so the conversion can be audited later.
    const toAmount = sameCurrency ? parsed.fromAmount : parsed.toAmount
    const exchangeRateUsed = sameCurrency
      ? null
      : new Prisma.Decimal(parsed.toAmount).div(parsed.fromAmount)

    return tx.transfer.create({
      data: {
        userId,
        fromAccountId: parsed.fromAccountId,
        toAccountId: parsed.toAccountId,
        fromAmount: parsed.fromAmount,
        toAmount,
        exchangeRateUsed,
        date: parsed.date,
        note: parsed.note ?? null,
      },
    })
  })
}

/**
 * Removes a transfer, mirroring `deleteTransaction`.
 *
 * There is no stored balance, so deleting the row *is* the undo: both accounts
 * simply stop counting its two legs the next time a balance is derived. Both
 * ends must still be ACTIVE — an archived account has a zero balance by
 * construction, and removing a leg it can no longer show would silently change
 * history behind it. Without this operation a transfer would permanently lock
 * both of its accounts (`accountHasActivity` counts transfers), which is why
 * it exists at all.
 *
 * The ownership-scoped `findUniqueOrThrow` on `(userId, id)` is what makes
 * another user's transfer a P2025 rather than a deletable row.
 */
export async function deleteTransfer(userId: string, transferId: string) {
  const existing = await prisma.transfer.findUniqueOrThrow({
    where: { userId_id: { userId, id: transferId } },
  })
  await prisma.$transaction(async (tx) => {
    // Unlike `deleteTransaction`, the pre-read here cannot go stale in a way
    // that matters: a Transfer's two endpoints are immutable — nothing in the
    // app updates `fromAccountId`/`toAccountId`, there is no edit operation for
    // a transfer at all — so the accounts locked below are necessarily still
    // the accounts this row touches. There is nothing to re-verify.
    await lockAccountsForUpdate(tx, userId, [existing.fromAccountId, existing.toAccountId])
    await tx.transfer.delete({ where: { userId_id: { userId, id: transferId } } })
  })
}
