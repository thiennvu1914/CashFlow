import { Prisma } from '@prisma/client'
import type { RecordStatus, SavingsGoalEntryKind, SavingsGoalStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { calendarDateToUtcCarrier, todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import {
  createSavingsGoalSchema,
  savingsGoalEntrySchema,
  updateSavingsGoalProgressSchema,
  updateSavingsGoalSchema,
  type CreateSavingsGoalInput,
  type SavingsGoalEntryInput,
  type UpdateSavingsGoalInput,
  type UpdateSavingsGoalProgressInput,
} from '@/lib/validation/savings-goal'
import { ArchivedAccountError } from './account-lock'
import { getBalanceTimeline } from './balance-timeline'

/**
 * Savings-goal service (spec §4.8, amended by money-source linking, spec
 * 2026-10-12 §2 Q5, §5 and §6.7).
 *
 * Five invariants live here and are never delegated to the UI:
 *
 * 1. **Progress is derived, never stored.** A goal *linked* to an account
 *    (`linkedAccountId`) has that account's current derived balance as its
 *    progress — read through the balance service's one-statement timeline,
 *    batched for every linked goal of a listing in one call — so a transfer
 *    into the account moves the goal
 *    with no write to the goal at all. An *unlinked* goal's progress is
 *    Σ CONTRIBUTION − Σ WITHDRAWAL over its `SavingsGoalEntry` rows, one
 *    grouped query. The old typed-in `currentProgress` column is deprecated:
 *    every read omits it and nothing here writes it (its non-zero values were
 *    carried over as opening entries by the `savings_goal_entries` migration).
 *    Switching a goal between the two sources keeps its entries.
 * 2. **A goal never moves money.** Following an account is reading its
 *    balance: nothing here creates a Transaction or a Transfer or touches an
 *    account row, and `savings-goal.test.ts` proves it by running every
 *    mutation against a funded account and re-checking it field for field.
 *    The only balance import is the read-only `./balance-timeline`.
 * 3. **An unlinked goal's progress never goes below zero.** A withdrawal — or
 *    an edit or delete of an entry — that would take it negative is refused
 *    with `SavingsGoalWithdrawalExceedsProgressError`. The check reads the sum
 *    under a `FOR UPDATE` lock on the goal row, taken by every entry writer, so
 *    two concurrent withdrawals queue and the second sees the first's
 *    committed entry (`lockGoalForEntries` sets out why the sum has to be a
 *    separate statement *after* the lock). Entries are refused outright on a
 *    linked goal (`SavingsGoalLinkedError`) — its progress is not theirs — and
 *    on an archived one.
 * 4. **ACHIEVED is derived from that progress.** Every read re-derives the
 *    status (`deriveSavingsGoalStatus`), because a linked account's balance
 *    changes without any goal write; every goal write also stores the status it
 *    derived, so the column agrees with the goal as of its last write. ARCHIVED
 *    is the one stored human decision, and it is terminal: edits and entries on
 *    an archived goal are refused (`SavingsGoalArchivedError`) rather than
 *    silently un-archiving it. Nothing here deletes a goal.
 * 5. **Each goal keeps its own currency.** `User.baseCurrency` is display-only
 *    (ledger ruling R5-3) and nothing here converts a target or a progress
 *    figure; a linked goal's currency *is* its account's, so the balance it
 *    reads is already in it. There is no FX import at all, and money is
 *    `Prisma.Decimal` end to end; the only `toNumber()` for a goal is the
 *    progress bar's width in `lib/ui/savings-goal-view-model.ts`.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — there is no ambient user here.
 * Every single-row lookup goes through the composite `userId_id` key (or the
 * same predicate in the locking SQL), so another user's goal, entry or account
 * id is a P2025, never a usable reference; the composite foreign keys are the
 * database's backstop.
 */

/**
 * Thrown when an archived goal would be edited, or receive an entry.
 *
 * A distinct error rather than a P2025: the row exists and the user can still
 * see it under "Archived goals", so "that goal no longer exists" would be a
 * lie. The action layer maps this to its own code and the UI says the goal is
 * archived.
 */
export class SavingsGoalArchivedError extends Error {
  constructor() {
    super('This goal is archived and can no longer be changed.')
    this.name = 'SavingsGoalArchivedError'
  }
}

/**
 * Thrown when a contribution or withdrawal would be recorded — or an existing
 * entry edited or deleted — on a goal linked to an account. Its progress is the
 * account's balance, so an entry would be a figure the goal can never show
 * (spec §6.7: a linked goal has no entry buttons). Unlinking the goal makes its
 * entries its progress again.
 */
export class SavingsGoalLinkedError extends Error {
  constructor() {
    super("This goal follows a linked account's balance and takes no entries.")
    this.name = 'SavingsGoalLinkedError'
  }
}

/**
 * Thrown when an entry write would take an unlinked goal's progress below
 * zero: a withdrawal larger than what is saved, or shrinking, re-kinding or
 * deleting a contribution that later withdrawals already spent.
 *
 * Carries the progress that was true *under the lock*, so the caller can say
 * what is available without a second, possibly stale, query.
 */
export class SavingsGoalWithdrawalExceedsProgressError extends Error {
  readonly progress: Prisma.Decimal

  constructor(progress: Prisma.Decimal) {
    super("That would take this goal's progress below zero.")
    this.name = 'SavingsGoalWithdrawalExceedsProgressError'
    this.progress = progress
  }
}

/** What a create needs to know about the user that only the session has. */
export interface SavingsGoalContext {
  /** The user's IANA zone: an opening contribution is dated *today* there. */
  timezone: string
}

/** The account a goal follows, as the page shows it. */
export interface LinkedAccountSummary {
  id: string
  name: string
  status: RecordStatus
}

/** Every goal read leaves the deprecated column out, so no caller can mistake
 *  it for progress. */
const GOAL_OMIT = { currentProgress: true } as const

/** What the balance timeline needs of a linked account (`OwnedAccount`), plus
 *  what the page shows and the currency a link adopts. */
const LINKED_ACCOUNT_SELECT = {
  id: true,
  userId: true,
  name: true,
  status: true,
  currency: true,
  initialBalance: true,
  createdAt: true,
} as const

type LinkableAccount = Prisma.FinancialAccountGetPayload<{ select: typeof LINKED_ACCOUNT_SELECT }>

/** A stored goal row without the deprecated column — what `archiveSavingsGoal`
 *  returns, having derived nothing. */
export type SavingsGoalRecord = Prisma.SavingsGoalGetPayload<{ omit: typeof GOAL_OMIT }>

/** One contribution or withdrawal, as stored. */
export type SavingsGoalEntryRow = Prisma.SavingsGoalEntryGetPayload<Record<string, never>>

/**
 * A goal as every surface shows it: the stored definition, the account it
 * follows (or `null`), its derived `progress`, and its `status` re-derived from
 * that progress. `entries` — newest first — only when the read asked for them.
 */
export interface SavingsGoalRow extends SavingsGoalRecord {
  linkedAccount: LinkedAccountSummary | null
  progress: Prisma.Decimal
  entries?: SavingsGoalEntryRow[]
}

export interface ListSavingsGoalsOptions {
  /** The instant a linked goal's balance is read at. A page that renders
   *  several figures takes ONE `new Date()` and threads it through. */
  now?: Date
  /** Also load each goal's entry history. */
  entries?: boolean
}

/**
 * The status a goal must have, given its progress and target.
 *
 * `stored` is consulted for exactly one reason: ARCHIVED wins over everything.
 * An archived goal that happens to have progress past its target is still
 * archived — the user's decision outranks the arithmetic.
 *
 * Compared with `Decimal.gte`, never through `toNumber()`: at VND magnitudes a
 * float detour can flip the exact-boundary case, and "saved precisely the
 * target" is the case that most needs to read ACHIEVED. A linked account's
 * balance can be negative (an overdrawn card); that simply reads ACTIVE.
 */
export function deriveSavingsGoalStatus(
  current: Prisma.Decimal,
  target: Prisma.Decimal,
  stored: SavingsGoalStatus,
): SavingsGoalStatus {
  if (stored === 'ARCHIVED') return 'ARCHIVED'
  return current.gte(target) ? 'ACHIEVED' : 'ACTIVE'
}

/** Goals in progress before goals already met — the order the Savings page and
 *  the dashboard widget both render. */
const STATUS_RANK: Record<SavingsGoalStatus, number> = { ACTIVE: 0, ACHIEVED: 1, ARCHIVED: 2 }

/**
 * Sorted in memory, on the DERIVED status, rather than with an `orderBy` on the
 * stored one: a linked goal whose account just crossed its target is achieved
 * now, whatever its last write stored. The tie-breaks make the order total, so
 * two goals created in the same millisecond cannot swap between requests.
 */
function compareForDisplay(a: SavingsGoalRow, b: SavingsGoalRow): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  )
}

/** A history reads newest first; same-day entries in the order recorded. */
const ENTRY_ORDER: Prisma.SavingsGoalEntryOrderByWithRelationInput[] = [
  { date: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
]

const ZERO = new Prisma.Decimal(0)

/** An entry's effect on progress: the sign comes only from `kind`. */
function signedAmount(kind: SavingsGoalEntryKind, amount: Prisma.Decimal): Prisma.Decimal {
  return kind === 'CONTRIBUTION' ? amount : amount.neg()
}

type EntrySumRow = { kind: SavingsGoalEntryKind; _sum: { amount: Prisma.Decimal | null } }

/** Σ contributions − Σ withdrawals from a grouped query's rows. */
function progressFromSums(rows: EntrySumRow[]): Prisma.Decimal {
  return rows.reduce(
    (progress, row) => progress.add(signedAmount(row.kind, row._sum.amount ?? ZERO)),
    ZERO,
  )
}

/** One unlinked goal's progress: one grouped query over its entries. */
async function entryProgress(
  db: Prisma.TransactionClient,
  userId: string,
  goalId: string,
): Promise<Prisma.Decimal> {
  const rows = await db.savingsGoalEntry.groupBy({
    by: ['kind'],
    where: { userId, goalId },
    _sum: { amount: true },
  })
  return progressFromSums(rows)
}

/**
 * The current derived balance of each account, as of `now`: ONE statement for
 * any number of accounts (`getBalanceTimeline` sampled at the single cutoff
 * `now`) — the same arithmetic and the same `date <= now` cutoff as every other
 * current balance in the app, so a linked goal and its account always read the
 * same figure. Never stored.
 */
async function currentBalances(
  userId: string,
  accounts: LinkableAccount[],
  now: Date,
): Promise<Map<string, Prisma.Decimal>> {
  if (accounts.length === 0) return new Map()
  const timeline = await getBalanceTimeline(userId, accounts, [now])
  return timeline.balances[0]
}

/** One linked account's current derived balance. */
async function accountProgress(
  userId: string,
  account: LinkableAccount,
  now: Date,
): Promise<Prisma.Decimal> {
  const balances = await currentBalances(userId, [account], now)
  return balances.get(account.id) as Prisma.Decimal
}

/** The row every surface renders: definition, link summary, derived progress
 *  and the status derived from it. */
function toRow(
  goal: SavingsGoalRecord,
  account: LinkableAccount | null,
  progress: Prisma.Decimal,
  entries?: SavingsGoalEntryRow[],
): SavingsGoalRow {
  return {
    ...goal,
    status: deriveSavingsGoalStatus(progress, goal.targetAmount, goal.status),
    linkedAccount: account && { id: account.id, name: account.name, status: account.status },
    progress,
    ...(entries === undefined ? {} : { entries }),
  }
}

/**
 * Every goal matching `where`, with derived progress — one database round trip
 * when no goal is linked, two when some are:
 *
 * 1. side by side: the goals; the accounts they follow (a relation filter, so
 *    it need not wait for the goals); the entry sums grouped per goal and kind;
 *    and, when asked, the entry history;
 * 2. only if some goal is linked: ONE balance statement for all of those
 *    accounts together (`currentBalances`).
 *
 * The entry sums and history are scoped by `userId` alone rather than joined to
 * the goal filter: grouped per goal they are a handful of rows, and an
 * archived goal's sums are simply never looked up.
 */
async function loadGoals(
  userId: string,
  where: Prisma.SavingsGoalWhereInput,
  options: ListSavingsGoalsOptions,
): Promise<SavingsGoalRow[]> {
  const now = options.now ?? new Date()
  const goalWhere = { ...where, userId }
  const [goals, linkedAccounts, sums, entries] = await Promise.all([
    prisma.savingsGoal.findMany({
      where: goalWhere,
      omit: GOAL_OMIT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.financialAccount.findMany({
      where: { userId, savingsGoals: { some: goalWhere } },
      select: LINKED_ACCOUNT_SELECT,
    }),
    prisma.savingsGoalEntry.groupBy({
      by: ['goalId', 'kind'],
      where: { userId },
      _sum: { amount: true },
    }),
    options.entries
      ? prisma.savingsGoalEntry.findMany({ where: { userId }, orderBy: ENTRY_ORDER })
      : null,
  ])

  const accountsById = new Map(linkedAccounts.map((account) => [account.id, account]))
  // The two reads are separate statements, so a goal linked between them names
  // an account the second did not return: read it now rather than render the
  // goal without its progress source.
  const unread = [
    ...new Set(
      goals.flatMap((goal) =>
        goal.linkedAccountId !== null && !accountsById.has(goal.linkedAccountId)
          ? [goal.linkedAccountId]
          : [],
      ),
    ),
  ]
  if (unread.length > 0) {
    const late = await prisma.financialAccount.findMany({
      where: { userId, id: { in: unread } },
      select: LINKED_ACCOUNT_SELECT,
    })
    for (const account of late) accountsById.set(account.id, account)
  }
  const accountOf = (goal: SavingsGoalRecord): LinkableAccount | null => {
    if (goal.linkedAccountId === null) return null
    const account = accountsById.get(goal.linkedAccountId)
    // Unreachable under the composite foreign key: never fall back to the
    // entries, which would show a linked goal a progress that is not its own.
    if (!account) throw prismaNotFound('Account', goal.linkedAccountId)
    return account
  }

  const followed = new Map<string, LinkableAccount>()
  for (const goal of goals) {
    const account = accountOf(goal)
    if (account) followed.set(account.id, account)
  }
  const balances = await currentBalances(userId, [...followed.values()], now)

  const sumsByGoal = new Map<string, EntrySumRow[]>()
  for (const row of sums) sumsByGoal.set(row.goalId, [...(sumsByGoal.get(row.goalId) ?? []), row])
  const entriesByGoal = new Map<string, SavingsGoalEntryRow[]>()
  for (const entry of entries ?? []) {
    entriesByGoal.set(entry.goalId, [...(entriesByGoal.get(entry.goalId) ?? []), entry])
  }

  return goals.map((goal) => {
    const account = accountOf(goal)
    return toRow(
      goal,
      account,
      account
        ? (balances.get(account.id) as Prisma.Decimal)
        : progressFromSums(sumsByGoal.get(goal.id) ?? []),
      entries === null ? undefined : (entriesByGoal.get(goal.id) ?? []),
    )
  })
}

/**
 * The goals the Savings page's working list and the dashboard widget show:
 * everything the user is still tracking, in progress first (by derived status).
 *
 * ARCHIVED rows are excluded here and only here — they are still readable via
 * `listAllSavingsGoals`. Archiving hides a goal from the working list; it never
 * erases it.
 */
export async function listSavingsGoals(
  userId: string,
  options: ListSavingsGoalsOptions = {},
): Promise<SavingsGoalRow[]> {
  const goals = await loadGoals(userId, { status: { not: 'ARCHIVED' } }, options)
  return goals.sort(compareForDisplay)
}

/**
 * Every goal the user has ever set, archived ones included — the Savings page
 * (which splits it in memory) and the export sheet's data source.
 *
 * Oldest first and *not* status-ranked: this is a history, and a history reads
 * in the order things happened. Unbounded by design, like `listAllBudgets`: a
 * cap on a user's complete data is silent data loss rather than a safeguard.
 */
export async function listAllSavingsGoals(
  userId: string,
  options: ListSavingsGoalsOptions = {},
): Promise<SavingsGoalRow[]> {
  return loadGoals(userId, {}, options)
}

/**
 * Prisma's own `P2025`, byte for byte what `findUniqueOrThrow` raises on a
 * composite `(userId, id)` lookup that does not match.
 *
 * The goal lock is raw SQL and the account lookup a `findUnique`, so an id
 * belonging to another user comes back as an empty result rather than an
 * error — and that must not be distinguishable from Prisma's answer for a
 * nonexistent id. Rebuilt here for the same reason `debt.ts` rebuilds it.
 */
function prismaNotFound(model: 'Savings goal' | 'Savings goal entry' | 'Account', id: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not found. ${model} ${id} was not found for this user.`,
    { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
  )
}

/** The user's own account by id, or `null` — another user's id included. */
function findAccount(userId: string, accountId: string): Promise<LinkableAccount | null> {
  return prisma.financialAccount.findUnique({
    where: { userId_id: { userId, id: accountId } },
    select: LINKED_ACCOUNT_SELECT,
  })
}

/**
 * The account a goal is about to follow must be the user's own (else P2025)
 * and ACTIVE — unless it is the account the goal already follows, so an
 * account archived since does not block editing the goal's name.
 *
 * No lock: linking moves no money, and an account archived a moment later
 * leaves a goal that simply follows an archived account (whose balance is zero
 * by construction) — the same state as archiving it after the link.
 */
function assertLinkable(
  account: LinkableAccount | null,
  accountId: string,
  currentLinkId: string | null,
): LinkableAccount {
  if (!account) throw prismaNotFound('Account', accountId)
  if (account.status !== 'ACTIVE' && account.id !== currentLinkId) {
    throw new ArchivedAccountError()
  }
  return account
}

/** `undefined` (no deadline) stays `null`; a `yyyy-MM-dd` becomes its
 *  UTC-midnight carrier. The only place a goal's deadline is built. */
function deadlineCarrier(deadline: string | undefined): Date | null {
  return deadline === undefined ? null : calendarDateToUtcCarrier(deadline)
}

/** Today in the user's zone, as an entry-date carrier. */
function todayCarrier(timezone: string, now: Date): Date {
  return calendarDateToUtcCarrier(todayCalendarDateInZone(timezone, now))
}

/**
 * Creates a goal.
 *
 * Fields are listed explicitly rather than spread, so the authenticated
 * `userId` can never be overridden regardless of Zod's stripping behaviour, and
 * a client-supplied `status` is ignored — the status is derived here from the
 * progress the goal starts with, so a goal created already met is ACHIEVED from
 * its first render.
 *
 * - **Linked**: the goal takes the account's currency (whatever `currency`
 *   says), and its starting progress is the account's balance as of `now`.
 * - **Unlinked**: an `initialContribution` above zero becomes the goal's first
 *   CONTRIBUTION entry, dated today in the user's zone, written in the same
 *   statement as the goal (a nested create), so a goal never exists without
 *   the entry its starting figure came from.
 */
export async function createSavingsGoal(
  userId: string,
  input: CreateSavingsGoalInput,
  context: SavingsGoalContext,
  now: Date = new Date(),
): Promise<SavingsGoalRow> {
  const parsed = createSavingsGoalSchema.parse(input)
  const targetAmount = new Prisma.Decimal(parsed.targetAmount)
  const definition = {
    userId,
    name: parsed.name,
    targetAmount,
    deadline: deadlineCarrier(parsed.deadline),
    note: parsed.note ?? null,
  }

  if (parsed.linkedAccountId !== undefined) {
    const account = assertLinkable(
      await findAccount(userId, parsed.linkedAccountId),
      parsed.linkedAccountId,
      null,
    )
    const progress = await accountProgress(userId, account, now)
    const goal = await prisma.savingsGoal.create({
      omit: GOAL_OMIT,
      data: {
        ...definition,
        currency: account.currency,
        linkedAccountId: account.id,
        // 'ACTIVE' as the stored value because there is no stored row yet; a
        // new goal cannot be archived.
        status: deriveSavingsGoalStatus(progress, targetAmount, 'ACTIVE'),
      },
    })
    return toRow(goal, account, progress)
  }

  const initial = new Prisma.Decimal(parsed.initialContribution ?? 0)
  const goal = await prisma.savingsGoal.create({
    omit: GOAL_OMIT,
    data: {
      ...definition,
      currency: parsed.currency,
      status: deriveSavingsGoalStatus(initial, targetAmount, 'ACTIVE'),
      ...(initial.gt(0) && {
        entries: {
          create: {
            kind: 'CONTRIBUTION',
            amount: initial,
            date: todayCarrier(context.timezone, now),
          },
        },
      }),
    },
  })
  return toRow(goal, null, initial)
}

/**
 * Changes a goal's definition — name, target, currency, deadline, note — and
 * its progress SOURCE (`linkedAccountId`), but never its progress. Linking
 * adopts the account's currency; unlinking keeps the goal's entries, which
 * become its progress again (spec §6.7).
 *
 * The existing row is read through the composite key, so another user's goal
 * id raises P2025 (propagated untouched). Its stored status decides ARCHIVED,
 * and the new status is derived against the progress the goal will have —
 * the account's balance (the account itself read side by side with the row),
 * or the entry sum (likewise).
 * That progress can change under a concurrent entry write; the stored status
 * is then one write stale, which no read trusts (every read re-derives it).
 */
export async function updateSavingsGoal(
  userId: string,
  goalId: string,
  input: UpdateSavingsGoalInput,
  now: Date = new Date(),
): Promise<SavingsGoalRow> {
  const parsed = updateSavingsGoalSchema.parse(input)
  const linkId = parsed.linkedAccountId
  const [existing, linkTarget, unlinkedProgress] = await Promise.all([
    prisma.savingsGoal.findUniqueOrThrow({
      where: { userId_id: { userId, id: goalId } },
      select: { status: true, linkedAccountId: true },
    }),
    linkId === undefined ? null : findAccount(userId, linkId),
    linkId === undefined ? entryProgress(prisma, userId, goalId) : null,
  ])
  if (existing.status === 'ARCHIVED') throw new SavingsGoalArchivedError()

  const account =
    linkId === undefined ? null : assertLinkable(linkTarget, linkId, existing.linkedAccountId)
  const progress = account
    ? await accountProgress(userId, account, now)
    : (unlinkedProgress as Prisma.Decimal)

  const targetAmount = new Prisma.Decimal(parsed.targetAmount)
  const goal = await prisma.savingsGoal.update({
    omit: GOAL_OMIT,
    where: { userId_id: { userId, id: goalId } },
    data: {
      name: parsed.name,
      targetAmount,
      currency: account?.currency ?? parsed.currency,
      // An edit that clears the deadline field stores `null` — the absence has
      // to be written, not skipped, or the old deadline would survive. The
      // link likewise: absent means unlinked.
      deadline: deadlineCarrier(parsed.deadline),
      note: parsed.note ?? null,
      linkedAccountId: account?.id ?? null,
      status: deriveSavingsGoalStatus(progress, targetAmount, existing.status),
    },
  })
  return toRow(goal, account, progress)
}

/**
 * Retires a goal. The row and its entries are kept — nothing here deletes a
 * goal — and the page shows it under "Archived goals" from then on.
 *
 * Idempotent, and deliberately not a `SavingsGoalArchivedError`: archiving an
 * already-archived goal is the *same request as the one that succeeded*, which
 * is what a double-click or a stale tab produces. The early return makes it a
 * true no-op — no write at all, so `updatedAt` is not bumped either.
 */
export async function archiveSavingsGoal(
  userId: string,
  goalId: string,
): Promise<SavingsGoalRecord> {
  const existing = await prisma.savingsGoal.findUniqueOrThrow({
    where: { userId_id: { userId, id: goalId } },
    omit: GOAL_OMIT,
  })
  if (existing.status === 'ARCHIVED') return existing

  return prisma.savingsGoal.update({
    where: { userId_id: { userId, id: goalId } },
    data: { status: 'ARCHIVED' },
    omit: GOAL_OMIT,
  })
}

interface EntryGoal {
  status: SavingsGoalStatus
  targetAmount: Prisma.Decimal
}

/**
 * Takes an exclusive lock on one goal row, tenant-scoped in the SQL itself,
 * and refuses a goal that cannot take entries (archived, or linked).
 *
 * Every entry writer takes it first, inside its `prisma.$transaction`, so the
 * entries of one goal only ever change under this lock: the progress the
 * writer reads next is the true, post-commit sum, and two withdrawals that
 * would each fit alone cannot both pass — the second queues, then sees the
 * first. An edit or archive of the goal (an `UPDATE`) conflicts with it too, so
 * a goal linked or archived a moment earlier is seen as such.
 *
 * The progress is read by a SEPARATE statement after this one, never as a
 * subquery of it: under READ COMMITTED a statement that waited for a row lock
 * re-checks only the locked row, while its subqueries keep the snapshot taken
 * before the wait — they would miss exactly the concurrent entry this lock
 * exists to see.
 *
 * Only a goal row is locked — no account, no other goal — so there is no lock
 * order to get wrong against the account-first writers.
 */
async function lockGoalForEntries(
  tx: Prisma.TransactionClient,
  userId: string,
  goalId: string,
): Promise<EntryGoal> {
  const locked = await tx.$queryRaw<
    { status: SavingsGoalStatus; linkedAccountId: string | null; targetAmount: Prisma.Decimal }[]
  >`
    SELECT "status", "linkedAccountId", "targetAmount"
    FROM "SavingsGoal"
    WHERE "userId" = ${userId} AND "id" = ${goalId}
    FOR UPDATE`
  // Empty means another user's goal or none at all — indistinguishable.
  if (locked.length === 0) throw prismaNotFound('Savings goal', goalId)
  const [goal] = locked
  if (goal.status === 'ARCHIVED') throw new SavingsGoalArchivedError()
  if (goal.linkedAccountId !== null) throw new SavingsGoalLinkedError()
  return { status: goal.status, targetAmount: new Prisma.Decimal(goal.targetAmount) }
}

/**
 * The cross-row rule: the progress an entry write leaves behind may be zero,
 * never below it. `before` is what the error reports — the progress under the
 * lock, before this write.
 */
function assertNotNegative(next: Prisma.Decimal, before: Prisma.Decimal): void {
  if (next.isNegative()) throw new SavingsGoalWithdrawalExceedsProgressError(before)
}

/**
 * Stores the status the goal's new progress derives, inside the entry write's
 * transaction (the goal row is already locked) — and only when it changed, so
 * an ordinary entry costs no extra statement.
 */
async function storeDerivedStatus(
  tx: Prisma.TransactionClient,
  userId: string,
  goalId: string,
  goal: EntryGoal,
  progress: Prisma.Decimal,
): Promise<void> {
  const status = deriveSavingsGoalStatus(progress, goal.targetAmount, goal.status)
  if (status === goal.status) return
  await tx.savingsGoal.update({ where: { userId_id: { userId, id: goalId } }, data: { status } })
}

/** The columns an entry's input writes. */
function entryData(input: SavingsGoalEntryInput) {
  return {
    kind: input.kind,
    amount: new Prisma.Decimal(input.amount),
    date: calendarDateToUtcCarrier(input.date),
    note: input.note ?? null,
  }
}

/**
 * The goal an existing entry belongs to, read before any lock is taken so the
 * goal can be locked FIRST (the one lock order every entry writer shares). An
 * entry's `goalId` never changes, so this copy cannot go stale; the entry
 * itself is re-read under the goal lock.
 */
async function goalIdOfEntry(userId: string, entryId: string): Promise<string> {
  const entry = await prisma.savingsGoalEntry.findUniqueOrThrow({
    where: { userId_id: { userId, id: entryId } },
    select: { goalId: true },
  })
  return entry.goalId
}

/** The entry, read under its goal's lock — gone means deleted meanwhile. */
async function lockedEntry(
  tx: Prisma.TransactionClient,
  userId: string,
  entryId: string,
): Promise<SavingsGoalEntryRow> {
  const entry = await tx.savingsGoalEntry.findUnique({
    where: { userId_id: { userId, id: entryId } },
  })
  if (!entry) throw prismaNotFound('Savings goal entry', entryId)
  return entry
}

/**
 * Records one "+ contribution" or "− withdrawal" on an unlinked goal.
 *
 * Parsed before the transaction opens, so a malformed input never takes the
 * lock. Under the goal lock: the progress so far, the new progress with this
 * entry, the zero floor, the insert, and the derived status.
 */
export async function addSavingsGoalEntry(
  userId: string,
  goalId: string,
  input: SavingsGoalEntryInput,
): Promise<SavingsGoalEntryRow> {
  const data = entryData(savingsGoalEntrySchema.parse(input))

  return prisma.$transaction(async (tx) => {
    const goal = await lockGoalForEntries(tx, userId, goalId)
    const progress = await entryProgress(tx, userId, goalId)
    const next = progress.add(signedAmount(data.kind, data.amount))
    assertNotNegative(next, progress)

    const entry = await tx.savingsGoalEntry.create({ data: { userId, goalId, ...data } })
    await storeDerivedStatus(tx, userId, goalId, goal, next)
    return entry
  })
}

/**
 * Changes an entry's kind, amount, date or note. The progress it leaves is the
 * sum without the entry's old effect plus its new one — so shrinking a
 * contribution that later withdrawals already spent is refused like the
 * withdrawal it amounts to.
 */
export async function updateSavingsGoalEntry(
  userId: string,
  entryId: string,
  input: SavingsGoalEntryInput,
): Promise<SavingsGoalEntryRow> {
  const data = entryData(savingsGoalEntrySchema.parse(input))
  const goalId = await goalIdOfEntry(userId, entryId)

  return prisma.$transaction(async (tx) => {
    const goal = await lockGoalForEntries(tx, userId, goalId)
    const current = await lockedEntry(tx, userId, entryId)
    const progress = await entryProgress(tx, userId, goalId)
    const next = progress
      .sub(signedAmount(current.kind, current.amount))
      .add(signedAmount(data.kind, data.amount))
    assertNotNegative(next, progress)

    const entry = await tx.savingsGoalEntry.update({
      where: { userId_id: { userId, id: entryId } },
      data,
    })
    await storeDerivedStatus(tx, userId, goalId, goal, next)
    return entry
  })
}

/** Removes an entry — refused when it is a contribution later withdrawals
 *  already spent. */
export async function deleteSavingsGoalEntry(userId: string, entryId: string): Promise<void> {
  const goalId = await goalIdOfEntry(userId, entryId)

  await prisma.$transaction(async (tx) => {
    const goal = await lockGoalForEntries(tx, userId, goalId)
    const current = await lockedEntry(tx, userId, entryId)
    const progress = await entryProgress(tx, userId, goalId)
    const next = progress.sub(signedAmount(current.kind, current.amount))
    assertNotNegative(next, progress)

    await tx.savingsGoalEntry.delete({ where: { userId_id: { userId, id: entryId } } })
    await storeDerivedStatus(tx, userId, goalId, goal, next)
  })
}

/**
 * @deprecated Transitional (money-source linking Task 9 → Task 10): backs the
 * Savings page's existing "Cập nhật tiến độ / Update progress" dialog, which
 * still posts an absolute "current amount", until the contribute/withdraw UI
 * replaces it — Task 10 removes this and its action.
 *
 * The figure is never stored: the DIFFERENCE from the derived progress is
 * recorded as one CONTRIBUTION (up) or WITHDRAWAL (down) dated today in the
 * user's zone, under the same goal lock as every entry writer, so the
 * difference is taken against the true sum. The same figure again records
 * nothing and returns `null`. Linked and archived goals are refused like any
 * entry; the target figure is `>= 0`, so the zero floor holds by construction.
 */
export async function updateSavingsGoalProgress(
  userId: string,
  goalId: string,
  input: UpdateSavingsGoalProgressInput,
  context: SavingsGoalContext,
  now: Date = new Date(),
): Promise<SavingsGoalEntryRow | null> {
  const wanted = new Prisma.Decimal(updateSavingsGoalProgressSchema.parse(input).progress)
  const date = todayCarrier(context.timezone, now)

  return prisma.$transaction(async (tx) => {
    const goal = await lockGoalForEntries(tx, userId, goalId)
    const progress = await entryProgress(tx, userId, goalId)
    const difference = wanted.sub(progress)
    if (difference.isZero()) return null

    const entry = await tx.savingsGoalEntry.create({
      data: {
        userId,
        goalId,
        kind: difference.isNegative() ? 'WITHDRAWAL' : 'CONTRIBUTION',
        amount: difference.abs(),
        date,
      },
    })
    await storeDerivedStatus(tx, userId, goalId, goal, wanted)
    return entry
  })
}
