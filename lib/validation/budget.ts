import { z } from 'zod'
import { MAX_BUDGET_YEAR, MIN_BUDGET_YEAR } from '@/lib/datetime/calendar-month'
import { moneyAmountSchema } from '@/lib/validation/money'

/**
 * A budget's client-supplied fields (spec §4.6).
 *
 * No Prisma import, deliberately: the budget form is a client component and
 * imports these schemas straight into its `zodResolver`, so this module has to
 * stay free of anything that would drag the Prisma client into a browser
 * bundle. The enums are therefore written out as literals rather than derived
 * from `$Enums.BudgetScope` / `$Enums.Currency` — they mirror the schema's own
 * `BudgetScope` and `Currency`, and the service's `create`/`update` calls are
 * type-checked against the generated Prisma types, so a divergence fails the
 * build rather than reaching the database.
 *
 * `amount` reuses the shared money rule (at most 2 decimal places, magnitude
 * capped) and adds strict positivity: a zero or negative spending target is
 * meaningless, and the database says so too (`Budget_amount_positive`).
 *
 * `year`/`month` are plain integers with no timezone — see
 * `lib/datetime/calendar-month.ts`. The `month` bound mirrors the database's
 * own `Budget_month_range` CHECK; the `year` bound is application-level only
 * (there is no `Budget_year_range`), shared with `isBudgetableMonth` through
 * `MIN_BUDGET_YEAR`/`MAX_BUDGET_YEAR`.
 */
export const budgetScopeSchema = z.enum(['OVERALL', 'CATEGORY'])
export const budgetCurrencySchema = z.enum(['VND', 'USD'])

const budgetFields = {
  year: z.number().int().min(MIN_BUDGET_YEAR).max(MAX_BUDGET_YEAR),
  month: z.number().int().min(1).max(12),
  scope: budgetScopeSchema,
  categoryId: z.string().min(1).optional(),
  amount: moneyAmountSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  currency: budgetCurrencySchema,
}

/**
 * A CATEGORY budget must name a category. The converse (an OVERALL budget must
 * not) is enforced in the service, which writes `categoryId: null` for OVERALL
 * regardless of what arrived, and by the database's
 * `Budget_scope_category_consistent` CHECK.
 *
 * Written once and applied to both schemas below, so the form and the server
 * cannot disagree about when a category is required.
 */
function hasCategoryWhenScoped(d: { scope: 'OVERALL' | 'CATEGORY'; categoryId?: string }): boolean {
  return d.scope === 'OVERALL' || !!d.categoryId
}

const CATEGORY_REQUIRED_ISSUE = {
  message: 'Category is required for a category budget',
  path: ['categoryId'],
}

/**
 * What the create form itself collects — the four fields the user actually
 * types. `year`/`month` are deliberately absent: they are the page's selected
 * month (props), not form state, and keeping them out of `useForm` is what
 * stops a mounted form from submitting a month the user has since navigated
 * away from (react-hook-form snapshots `defaultValues` at mount, and Next's
 * App Router preserves client state across a search-param-only navigation).
 * `components/budgets/budget-form.tsx` merges the current month in at submit.
 */
export const budgetFormSchema = z
  .object({
    scope: budgetFields.scope,
    categoryId: budgetFields.categoryId,
    amount: budgetFields.amount,
    currency: budgetFields.currency,
  })
  .refine(hasCategoryWhenScoped, CATEGORY_REQUIRED_ISSUE)

/** The full shape a create actually needs — the form's fields plus the month
 *  the page is showing. This is what the server action and the service parse. */
export const createBudgetSchema = z
  .object(budgetFields)
  .refine(hasCategoryWhenScoped, CATEGORY_REQUIRED_ISSUE)

/**
 * An edit changes only the target. `year`, `month`, `scope` and `categoryId`
 * are a budget's identity — the thing the two partial unique indexes are keyed
 * on — so moving a budget to another month or category is a delete plus a
 * create, not an update.
 */
export const updateBudgetSchema = z.object({
  amount: budgetFields.amount,
  currency: budgetCurrencySchema,
})

export type BudgetFormInput = z.infer<typeof budgetFormSchema>
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>
