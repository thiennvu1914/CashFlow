# CashFlow Phase 2: Core Money Model & FX Trust Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task's commit must leave `npx prisma validate`, targeted tests, `npm run lint`, and `npm run build` all passing — never commit a dangling relation, a stub, or a fake financial implementation.

**Goal:** Accounts, Categories, real currency-conversion infrastructure (provider, cache, outage-resilient snapshotting), Transactions (all six types), and Transfers — with mathematically correct derived balances, database-enforced tenant isolation, and no transaction ever recording a fabricated FX rate.

**Architecture:** This phase is intentionally reordered from a naive "build accounts then transactions then currency" sequence. A `Transaction` row's FX snapshot is an immutable historical financial fact — it must never be populated with a fabricated placeholder rate, so the real `ExchangeRateProvider` + cache + `getUsableCurrentRate` (outage-resilient, staleness-bounded) are built **before** `Transaction` becomes usable at all, not after. Balance calculation is built in two honest stages: Transaction-only first (Transfer doesn't exist yet, so this is completely correct for what data can exist at that point, not a stub), then extended once Transfer lands. The `FinancialAccount` currency/initial-balance lock and the archive-requires-zero-balance guard are deferred to a dedicated hardening task at the end of this phase, once Transaction, Transfer, and balance calculation all exist to support them — again, not stubbed early and "fixed later," but built once, correctly, when their real dependencies exist. Every task that introduces a new Prisma relation adds **both sides** of that relation in the same commit, so no committed schema state ever has a dangling reference.

**Tech Stack:** Prisma (proper migration workflow — `prisma migrate dev`, not `db push`, from this phase onward), Zod, React Hook Form, Vitest (unit + integration against the real local Postgres from Phase 0).

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md`

**Depends on:** Phase 0 (Prisma/Postgres, design tokens), Phase 1 (`requireUser()`, the initial migration already established there, the `databaseHooks.user.create.after` extension point in `lib/auth/auth.ts`).

## Global Constraints

- No stored balance column anywhere — balance is always derived from Transaction + Transfer.
- Every financial Prisma model is scoped by `userId`; cross-user relations use tenant-scoped composite foreign keys (`@@unique([userId, id])` on the parent + composite `@relation([userId, xId], [userId, id])` on the child).
- Money fields are always Prisma `Decimal`, never `Float`.
- `Transaction.amount` is always ≥ 0; sign is determined solely by `type`.
- Every Transaction snapshots `vndPerUsdAtEntry`, `fxRateFetchedAt`, `fxRateEffectiveAt`, `fxRateSource` regardless of its own currency — and that snapshot is always a real value obtained through `getUsableCurrentRate`, never a fabricated constant.
- `historicalAmountIn()` (built in Phase 3) is the only function permitted to do historical currency conversion; it must never read `User.baseCurrency` or call the live FX provider.
- `User.baseCurrency` is a display/aggregation preference only — never a stored unit of financial fact.
- `User.isDemo` must never appear in any client-facing Zod schema.
- No background jobs/cron — reminders and historical FX lookups are computed lazily on read.
- Every server action/query calls `requireUser()` and scopes every query by the resulting `userId` — a client-supplied user id is never trusted.
- Zod validates every mutation server-side, independent of client-side validation.
- Package manager: npm. No `src/` directory — `app/`, `components/`, `lib/`, `prisma/` at repo root. Import alias `@/*`. Node 20+ LTS.
- **Migration workflow**: every schema change in this phase uses `npx prisma migrate dev --name <description>` (or `--create-only` when a raw-SQL addition follows, e.g. a partial index or CHECK constraint), never `prisma db push` — `db push` is reserved for the one-time empty-schema connectivity check already done in Phase 0.

**Standard ownership-safe lookup pattern**, used throughout: `prisma.<model>.findUniqueOrThrow({ where: { userId_id: { userId, id } } })` / `.update({ where: { userId_id: { userId, id } }, ... })`. Because `userId_id` is Prisma's generated compound key for `@@unique([userId, id])`, this single call structurally cannot read or write another user's row.

---

## Task 1: AccountType and Category — schema, defaults, seeding

**Files:**
- Modify: `prisma/schema.prisma`, `lib/auth/auth.ts`
- Create: `lib/server/defaults.ts`
- Test: `lib/server/defaults.test.ts`

**Interfaces:**
- Consumes: `databaseHooks.user.create.after` extension point (Phase 1)
- Produces: `seedDefaultsForUser(userId: string): Promise<void>`

- [ ] **Step 1: Add the schema — no forward-referencing relations to models that don't exist yet**

Append to `prisma/schema.prisma`:
```prisma
enum RecordStatus {
  ACTIVE
  ARCHIVED
}

enum CategoryType {
  INCOME
  EXPENSE
}

model AccountType {
  id        String       @id @default(cuid())
  userId    String
  name      String
  icon      String?
  isDefault Boolean      @default(false)
  status    RecordStatus @default(ACTIVE)
  createdAt DateTime     @default(now())

  @@unique([userId, id])
  @@index([userId])
}

model Category {
  id        String       @id @default(cuid())
  userId    String
  name      String
  type      CategoryType
  icon      String?
  isDefault Boolean      @default(false)
  status    RecordStatus @default(ACTIVE)
  createdAt DateTime     @default(now())

  @@unique([userId, id])
  @@index([userId])
}
```
Neither model declares a back-relation array yet (e.g. no `accounts FinancialAccount[]`) — Task 4 and Task 9 each add the one-line back-relation field to the model they reference, in the same commit that introduces the referencing model. This keeps every migration in this phase self-contained and valid on its own.

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add_account_type_and_category
```
Expected: succeeds, creates `prisma/migrations/<timestamp>_add_account_type_and_category/`, applies cleanly, regenerates the client.

- [ ] **Step 3: Write the failing test for default seeding**

`lib/server/defaults.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { seedDefaultsForUser } from './defaults'
import { randomUUID } from 'node:crypto'

describe('seedDefaultsForUser', () => {
  let userId: string

  afterEach(async () => {
    await prisma.accountType.deleteMany({ where: { userId } })
    await prisma.category.deleteMany({ where: { userId } })
    await prisma.user.delete({ where: { id: userId } })
  })

  it('creates 5 default account types and 16 default categories owned by the user', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
    })
    userId = user.id

    await seedDefaultsForUser(userId)

    const accountTypes = await prisma.accountType.findMany({ where: { userId } })
    const categories = await prisma.category.findMany({ where: { userId } })

    expect(accountTypes).toHaveLength(5)
    expect(accountTypes.every((t) => t.isDefault)).toBe(true)
    expect(categories.filter((c) => c.type === 'EXPENSE')).toHaveLength(10)
    expect(categories.filter((c) => c.type === 'INCOME')).toHaveLength(6)
  })
})
```
Adjust the `prisma.user.create` field list if Phase 1's Better Auth generator produced different required fields on `model User` — check `prisma/schema.prisma` for the actual shape before running this.

- [ ] **Step 4: Run and verify it fails**

Run: `npx vitest run lib/server/defaults.test.ts`
Expected: FAIL — `./defaults` does not exist.

- [ ] **Step 5: Implement**

`lib/server/defaults.ts`:
```ts
import { prisma } from '@/lib/prisma'

export const DEFAULT_ACCOUNT_TYPES = ['Cash', 'Bank Account', 'E-wallet', 'Savings Account', 'Other']

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Food & Dining', 'Transportation', 'Shopping', 'Entertainment', 'Bills & Utilities',
  'Health', 'Education', 'Family', 'Travel', 'Other',
]

export const DEFAULT_INCOME_CATEGORIES = ['Salary', 'Bonus', 'Freelance', 'Investment Income', 'Gift', 'Other']

export async function seedDefaultsForUser(userId: string): Promise<void> {
  await prisma.accountType.createMany({
    data: DEFAULT_ACCOUNT_TYPES.map((name) => ({ userId, name, isDefault: true })),
  })
  await prisma.category.createMany({
    data: [
      ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ userId, name, type: 'EXPENSE' as const, isDefault: true })),
      ...DEFAULT_INCOME_CATEGORIES.map((name) => ({ userId, name, type: 'INCOME' as const, isDefault: true })),
    ],
  })
}
```

- [ ] **Step 6: Wire into the registration hook**

In `lib/auth/auth.ts`, replace the Phase 1 placeholder comment:
```ts
databaseHooks: {
  user: {
    create: {
      after: async (user) => {
        await seedDefaultsForUser(user.id)
      },
    },
  },
},
```
Add the import: `import { seedDefaultsForUser } from '@/lib/server/defaults'`.

- [ ] **Step 7: Run the test and verify it passes**

Run: `npx vitest run lib/server/defaults.test.ts`
Expected: PASS.

- [ ] **Step 8: Verification before commit**

```bash
npx prisma validate
npx vitest run lib/server/defaults.test.ts
npm run lint
npm run build
```
All must pass.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/server/defaults.ts lib/server/defaults.test.ts lib/auth/auth.ts
git commit -m "feat: add AccountType/Category schema and per-user default seeding"
```

---

## Task 2: AccountType CRUD

**Files:**
- Create: `lib/validation/account-type.ts`, `lib/server/services/account-type.ts`, `lib/server/actions/account-type-actions.ts`

**Interfaces:**
- Consumes: `requireUser` (Phase 1)
- Produces: `listAccountTypes`, `createAccountType`, `archiveAccountType` — consumed by Task 5's FinancialAccount form

- [ ] **Step 1: Validation schema**

`lib/validation/account-type.ts`:
```ts
import { z } from 'zod'

export const createAccountTypeSchema = z.object({
  name: z.string().min(1).max(50),
  icon: z.string().max(50).optional(),
})

export type CreateAccountTypeInput = z.infer<typeof createAccountTypeSchema>
```

- [ ] **Step 2: Service**

`lib/server/services/account-type.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { createAccountTypeSchema, type CreateAccountTypeInput } from '@/lib/validation/account-type'

export async function listAccountTypes(userId: string) {
  return prisma.accountType.findMany({
    where: { userId, status: 'ACTIVE' },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
}

export async function createAccountType(userId: string, input: CreateAccountTypeInput) {
  const parsed = createAccountTypeSchema.parse(input)
  return prisma.accountType.create({ data: { userId, name: parsed.name, icon: parsed.icon, isDefault: false } })
}

export async function archiveAccountType(userId: string, accountTypeId: string) {
  return prisma.accountType.update({
    where: { userId_id: { userId, id: accountTypeId } },
    data: { status: 'ARCHIVED' },
  })
}
```

- [ ] **Step 3: Server actions**

`lib/server/actions/account-type-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as accountTypeService from '@/lib/server/services/account-type'
import type { CreateAccountTypeInput } from '@/lib/validation/account-type'

export async function createAccountTypeAction(input: CreateAccountTypeInput) {
  const user = await requireUser()
  await accountTypeService.createAccountType(user.id, input)
  revalidatePath('/categories')
}

export async function archiveAccountTypeAction(accountTypeId: string) {
  const user = await requireUser()
  await accountTypeService.archiveAccountType(user.id, accountTypeId)
  revalidatePath('/categories')
}
```
UI is built together with Category's in Task 3 (a shared page, since both are structurally identical named-list CRUD).

- [ ] **Step 4: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add lib/validation/account-type.ts lib/server/services/account-type.ts lib/server/actions/account-type-actions.ts
git commit -m "feat: add AccountType service and server actions"
```

---

## Task 3: Category CRUD + shared management UI

**Files:**
- Create: `lib/validation/category.ts`, `lib/server/services/category.ts`, `lib/server/actions/category-actions.ts`, `app/(app)/categories/page.tsx`, `components/categories/named-list-manager.tsx`

**Interfaces:**
- Consumes: `requireUser`, `listAccountTypes`/`createAccountType`/`archiveAccountType` (Task 2)
- Produces: `listCategories(userId, type?)`, `createCategory`, `archiveCategory` — consumed by Task 9's Transaction form and every later category-scoped feature

- [ ] **Step 1: Validation schema**

`lib/validation/category.ts`:
```ts
import { z } from 'zod'

export const createCategorySchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['INCOME', 'EXPENSE']),
  icon: z.string().max(50).optional(),
})

export type CreateCategoryInput = z.infer<typeof createCategorySchema>
```

- [ ] **Step 2: Service**

`lib/server/services/category.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { createCategorySchema, type CreateCategoryInput } from '@/lib/validation/category'
import type { CategoryType } from '@prisma/client'

export async function listCategories(userId: string, type?: CategoryType) {
  return prisma.category.findMany({
    where: { userId, status: 'ACTIVE', ...(type ? { type } : {}) },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
}

export async function createCategory(userId: string, input: CreateCategoryInput) {
  const parsed = createCategorySchema.parse(input)
  return prisma.category.create({ data: { userId, ...parsed, isDefault: false } })
}

export async function archiveCategory(userId: string, categoryId: string) {
  return prisma.category.update({
    where: { userId_id: { userId, id: categoryId } },
    data: { status: 'ARCHIVED' },
  })
}
```

- [ ] **Step 3: Server actions**

`lib/server/actions/category-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as categoryService from '@/lib/server/services/category'
import type { CreateCategoryInput } from '@/lib/validation/category'

export async function createCategoryAction(input: CreateCategoryInput) {
  const user = await requireUser()
  await categoryService.createCategory(user.id, input)
  revalidatePath('/categories')
}

export async function archiveCategoryAction(categoryId: string) {
  const user = await requireUser()
  await categoryService.archiveCategory(user.id, categoryId)
  revalidatePath('/categories')
}
```

- [ ] **Step 4: Shared named-list manager component**

`components/categories/named-list-manager.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Item = { id: string; name: string; isDefault: boolean }

export function NamedListManager({
  title,
  items,
  onCreate,
  onArchive,
}: {
  title: string
  items: Item[]
  onCreate: (name: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)

  async function handleAdd() {
    if (!name.trim()) return
    setPending(true)
    await onCreate(name.trim())
    setName('')
    setPending(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between rounded-md border p-2">
            <span>{item.name}</span>
            {!item.isDefault && (
              <button onClick={() => onArchive(item.id)} className="text-sm text-negative">
                Archive
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New name" />
        <Button onClick={handleAdd} disabled={pending}>
          Add
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Page wiring both AccountType and Category**

`app/(app)/categories/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { listCategories } from '@/lib/server/services/category'
import { createAccountTypeAction, archiveAccountTypeAction } from '@/lib/server/actions/account-type-actions'
import { createCategoryAction, archiveCategoryAction } from '@/lib/server/actions/category-actions'
import { NamedListManager } from '@/components/categories/named-list-manager'

export default async function CategoriesPage() {
  const user = await requireUser()
  const [accountTypes, expenseCategories, incomeCategories] = await Promise.all([
    listAccountTypes(user.id),
    listCategories(user.id, 'EXPENSE'),
    listCategories(user.id, 'INCOME'),
  ])

  return (
    <div className="mx-auto grid max-w-3xl gap-8 p-6 md:grid-cols-2">
      <NamedListManager
        title="Account Types"
        items={accountTypes}
        onCreate={async (name) => { 'use server'; await createAccountTypeAction({ name }) }}
        onArchive={async (id) => { 'use server'; await archiveAccountTypeAction(id) }}
      />
      <NamedListManager
        title="Expense Categories"
        items={expenseCategories}
        onCreate={async (name) => { 'use server'; await createCategoryAction({ name, type: 'EXPENSE' }) }}
        onArchive={async (id) => { 'use server'; await archiveCategoryAction(id) }}
      />
      <NamedListManager
        title="Income Categories"
        items={incomeCategories}
        onCreate={async (name) => { 'use server'; await createCategoryAction({ name, type: 'INCOME' }) }}
        onArchive={async (id) => { 'use server'; await archiveCategoryAction(id) }}
      />
    </div>
  )
}
```

- [ ] **Step 6: Manual verification**

Run `npm run dev`, log in, visit `/categories`. Confirm default account types/categories render (no archive button for defaults), add a custom one to each list, archive it, confirm it disappears.

- [ ] **Step 7: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add lib/validation/category.ts lib/server/services/category.ts lib/server/actions/category-actions.ts "app/(app)/categories" components/categories
git commit -m "feat: add Category CRUD and shared account-type/category management page"
```

---

## Task 4: FinancialAccount — schema and basic CRUD (no lock, no archive yet)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/validation/financial-account.ts`, `lib/server/services/financial-account.ts`

**Interfaces:**
- Consumes: `AccountType` (Task 1)
- Produces: `createFinancialAccount`, `updateFinancialAccount` (all fields freely editable — the lock is added in Task 15), `listActiveFinancialAccounts`, `listAllFinancialAccounts` — Task 9 depends on the latter two names being final now, since later tasks call them by these exact names throughout the rest of this phase and Phase 4/6

This task deliberately does **not** include an `archiveFinancialAccount` function yet — archiving correctly requires checking the account's derived balance is zero, and balance calculation doesn't exist until Task 11. Building a fake or partial archive guard now and hardening it later would violate the "no stubs" rule; Task 15 adds real archiving once its real dependency exists.

- [ ] **Step 1: Schema**

Append to `prisma/schema.prisma`:
```prisma
enum Currency {
  VND
  USD
}

model FinancialAccount {
  id             String       @id @default(cuid())
  userId         String
  name           String
  accountTypeId  String
  initialBalance Decimal      @db.Decimal(18, 2)
  currency       Currency
  description    String?
  status         RecordStatus @default(ACTIVE)
  createdAt      DateTime     @default(now())

  accountType AccountType @relation(fields: [userId, accountTypeId], references: [userId, id])

  @@unique([userId, id])
  @@index([userId])
}
```
Add the one-line back-relation to `AccountType` in the same commit:
```prisma
model AccountType {
  // ...existing fields unchanged...
  accounts FinancialAccount[]
}
```

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add_financial_account
```

- [ ] **Step 3: Validation schemas**

`lib/validation/financial-account.ts`:
```ts
import { z } from 'zod'

export const createFinancialAccountSchema = z.object({
  name: z.string().min(1).max(100),
  accountTypeId: z.string().min(1),
  initialBalance: z.number(),
  currency: z.enum(['VND', 'USD']),
  description: z.string().max(500).optional(),
})

export const updateFinancialAccountSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  accountTypeId: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  initialBalance: z.number().optional(),
  currency: z.enum(['VND', 'USD']).optional(),
})

export type CreateFinancialAccountInput = z.infer<typeof createFinancialAccountSchema>
export type UpdateFinancialAccountInput = z.infer<typeof updateFinancialAccountSchema>
```

- [ ] **Step 4: Service (basic CRUD only)**

`lib/server/services/financial-account.ts`:
```ts
import { prisma } from '@/lib/prisma'
import {
  createFinancialAccountSchema, updateFinancialAccountSchema,
  type CreateFinancialAccountInput, type UpdateFinancialAccountInput,
} from '@/lib/validation/financial-account'

export async function listActiveFinancialAccounts(userId: string) {
  return prisma.financialAccount.findMany({
    where: { userId, status: 'ACTIVE' },
    include: { accountType: true },
    orderBy: { createdAt: 'asc' },
  })
}

export async function listAllFinancialAccounts(userId: string) {
  return prisma.financialAccount.findMany({
    where: { userId },
    include: { accountType: true },
    orderBy: { createdAt: 'asc' },
  })
}

export async function createFinancialAccount(userId: string, input: CreateFinancialAccountInput) {
  const parsed = createFinancialAccountSchema.parse(input)
  return prisma.financialAccount.create({ data: { userId, ...parsed } })
}

export async function updateFinancialAccount(
  userId: string,
  accountId: string,
  input: UpdateFinancialAccountInput,
) {
  const parsed = updateFinancialAccountSchema.parse(input)
  // No currency/initialBalance lock yet — Task 15 adds it once Transaction and Transfer
  // both exist and an activity check can be written for real, not stubbed.
  return prisma.financialAccount.update({
    where: { userId_id: { userId, id: accountId } },
    data: parsed,
  })
}
```

- [ ] **Step 5: Verification before commit**

```bash
npx prisma validate
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/validation/financial-account.ts lib/server/services/financial-account.ts
git commit -m "feat: add FinancialAccount schema and basic CRUD"
```

---

## Task 5: FinancialAccount UI

**Files:**
- Create: `app/(app)/accounts/page.tsx`, `components/accounts/account-form.tsx`, `components/accounts/account-list.tsx`, `lib/server/actions/financial-account-actions.ts`

**Interfaces:**
- Consumes: `createFinancialAccount`/`updateFinancialAccount`/`listActiveFinancialAccounts` (Task 4), `listAccountTypes` (Task 2)
- Produces: nothing new — balance shows a placeholder until Task 11; no archive button yet since the service doesn't support it until Task 15

- [ ] **Step 1: Server actions**

`lib/server/actions/financial-account-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as accountService from '@/lib/server/services/financial-account'
import type { CreateFinancialAccountInput, UpdateFinancialAccountInput } from '@/lib/validation/financial-account'

export async function createFinancialAccountAction(input: CreateFinancialAccountInput) {
  const user = await requireUser()
  await accountService.createFinancialAccount(user.id, input)
  revalidatePath('/accounts')
}

export async function updateFinancialAccountAction(accountId: string, input: UpdateFinancialAccountInput) {
  const user = await requireUser()
  await accountService.updateFinancialAccount(user.id, accountId, input)
  revalidatePath('/accounts')
}
```

- [ ] **Step 2: Account form**

`components/accounts/account-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createFinancialAccountSchema, type CreateFinancialAccountInput } from '@/lib/validation/financial-account'
import { createFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type AccountType = { id: string; name: string }

export function AccountForm({ accountTypes }: { accountTypes: AccountType[] }) {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<CreateFinancialAccountInput>({
    resolver: zodResolver(createFinancialAccountSchema),
    defaultValues: { currency: 'VND', initialBalance: 0 },
  })

  async function onSubmit(values: CreateFinancialAccountInput) {
    await createFinancialAccountAction(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <Input placeholder="Account name" {...register('name')} />
      <select {...register('accountTypeId')} className="rounded-md border p-2">
        {accountTypes.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <Input type="number" step="0.01" placeholder="Initial balance" {...register('initialBalance', { valueAsNumber: true })} />
      <select {...register('currency')} className="rounded-md border p-2">
        <option value="VND">VND</option>
        <option value="USD">USD</option>
      </select>
      <Input placeholder="Description (optional)" {...register('description')} />
      <Button type="submit" disabled={isSubmitting}>Create account</Button>
    </form>
  )
}
```

- [ ] **Step 3: Account list (balance placeholder)**

`components/accounts/account-list.tsx`:
```tsx
export function AccountList({
  accounts,
}: {
  accounts: { id: string; name: string; currency: string; accountType: { name: string } }[]
}) {
  return (
    <ul className="flex flex-col gap-2">
      {accounts.map((account) => (
        <li key={account.id} className="flex items-center justify-between rounded-md border p-3">
          <div>
            <p className="font-medium">{account.name}</p>
            <p className="text-sm text-foreground/60">{account.accountType.name} · {account.currency}</p>
          </div>
          <span className="tabular-nums">— {/* wired to getAccountBalance in Task 11 */}</span>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: Page**

`app/(app)/accounts/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { AccountForm } from '@/components/accounts/account-form'
import { AccountList } from '@/components/accounts/account-list'

export default async function AccountsPage() {
  const user = await requireUser()
  const [accounts, accountTypes] = await Promise.all([
    listActiveFinancialAccounts(user.id),
    listAccountTypes(user.id),
  ])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <AccountList accounts={accounts} />
      <div>
        <h2 className="mb-3 text-lg font-semibold">Add account</h2>
        <AccountForm accountTypes={accountTypes} />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Manual verification**

Run `npm run dev`, visit `/accounts`, create a VND cash account and a USD bank account. Confirm both appear with a "—" balance placeholder.

- [ ] **Step 6: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/accounts" components/accounts lib/server/actions/financial-account-actions.ts
git commit -m "feat: add FinancialAccount create/list UI"
```

---

## Task 6: ExchangeRateProvider interface, concrete adapter, and live historical-support verification

**Files:**
- Create: `lib/currency/provider.ts`, `lib/currency/open-er-api-provider.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `ExchangeRateProvider`, `CurrencyPair`, `RateResult` types, `OpenErApiProvider` class — Task 7 wraps this with caching

- [ ] **Step 1: Manually verify the candidate provider's real capabilities (network call, not a unit test)**

```bash
curl -s "https://open.er-api.com/v6/latest/USD"
```
Confirm the response includes a `VND` key under `rates` and a `time_last_update_utc` field. Then check its current documentation for a historical/date-based endpoint. If none exists on the free tier, check one alternative:
```bash
curl -s "https://api.frankfurter.dev/v1/currencies" | grep -i VND
```
If that also lacks VND, **stop searching and accept the documented limitation** — this is the scenario spec §6.1/§17 anticipated: `getLatestRate` fully works, `getHistoricalRate` returns `null` universally, and Account Balance Over Time (Phase 4) shows gaps for historical points rather than fabricating history.

- [ ] **Step 2: Write the interface**

`lib/currency/provider.ts`:
```ts
export type Currency = 'VND' | 'USD'
export type CurrencyPair = { base: Currency; quote: Currency }

export interface RateResult {
  rate: number
  effectiveDate: Date
  fetchedAt: Date
  source: string
}

export interface ExchangeRateProvider {
  getLatestRate(pair: CurrencyPair): Promise<RateResult>
  getHistoricalRate(pair: CurrencyPair, date: Date): Promise<RateResult | null>
}
```

- [ ] **Step 3: Implement the concrete adapter using Step 1's findings**

`lib/currency/open-er-api-provider.ts` (written for the no-free-historical-endpoint outcome — the more likely one; if Step 1 found a working historical endpoint, implement `getHistoricalRate` for real using its actual request/response shape instead):
```ts
import type { ExchangeRateProvider, CurrencyPair, RateResult } from './provider'

export class OpenErApiProvider implements ExchangeRateProvider {
  async getLatestRate(pair: CurrencyPair): Promise<RateResult> {
    const response = await fetch(`https://open.er-api.com/v6/latest/${pair.base}`)
    if (!response.ok) {
      throw new Error(`FX provider request failed with status ${response.status}`)
    }
    const data = (await response.json()) as { rates?: Record<string, number>; time_last_update_utc?: string }
    const rate = data.rates?.[pair.quote]
    if (typeof rate !== 'number') {
      throw new Error(`FX provider returned no rate for ${pair.base}/${pair.quote}`)
    }
    return {
      rate,
      effectiveDate: data.time_last_update_utc ? new Date(data.time_last_update_utc) : new Date(),
      fetchedAt: new Date(),
      source: 'open.er-api.com',
    }
  }

  async getHistoricalRate(_pair: CurrencyPair, _date: Date): Promise<RateResult | null> {
    // Verified during Task 6 Step 1: open.er-api.com's free tier does not expose a
    // historical-date endpoint. Returning null is correct per spec §6.1/§6.4 — callers
    // (Account Balance Over Time, Phase 4) must render a gap rather than substitute the live rate.
    return null
  }
}
```

- [ ] **Step 4: Manual verification**

```bash
npx tsx -e "
import { OpenErApiProvider } from './lib/currency/open-er-api-provider'
new OpenErApiProvider().getLatestRate({ base: 'USD', quote: 'VND' }).then(console.log)
"
```
Expected: prints a `RateResult` with a plausible VND rate (tens of thousands) and today's date.

- [ ] **Step 5: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/currency/provider.ts lib/currency/open-er-api-provider.ts
git commit -m "feat: add ExchangeRateProvider interface and concrete adapter"
```

---

## Task 7: Cache-backed getLatestRate / getHistoricalRate (TDD)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/currency/fx-service.ts`
- Test: `lib/currency/fx-service.test.ts`

**Interfaces:**
- Consumes: `ExchangeRateProvider`, `OpenErApiProvider` (Task 6)
- Produces: `getLatestRate(pair, providerOverride?)`, `getHistoricalRate(pair, date, providerOverride?)` — Task 8 (`getUsableCurrentRate`) and Phase 4 (Net Worth, Account Balance Over Time) consume these

- [ ] **Step 1: Schema**

Append to `prisma/schema.prisma`:
```prisma
model ExchangeRate {
  id            String   @id @default(cuid())
  base          Currency
  quote         Currency
  rate          Decimal  @db.Decimal(18, 6)
  effectiveDate DateTime
  fetchedAt     DateTime
  source        String

  @@unique([base, quote, effectiveDate])
}
```
```bash
npx prisma migrate dev --name add_exchange_rate
```

- [ ] **Step 2: Write the failing tests**

`lib/currency/fx-service.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { getLatestRate, getHistoricalRate } from './fx-service'
import type { ExchangeRateProvider } from './provider'

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

async function cleanupRatesFor(pair: typeof PAIR) {
  await prisma.exchangeRate.deleteMany({ where: { base: pair.base, quote: pair.quote } })
}

describe('getLatestRate', () => {
  afterEach(() => cleanupRatesFor(PAIR))

  it('fetches from the provider and caches under today when nothing is cached', async () => {
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
      getHistoricalRate: async () => null,
    }
    const result = await getLatestRate(PAIR, fakeProvider)
    expect(result.rate).toBe(25000)
    const cached = await prisma.exchangeRate.findFirst({ where: { base: PAIR.base, quote: PAIR.quote } })
    expect(cached).not.toBeNull()
  })

  it('returns the cached value for today without calling the provider again', async () => {
    let callCount = 0
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => {
        callCount += 1
        return { rate: 25500, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }
      },
      getHistoricalRate: async () => null,
    }
    await getLatestRate(PAIR, fakeProvider)
    await getLatestRate(PAIR, fakeProvider)
    expect(callCount).toBe(1)
  })
})

describe('getHistoricalRate', () => {
  afterEach(() => cleanupRatesFor(PAIR))

  it('returns null when the provider has no historical data, without caching anything', async () => {
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
      getHistoricalRate: async () => null,
    }
    const result = await getHistoricalRate(PAIR, new Date('2020-01-01'), fakeProvider)
    expect(result).toBeNull()
    const cached = await prisma.exchangeRate.findFirst({ where: { base: PAIR.base, quote: PAIR.quote } })
    expect(cached).toBeNull()
  })

  it('caches a historical rate once retrieved and reuses it on the next call', async () => {
    let callCount = 0
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
      getHistoricalRate: async (_pair, date) => {
        callCount += 1
        return { rate: 24000, effectiveDate: date, fetchedAt: new Date(), source: 'fake-historical' }
      },
    }
    const date = new Date('2020-01-01')
    const first = await getHistoricalRate(PAIR, date, fakeProvider)
    const second = await getHistoricalRate(PAIR, date, fakeProvider)
    expect(first?.rate).toBe(24000)
    expect(second?.rate).toBe(24000)
    expect(callCount).toBe(1)
  })
})
```

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run lib/currency/fx-service.test.ts`
Expected: FAIL — `./fx-service` does not exist.

- [ ] **Step 4: Implement**

`lib/currency/fx-service.ts`:
```ts
import { prisma } from '@/lib/prisma'
import type { CurrencyPair, ExchangeRateProvider, RateResult } from './provider'
import { OpenErApiProvider } from './open-er-api-provider'

const defaultProvider = new OpenErApiProvider()

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

async function findCached(pair: CurrencyPair, effectiveDate: Date) {
  return prisma.exchangeRate.findUnique({
    where: { base_quote_effectiveDate: { base: pair.base, quote: pair.quote, effectiveDate } },
  })
}

async function cacheRate(pair: CurrencyPair, effectiveDate: Date, result: RateResult) {
  await prisma.exchangeRate.upsert({
    where: { base_quote_effectiveDate: { base: pair.base, quote: pair.quote, effectiveDate } },
    create: { base: pair.base, quote: pair.quote, effectiveDate, rate: result.rate, fetchedAt: result.fetchedAt, source: result.source },
    update: { rate: result.rate, fetchedAt: result.fetchedAt, source: result.source },
  })
}

function toRateResult(cached: { rate: unknown; effectiveDate: Date; fetchedAt: Date; source: string }): RateResult {
  return { rate: Number(cached.rate), effectiveDate: cached.effectiveDate, fetchedAt: cached.fetchedAt, source: cached.source }
}

export async function getLatestRate(
  pair: CurrencyPair,
  providerOverride?: ExchangeRateProvider,
): Promise<RateResult> {
  const today = startOfUtcDay(new Date())
  const cached = await findCached(pair, today)
  if (cached) return toRateResult(cached)

  const provider = providerOverride ?? defaultProvider
  const fresh = await provider.getLatestRate(pair)
  const effectiveDate = startOfUtcDay(fresh.effectiveDate)
  await cacheRate(pair, effectiveDate, fresh)
  return fresh
}

export async function getHistoricalRate(
  pair: CurrencyPair,
  date: Date,
  providerOverride?: ExchangeRateProvider,
): Promise<RateResult | null> {
  const effectiveDate = startOfUtcDay(date)
  const cached = await findCached(pair, effectiveDate)
  if (cached) return toRateResult(cached)

  const provider = providerOverride ?? defaultProvider
  const fetched = await provider.getHistoricalRate(pair, effectiveDate)
  if (!fetched) return null
  await cacheRate(pair, effectiveDate, fetched)
  return fetched
}
```

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run lib/currency/fx-service.test.ts`
Expected: PASS, all 4 tests. No real network call is made — every test injects a fake provider.

- [ ] **Step 6: Verification before commit**

```bash
npx prisma validate
npm run lint
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/currency/fx-service.ts lib/currency/fx-service.test.ts
git commit -m "feat: add cached getLatestRate/getHistoricalRate"
```

---

## Task 8: Shared current-rate policy — getUsableCurrentRate (TDD)

**Files:**
- Create: `lib/currency/current-rate-policy.ts`
- Test: `lib/currency/current-rate-policy.test.ts`

**Interfaces:**
- Consumes: `getLatestRate` (Task 7)
- Produces: `getUsableCurrentRate(pair, providerOverride?): Promise<UsableRateResult>` and `FxUnavailableError`. `UsableRateResult` extends `RateResult` with `isFallback: boolean`. This is the **one** current-rate policy for the whole application: Task 9's `createTransaction` (the only place permitted to populate a Transaction's FX snapshot), Phase 3's `convertToCurrentAmount` (Total Balance, current Net Worth, Account Distribution), and Phase 4's "FX rate last updated" indicator all go through it. Historical activity (Transaction snapshots) and historical position points (`getHistoricalRate`) never use it.

The policy, in order: (1) today's cached rate if present; (2) live provider lookup, cached on success; (3) a last-known-good *current* rate within the 48-hour freshness window, returned with `isFallback: true` and its real original timestamp/source preserved; (4) otherwise `FxUnavailableError`. Steps 1–2 are what `getLatestRate` already does; this function adds 3–4.

**Why a separate staleness concept is needed:** a naive fallback ("use whatever's most recently cached, regardless of age") is not safe — if the live provider has been down since before any "latest" rate was ever successfully cached, the only row in the cache might be a `getHistoricalRate`-cached entry from years ago (e.g. fetched once for a Account Balance Over Time chart point). Ordering by `effectiveDate desc` would still select it, since it's the only candidate, however old. The fix: the fallback query is bounded by an explicit maximum age, checked against `effectiveDate` (not `fetchedAt`, since a historical row can have a recent `fetchedAt` — "when we happened to query it" — while its `effectiveDate` is genuinely ancient; filtering on `effectiveDate` is what correctly excludes it).

- [ ] **Step 1: Write the failing tests**

`lib/currency/current-rate-policy.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { getUsableCurrentRate, FxUnavailableError } from './current-rate-policy'
import type { ExchangeRateProvider } from './provider'

const PAIR = { base: 'USD' as const, quote: 'VND' as const }
const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => { throw new Error('provider down') },
  getHistoricalRate: async () => null,
}

async function cleanup() {
  await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
}

describe('getUsableCurrentRate', () => {
  afterEach(cleanup)

  it('returns a fresh rate with isFallback=false when the provider is available', async () => {
    const workingProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
      getHistoricalRate: async () => null,
    }
    const result = await getUsableCurrentRate(PAIR, workingProvider)
    expect(result.rate).toBe(25000)
    expect(result.source).toBe('fake')
    expect(result.isFallback).toBe(false)
  })

  it('falls back to a recent last-known-good current rate (within 48h) with isFallback=true, preserving its original fetchedAt', async () => {
    const recentFetchedAt = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
    await prisma.exchangeRate.create({
      data: { base: PAIR.base, quote: PAIR.quote, rate: 25000, effectiveDate: recentFetchedAt, fetchedAt: recentFetchedAt, source: 'fresh-fake' },
    })
    const result = await getUsableCurrentRate(PAIR, failingProvider)
    expect(result.rate).toBe(25000)
    expect(result.fetchedAt.toISOString()).toBe(recentFetchedAt.toISOString())
    expect(result.source).toBe('cache-fallback:fresh-fake')
    expect(result.isFallback).toBe(true)
  })

  it('rejects a stale cached fallback older than the freshness window', async () => {
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
    await prisma.exchangeRate.create({
      data: { base: PAIR.base, quote: PAIR.quote, rate: 20000, effectiveDate: staleDate, fetchedAt: staleDate, source: 'stale-fake' },
    })
    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)
  })

  it('does not let a historical-lookup cache entry qualify as a current fallback, even if freshly fetched', async () => {
    // Simulates what getHistoricalRate would cache for an Account Balance Over Time point about
    // a date years in the past. fetchedAt is "just now," but effectiveDate is genuinely ancient
    // — the filter must key off effectiveDate, not fetchedAt, or this would wrongly pass.
    await prisma.exchangeRate.create({
      data: { base: PAIR.base, quote: PAIR.quote, rate: 23000, effectiveDate: new Date('2020-01-01'), fetchedAt: new Date(), source: 'historical-fake' },
    })
    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)
  })

  it('throws FxUnavailableError when the provider fails and no usable cached rate exists at all', async () => {
    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/currency/current-rate-policy.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`lib/currency/current-rate-policy.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { getLatestRate } from './fx-service'
import type { CurrencyPair, ExchangeRateProvider, RateResult } from './provider'

export class FxUnavailableError extends Error {
  constructor() {
    super('Unable to retrieve an exchange rate and no sufficiently recent cached rate is available. Please try again shortly.')
    this.name = 'FxUnavailableError'
  }
}

export interface UsableRateResult extends RateResult {
  /** true when a stale-but-accepted last-known-good current rate was used because the live
   *  provider was unavailable — surfaced to the UI as "rate may be out of date". */
  isFallback: boolean
}

/** A cached rate older than this is not trusted as a "current" fallback — a temporary outage
 * is measured in hours, not days; beyond this window it's more honest to fail than to pretend
 * a stale figure still represents reality. */
export const MAX_FALLBACK_STALENESS_MS = 48 * 60 * 60 * 1000

async function getLastKnownGoodCurrentRate(pair: CurrencyPair): Promise<RateResult | null> {
  const cutoff = new Date(Date.now() - MAX_FALLBACK_STALENESS_MS)
  const candidate = await prisma.exchangeRate.findFirst({
    where: { base: pair.base, quote: pair.quote, effectiveDate: { gte: cutoff } },
    orderBy: { effectiveDate: 'desc' },
  })
  if (!candidate) return null
  return { rate: Number(candidate.rate), effectiveDate: candidate.effectiveDate, fetchedAt: candidate.fetchedAt, source: candidate.source }
}

/**
 * The single current-rate policy for the application (spec §6.3, generalised to every
 * current-position use): today's cache → live provider → recent last-known-good (≤48h,
 * flagged isFallback) → FxUnavailableError. Never used for historical activity or historical
 * position points.
 */
export async function getUsableCurrentRate(
  pair: CurrencyPair,
  providerOverride?: ExchangeRateProvider,
): Promise<UsableRateResult> {
  try {
    const fresh = await getLatestRate(pair, providerOverride)
    return { ...fresh, isFallback: false }
  } catch {
    const fallback = await getLastKnownGoodCurrentRate(pair)
    if (!fallback) throw new FxUnavailableError()
    return { ...fallback, source: `cache-fallback:${fallback.source}`, isFallback: true }
  }
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/currency/current-rate-policy.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/currency/current-rate-policy.ts lib/currency/current-rate-policy.test.ts
git commit -m "feat: add shared getUsableCurrentRate policy with bounded staleness fallback"
```

---

## Task 9: Transaction — schema and service, using the real FX trust center (TDD)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/validation/transaction.ts`, `lib/server/services/transaction.ts`
- Test: `lib/server/services/transaction.test.ts`

**Interfaces:**
- Consumes: `getUsableCurrentRate` (Task 8), `FinancialAccount` (Task 4), `Category` (Task 1)
- Produces: `createTransaction(userId, input, providerOverride?)`, `updateTransaction(userId, id, input)`, `deleteTransaction`, `listTransactions`, plus the domain errors `ArchivedAccountError` and `InvalidCategoryError` — Task 10's UI and every later phase reading transaction history depend on these. The optional `providerOverride` exists only so tests can inject a deterministic fake provider; every production call path omits it and therefore uses the real provider.

No stub of any kind is used here — `getUsableCurrentRate` is real, complete infrastructure by the time this task runs.

**Server-side rules enforced here, never delegated to the UI:**
- Every referenced account must be `ACTIVE`. An archived account has a zero balance by construction (Task 15) and must never silently regain a hidden balance, so a crafted request targeting an archived account is rejected with `ArchivedAccountError`.
- `INCOME` requires an `ACTIVE` category of type `INCOME`; `EXPENSE` requires an `ACTIVE` category of type `EXPENSE`. `CASH_IN`/`CASH_OUT`/`ADJUSTMENT_*` need no category; if one is supplied anyway it must at least be an `ACTIVE` category the user owns. Violations throw `InvalidCategoryError`.

- [ ] **Step 1: Schema, adding both new back-relations in the same commit**

Append to `prisma/schema.prisma`:
```prisma
enum TransactionType {
  INCOME
  EXPENSE
  CASH_IN
  CASH_OUT
  ADJUSTMENT_INCREASE
  ADJUSTMENT_DECREASE
}

model Transaction {
  id               String          @id @default(cuid())
  userId           String
  accountId        String
  categoryId       String?
  type             TransactionType
  amount           Decimal         @db.Decimal(18, 2)
  currency         Currency
  date             DateTime
  note             String?
  vndPerUsdAtEntry  Decimal        @db.Decimal(18, 6)
  fxRateFetchedAt   DateTime
  fxRateEffectiveAt DateTime
  fxRateSource      String
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt

  account  FinancialAccount @relation(fields: [userId, accountId], references: [userId, id])
  category Category?        @relation(fields: [userId, categoryId], references: [userId, id])

  @@unique([userId, id])
  @@index([userId, date])
  @@index([userId, accountId, date])
  @@index([userId, categoryId, date])
}
```
Add the back-relations to the two existing models in the same commit:
```prisma
model Category {
  // ...existing fields unchanged...
  transactions Transaction[]
}

model FinancialAccount {
  // ...existing fields unchanged...
  transactions Transaction[]
}
```
The `category` relation being optional (`Category?`) while still a composite FK works correctly under Postgres's default FK match semantics: a `NULL` in any column of a composite FK exempts that row from the constraint check, so CASH_IN/CASH_OUT/ADJUSTMENT_* transactions with no category are unaffected.

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add_transaction
```

- [ ] **Step 3: Validation schema**

`lib/validation/transaction.ts`:
```ts
import { z } from 'zod'

export const transactionTypeSchema = z.enum([
  'INCOME', 'EXPENSE', 'CASH_IN', 'CASH_OUT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE',
])

const CATEGORY_REQUIRED_TYPES = new Set(['INCOME', 'EXPENSE'])

export const createTransactionSchema = z
  .object({
    accountId: z.string().min(1),
    categoryId: z.string().min(1).optional(),
    type: transactionTypeSchema,
    amount: z.number().positive(),
    date: z.coerce.date(),
    note: z.string().max(500).optional(),
  })
  .refine((data) => !CATEGORY_REQUIRED_TYPES.has(data.type) || !!data.categoryId, {
    message: 'Category is required for income and expense transactions',
    path: ['categoryId'],
  })

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>
```

- [ ] **Step 4: Write the failing tests**

`lib/server/services/transaction.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { createTransaction, deleteTransaction, ArchivedAccountError, InvalidCategoryError } from './transaction'
import type { ExchangeRateProvider } from '@/lib/currency/provider'

// Every test injects this — no test in this file ever touches the network or the real provider.
const fakeProvider: ExchangeRateProvider = {
  getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
  getHistoricalRate: async () => null,
}

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'Test', accountTypeId: accountType.id, initialBalance: 0, currency: 'VND' },
  })
  const expenseCategory = await prisma.category.create({ data: { userId: user.id, name: 'Food', type: 'EXPENSE' } })
  const incomeCategory = await prisma.category.create({ data: { userId: user.id, name: 'Salary', type: 'INCOME' } })
  return { userId: user.id, accountId: account.id, accountTypeId: accountType.id, expenseCategoryId: expenseCategory.id, incomeCategoryId: incomeCategory.id }
}

async function cleanup(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.exchangeRate.deleteMany({ where: { source: 'fake' } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.category.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('createTransaction', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('rejects an EXPENSE transaction with no category', async () => {
    const s = await setup()
    userId = s.userId
    await expect(
      createTransaction(userId, { accountId: s.accountId, type: 'EXPENSE', amount: 1000, date: new Date() }, fakeProvider),
    ).rejects.toThrow()
  })

  it('allows a CASH_IN transaction with no category and snapshots the FX rate through getUsableCurrentRate', async () => {
    const s = await setup()
    userId = s.userId
    const tx = await createTransaction(userId, { accountId: s.accountId, type: 'CASH_IN', amount: 5000, date: new Date() }, fakeProvider)
    expect(tx.categoryId).toBeNull()
    expect(tx.vndPerUsdAtEntry.toNumber()).toBe(25000)
    expect(tx.fxRateSource).toBe('fake')
  })

  it('rejects EXPENSE with an INCOME category', async () => {
    const s = await setup()
    userId = s.userId
    await expect(
      createTransaction(userId, { accountId: s.accountId, categoryId: s.incomeCategoryId, type: 'EXPENSE', amount: 1000, date: new Date() }, fakeProvider),
    ).rejects.toThrow(InvalidCategoryError)
  })

  it('rejects INCOME with an EXPENSE category', async () => {
    const s = await setup()
    userId = s.userId
    await expect(
      createTransaction(userId, { accountId: s.accountId, categoryId: s.expenseCategoryId, type: 'INCOME', amount: 1000, date: new Date() }, fakeProvider),
    ).rejects.toThrow(InvalidCategoryError)
  })

  it('rejects an archived category for a new transaction', async () => {
    const s = await setup()
    userId = s.userId
    await prisma.category.update({ where: { userId_id: { userId, id: s.expenseCategoryId } }, data: { status: 'ARCHIVED' } })
    await expect(
      createTransaction(userId, { accountId: s.accountId, categoryId: s.expenseCategoryId, type: 'EXPENSE', amount: 1000, date: new Date() }, fakeProvider),
    ).rejects.toThrow(InvalidCategoryError)
  })

  it('rejects any new activity on an archived account, even via a crafted request', async () => {
    const s = await setup()
    userId = s.userId
    // Task 15 adds the archive service; here the status is set directly to simulate an
    // archived account and prove the transaction service itself refuses it.
    await prisma.financialAccount.update({ where: { userId_id: { userId, id: s.accountId } }, data: { status: 'ARCHIVED' } })
    await expect(
      createTransaction(userId, { accountId: s.accountId, type: 'CASH_IN', amount: 1000, date: new Date() }, fakeProvider),
    ).rejects.toThrow(ArchivedAccountError)
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0)
  })

  it('deletes cleanly without affecting other rows', async () => {
    const s = await setup()
    userId = s.userId
    const tx = await createTransaction(userId, {
      accountId: s.accountId, categoryId: s.expenseCategoryId, type: 'EXPENSE', amount: 20000, date: new Date(),
    }, fakeProvider)
    await deleteTransaction(userId, tx.id)
    const remaining = await prisma.transaction.findMany({ where: { userId } })
    expect(remaining).toHaveLength(0)
  })
})
```
These tests have zero network dependency: every call passes `fakeProvider`, and `getUsableCurrentRate` only reaches a provider when today's rate isn't already cached. The cleanup deletes any `source: 'fake'` cache rows so tests don't leak state into each other.

- [ ] **Step 5: Run and verify they fail**

Run: `npx vitest run lib/server/services/transaction.test.ts`
Expected: FAIL — `./transaction` does not exist.

- [ ] **Step 6: Implement**

`lib/server/services/transaction.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { createTransactionSchema, type CreateTransactionInput } from '@/lib/validation/transaction'
import { getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import type { TransactionType } from '@prisma/client'

export class ArchivedAccountError extends Error {
  constructor() {
    super('This account is archived and cannot receive new activity.')
    this.name = 'ArchivedAccountError'
  }
}

export class InvalidCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid category: ${reason}`)
    this.name = 'InvalidCategoryError'
  }
}

const P_AND_L_TYPES = new Set<TransactionType>(['INCOME', 'EXPENSE'])

/** Ownership-safe lookup that also enforces the ACTIVE invariant (exported so Task 12's
 *  transfer service can reuse it for both ends of a transfer). */
export async function requireActiveAccount(userId: string, accountId: string) {
  const account = await prisma.financialAccount.findUniqueOrThrow({
    where: { userId_id: { userId, id: accountId } },
  })
  if (account.status !== 'ACTIVE') throw new ArchivedAccountError()
  return account
}

/** Returns the categoryId to store (null for P&L-neutral types with no category supplied). */
async function resolveCategoryId(userId: string, type: TransactionType, categoryId?: string): Promise<string | null> {
  if (!categoryId) {
    if (P_AND_L_TYPES.has(type)) throw new InvalidCategoryError(`${type} requires a category`)
    return null
  }
  const category = await prisma.category.findUniqueOrThrow({ where: { userId_id: { userId, id: categoryId } } })
  if (category.status !== 'ACTIVE') throw new InvalidCategoryError('category is archived')
  if (P_AND_L_TYPES.has(type) && category.type !== type) {
    throw new InvalidCategoryError(`${type} requires a category of type ${type}, got ${category.type}`)
  }
  return category.id
}

export async function listTransactions(userId: string) {
  return prisma.transaction.findMany({
    where: { userId },
    include: { account: true, category: true },
    orderBy: { date: 'desc' },
  })
}

export async function createTransaction(
  userId: string,
  input: CreateTransactionInput,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
) {
  const parsed = createTransactionSchema.parse(input)
  const account = await requireActiveAccount(userId, parsed.accountId)
  const categoryId = await resolveCategoryId(userId, parsed.type, parsed.categoryId)
  const fx = await getUsableCurrentRate({ base: 'USD', quote: 'VND' }, providerOverride)

  return prisma.transaction.create({
    data: {
      userId,
      accountId: parsed.accountId,
      categoryId,
      type: parsed.type,
      amount: parsed.amount,
      currency: account.currency,
      date: parsed.date,
      note: parsed.note,
      vndPerUsdAtEntry: fx.rate,
      fxRateFetchedAt: fx.fetchedAt,
      fxRateEffectiveAt: fx.effectiveDate,
      fxRateSource: fx.source,
    },
  })
}

**Edit semantics (ruling R-6).** The FX snapshot is *not* frozen for the life of the row. It
records the usable current rate at the moment the transaction's **economic content** was last
recorded, so an edit that changes that content re-snapshots it and an edit that does not leaves
it exactly as it was. Concretely: if any of `accountId`, `type`, `amount` (compared as `Decimal`)
or `date` (compared by `getTime()`) differs from the stored row, `updateTransaction` calls
`getUsableCurrentRate` again and writes all four snapshot fields anew (and re-derives `currency`
from the — possibly new — account). If only `note` and/or `categoryId` change, the snapshot is
preserved byte for byte. Because the FX call happens before the write, an economic edit while FX
is unavailable fails with `FxUnavailableError` and leaves the row untouched — a corrected amount
never gets paired with a fabricated or borrowed rate. Both the transaction's current account and
the new target account must be `ACTIVE` (ruling R-7), so a row can neither leave nor enter an
archived account.

```ts
export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: CreateTransactionInput,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
) {
  const parsed = createTransactionSchema.parse(input)
  const existing = await prisma.transaction.findUniqueOrThrow({
    where: { userId_id: { userId, id: transactionId } },
  })
  // Both ends are checked: an archived account may neither lose nor gain activity.
  await requireActiveAccount(userId, existing.accountId)
  const account = await requireActiveAccount(userId, parsed.accountId)
  const categoryId = await resolveCategoryId(userId, parsed.type, parsed.categoryId)

  const economicChange =
    parsed.accountId !== existing.accountId ||
    parsed.type !== existing.type ||
    !new Prisma.Decimal(parsed.amount).equals(existing.amount) ||
    parsed.date.getTime() !== existing.date.getTime()

  // Re-snapshotted only for an economic change; a note/category correction keeps the
  // original snapshot. The FX call runs before the write, so an unavailable rate aborts
  // the edit rather than storing a corrected amount against a borrowed rate.
  const fx = economicChange
    ? await getUsableCurrentRate({ base: 'USD', quote: 'VND' }, providerOverride)
    : null

  return prisma.transaction.update({
    where: { userId_id: { userId, id: transactionId } },
    data: {
      accountId: parsed.accountId,
      categoryId,
      type: parsed.type,
      amount: parsed.amount,
      currency: account.currency,
      date: parsed.date,
      note: parsed.note ?? null,
      ...(fx
        ? {
            vndPerUsdAtEntry: fx.rate,
            fxRateFetchedAt: fx.fetchedAt,
            fxRateEffectiveAt: fx.effectiveDate,
            fxRateSource: fx.source,
          }
        : {}),
    },
  })
}

export async function deleteTransaction(userId: string, transactionId: string) {
  await prisma.transaction.delete({ where: { userId_id: { userId, id: transactionId } } })
}
```

- [ ] **Step 7: Run and verify they pass**

Run: `npx vitest run lib/server/services/transaction.test.ts`
Expected: PASS, all 7 tests, with no network access required.

- [ ] **Step 8: Verification before commit**

```bash
npx prisma validate
npm run lint
npm run build
```

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/validation/transaction.ts lib/server/services/transaction.ts lib/server/services/transaction.test.ts
git commit -m "feat: add Transaction service using the real FX trust center — no fabricated rates"
```

---

## Task 10: Transaction UI

**Files:**
- Create: `app/(app)/transactions/page.tsx`, `components/transactions/transaction-form.tsx`, `components/transactions/transaction-list.tsx`, `lib/server/actions/transaction-actions.ts`

**Interfaces:**
- Consumes: Tasks 1–9
- Produces: nothing new

- [ ] **Step 1: Server actions**

`lib/server/actions/transaction-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as transactionService from '@/lib/server/services/transaction'
import type { CreateTransactionInput } from '@/lib/validation/transaction'

export async function createTransactionAction(input: CreateTransactionInput) {
  const user = await requireUser()
  await transactionService.createTransaction(user.id, input)
  revalidatePath('/transactions')
  revalidatePath('/accounts')
}

export async function updateTransactionAction(id: string, input: CreateTransactionInput) {
  const user = await requireUser()
  await transactionService.updateTransaction(user.id, id, input)
  revalidatePath('/transactions')
  revalidatePath('/accounts')
}

export async function deleteTransactionAction(id: string) {
  const user = await requireUser()
  await transactionService.deleteTransaction(user.id, id)
  revalidatePath('/transactions')
  revalidatePath('/accounts')
}
```

- [ ] **Step 2: Transaction form with type-dependent fields**

`components/transactions/transaction-form.tsx`:
```tsx
'use client'

import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createTransactionSchema, type CreateTransactionInput } from '@/lib/validation/transaction'
import { createTransactionAction } from '@/lib/server/actions/transaction-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const CATEGORY_REQUIRED = new Set(['INCOME', 'EXPENSE'])

export function TransactionForm({
  accounts,
  categories,
}: {
  accounts: { id: string; name: string }[]
  categories: { id: string; name: string; type: 'INCOME' | 'EXPENSE' }[]
}) {
  const { register, control, handleSubmit, formState: { isSubmitting, errors } } =
    useForm<CreateTransactionInput>({ resolver: zodResolver(createTransactionSchema) })
  const type = useWatch({ control, name: 'type' })
  const needsCategory = CATEGORY_REQUIRED.has(type)
  const relevantCategories = categories.filter((c) => c.type === type)

  async function onSubmit(values: CreateTransactionInput) {
    await createTransactionAction(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <select {...register('type')} className="rounded-md border p-2">
        <option value="INCOME">Income</option>
        <option value="EXPENSE">Expense</option>
        <option value="CASH_IN">Cash In (other)</option>
        <option value="CASH_OUT">Cash Out (other)</option>
        <option value="ADJUSTMENT_INCREASE">Balance Adjustment — increase</option>
        <option value="ADJUSTMENT_DECREASE">Balance Adjustment — decrease</option>
      </select>
      <select {...register('accountId')} className="rounded-md border p-2">
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {needsCategory && (
        <select {...register('categoryId')} className="rounded-md border p-2">
          <option value="">Select a category</option>
          {relevantCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {errors.categoryId && <p className="text-sm text-negative">{errors.categoryId.message}</p>}
      <Input type="number" step="0.01" placeholder="Amount" {...register('amount', { valueAsNumber: true })} />
      <Input type="date" {...register('date', { valueAsDate: true })} />
      <Input placeholder="Note (optional)" {...register('note')} />
      <Button type="submit" disabled={isSubmitting}>Add transaction</Button>
    </form>
  )
}
```

- [ ] **Step 3: Transaction list**

`components/transactions/transaction-list.tsx`:
```tsx
'use client'

import { deleteTransactionAction } from '@/lib/server/actions/transaction-actions'

type Row = {
  id: string
  type: string
  amount: unknown
  currency: string
  date: Date
  note: string | null
  account: { name: string }
  category: { name: string } | null
}

export function TransactionList({ transactions }: { transactions: Row[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {transactions.map((tx) => (
        <li key={tx.id} className="flex items-center justify-between rounded-md border p-2">
          <div>
            <p className="font-medium">{tx.category?.name ?? tx.type} · {tx.account.name}</p>
            <p className="text-sm text-foreground/60">{new Date(tx.date).toLocaleDateString()}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="tabular-nums">{String(tx.amount)} {tx.currency}</span>
            <button onClick={() => deleteTransactionAction(tx.id)} className="text-sm text-negative">
              Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: Transactions page**

`app/(app)/transactions/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listTransactions } from '@/lib/server/services/transaction'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listCategories } from '@/lib/server/services/category'
import { TransactionForm } from '@/components/transactions/transaction-form'
import { TransactionList } from '@/components/transactions/transaction-list'

export default async function TransactionsPage() {
  const user = await requireUser()
  const [transactions, accounts, expenseCategories, incomeCategories] = await Promise.all([
    listTransactions(user.id),
    listActiveFinancialAccounts(user.id),
    listCategories(user.id, 'EXPENSE'),
    listCategories(user.id, 'INCOME'),
  ])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <TransactionForm accounts={accounts} categories={[...expenseCategories, ...incomeCategories]} />
      <TransactionList transactions={transactions} />
    </div>
  )
}
```

- [ ] **Step 5: Manual verification**

Run `npm run dev`. Create INCOME/EXPENSE/CASH_IN transactions, confirm the form behaves correctly (category required only for the first two).

- [ ] **Step 6: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/transactions" components/transactions lib/server/actions/transaction-actions.ts
git commit -m "feat: add Transaction UI"
```

---

## Task 11: Balance calculation — Transaction-only (TDD)

**Files:**
- Create: `lib/server/services/balance.ts`
- Test: `lib/server/services/balance.test.ts`
- Modify: `components/accounts/account-list.tsx`, `app/(app)/accounts/page.tsx`

**Interfaces:**
- Consumes: `Transaction` (Task 9), `FinancialAccount` (Task 4)
- Produces: `getAccountBalance(userId, accountId, asOfDate?): Promise<Decimal>` — this signature, including the `asOfDate` parameter and the "zero before the account existed" invariant, is final now; Task 13 extends the function body to add transfer terms but does not change its signature

This is a genuinely complete, correct implementation for what data can exist at this point in the build — Transfer doesn't exist yet, so there are no transfer terms to include; this is not a partial stub, it's an honestly-scoped stage that Task 13 extends.

- [ ] **Step 1: Write the failing tests**

`lib/server/services/balance.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { getAccountBalance } from './balance'

async function setupUserAccount(initialBalance: number, currency: 'VND' | 'USD' = 'VND', createdAt?: Date) {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: {
      userId: user.id, name: 'Test Account', accountTypeId: accountType.id, initialBalance, currency,
      ...(createdAt ? { createdAt } : {}),
    },
  })
  return { userId: user.id, accountId: account.id }
}

async function cleanup(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

function makeTx(userId: string, accountId: string, type: string, amount: number, date: Date = new Date()) {
  return prisma.transaction.create({
    data: {
      userId, accountId, type: type as never, amount, currency: 'VND', date,
      vndPerUsdAtEntry: 25000, fxRateFetchedAt: new Date(), fxRateEffectiveAt: new Date(), fxRateSource: 'test',
    },
  })
}

describe('getAccountBalance', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('starts at initialBalance with no activity', async () => {
    const s = await setupUserAccount(100000)
    userId = s.userId
    expect((await getAccountBalance(userId, s.accountId)).toNumber()).toBe(100000)
  })

  it('applies the correct sign for every transaction type', async () => {
    const s = await setupUserAccount(0)
    userId = s.userId
    await makeTx(userId, s.accountId, 'INCOME', 1000)
    await makeTx(userId, s.accountId, 'EXPENSE', 200)
    await makeTx(userId, s.accountId, 'CASH_IN', 500)
    await makeTx(userId, s.accountId, 'CASH_OUT', 100)
    await makeTx(userId, s.accountId, 'ADJUSTMENT_INCREASE', 50)
    await makeTx(userId, s.accountId, 'ADJUSTMENT_DECREASE', 30)
    // 0 + 1000 - 200 + 500 - 100 + 50 - 30 = 1220
    expect((await getAccountBalance(userId, s.accountId)).toNumber()).toBe(1220)
  })

  it('returns zero for any asOfDate before the account existed', async () => {
    const s = await setupUserAccount(5_000_000, 'VND', new Date('2026-06-01T00:00:00Z'))
    userId = s.userId
    const before = await getAccountBalance(userId, s.accountId, new Date('2026-03-01T00:00:00Z'))
    expect(before.toNumber()).toBe(0)
    const after = await getAccountBalance(userId, s.accountId, new Date('2026-07-01T00:00:00Z'))
    expect(after.toNumber()).toBe(5_000_000)
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/server/services/balance.test.ts`
Expected: FAIL — `./balance` does not exist.

- [ ] **Step 3: Implement**

`lib/server/services/balance.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { Decimal } from '@prisma/client/runtime/library'
import type { TransactionType } from '@prisma/client'

const BALANCE_SIGN: Record<TransactionType, 1 | -1> = {
  INCOME: 1,
  EXPENSE: -1,
  CASH_IN: 1,
  CASH_OUT: -1,
  ADJUSTMENT_INCREASE: 1,
  ADJUSTMENT_DECREASE: -1,
}

export async function getAccountBalance(userId: string, accountId: string, asOfDate?: Date): Promise<Decimal> {
  const account = await prisma.financialAccount.findUniqueOrThrow({
    where: { userId_id: { userId, id: accountId } },
  })

  if (asOfDate && asOfDate < account.createdAt) {
    return new Decimal(0)
  }

  const dateFilter = asOfDate ? { date: { lte: asOfDate } } : {}
  const transactionSums = await prisma.transaction.groupBy({
    by: ['type'],
    where: { userId, accountId, ...dateFilter },
    _sum: { amount: true },
  })

  let balance = account.initialBalance as Decimal
  for (const row of transactionSums) {
    balance = balance.add((row._sum.amount ?? new Decimal(0)).mul(BALANCE_SIGN[row.type]))
  }
  return balance
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/server/services/balance.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Wire real balances into the Accounts UI**

`app/(app)/accounts/page.tsx` — fetch balances alongside accounts:
```tsx
import { getAccountBalance } from '@/lib/server/services/balance'
// ...
const accountsWithBalance = await Promise.all(
  accounts.map(async (a) => ({ ...a, balance: await getAccountBalance(user.id, a.id) })),
)
```
`components/accounts/account-list.tsx` — replace the placeholder span:
```tsx
<span className="tabular-nums">
  {new Intl.NumberFormat('vi-VN').format(account.balance.toNumber())} {account.currency}
</span>
```
(Update the component's prop type from `accounts` to the balance-augmented shape.)

- [ ] **Step 6: Manual verification**

Create a transaction against a test account (Task 10's UI), reload `/accounts`, confirm the displayed balance matches the formula.

- [ ] **Step 7: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add lib/server/services/balance.ts lib/server/services/balance.test.ts "app/(app)/accounts/page.tsx" components/accounts/account-list.tsx
git commit -m "feat: add Transaction-only derived balance calculation, wired into the Accounts UI"
```

---

## Task 12: Transfer — schema and service (TDD)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/validation/transfer.ts`, `lib/server/services/transfer.ts`
- Test: `lib/server/services/transfer.test.ts`

**Interfaces:**
- Consumes: `FinancialAccount` (Task 4), `requireActiveAccount` / `ArchivedAccountError` (Task 9)
- Produces: `createTransfer`, `listTransfers` — Task 13 extends balance calculation to include these; Task 14's UI consumes both

**Server-side rules enforced here, never delegated to the UI:**
- **Same-currency transfers conserve money.** When `fromAccount.currency === toAccount.currency`, the server derives `toAmount` from `fromAmount` and ignores any client-supplied `toAmount` — a crafted request cannot move 100 VND out of one account and materialise 500 VND in another. `toAmount` stays a required input only because cross-currency transfers genuinely need it.
- Both the source and destination account must be `ACTIVE` (reusing Task 9's `requireActiveAccount`), so an archived account can never regain a hidden balance through a transfer.

- [ ] **Step 1: Schema, adding both new back-relations in the same commit**

Append to `prisma/schema.prisma`:
```prisma
model Transfer {
  id               String   @id @default(cuid())
  userId           String
  fromAccountId    String
  toAccountId      String
  fromAmount       Decimal  @db.Decimal(18, 2)
  toAmount         Decimal  @db.Decimal(18, 2)
  exchangeRateUsed Decimal? @db.Decimal(18, 6)
  date             DateTime
  note             String?
  createdAt        DateTime @default(now())

  fromAccount FinancialAccount @relation("TransferFromAccount", fields: [userId, fromAccountId], references: [userId, id])
  toAccount   FinancialAccount @relation("TransferToAccount", fields: [userId, toAccountId], references: [userId, id])

  @@unique([userId, id])
  @@index([userId, date])
}
```
Add the reciprocal named relations to `FinancialAccount` in the same commit:
```prisma
model FinancialAccount {
  // ...existing fields unchanged...
  transfersFrom Transfer[] @relation("TransferFromAccount")
  transfersTo   Transfer[] @relation("TransferToAccount")
}
```

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add_transfer
```

- [ ] **Step 3: Write the failing tests**

`lib/validation/transfer.ts`:
```ts
import { z } from 'zod'

export const createTransferSchema = z
  .object({
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    fromAmount: z.number().positive(),
    toAmount: z.number().positive(),
    date: z.coerce.date(),
    note: z.string().max(500).optional(),
  })
  .refine((data) => data.fromAccountId !== data.toAccountId, {
    message: 'Cannot transfer to the same account',
    path: ['toAccountId'],
  })

export type CreateTransferInput = z.infer<typeof createTransferSchema>
```

`lib/server/services/transfer.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { createTransfer } from './transfer'
import { ArchivedAccountError } from './transaction'
import { getAccountBalance } from './balance'

async function setupTwoAccounts(currencyA: 'VND' | 'USD', currencyB: 'VND' | 'USD') {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  const type = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const a = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'A', accountTypeId: type.id, initialBalance: 1000000, currency: currencyA },
  })
  const b = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'B', accountTypeId: type.id, initialBalance: 0, currency: currencyB },
  })
  return { userId: user.id, accountAId: a.id, accountBId: b.id }
}

async function cleanup(userId: string) {
  await prisma.transfer.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('createTransfer', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('rejects transferring an account to itself', async () => {
    const s = await setupTwoAccounts('VND', 'VND')
    userId = s.userId
    await expect(
      createTransfer(userId, { fromAccountId: s.accountAId, toAccountId: s.accountAId, fromAmount: 100, toAmount: 100, date: new Date() }),
    ).rejects.toThrow()
  })

  it('records no exchangeRateUsed for a same-currency transfer', async () => {
    const s = await setupTwoAccounts('VND', 'VND')
    userId = s.userId
    const transfer = await createTransfer(userId, {
      fromAccountId: s.accountAId, toAccountId: s.accountBId, fromAmount: 500000, toAmount: 500000, date: new Date(),
    })
    expect(transfer.exchangeRateUsed).toBeNull()
  })

  it('records the effective exchangeRateUsed for a cross-currency transfer', async () => {
    const s = await setupTwoAccounts('VND', 'USD')
    userId = s.userId
    const transfer = await createTransfer(userId, {
      fromAccountId: s.accountAId, toAccountId: s.accountBId, fromAmount: 250000, toAmount: 10, date: new Date(),
    })
    expect(transfer.exchangeRateUsed?.toNumber()).toBeCloseTo(10 / 250000)
  })

  it('conserves money on a same-currency transfer: a crafted mismatched toAmount is overridden server-side', async () => {
    const s = await setupTwoAccounts('VND', 'VND')
    userId = s.userId
    // Crafted request: 100 out, 500 in. The server must store toAmount = fromAmount = 100.
    const transfer = await createTransfer(userId, {
      fromAccountId: s.accountAId, toAccountId: s.accountBId, fromAmount: 100, toAmount: 500, date: new Date(),
    })
    expect(transfer.toAmount.toNumber()).toBe(100)
    expect(transfer.fromAmount.toNumber()).toBe(100)
    // Total money across both accounts is unchanged: 1,000,000 + 0 before, 999,900 + 100 after.
    // (getAccountBalance includes transfer terms from Task 13 onward — until then this
    // assertion is satisfied by the stored amounts above; keep it, it becomes live in Task 13.)
    const a = await getAccountBalance(userId, s.accountAId)
    const b = await getAccountBalance(userId, s.accountBId)
    expect(a.add(b).toNumber()).toBe(1_000_000)
  })

  it('rejects a transfer whose source account is archived', async () => {
    const s = await setupTwoAccounts('VND', 'VND')
    userId = s.userId
    await prisma.financialAccount.update({ where: { userId_id: { userId, id: s.accountAId } }, data: { status: 'ARCHIVED' } })
    await expect(
      createTransfer(userId, { fromAccountId: s.accountAId, toAccountId: s.accountBId, fromAmount: 100, toAmount: 100, date: new Date() }),
    ).rejects.toThrow(ArchivedAccountError)
  })

  it('rejects a transfer whose destination account is archived', async () => {
    const s = await setupTwoAccounts('VND', 'VND')
    userId = s.userId
    await prisma.financialAccount.update({ where: { userId_id: { userId, id: s.accountBId } }, data: { status: 'ARCHIVED' } })
    await expect(
      createTransfer(userId, { fromAccountId: s.accountAId, toAccountId: s.accountBId, fromAmount: 100, toAmount: 100, date: new Date() }),
    ).rejects.toThrow(ArchivedAccountError)
    expect(await prisma.transfer.count({ where: { userId } })).toBe(0)
  })
})
```
The conservation test's final balance assertion depends on `getAccountBalance` including transfer terms, which Task 13 adds. At this task, `getAccountBalance` is Transaction-only and returns `1,000,000 + 0` regardless — so the assertion passes trivially now and becomes a genuine conservation check once Task 13 lands (re-run this file in Task 13 Step 4 to confirm it still passes then). The stored-amount assertions above it are the load-bearing check at this task.

- [ ] **Step 4: Run and verify they fail**

Run: `npx vitest run lib/server/services/transfer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 5: Implement**

`lib/server/services/transfer.ts`:
```ts
import { prisma } from '@/lib/prisma'
import { Decimal } from '@prisma/client/runtime/library'
import { createTransferSchema, type CreateTransferInput } from '@/lib/validation/transfer'
import { requireActiveAccount } from './transaction'

export async function listTransfers(userId: string) {
  return prisma.transfer.findMany({
    where: { userId },
    include: { fromAccount: true, toAccount: true },
    orderBy: { date: 'desc' },
  })
}

export async function createTransfer(userId: string, input: CreateTransferInput) {
  const parsed = createTransferSchema.parse(input)
  const [fromAccount, toAccount] = await Promise.all([
    requireActiveAccount(userId, parsed.fromAccountId),
    requireActiveAccount(userId, parsed.toAccountId),
  ])

  const sameCurrency = fromAccount.currency === toAccount.currency
  // Same currency: money is conserved by construction — toAmount is derived, never trusted
  // from the client. Cross-currency: the client's explicit toAmount is the actual received
  // amount, and the effective rate is recorded for the audit trail.
  const toAmount = sameCurrency ? parsed.fromAmount : parsed.toAmount
  const exchangeRateUsed = sameCurrency ? null : new Decimal(parsed.toAmount).div(parsed.fromAmount)

  return prisma.transfer.create({
    data: {
      userId,
      fromAccountId: parsed.fromAccountId,
      toAccountId: parsed.toAccountId,
      fromAmount: parsed.fromAmount,
      toAmount,
      exchangeRateUsed,
      date: parsed.date,
      note: parsed.note,
    },
  })
}
```

- [ ] **Step 6: Run and verify they pass**

Run: `npx vitest run lib/server/services/transfer.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 7: Verification before commit**

```bash
npx prisma validate
npm run lint
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/validation/transfer.ts lib/server/services/transfer.ts lib/server/services/transfer.test.ts
git commit -m "feat: add Transfer schema and service"
```

---

## Task 13: Extend balance calculation with transfer terms (TDD)

**Files:**
- Modify: `lib/server/services/balance.ts`, `lib/server/services/balance.test.ts`

**Interfaces:**
- Consumes: `Transfer` (Task 12)
- Produces: `getAccountBalance` — same signature as Task 11, body extended; this is now the phase's final, complete balance formula

- [ ] **Step 1: Add the failing test cases**

Append to `lib/server/services/balance.test.ts`:
```ts
it('applies transfers in and out without affecting income/expense', async () => {
  const setupA = await setupUserAccount(1000)
  userId = setupA.userId
  const accountType = await prisma.accountType.create({ data: { userId, name: 'Bank' } })
  const accountB = await prisma.financialAccount.create({
    data: { userId, name: 'B', accountTypeId: accountType.id, initialBalance: 0, currency: 'VND' },
  })
  await prisma.transfer.create({
    data: { userId, fromAccountId: setupA.accountId, toAccountId: accountB.id, fromAmount: 300, toAmount: 300, date: new Date() },
  })
  expect((await getAccountBalance(userId, setupA.accountId)).toNumber()).toBe(700)
  expect((await getAccountBalance(userId, accountB.id)).toNumber()).toBe(300)
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run lib/server/services/balance.test.ts`
Expected: FAIL on the new case — `prisma.transfer` isn't consulted by the current implementation.

- [ ] **Step 3: Extend the implementation**

In `lib/server/services/balance.ts`, extend the return of `getAccountBalance`:
```ts
export async function getAccountBalance(userId: string, accountId: string, asOfDate?: Date): Promise<Decimal> {
  const account = await prisma.financialAccount.findUniqueOrThrow({
    where: { userId_id: { userId, id: accountId } },
  })

  if (asOfDate && asOfDate < account.createdAt) {
    return new Decimal(0)
  }

  const dateFilter = asOfDate ? { date: { lte: asOfDate } } : {}
  const transactionSums = await prisma.transaction.groupBy({
    by: ['type'],
    where: { userId, accountId, ...dateFilter },
    _sum: { amount: true },
  })

  let balance = account.initialBalance as Decimal
  for (const row of transactionSums) {
    balance = balance.add((row._sum.amount ?? new Decimal(0)).mul(BALANCE_SIGN[row.type]))
  }

  const [transfersIn, transfersOut] = await Promise.all([
    prisma.transfer.aggregate({ where: { userId, toAccountId: accountId, ...dateFilter }, _sum: { toAmount: true } }),
    prisma.transfer.aggregate({ where: { userId, fromAccountId: accountId, ...dateFilter }, _sum: { fromAmount: true } }),
  ])

  return balance
    .add(transfersIn._sum.toAmount ?? new Decimal(0))
    .sub(transfersOut._sum.fromAmount ?? new Decimal(0))
}
```

- [ ] **Step 4: Run and verify all balance tests pass**

Run: `npx vitest run lib/server/services/balance.test.ts`
Expected: PASS, all 4 tests, including the `asOfDate`-before-`createdAt` case from Task 11 (confirm no regression).

- [ ] **Step 5: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/server/services/balance.ts lib/server/services/balance.test.ts
git commit -m "feat: extend derived balance to include transfers"
```

---

## Task 14: Transfer UI

**Files:**
- Create: `app/(app)/transfers/page.tsx`, `components/transfers/transfer-form.tsx`, `lib/server/actions/transfer-actions.ts`

**Interfaces:**
- Consumes: `createTransfer`/`listTransfers` (Task 12), `listActiveFinancialAccounts` (Task 4)
- Produces: nothing new

- [ ] **Step 1: Server action**

`lib/server/actions/transfer-actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createTransfer } from '@/lib/server/services/transfer'
import type { CreateTransferInput } from '@/lib/validation/transfer'

export async function createTransferAction(input: CreateTransferInput) {
  const user = await requireUser()
  await createTransfer(user.id, input)
  revalidatePath('/transfers')
  revalidatePath('/accounts')
}
```

- [ ] **Step 2: Transfer form**

`components/transfers/transfer-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createTransferSchema, type CreateTransferInput } from '@/lib/validation/transfer'
import { createTransferAction } from '@/lib/server/actions/transfer-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function TransferForm({ accounts }: { accounts: { id: string; name: string; currency: string }[] }) {
  const { register, watch, handleSubmit, formState: { isSubmitting } } =
    useForm<CreateTransferInput>({ resolver: zodResolver(createTransferSchema) })
  const fromId = watch('fromAccountId')
  const toId = watch('toAccountId')
  const sameCurrency = accounts.find((a) => a.id === fromId)?.currency === accounts.find((a) => a.id === toId)?.currency

  async function onSubmit(values: CreateTransferInput) {
    await createTransferAction(sameCurrency ? { ...values, toAmount: values.fromAmount } : values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <select {...register('fromAccountId')} className="rounded-md border p-2">
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
      </select>
      <select {...register('toAccountId')} className="rounded-md border p-2">
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
      </select>
      <Input type="number" step="0.01" placeholder="Amount sent" {...register('fromAmount', { valueAsNumber: true })} />
      {!sameCurrency && (
        <Input type="number" step="0.01" placeholder="Amount received" {...register('toAmount', { valueAsNumber: true })} />
      )}
      <Input type="date" {...register('date', { valueAsDate: true })} />
      <Button type="submit" disabled={isSubmitting}>Transfer</Button>
    </form>
  )
}
```

- [ ] **Step 3: Page**

`app/(app)/transfers/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listTransfers } from '@/lib/server/services/transfer'
import { TransferForm } from '@/components/transfers/transfer-form'

export default async function TransfersPage() {
  const user = await requireUser()
  const [accounts, transfers] = await Promise.all([listActiveFinancialAccounts(user.id), listTransfers(user.id)])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <TransferForm accounts={accounts} />
      <ul className="flex flex-col gap-1">
        {transfers.map((t) => (
          <li key={t.id} className="rounded-md border p-2 text-sm">
            {t.fromAccount.name} → {t.toAccount.name}: {String(t.fromAmount)} {t.fromAccount.currency}
            {t.fromAccount.currency !== t.toAccount.currency && ` → ${String(t.toAmount)} ${t.toAccount.currency}`}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Manual verification**

Run `npm run dev`, transfer between two test accounts (one VND, one USD), confirm both balances update and the cross-currency rate displays.

- [ ] **Step 5: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/transfers" components/transfers lib/server/actions/transfer-actions.ts
git commit -m "feat: add Transfer UI"
```

---

## Task 15: Harden FinancialAccount — currency/balance lock and archive-requires-zero-balance (TDD)

**Files:**
- Modify: `lib/server/services/financial-account.ts`, `components/accounts/account-form.tsx`, `components/accounts/account-list.tsx`, `app/(app)/accounts/page.tsx`, `lib/server/actions/financial-account-actions.ts`
- Test: `lib/server/services/financial-account.test.ts`

**Interfaces:**
- Consumes: `getAccountBalance` (Task 13, now complete), `Transaction`/`Transfer` (Tasks 9/12)
- Produces: `AccountLockedError`, `AccountHasNonZeroBalanceError`, `archiveFinancialAccount` — this is the first point in the phase where these can be built for real, since both of their real dependencies (balance calculation, transaction/transfer existence checks) are now complete

- [ ] **Step 1: Write the failing tests**

`lib/server/services/financial-account.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import {
  createFinancialAccount, updateFinancialAccount, archiveFinancialAccount,
  AccountLockedError, AccountHasNonZeroBalanceError,
} from './financial-account'

async function createTestUserWithAccountType() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  return { userId: user.id, accountTypeId: accountType.id }
}

async function cleanup(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.transfer.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('updateFinancialAccount currency/initialBalance lock', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('allows changing currency and initialBalance before any activity exists', async () => {
    const setup = await createTestUserWithAccountType()
    userId = setup.userId
    const account = await createFinancialAccount(userId, {
      name: 'Test', accountTypeId: setup.accountTypeId, initialBalance: 100, currency: 'VND',
    })
    const updated = await updateFinancialAccount(userId, account.id, { currency: 'USD', initialBalance: 200 })
    expect(updated.currency).toBe('USD')
    expect(updated.initialBalance.toNumber()).toBe(200)
  })

  it('rejects changing currency or initialBalance once a Transaction exists', async () => {
    const setup = await createTestUserWithAccountType()
    userId = setup.userId
    const account = await createFinancialAccount(userId, {
      name: 'Test', accountTypeId: setup.accountTypeId, initialBalance: 100, currency: 'VND',
    })
    await prisma.transaction.create({
      data: {
        userId, accountId: account.id, type: 'INCOME', amount: 50000, currency: 'VND',
        date: new Date(), vndPerUsdAtEntry: 25000, fxRateFetchedAt: new Date(), fxRateEffectiveAt: new Date(), fxRateSource: 'test',
      },
    })
    await expect(updateFinancialAccount(userId, account.id, { currency: 'USD' })).rejects.toThrow(AccountLockedError)
    const updated = await updateFinancialAccount(userId, account.id, { name: 'Renamed' })
    expect(updated.name).toBe('Renamed')
  })
})

describe('archiveFinancialAccount', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('rejects archiving an account with a non-zero balance', async () => {
    const setup = await createTestUserWithAccountType()
    userId = setup.userId
    const account = await createFinancialAccount(userId, {
      name: 'Test', accountTypeId: setup.accountTypeId, initialBalance: 100000, currency: 'VND',
    })
    await expect(archiveFinancialAccount(userId, account.id)).rejects.toThrow(AccountHasNonZeroBalanceError)
  })

  it('allows archiving an account once its derived balance is zero', async () => {
    const setup = await createTestUserWithAccountType()
    userId = setup.userId
    const account = await createFinancialAccount(userId, {
      name: 'Test', accountTypeId: setup.accountTypeId, initialBalance: 100000, currency: 'VND',
    })
    await prisma.transaction.create({
      data: {
        userId, accountId: account.id, type: 'EXPENSE', amount: 100000, currency: 'VND',
        date: new Date(), vndPerUsdAtEntry: 25000, fxRateFetchedAt: new Date(), fxRateEffectiveAt: new Date(), fxRateSource: 'test',
      },
    })
    const archived = await archiveFinancialAccount(userId, account.id)
    expect(archived.status).toBe('ARCHIVED')
  })
})
```

- [ ] **Step 2: Run and verify the archive tests fail (the lock tests already exist and should already pass from Task 4, since no lock existed then — but the assertion `.rejects.toThrow(AccountLockedError)` should now fail since `AccountLockedError` doesn't exist yet either)**

Run: `npx vitest run lib/server/services/financial-account.test.ts`
Expected: FAIL — `AccountLockedError`, `AccountHasNonZeroBalanceError`, `archiveFinancialAccount` are not exported yet.

- [ ] **Step 3: Implement the hardening**

In `lib/server/services/financial-account.ts`, add:
```ts
import { getAccountBalance } from './balance'

export class AccountLockedError extends Error {
  constructor() {
    super('Currency and initial balance cannot be changed once the account has activity')
    this.name = 'AccountLockedError'
  }
}

export class AccountHasNonZeroBalanceError extends Error {
  constructor() {
    super('This account must have a zero balance before it can be archived. Transfer or adjust the balance first.')
    this.name = 'AccountHasNonZeroBalanceError'
  }
}

async function accountHasActivity(userId: string, accountId: string): Promise<boolean> {
  const [txCount, transferCount] = await Promise.all([
    prisma.transaction.count({ where: { userId, accountId } }),
    prisma.transfer.count({ where: { userId, OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] } }),
  ])
  return txCount > 0 || transferCount > 0
}

export async function archiveFinancialAccount(userId: string, accountId: string) {
  const balance = await getAccountBalance(userId, accountId)
  if (!balance.isZero()) {
    throw new AccountHasNonZeroBalanceError()
  }
  return prisma.financialAccount.update({
    where: { userId_id: { userId, id: accountId } },
    data: { status: 'ARCHIVED' },
  })
}
```
Replace `updateFinancialAccount` (from Task 4) with the locked version:
```ts
export async function updateFinancialAccount(
  userId: string,
  accountId: string,
  input: UpdateFinancialAccountInput,
) {
  const parsed = updateFinancialAccountSchema.parse(input)
  const changingLockedField = parsed.currency !== undefined || parsed.initialBalance !== undefined

  if (changingLockedField && (await accountHasActivity(userId, accountId))) {
    throw new AccountLockedError()
  }

  return prisma.financialAccount.update({
    where: { userId_id: { userId, id: accountId } },
    data: parsed,
  })
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/server/services/financial-account.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Wire the archive action and lock notice into the UI**

`lib/server/actions/financial-account-actions.ts`, add:
```ts
export async function archiveFinancialAccountAction(accountId: string) {
  const user = await requireUser()
  await accountService.archiveFinancialAccount(user.id, accountId)
  revalidatePath('/accounts')
}
```

`components/accounts/account-list.tsx`, add an archive button per row:
```tsx
'use client'

import { useState } from 'react'
import { archiveFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'

// (keep the existing props/rendering; add this handler and button per row)
async function handleArchive(accountId: string, setError: (msg: string | null) => void) {
  try {
    await archiveFinancialAccountAction(accountId)
  } catch {
    setError('This account must have a zero balance before it can be archived. Transfer or adjust the balance first.')
  }
}
```
Add an `<button onClick={() => handleArchive(account.id, setError)}>Archive</button>` per row, with a local `useState<string | null>` per-row (or a single shared error banner) to display `error` when set.

`components/accounts/account-form.tsx`, add a `locked` prop and disable the two affected fields:
```tsx
export function AccountForm({
  accountTypes,
  locked = false,
}: {
  accountTypes: AccountType[]
  locked?: boolean
}) {
  // ...existing useForm(...) unchanged...
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      <Input placeholder="Account name" {...register('name')} />
      <select {...register('accountTypeId')} className="rounded-md border p-2">
        {accountTypes.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <Input
        type="number"
        step="0.01"
        placeholder="Initial balance"
        disabled={locked}
        {...register('initialBalance', { valueAsNumber: true })}
      />
      <select {...register('currency')} disabled={locked} className="rounded-md border p-2">
        <option value="VND">VND</option>
        <option value="USD">USD</option>
      </select>
      {locked && (
        <p className="text-sm text-warning">
          Currency and initial balance are locked because this account already has activity.
        </p>
      )}
      <Input placeholder="Description (optional)" {...register('description')} />
      <Button type="submit" disabled={isSubmitting}>Save</Button>
    </form>
  )
}
```
The caller (an account-edit view, if/when one is added) determines `locked` by checking whether the account has any transactions/transfers before rendering the form — the create form on `/accounts` simply omits the prop (defaults to `false`, matching a brand-new account with no activity yet).

- [ ] **Step 6: Manual verification**

Attempt to archive an account with a non-zero balance — confirm a clear error. Bring its balance to zero (via an offsetting transaction), archive it successfully, confirm it disappears from `/accounts` and from the transaction/transfer form's account picker, but still exists in the database with `status: ARCHIVED`.

- [ ] **Step 7: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add lib/server/services/financial-account.ts lib/server/services/financial-account.test.ts components/accounts lib/server/actions/financial-account-actions.ts
git commit -m "feat: enforce currency/balance lock and require zero balance to archive an account"
```

---

## Task 16: Tenant isolation integration test

**Files:**
- Create: `lib/server/services/tenant-isolation.test.ts`

**Interfaces:**
- Consumes: everything from this phase
- Produces: nothing new — this is the phase's security acceptance check

- [ ] **Step 1: Write the test**

`lib/server/services/tenant-isolation.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'

async function createUserWithAccount(currency: 'VND' | 'USD' = 'VND') {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  const type = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'A', accountTypeId: type.id, initialBalance: 0, currency },
  })
  return { userId: user.id, accountId: account.id }
}

async function cleanup(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('tenant isolation at the database level', () => {
  it('rejects a Transaction whose accountId belongs to a different user, even bypassing the service layer', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    await expect(
      prisma.transaction.create({
        data: {
          userId: userA.userId,
          accountId: userB.accountId,
          type: 'INCOME',
          amount: 100000,
          currency: 'VND',
          date: new Date(),
          vndPerUsdAtEntry: 25000,
          fxRateFetchedAt: new Date(),
          fxRateEffectiveAt: new Date(),
          fxRateSource: 'test',
        },
      }),
    ).rejects.toThrow()

    await cleanup(userA.userId)
    await cleanup(userB.userId)
  })

  it('rejects a Transfer whose toAccountId belongs to a different user', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    await expect(
      prisma.transfer.create({
        data: {
          userId: userA.userId,
          fromAccountId: userA.accountId,
          toAccountId: userB.accountId,
          fromAmount: 1000,
          toAmount: 1000,
          date: new Date(),
        },
      }),
    ).rejects.toThrow()

    await cleanup(userA.userId)
    await cleanup(userB.userId)
  })
})
```

- [ ] **Step 2: Run and verify both pass**

Run: `npx vitest run lib/server/services/tenant-isolation.test.ts`
Expected: PASS — both `.rejects.toThrow()` assertions succeed because Postgres rejects the insert (foreign key violation on the composite constraint).

- [ ] **Step 3: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add lib/server/services/tenant-isolation.test.ts
git commit -m "test: prove cross-tenant references are rejected at the database level"
```

---

## Phase 2 Acceptance Check

- [ ] Every schema change in this phase used `prisma migrate dev`, never `db push`; `prisma/migrations/` contains one migration per task that changed the schema.
- [ ] No committed state in this phase ever had a dangling Prisma relation, a stub function, or a fabricated FX rate — verified by re-reading each task's commit message and confirming `npx prisma validate`/`npm run build` passed at that point.
- [ ] Every Transaction's FX snapshot was populated exclusively via `getUsableCurrentRate`, which is real, complete, outage-resilient, staleness-bounded infrastructure by the time `Transaction` creation exists at all.
- [ ] Account balances always equal `initialBalance` plus the signed sum of all six transaction types plus net transfers, and are zero for any `asOfDate` before the account's `createdAt`.
- [ ] Transfers move money between accounts (including cross-currency) without ever appearing as income or expense; a same-currency transfer conserves money by construction (`toAmount` is derived server-side, a crafted mismatched `toAmount` is ignored) — proven by `transfer.test.ts`.
- [ ] Archived accounts cannot receive new activity: Transaction creation/update and both ends of a Transfer reject a non-ACTIVE account server-side — proven by `transaction.test.ts` and `transfer.test.ts`.
- [ ] Category semantics are enforced server-side: INCOME requires an ACTIVE INCOME category, EXPENSE an ACTIVE EXPENSE category, archived categories are rejected — proven by `transaction.test.ts`.
- [ ] `transaction.test.ts` and every other test in this phase pass with no network access; every FX-touching test injects a fake provider.
- [ ] `FinancialAccount.currency`/`initialBalance` are editable before activity and rejected after; archiving is rejected unless the derived balance is exactly zero.
- [ ] Normal UI selectors (transaction/transfer account pickers) use `listActiveFinancialAccounts`; `listAllFinancialAccounts` exists for Phase 4's full-export use.
- [ ] A cross-tenant Transaction/Transfer reference fails at the database level, proven by `tenant-isolation.test.ts` calling Prisma directly.
- [ ] `npm run test`, `npm run lint`, and `npm run build` all succeed.
