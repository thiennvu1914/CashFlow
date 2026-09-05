# CashFlow Phase 5: Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can set one overall monthly spending budget and per-category monthly budgets (each with its own currency), see accurate progress with 50/80/100/exceeded states for any month (open or closed) that never shifts when today's FX rate changes, and see a Budget Progress widget on the dashboard.

**Architecture:** Budget progress always converts each contributing expense transaction via `historicalAmountIn(budget.currency, tx)` — never a live rate — for both open and closed months, per spec §5.5 (this was explicitly corrected during design review; there is no "budgets use current rate" exception). A plain `@@unique` on `(userId, scope, categoryId, year, month)` cannot enforce "at most one OVERALL budget per month," because Postgres treats every `NULL` in a unique index as distinct from every other `NULL` — two OVERALL rows (both with `categoryId = NULL`) would pass that constraint. This phase uses two partial unique indexes instead (added via raw SQL in a Prisma migration), one scoped to `OVERALL` rows and one to `CATEGORY` rows.

**Tech Stack:** Prisma (raw-SQL migration for partial indexes), Zod, React Hook Form.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§4.6, §5.5)

**Depends on:** Phase 2 (Transaction, Category), Phase 3 (`historicalAmountIn`), Phase 4 (dashboard layout, export registry).

## Global Constraints

- No stored balance column anywhere — balance is always derived from Transaction + Transfer.
- Every financial Prisma model is scoped by `userId`; cross-user relations use tenant-scoped composite foreign keys.
- Money fields are always Prisma `Decimal`, never `Float`.
- `Transaction.amount` is always ≥ 0; sign is determined solely by `type`.
- Every Transaction snapshots `vndPerUsdAtEntry`, `fxRateTimestamp`, `fxRateSource` regardless of its own currency.
- `historicalAmountIn()` is the only function permitted to do historical currency conversion; it must never read `User.baseCurrency` or call the live FX provider.
- `User.baseCurrency` is a display/aggregation preference only — never a stored unit of financial fact.
- `User.isDemo` must never appear in any client-facing Zod schema.
- No background jobs/cron — reminders and historical FX lookups are computed lazily on read.
- Every server action/query calls `requireUser()` and scopes every query by the resulting `userId` — a client-supplied user id is never trusted.
- Zod validates every mutation server-side, independent of client-side validation.
- Package manager: npm. No `src/` directory — `app/`, `components/`, `lib/`, `prisma/` at repo root. Import alias `@/*`. Node 20+ LTS.
- **Migration workflow**: `npx prisma migrate dev --name <description>`, never `db push` — the same workflow established from Phase 1 onward, continued here (not a new exception).

---

## Task 1: Budget schema with partial unique indexes

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a migration under `prisma/migrations/` (via the CLI, then hand-edited)

**Interfaces:**
- Consumes: `Category` (Phase 2)
- Produces: `Budget` model — Task 2's service is the only consumer

- [ ] **Step 1: Add the model to schema.prisma (without relying on `@@unique` for the overlap rule)**

```prisma
enum BudgetScope {
  OVERALL
  CATEGORY
}

model Budget {
  id         String      @id @default(cuid())
  userId     String
  year       Int
  month      Int
  scope      BudgetScope
  categoryId String?
  amount     Decimal     @db.Decimal(18, 2)
  currency   Currency
  createdAt  DateTime    @default(now())

  category Category? @relation(fields: [userId, categoryId], references: [userId, id])

  @@unique([userId, id])
  @@index([userId, year, month])
}
```

- [ ] **Step 2: Create a migration and hand-add the two partial unique indexes**

```bash
npx prisma migrate dev --name add_budget --create-only
```
Open the generated migration file under `prisma/migrations/<timestamp>_add_budget/migration.sql` and append:
```sql
CREATE UNIQUE INDEX "budget_overall_per_month" ON "Budget" ("userId", "year", "month") WHERE "scope" = 'OVERALL';
CREATE UNIQUE INDEX "budget_category_per_month" ON "Budget" ("userId", "categoryId", "year", "month") WHERE "scope" = 'CATEGORY';
```
Then apply it:
```bash
npx prisma migrate dev
npx prisma generate
```

- [ ] **Step 3: Verify the partial indexes actually work (not just that the migration ran)**

```bash
npx tsx -e "
import { prisma } from './lib/prisma'
async function main() {
  const user = await prisma.user.create({ data: { id: crypto.randomUUID(), email: 'partial-index-check@example.com', name: 'Test', emailVerified: false } })
  await prisma.budget.create({ data: { userId: user.id, year: 2026, month: 1, scope: 'OVERALL', amount: 1000000, currency: 'VND' } })
  try {
    await prisma.budget.create({ data: { userId: user.id, year: 2026, month: 1, scope: 'OVERALL', amount: 2000000, currency: 'VND' } })
    console.error('FAIL: a second OVERALL budget for the same month was allowed')
  } catch {
    console.log('PASS: second OVERALL budget for the same month was correctly rejected')
  }
  await prisma.budget.deleteMany({ where: { userId: user.id } })
  await prisma.user.delete({ where: { id: user.id } })
}
main()
"
```
Expected output: `PASS: ...`. This is a one-time manual verification of the raw-SQL migration, not a permanent test file — the behavior it proves is exercised again properly in Task 2's automated test suite.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add Budget schema with partial unique indexes for overlap prevention"
```

---

## Task 2: Budget service and progress calculation (TDD)

**Files:**
- Create: `lib/validation/budget.ts`, `lib/server/services/budget.ts`
- Test: `lib/server/services/budget.test.ts`

**Interfaces:**
- Consumes: `historicalAmountIn` (Phase 3), `getPeriodBounds` (Phase 0)
- Produces: `createBudget`, `listBudgetsForMonth`, `getBudgetProgress(userId, budgetId, timezone)` returning `{ spent, budget, percentage, status }` where `status: 'ok' | 'warning_50' | 'warning_80' | 'at_100' | 'exceeded'` — consumed by Task 3's UI and Task 4's dashboard widget

- [ ] **Step 1: Validation schema**

`lib/validation/budget.ts`:
```ts
import { z } from 'zod'

export const createBudgetSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
    scope: z.enum(['OVERALL', 'CATEGORY']),
    categoryId: z.string().min(1).optional(),
    amount: z.number().positive(),
    currency: z.enum(['VND', 'USD']),
  })
  .refine((data) => data.scope === 'OVERALL' || !!data.categoryId, {
    message: 'Category is required for a category-scoped budget',
    path: ['categoryId'],
  })

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>
```

- [ ] **Step 2: Write the failing tests**

`lib/server/services/budget.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { createBudget, getBudgetProgress } from './budget'

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false, timezone: 'Asia/Ho_Chi_Minh' },
  })
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'A', accountTypeId: accountType.id, initialBalance: 0, currency: 'VND' },
  })
  const category = await prisma.category.create({ data: { userId: user.id, name: 'Food', type: 'EXPENSE' } })
  return { userId: user.id, accountId: account.id, categoryId: category.id }
}

async function cleanup(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.budget.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.category.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

function expenseTx(userId: string, accountId: string, categoryId: string, amount: number, date: Date) {
  return prisma.transaction.create({
    data: { userId, accountId, categoryId, type: 'EXPENSE', amount, currency: 'VND', date, vndPerUsdAtEntry: 25000, fxRateTimestamp: new Date(), fxRateSource: 'test' },
  })
}

describe('getBudgetProgress', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it.each([
    [0, 'ok'], [400000, 'warning_50'], [850000, 'warning_80'], [1000000, 'at_100'], [1200000, 'exceeded'],
  ])('classifies %i VND spent against a 1,000,000 VND budget as %s', async (spentAmount, expectedStatus) => {
    const s = await setup()
    userId = s.userId
    const budget = await createBudget(userId, { year: 2026, month: 3, scope: 'CATEGORY', categoryId: s.categoryId, amount: 1_000_000, currency: 'VND' })
    if (spentAmount > 0) {
      await expenseTx(userId, s.accountId, s.categoryId, spentAmount, new Date('2026-03-10T04:00:00Z'))
    }
    const progress = await getBudgetProgress(userId, budget.id, 'Asia/Ho_Chi_Minh')
    expect(progress.status).toBe(expectedStatus)
  })

  it('does not change for a closed month when the FX conversion basis differs from today (uses each transaction\'s own snapshot)', async () => {
    const s = await setup()
    userId = s.userId
    const budget = await createBudget(userId, { year: 2026, month: 1, scope: 'CATEGORY', categoryId: s.categoryId, amount: 1_000_000, currency: 'VND' })
    // Two USD-denominated-equivalent-basis transactions with different snapshot rates should
    // each convert using their own rate, not a single "current" rate applied to the batch.
    await prisma.transaction.create({
      data: { userId, accountId: s.accountId, categoryId: s.categoryId, type: 'EXPENSE', amount: 500_000, currency: 'VND', date: new Date('2026-01-05T04:00:00Z'), vndPerUsdAtEntry: 24000, fxRateTimestamp: new Date(), fxRateSource: 'test' },
    })
    const progress = await getBudgetProgress(userId, budget.id, 'Asia/Ho_Chi_Minh')
    // Since the budget's own currency (VND) matches the transaction's native currency,
    // no conversion is even applied — this asserts the amount passes through unchanged
    // regardless of vndPerUsdAtEntry, confirming no live-rate dependency exists in the path.
    expect(progress.spent.toNumber()).toBe(500_000)
  })
})
```

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run lib/server/services/budget.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement**

`lib/server/services/budget.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/prisma'
import { createBudgetSchema, type CreateBudgetInput } from '@/lib/validation/budget'
import { historicalAmountIn } from '@/lib/currency/historical-amount'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'

export type BudgetStatus = 'ok' | 'warning_50' | 'warning_80' | 'at_100' | 'exceeded'

export async function listBudgetsForMonth(userId: string, year: number, month: number) {
  return prisma.budget.findMany({ where: { userId, year, month }, include: { category: true } })
}

export async function createBudget(userId: string, input: CreateBudgetInput) {
  const parsed = createBudgetSchema.parse(input)
  return prisma.budget.create({
    data: {
      userId,
      year: parsed.year,
      month: parsed.month,
      scope: parsed.scope,
      categoryId: parsed.scope === 'CATEGORY' ? parsed.categoryId : null,
      amount: parsed.amount,
      currency: parsed.currency,
    },
  })
}

function classify(percentage: number): BudgetStatus {
  if (percentage > 100) return 'exceeded'
  if (percentage === 100) return 'at_100'
  if (percentage >= 80) return 'warning_80'
  if (percentage >= 50) return 'warning_50'
  return 'ok'
}

export async function getBudgetProgress(userId: string, budgetId: string, timezone: string) {
  const budget = await prisma.budget.findUniqueOrThrow({ where: { userId_id: { userId, id: budgetId } } })
  const { startUtc, endUtc } = getPeriodBounds(timezone, 'month', new Date(Date.UTC(budget.year, budget.month - 1, 1)))

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      type: 'EXPENSE',
      date: { gte: startUtc, lt: endUtc },
      ...(budget.scope === 'CATEGORY' ? { categoryId: budget.categoryId } : {}),
    },
  })

  let spent = new Decimal(0)
  for (const t of transactions) {
    spent = spent.add(historicalAmountIn(budget.currency, t))
  }

  const percentage = budget.amount.isZero() ? 0 : spent.div(budget.amount).mul(100).toNumber()

  return { spent, budget: budget.amount, percentage, status: classify(percentage) }
}
```

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run lib/server/services/budget.test.ts`
Expected: PASS, all 6 cases (5 threshold cases + the stability case).

- [ ] **Step 6: Commit**

```bash
git add lib/validation/budget.ts lib/server/services/budget.ts lib/server/services/budget.test.ts
git commit -m "feat: add Budget service with 50/80/100/exceeded progress classification"
```

---

## Task 3: Budget UI

**Files:**
- Create: `app/(app)/budgets/page.tsx`, `components/budgets/budget-form.tsx`, `components/budgets/budget-progress-card.tsx`, `lib/server/actions/budget-actions.ts`

**Interfaces:**
- Consumes: `createBudget`, `listBudgetsForMonth`, `getBudgetProgress` (Task 2)
- Produces: `<BudgetProgressCard>` — reused by Task 4's dashboard widget

- [ ] **Step 1: Server action**

`lib/server/actions/budget-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createBudget } from '@/lib/server/services/budget'
import type { CreateBudgetInput } from '@/lib/validation/budget'

export async function createBudgetAction(input: CreateBudgetInput) {
  const user = await requireUser()
  await createBudget(user.id, input)
  revalidatePath('/budgets')
  revalidatePath('/dashboard')
}
```

- [ ] **Step 2: Progress card**

`components/budgets/budget-progress-card.tsx`:
```tsx
const STATUS_COLOR: Record<string, string> = {
  ok: 'bg-positive',
  warning_50: 'bg-warning/60',
  warning_80: 'bg-warning',
  at_100: 'bg-negative/70',
  exceeded: 'bg-negative',
}

export function BudgetProgressCard({
  label,
  spent,
  budget,
  currency,
  percentage,
  status,
}: {
  label: string
  spent: number
  budget: number
  currency: string
  percentage: number
  status: string
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="mb-2 flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums">
          {spent.toLocaleString('vi-VN')} / {budget.toLocaleString('vi-VN')} {currency}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className={`h-full ${STATUS_COLOR[status] ?? 'bg-positive'}`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Form**

`components/budgets/budget-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createBudgetSchema, type CreateBudgetInput } from '@/lib/validation/budget'
import { createBudgetAction } from '@/lib/server/actions/budget-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function BudgetForm({
  year,
  month,
  categories,
}: {
  year: number
  month: number
  categories: { id: string; name: string }[]
}) {
  const { register, watch, handleSubmit, formState: { isSubmitting } } = useForm<CreateBudgetInput>({
    resolver: zodResolver(createBudgetSchema),
    defaultValues: { year, month, scope: 'OVERALL', currency: 'VND' },
  })
  const scope = watch('scope')

  async function onSubmit(values: CreateBudgetInput) {
    await createBudgetAction(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <select {...register('scope')} className="rounded-md border p-2">
        <option value="OVERALL">Overall</option>
        <option value="CATEGORY">Category</option>
      </select>
      {scope === 'CATEGORY' && (
        <select {...register('categoryId')} className="rounded-md border p-2">
          <option value="">Select a category</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      <Input type="number" step="0.01" placeholder="Amount" {...register('amount', { valueAsNumber: true })} />
      <select {...register('currency')} className="rounded-md border p-2">
        <option value="VND">VND</option>
        <option value="USD">USD</option>
      </select>
      <Button type="submit" disabled={isSubmitting}>Add budget</Button>
    </form>
  )
}
```

- [ ] **Step 4: Page**

`app/(app)/budgets/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listBudgetsForMonth, getBudgetProgress } from '@/lib/server/services/budget'
import { listCategories } from '@/lib/server/services/category'
import { BudgetForm } from '@/components/budgets/budget-form'
import { BudgetProgressCard } from '@/components/budgets/budget-progress-card'

export default async function BudgetsPage() {
  const user = await requireUser()
  const timezone = (user as typeof user & { timezone: string }).timezone
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1

  const [budgets, categories] = await Promise.all([
    listBudgetsForMonth(user.id, year, month),
    listCategories(user.id, 'EXPENSE'),
  ])
  const withProgress = await Promise.all(
    budgets.map(async (b) => ({ ...b, progress: await getBudgetProgress(user.id, b.id, timezone) })),
  )

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-3">
        {withProgress.map((b) => (
          <BudgetProgressCard
            key={b.id}
            label={b.scope === 'OVERALL' ? 'Overall' : (b.category?.name ?? 'Category')}
            spent={b.progress.spent.toNumber()}
            budget={b.progress.budget.toNumber()}
            currency={b.currency}
            percentage={b.progress.percentage}
            status={b.progress.status}
          />
        ))}
      </div>
      <BudgetForm year={year} month={month} categories={categories} />
    </div>
  )
}
```

- [ ] **Step 5: Manual verification**

Run `npm run dev`, visit `/budgets`, create an overall budget and a category budget for the current month, add expense transactions crossing the 50/80/100 thresholds, confirm the progress bar color changes accordingly. Attempt to create a second overall budget for the same month — confirm it's rejected (surfaces as an error from the partial unique index via the service call).

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/budgets" components/budgets lib/server/actions/budget-actions.ts
git commit -m "feat: add Budget UI with progress bars"
```

---

## Task 4: Dashboard widget + export sheet

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`
- Create: `lib/server/export/build-budgets-sheet.ts`
- Modify: `app/api/reports/export/route.ts` (add the registration import)

**Interfaces:**
- Consumes: `getBudgetProgress`, `listBudgetsForMonth` (Task 2), `BudgetProgressCard` (Task 3), `registerExportSheet` (Phase 4)
- Produces: nothing new

- [ ] **Step 1: Add the Budget Progress widget to the dashboard**

In `app/(app)/dashboard/page.tsx`, add to the data-fetching `Promise.all` and render a new section:
```tsx
import { listBudgetsForMonth, getBudgetProgress } from '@/lib/server/services/budget'
import { BudgetProgressCard } from '@/components/budgets/budget-progress-card'
// ...
const now = new Date()
const budgets = await listBudgetsForMonth(user.id, now.getFullYear(), now.getMonth() + 1)
const budgetsWithProgress = await Promise.all(
  budgets.map(async (b) => ({ ...b, progress: await getBudgetProgress(user.id, b.id, timezone) })),
)
```
```tsx
{budgetsWithProgress.length > 0 && (
  <div className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">Budget Progress</h3>
    {budgetsWithProgress.map((b) => (
      <BudgetProgressCard
        key={b.id}
        label={b.scope === 'OVERALL' ? 'Overall' : (b.category?.name ?? 'Category')}
        spent={b.progress.spent.toNumber()}
        budget={b.progress.budget.toNumber()}
        currency={b.currency}
        percentage={b.progress.percentage}
        status={b.progress.status}
      />
    ))}
  </div>
)}
```

- [ ] **Step 2: Add the Budgets sheet to the export registry**

`lib/server/export/build-budgets-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { prisma } from '@/lib/prisma'

registerExportSheet(async (workbook, userId) => {
  const budgets = await prisma.budget.findMany({ where: { userId }, include: { category: true } })
  const sheet = workbook.addWorksheet('Budgets')
  sheet.addRow(['Year', 'Month', 'Scope', 'Category', 'Amount', 'Currency'])
  for (const b of budgets) {
    sheet.addRow([b.year, b.month, b.scope, b.category?.name ?? '', b.amount.toNumber(), b.currency])
  }
})
```
In `app/api/reports/export/route.ts`, add:
```ts
import '@/lib/server/export/build-budgets-sheet'
```
alongside the other registration imports.

- [ ] **Step 3: Manual verification**

Run `npm run dev`, confirm the dashboard shows Budget Progress cards matching `/budgets`. Download the full export and confirm a "Budgets" sheet now appears with the expected rows.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/dashboard/page.tsx" lib/server/export/build-budgets-sheet.ts app/api/reports/export/route.ts
git commit -m "feat: add Budget Progress dashboard widget and Budgets export sheet"
```

---

## Phase 5 Acceptance Check

- [ ] A user can create exactly one overall budget and multiple category budgets per month, each with its own currency.
- [ ] Attempting a second overall budget (or a second budget for the same category) in the same month is rejected — proven both by the Task 1 manual check and exercised through the real UI.
- [ ] Budget progress correctly shows ok/50%/80%/100%/exceeded states, verified by the Task 2 test suite's five threshold cases.
- [ ] A closed month's budget percentage does not change when today's FX rate changes — the progress calculation only ever uses `historicalAmountIn`, never a live rate.
- [ ] The dashboard's Budget Progress widget matches the standalone Budgets page.
- [ ] The full Excel export now includes a Budgets sheet.
- [ ] `npm run test`, `npm run lint`, and `npm run build` all succeed.
