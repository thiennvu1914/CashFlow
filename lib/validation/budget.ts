import { z } from 'zod'
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
 * `lib/datetime/calendar-month.ts`. The bounds mirror the database's own
 * `Budget_month_range` CHECK.
 */
export const budgetScopeSchema = z.enum(['OVERALL', 'CATEGORY'])
export const budgetCurrencySchema = z.enum(['VND', 'USD'])

const budgetFields = {
  year: z.number().int().min(2000).max(2100),
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
 */
export const createBudgetSchema = z
  .object(budgetFields)
  .refine((d) => d.scope === 'OVERALL' || !!d.categoryId, {
    message: 'Category is required for a category budget',
    path: ['categoryId'],
  })

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

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>
