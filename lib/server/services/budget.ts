import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { historicalAmountIn } from '@/lib/currency/historical-amount'
import { getCalendarMonthBounds } from '@/lib/datetime/calendar-month'
import {
  createBudgetSchema,
  updateBudgetSchema,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from '@/lib/validation/budget'

/**
 * Budget service (spec §4.6, §5.5).
 *
 * Five invariants live here and are never delegated to the UI:
 *
 * 1. **Tracking only.** Nothing in this file creates a Transaction, touches a
 *    FinancialAccount, or moves money. A budget is a target to compare against;
 *    exceeding one changes no balance anywhere.
 * 2. **Historical FX, always.** Every contributing transaction is restated with
 *    `historicalAmountIn(budget.currency, row)` — the rate *that row*
 *    snapshotted at entry. This module therefore imports no FX policy at all:
 *    not `getUsableCurrentRate`, not the provider, not `convertToCurrentAmount`,
 *    not the `ExchangeRate` cache. A closed month's percentage is permanently
 *    fixed, and today's rate moving cannot shift last March's progress by a
 *    single dong. That absence of imports is the invariant, so keep it.
 * 3. **EXPENSE only.** A budget is a spending target. INCOME is not spending;
 *    CASH_IN, CASH_OUT and the two ADJUSTMENT types move a balance without
 *    being spending (spec §4.4); and a Transfer is its own entity that is
 *    neither income nor expense (spec §4.5). None of them ever counts, so the
 *    Transfer table is not even queried.
 * 4. **No stored progress.** There is no "spent" column. Progress is derived on
 *    every read from the transactions themselves, so a budget can never drift
 *    out of step with the ledger it summarises — and editing or deleting a
 *    transaction needs no budget write at all.
 * 5. **The month is the user's.** A month's boundaries come from
 *    `getCalendarMonthBounds` in the user's IANA zone, so for a user in
 *    `Asia/Ho_Chi_Minh` an expense at 17:30Z on 31 March counts against April,
 *    because locally it is already 00:30 on 1 April.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — there is no ambient user here.
 * Every single-row lookup goes through the composite `userId_id` key, so
 * another user's budget id is a P2025, never a usable reference.
 *
 * Amounts are `Prisma.Decimal` end to end and nothing here rounds: `ratio` in
 * particular is left at decimal.js's full precision, and the pages that render
 * a percentage apply their own scale.
 */

/**
 * Thrown when a budget would collide with one that already exists — one OVERALL
 * budget per month, one per category per month (the two partial unique indexes
 * `budget_overall_per_month` / `budget_category_per_month`).
 *
 * Mapped from Prisma's P2002 rather than pre-checked with a `findFirst`: a
 * read-then-write cannot be made race-free without a lock, and the index is the
 * only thing that actually holds under two concurrent creates.
 */
export class DuplicateBudgetError extends Error {
  constructor() {
    super('A budget for this month already exists.')
    this.name = 'DuplicateBudgetError'
  }
}

/** Thrown when a CATEGORY budget names a category that is missing, belongs to
 *  another user, is not an EXPENSE category, or has been archived. */
export class InvalidBudgetCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid budget category: ${reason}`)
    this.name = 'InvalidBudgetCategoryError'
  }
}

/**
 * Where a budget stands, as five named bands rather than a raw percentage: the
 * UI colours a bar and may warn, and both need the same thresholds. `at_100` is
 * deliberately distinct from `exceeded` — spending exactly the target is on
 * plan, not over it.
 */
export type BudgetStatus = 'ok' | 'warning_50' | 'warning_80' | 'at_100' | 'exceeded'

/** Only the category columns a budget list renders — not the whole joined row,
 *  whose `userId` has no business crossing to a client component. */
const BUDGET_CATEGORY_SELECT = {
  select: { id: true, name: true, type: true, status: true },
} satisfies Prisma.Budget$categoryArgs

/** Derived from `BUDGET_CATEGORY_SELECT` rather than restating it: adding a
 *  column to the const above must widen this type too, or every caller that
 *  renders off `BudgetRow` (Tasks 3/4) would silently not see the new field. */
export type BudgetRow = Prisma.BudgetGetPayload<{
  include: { category: typeof BUDGET_CATEGORY_SELECT }
}>

export interface BudgetProgress {
  budget: BudgetRow
  /** Σ `historicalAmountIn(budget.currency, row)` over the month's EXPENSE rows
   *  — scoped to the budget's category when its scope is CATEGORY. */
  spent: Prisma.Decimal
  /** `amount − spent`; negative once the budget is exceeded. */
  remaining: Prisma.Decimal
  /** `spent ÷ amount`, unrounded. Callers format it; nobody re-derives it. */
  ratio: Prisma.Decimal
  status: BudgetStatus
}

/** Half of the target — the first band the UI calls out. */
const WARNING_50 = new Prisma.Decimal('0.5')
/** Four fifths — the "you are close" band. */
const WARNING_80 = new Prisma.Decimal('0.8')

/**
 * Which band `spent` falls in against `amount`.
 *
 * Compared as `Decimal` throughout, never via `toNumber()`: at VND magnitudes a
 * float detour can flip the `=== amount` case, and "exactly on target" is a
 * distinct state from "over".
 *
 * `amount` is guaranteed positive by Zod and by the `Budget_amount_positive`
 * CHECK, so the division below is always safe — but a zero would divide to
 * `Infinity` or `NaN` and silently paint a bar rather than fail, so it is
 * rejected loudly instead.
 *
 * `ratio` is an optional pre-computed `spent ÷ amount`. `getBudgetProgressForMonth`
 * has to compute that quotient anyway (it returns it), and dividing a second
 * time here would make `status` and the `ratio` the UI renders two independent
 * computations of the same number — they agree today, but a later change to
 * either (a rounding mode, a guard) could have a bar say 79 % while the badge
 * says `warning_80`. One division, one answer. Callers with no ratio in hand
 * omit it and this computes it.
 */
export function classifyBudgetStatus(
  spent: Prisma.Decimal,
  amount: Prisma.Decimal,
  ratio?: Prisma.Decimal,
): BudgetStatus {
  if (amount.lte(0)) {
    throw new Error(
      `classifyBudgetStatus: budget amount must be positive, got ${amount.toString()}`,
    )
  }
  const cmp = spent.comparedTo(amount)
  if (cmp > 0) return 'exceeded'
  if (cmp === 0) return 'at_100'
  const share = ratio ?? spent.div(amount)
  if (share.gte(WARNING_80)) return 'warning_80'
  if (share.gte(WARNING_50)) return 'warning_50'
  return 'ok'
}

/**
 * Creates a budget for a month.
 *
 * The category is verified through the composite `(userId, id)` key, so another
 * user's category id resolves to nothing and is refused — and it must be an
 * ACTIVE EXPENSE category, because a budget is a spending target and a new one
 * should not be filed under a category the user has retired. (An *existing*
 * budget survives its category being archived; see `listBudgetsForMonth`.)
 *
 * Fields are listed explicitly rather than spread, so the authenticated
 * `userId` can never be overridden regardless of Zod's stripping behaviour, and
 * an OVERALL budget stores `categoryId: null` whatever the input said.
 */
export async function createBudget(userId: string, input: CreateBudgetInput): Promise<BudgetRow> {
  const parsed = createBudgetSchema.parse(input)

  let categoryId: string | null = null
  if (parsed.scope === 'CATEGORY') {
    // `parsed.categoryId` is non-empty here: the schema's refine requires it
    // for CATEGORY scope. The check keeps TypeScript honest about the optional.
    if (!parsed.categoryId) throw new InvalidBudgetCategoryError('no category supplied')
    const category = await prisma.category.findUnique({
      where: { userId_id: { userId, id: parsed.categoryId } },
    })
    if (!category) throw new InvalidBudgetCategoryError('category not found')
    if (category.type !== 'EXPENSE') {
      throw new InvalidBudgetCategoryError(`expected an EXPENSE category, got ${category.type}`)
    }
    if (category.status !== 'ACTIVE') throw new InvalidBudgetCategoryError('category is archived')
    categoryId = category.id
  }

  try {
    return await prisma.budget.create({
      data: {
        userId,
        year: parsed.year,
        month: parsed.month,
        scope: parsed.scope,
        categoryId,
        amount: new Prisma.Decimal(parsed.amount),
        currency: parsed.currency,
      },
      include: { category: BUDGET_CATEGORY_SELECT },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new DuplicateBudgetError()
    }
    throw error
  }
}

/**
 * Changes a budget's target. `year`, `month`, `scope` and `categoryId` are
 * immutable — they are the budget's identity, and the two partial unique
 * indexes are keyed on them — so re-aiming a budget is a delete plus a create.
 *
 * A budget id belonging to another user matches nothing under the composite
 * `userId_id` key and raises Prisma's P2025, which propagates untouched; the
 * action layer maps it to NOT_FOUND, exactly as the transaction services do.
 */
export async function updateBudget(
  userId: string,
  budgetId: string,
  input: UpdateBudgetInput,
): Promise<BudgetRow> {
  const parsed = updateBudgetSchema.parse(input)
  return prisma.budget.update({
    where: { userId_id: { userId, id: budgetId } },
    data: { amount: new Prisma.Decimal(parsed.amount), currency: parsed.currency },
    include: { category: BUDGET_CATEGORY_SELECT },
  })
}

/**
 * Removes a budget. Nothing cascades and no money moves: a budget references
 * transactions only through the month-and-category query in
 * `getBudgetProgressForMonth`, never by a stored link, so deleting one leaves
 * the ledger untouched. P2025 propagates as in `updateBudget`.
 */
export async function deleteBudget(userId: string, budgetId: string): Promise<void> {
  await prisma.budget.delete({ where: { userId_id: { userId, id: budgetId } } })
}

/**
 * OVERALL first, then category budgets by name — the order the budgets page and
 * the export sheet both render within a single month.
 *
 * Sorted in memory rather than by the database: `orderBy: { scope: 'asc' }`
 * orders the enum by its declaration (CATEGORY before OVERALL), and the display
 * order wanted here ("the whole month, then its parts") is not something a
 * single `orderBy` expresses together with a joined `category.name`. The `id`
 * tie-break makes the order total — two categories may legitimately share a
 * name, and without it the same data could render in two different orders on
 * two consecutive requests.
 */
function compareWithinMonth(a: BudgetRow, b: BudgetRow): number {
  return (
    Number(a.scope === 'CATEGORY') - Number(b.scope === 'CATEGORY') ||
    (a.category?.name ?? '').localeCompare(b.category?.name ?? '') ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Every budget the user set for one month.
 *
 * Archived categories are included: archiving hides a category from new entries,
 * it does not erase the budget already set against it or the history filed under
 * it. The UI shows such a row as archived rather than dropping it.
 */
export async function listBudgetsForMonth(
  userId: string,
  year: number,
  month: number,
): Promise<BudgetRow[]> {
  const budgets = await prisma.budget.findMany({
    where: { userId, year, month },
    include: { category: BUDGET_CATEGORY_SELECT },
  })
  return budgets.sort(compareWithinMonth)
}

/**
 * Every budget the user has ever set — the export sheet's data source, newest
 * month first and, within a month, in the same display order as the page.
 *
 * Unbounded by design, like `listTransactionsForExport`: a spreadsheet is the
 * user's complete data, and a cap there is silent data loss rather than a
 * safeguard.
 */
export async function listAllBudgets(userId: string): Promise<BudgetRow[]> {
  const budgets = await prisma.budget.findMany({
    where: { userId },
    include: { category: BUDGET_CATEGORY_SELECT },
  })
  // The month order and the within-month order are one comparator, not a
  // database `orderBy` followed by a re-sort: `compareWithinMonth` ignores
  // year/month, so applying it on top of an ordered result would interleave the
  // months again (stability only preserves the order of *equal* elements, and
  // an OVERALL row from March and a CATEGORY row from April are not equal
  // under it). The within-month half is the same comparator the page uses, so
  // the sheet and the page cannot disagree.
  return budgets.sort((a, b) => b.year - a.year || b.month - a.month || compareWithinMonth(a, b))
}

/** Exactly the columns the sum needs: the amount, its currency and its own FX
 *  snapshot (for `historicalAmountIn`), plus the category key to group on. */
const BUDGET_PROGRESS_SELECT = {
  amount: true,
  currency: true,
  vndPerUsdAtEntry: true,
  categoryId: true,
} satisfies Prisma.TransactionSelect

/**
 * Progress for every budget in one month, in the same order as
 * `listBudgetsForMonth`.
 *
 * Two queries total, whatever the number of budgets: the budgets, then the
 * month's EXPENSE rows once. The rows are then reduced in memory rather than
 * with a `groupBy` per budget, for three reasons — a `groupBy` cannot apply
 * `historicalAmountIn` (each row converts at its *own* snapshot rate, so the
 * conversion has to happen per row before it is summed, which is not something
 * SQL can do here); an OVERALL budget and a CATEGORY budget in the same month
 * read the same rows, so one scan feeds both; and the arithmetic stays in
 * `Decimal` end to end instead of passing through a database `SUM` over a
 * mixed-currency column, which would be meaningless.
 *
 * Returns `[]` without touching the transaction table when the month has no
 * budgets — a user who set none should not pay for a ledger scan.
 */
export async function getBudgetProgressForMonth(
  userId: string,
  timezone: string,
  year: number,
  month: number,
): Promise<BudgetProgress[]> {
  // Before the early return, deliberately: `getCalendarMonthBounds` is the only
  // thing that validates `year`/`month`, and Task 3 parses both from a URL
  // param. Validating after the return would make `month: 13` throw for a user
  // who has budgets and answer `[]` for a user who does not — the same bad
  // request quietly succeeding or failing depending on unrelated data.
  const { startUtc, endUtc } = getCalendarMonthBounds(timezone, year, month)

  const budgets = await listBudgetsForMonth(userId, year, month)
  if (budgets.length === 0) return []

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      // EXPENSE only — see invariant 3 above.
      type: 'EXPENSE',
      // `lt`, never `lte`: `endUtc` is the first instant of the next month.
      date: { gte: startUtc, lt: endUtc },
    },
    select: BUDGET_PROGRESS_SELECT,
  })

  return budgets.map((budget) => {
    let spent = new Prisma.Decimal(0)
    for (const row of rows) {
      // An OVERALL budget takes every expense, uncategorised rows included; a
      // CATEGORY budget takes only its own. `row.categoryId` is `null` for an
      // uncategorised expense and `budget.categoryId` is non-null for every
      // CATEGORY budget (`Budget_scope_category_consistent`), so the two never
      // match accidentally.
      if (budget.scope === 'CATEGORY' && row.categoryId !== budget.categoryId) continue
      spent = spent.add(historicalAmountIn(budget.currency, row))
    }
    // Divided once and shared with the classifier, so `status` and `ratio` can
    // never be two different readings of the same budget.
    const ratio = spent.div(budget.amount)
    return {
      budget,
      spent,
      remaining: budget.amount.sub(spent),
      ratio,
      status: classifyBudgetStatus(spent, budget.amount, ratio),
    }
  })
}
