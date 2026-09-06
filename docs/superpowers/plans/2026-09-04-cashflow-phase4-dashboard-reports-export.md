# CashFlow Phase 4: Dashboard, Reports & Excel Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder layout with the real sidebar/mobile-nav shell; ship a dashboard with every widget that's derivable from Accounts/Transactions/Transfers/FX (KPIs, Cash Flow Trend, Account Balance Over Time, Expense by Category, Account Balance Distribution, Income vs Expense, Recent Transactions); ship a filterable Reports page; ship Excel export (filtered + an extensible full-workbook registry that Phases 5–6 append sheets to).

**Architecture:** Net Worth in this phase equals Total Account Balance only — Phase 6 extends the same function to subtract outstanding loans and payables and add receivables (spec §5.4); the function is written now in a form that's a strict superset later, not something that gets rewritten. Position metrics (Total Balance, Net Worth "now") use `convertToCurrentAmount` (live rate); every historical/activity figure (Monthly Income/Expense, Net Income, category breakdowns, Reports) uses `historicalAmountIn` (entry-time snapshot) — never mixed. Account Balance Over Time renders a gap for any past point whose historical FX rate is unavailable, never substituting the live rate.

**Tech Stack:** Recharts, lucide-react, ExcelJS.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§5.2, §5.4, §5.6, §9–§12)

**Depends on:** Phase 2 (Accounts/Transactions/Transfers/balance), Phase 3 (`historicalAmountIn`, `convertToCurrentAmount`, `getHistoricalRate`).

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

---

## Task 1: Real AppShell (sidebar, mobile nav, Add-Transaction action)

**Files:**
- Create: `components/layout/app-shell.tsx`
- Modify: `app/(app)/layout.tsx`, `app/(app)/dashboard/page.tsx` (remove the Phase 1 placeholder body)

**Interfaces:**
- Consumes: `LogoutButton` (Phase 1)
- Produces: `<AppShell>` — wraps every page in the `(app)` route group from now on

- [ ] **Step 1: Install lucide-react**

```bash
npm install lucide-react
```

- [ ] **Step 2: Write the shell**

`components/layout/app-shell.tsx`:
```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, ArrowLeftRight, Wallet, PiggyBank, FileBarChart, Settings, Plus } from 'lucide-react'
import { LogoutButton } from '@/components/auth/logout-button'

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: Home },
  { href: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/accounts', label: 'Accounts', icon: Wallet },
  { href: '/budgets', label: 'Budgets', icon: PiggyBank },
  { href: '/reports', label: 'Reports', icon: FileBarChart },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-56 flex-col gap-1 border-r p-4 md:flex">
        <p className="mb-6 px-2 text-lg font-semibold text-brand">CashFlow</p>
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2 rounded-md p-2 text-sm ${
              pathname === href ? 'bg-brand/10 text-brand' : 'text-foreground/70 hover:bg-foreground/5'
            }`}
          >
            <Icon size={18} /> {label}
          </Link>
        ))}
        <div className="mt-auto">
          <LogoutButton />
        </div>
      </aside>

      <div className="flex-1 pb-20 md:pb-0">{children}</div>

      <nav className="fixed inset-x-0 bottom-0 flex items-center justify-around border-t bg-surface p-2 md:hidden">
        {NAV_ITEMS.slice(0, 2).map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className="flex flex-col items-center gap-0.5 text-xs text-foreground/70">
            <Icon size={20} />
            {label}
          </Link>
        ))}
        <Link
          href="/transactions"
          className="-mt-8 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-md"
        >
          <Plus size={26} />
        </Link>
        {NAV_ITEMS.slice(2, 4).map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className="flex flex-col items-center gap-0.5 text-xs text-foreground/70">
            <Icon size={20} />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
```

- [ ] **Step 3: Wire it into the protected layout**

`app/(app)/layout.tsx`:
```tsx
import { redirect } from 'next/navigation'
import { getOptionalSession } from '@/lib/auth/require-user'
import { AppShell } from '@/components/layout/app-shell'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getOptionalSession()
  if (!session?.user) redirect('/login')
  return <AppShell>{children}</AppShell>
}
```

- [ ] **Step 4: Remove the Phase 1 placeholder body from the dashboard page**

`app/(app)/dashboard/page.tsx` — replace its entire placeholder content; Task 5 below rebuilds this page properly, so for this step just leave a minimal `<div className="p-6">Dashboard</div>` so the app still compiles between tasks.

- [ ] **Step 5: Manual verification**

Run `npm run dev`, log in. Confirm the sidebar renders on desktop with working nav links and a working logout button. Resize to mobile width, confirm the bottom tab bar with a raised centered "+" button appears and the sidebar disappears, with no horizontal overflow.

- [ ] **Step 6: Commit**

```bash
git add components/layout "app/(app)/layout.tsx" "app/(app)/dashboard/page.tsx" package.json package-lock.json
git commit -m "feat: replace placeholder layout with the real AppShell (sidebar + mobile nav)"
```

---

## Task 2: Position metrics — Total Balance, Net Worth, Account Distribution (TDD)

**Files:**
- Create: `lib/server/services/net-worth.ts`
- Test: `lib/server/services/net-worth.test.ts`

**Interfaces:**
- Consumes: `getAccountBalance(userId, accountId, asOfDate?)` (Phase 2 — already includes the `asOfDate` parameter and the zero-before-`createdAt` invariant; nothing to extend here), `applyVndPerUsdRate`, `convertToCurrentAmount` (Phase 3)
- Produces: `getTotalAccountBalance(userId, displayCurrency)`, `getNetWorth(userId, displayCurrency)` (intentionally a superset point: Phase 6 adds receivable/payable/loan terms to its body without changing its signature), `getAccountDistribution(userId, displayCurrency)` (per-account balances converted to `displayCurrency` — never raw native numbers, since comparing e.g. a USD balance directly against a VND balance would be meaningless)

- [ ] **Step 1: Write the failing tests for Total Balance / Net Worth / Account Distribution**

`lib/server/services/net-worth.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { getTotalAccountBalance, getNetWorth, getAccountDistribution } from './net-worth'
import type { ExchangeRateProvider } from '@/lib/currency/provider'

const fakeProvider: ExchangeRateProvider = {
  getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
  getHistoricalRate: async () => null,
}

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  const type = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const vndAccount = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'VND', accountTypeId: type.id, initialBalance: 1_000_000, currency: 'VND' },
  })
  const usdAccount = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'USD', accountTypeId: type.id, initialBalance: 100, currency: 'USD' },
  })
  return { userId: user.id, vndAccountId: vndAccount.id, usdAccountId: usdAccount.id }
}

async function cleanup(userId: string) {
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('getTotalAccountBalance', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('sums balances across currencies into the display currency using the current rate', async () => {
    const s = await setup()
    userId = s.userId
    const total = await getTotalAccountBalance(userId, 'VND', fakeProvider)
    // 1,000,000 VND + (100 USD * 25,000) = 3,500,000 VND
    expect(total.toNumber()).toBe(3_500_000)
  })
})

describe('getNetWorth (Phase 4: accounts only — Phase 6 adds debts/loans/receivables)', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('equals total account balance until Phase 6 extends it', async () => {
    const s = await setup()
    userId = s.userId
    const netWorth = await getNetWorth(userId, 'VND', fakeProvider)
    const totalBalance = await getTotalAccountBalance(userId, 'VND', fakeProvider)
    expect(netWorth.toNumber()).toBe(totalBalance.toNumber())
  })
})

describe('getAccountDistribution', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('converts every account balance to the display currency before distribution, never raw native numbers', async () => {
    const s = await setup()
    userId = s.userId
    // VND account: 1,000,000 native. USD account: 100 native == 2,500,000 VND at the fake
    // 25,000 rate. A bug that compared raw native numbers would show 100 for the USD entry
    // instead of its true 2,500,000 VND equivalent.
    const distribution = await getAccountDistribution(userId, 'VND', fakeProvider)
    const vndEntry = distribution.find((d) => d.name === 'VND')
    const usdEntry = distribution.find((d) => d.name === 'USD')
    expect(vndEntry?.balance).toBe(1_000_000)
    expect(usdEntry?.balance).toBe(2_500_000)
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/server/services/net-worth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`lib/server/services/net-worth.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/prisma'
import { getAccountBalance } from './balance'
import { convertToCurrentAmount } from '@/lib/currency/current-amount'
import type { Currency, ExchangeRateProvider } from '@/lib/currency/provider'

export async function getTotalAccountBalance(
  userId: string,
  displayCurrency: Currency,
  providerOverride?: ExchangeRateProvider,
): Promise<Decimal> {
  const accounts = await prisma.financialAccount.findMany({ where: { userId, status: 'ACTIVE' } })
  let total = new Decimal(0)
  for (const account of accounts) {
    const balance = await getAccountBalance(userId, account.id)
    total = total.add(await convertToCurrentAmount(balance, account.currency, displayCurrency, providerOverride))
  }
  return total
}

/**
 * Per-account balances converted to displayCurrency — the only currency-correct input to the
 * Account Balance Distribution chart. Comparing raw native-currency numbers side by side would
 * be meaningless (e.g. "100" for a USD account next to "1,000,000" for a VND account gives no
 * sense of true relative size), so every entry is converted at the current rate before this
 * function returns, never left for the chart layer to compare natively. Active accounts only —
 * an archived account always has a zero balance (enforced at archive time, Phase 2 Task 15), so
 * it would contribute nothing but visual noise here.
 */
export async function getAccountDistribution(
  userId: string,
  displayCurrency: Currency,
  providerOverride?: ExchangeRateProvider,
): Promise<{ name: string; balance: number }[]> {
  const accounts = await prisma.financialAccount.findMany({ where: { userId, status: 'ACTIVE' } })
  return Promise.all(
    accounts.map(async (account) => {
      const nativeBalance = await getAccountBalance(userId, account.id)
      const converted = await convertToCurrentAmount(nativeBalance, account.currency, displayCurrency, providerOverride)
      return { name: account.name, balance: converted.toNumber() }
    }),
  )
}

/**
 * Phase 4: Net Worth = Total Account Balance only.
 * Phase 6 extends this to: + receivables outstanding − payables outstanding − outstanding
 * loan principal (spec §5.4), each converted the same way (own currency → displayCurrency
 * at the current rate). The signature does not change — only this function's body grows.
 */
export async function getNetWorth(
  userId: string,
  displayCurrency: Currency,
  providerOverride?: ExchangeRateProvider,
): Promise<Decimal> {
  return getTotalAccountBalance(userId, displayCurrency, providerOverride)
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/server/services/net-worth.test.ts`
Expected: PASS, all 3 tests, including the mixed VND/USD distribution case.

- [ ] **Step 5: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/server/services/net-worth.ts lib/server/services/net-worth.test.ts
git commit -m "feat: add Total Account Balance, Net Worth, and currency-correct Account Distribution"
```

---

## Task 3: Historical activity service (TDD)

**Files:**
- Create: `lib/server/services/activity.ts`
- Test: `lib/server/services/activity.test.ts`

**Interfaces:**
- Consumes: `historicalAmountIn` (Phase 3), `getPeriodBounds` (Phase 0)
- Produces: `getMonthlyIncomeExpense`, `getCashFlowTrend`, `getExpenseByCategory` — consumed by Task 5 (Dashboard) and Task 6 (Reports)

- [ ] **Step 1: Write the failing tests**

`lib/server/services/activity.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { getMonthlyIncomeExpense, getExpenseByCategory } from './activity'

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false, timezone: 'Asia/Ho_Chi_Minh' },
  })
  const type = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'A', accountTypeId: type.id, initialBalance: 0, currency: 'VND' },
  })
  const foodCategory = await prisma.category.create({ data: { userId: user.id, name: 'Food', type: 'EXPENSE' } })
  const salaryCategory = await prisma.category.create({ data: { userId: user.id, name: 'Salary', type: 'INCOME' } })
  return { userId: user.id, accountId: account.id, foodCategory, salaryCategory }
}

async function cleanup(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.category.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

function tx(userId: string, accountId: string, categoryId: string, type: string, amount: number, date: Date) {
  return prisma.transaction.create({
    data: { userId, accountId, categoryId, type: type as never, amount, currency: 'VND', date, vndPerUsdAtEntry: 25000, fxRateTimestamp: new Date(), fxRateSource: 'test' },
  })
}

describe('getMonthlyIncomeExpense and getExpenseByCategory', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('sums INCOME/EXPENSE for the given month, excluding CASH_IN/CASH_OUT/ADJUSTMENT', async () => {
    const s = await setup()
    userId = s.userId
    const inMonth = new Date('2026-03-15T10:00:00Z')
    await tx(userId, s.accountId, s.salaryCategory.id, 'INCOME', 10_000_000, inMonth)
    await tx(userId, s.accountId, s.foodCategory.id, 'EXPENSE', 2_000_000, inMonth)
    await prisma.transaction.create({
      data: { userId, accountId: s.accountId, type: 'CASH_IN', amount: 5_000_000, currency: 'VND', date: inMonth, vndPerUsdAtEntry: 25000, fxRateTimestamp: new Date(), fxRateSource: 'test' },
    })

    const result = await getMonthlyIncomeExpense(userId, 'Asia/Ho_Chi_Minh', 'VND', inMonth)
    expect(result.income.toNumber()).toBe(10_000_000)
    expect(result.expense.toNumber()).toBe(2_000_000)
    expect(result.netIncome.toNumber()).toBe(8_000_000)
  })

  it('breaks down expenses by category name for the given month', async () => {
    const s = await setup()
    userId = s.userId
    const inMonth = new Date('2026-03-15T10:00:00Z')
    await tx(userId, s.accountId, s.foodCategory.id, 'EXPENSE', 1_500_000, inMonth)
    await tx(userId, s.accountId, s.foodCategory.id, 'EXPENSE', 500_000, inMonth)

    const result = await getExpenseByCategory(userId, 'Asia/Ho_Chi_Minh', 'VND', inMonth)
    expect(result).toEqual([{ name: 'Food', total: 2_000_000 }])
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/server/services/activity.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`lib/server/services/activity.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/prisma'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { historicalAmountIn } from '@/lib/currency/historical-amount'
import type { Currency } from '@/lib/currency/provider'

export async function getMonthlyIncomeExpense(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  referenceDate: Date = new Date(),
) {
  const { startUtc, endUtc } = getPeriodBounds(timezone, 'month', referenceDate)
  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: startUtc, lt: endUtc }, type: { in: ['INCOME', 'EXPENSE'] } },
  })

  let income = new Decimal(0)
  let expense = new Decimal(0)
  for (const t of transactions) {
    const amount = historicalAmountIn(displayCurrency, t)
    if (t.type === 'INCOME') income = income.add(amount)
    else expense = expense.add(amount)
  }
  return { income, expense, netIncome: income.sub(expense) }
}

export async function getCashFlowTrend(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  monthsBack = 6,
) {
  const now = new Date()
  const points = []
  for (let i = monthsBack - 1; i >= 0; i--) {
    const ref = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const { income, expense, netIncome } = await getMonthlyIncomeExpense(userId, timezone, displayCurrency, ref)
    points.push({
      month: ref.toISOString().slice(0, 7),
      income: income.toNumber(),
      expense: expense.toNumber(),
      netIncome: netIncome.toNumber(),
    })
  }
  return points
}

export async function getExpenseByCategory(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  referenceDate: Date = new Date(),
) {
  const { startUtc, endUtc } = getPeriodBounds(timezone, 'month', referenceDate)
  const transactions = await prisma.transaction.findMany({
    where: { userId, type: 'EXPENSE', date: { gte: startUtc, lt: endUtc } },
    include: { category: true },
  })

  const byCategory = new Map<string, Decimal>()
  for (const t of transactions) {
    const name = t.category?.name ?? 'Uncategorized'
    const amount = historicalAmountIn(displayCurrency, t)
    byCategory.set(name, (byCategory.get(name) ?? new Decimal(0)).add(amount))
  }
  return [...byCategory.entries()].map(([name, total]) => ({ name, total: total.toNumber() }))
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/server/services/activity.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add lib/server/services/activity.ts lib/server/services/activity.test.ts
git commit -m "feat: add historical activity service (monthly income/expense, trend, category breakdown)"
```

---

## Task 4: Account Balance Over Time (TDD, historical-gap behavior)

**Files:**
- Create: `lib/server/services/account-balance-history.ts`
- Test: `lib/server/services/account-balance-history.test.ts`

**Interfaces:**
- Consumes: `getAccountBalance(userId, accountId, asOfDate)` (Task 2), `getHistoricalRate` (Phase 3), `applyVndPerUsdRate` (Task 2)
- Produces: `getAccountBalanceOverTime(userId, timezone, displayCurrency, monthsBack, providerOverride?): Promise<{month: string; netWorth: number | null}[]>` — `null` means "render a gap," consumed by Task 5

- [ ] **Step 1: Write the failing tests**

`lib/server/services/account-balance-history.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { getAccountBalanceOverTime } from './account-balance-history'
import type { ExchangeRateProvider } from '@/lib/currency/provider'

async function setup() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
  })
  const type = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: { userId: user.id, name: 'A', accountTypeId: type.id, initialBalance: 1_000_000, currency: 'VND' },
  })
  return { userId: user.id, accountId: account.id }
}

async function cleanup(userId: string) {
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

describe('getAccountBalanceOverTime', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('computes a stable value for each past month using only VND accounts (no FX call needed)', async () => {
    const s = await setup()
    userId = s.userId
    const points = await getAccountBalanceOverTime(userId, 'Asia/Ho_Chi_Minh', 'VND', 3)
    expect(points).toHaveLength(3)
    expect(points.every((p) => p.netWorth === 1_000_000)).toBe(true)
  })

  it('renders a gap (null) for a point whose historical rate is unavailable, for a foreign-currency account', async () => {
    const s = await setup()
    userId = s.userId
    const type = await prisma.accountType.findFirstOrThrow({ where: { userId } })
    await prisma.financialAccount.create({
      data: { userId, name: 'USD', accountTypeId: type.id, initialBalance: 100, currency: 'USD' },
    })
    const noHistoryProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
      getHistoricalRate: async () => null, // simulates a provider with no historical data
    }
    const points = await getAccountBalanceOverTime(userId, 'Asia/Ho_Chi_Minh', 'VND', 2, noHistoryProvider)
    expect(points.every((p) => p.netWorth === null)).toBe(true)
  })

  it('excludes an account from past points before its creation date, includes it from that month onward', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
    })
    userId = user.id
    const type = await prisma.accountType.create({ data: { userId, name: 'Cash' } })
    const now = new Date()
    // Created 2 months ago (i.e. "June" relative to whenever the suite runs) — the account
    // must contribute 0 to any point more than 2 months back, and its full balance from then on.
    const createdAt = new Date(now.getFullYear(), now.getMonth() - 2, 15)
    await prisma.financialAccount.create({
      data: { userId, name: 'New Account', accountTypeId: type.id, initialBalance: 1_000_000, currency: 'VND', createdAt },
    })

    const points = await getAccountBalanceOverTime(userId, 'Asia/Ho_Chi_Minh', 'VND', 6)
    const monthsAgoForEachPoint = [5, 4, 3, 2, 1, 0]
    points.forEach((p, idx) => {
      const monthsAgo = monthsAgoForEachPoint[idx]
      expect(p.netWorth).toBe(monthsAgo > 2 ? 0 : 1_000_000)
    })
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/server/services/account-balance-history.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`lib/server/services/account-balance-history.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/prisma'
import { getAccountBalance } from './balance'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { getHistoricalRate } from '@/lib/currency/fx-service'
import { applyVndPerUsdRate } from '@/lib/currency/apply-rate'
import type { Currency, ExchangeRateProvider } from '@/lib/currency/provider'

export async function getAccountBalanceOverTime(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  monthsBack = 6,
  providerOverride?: ExchangeRateProvider,
): Promise<{ month: string; netWorth: number | null }[]> {
  const accounts = await prisma.financialAccount.findMany({ where: { userId } })
  const now = new Date()
  const points: { month: string; netWorth: number | null }[] = []

  for (let i = monthsBack - 1; i >= 0; i--) {
    const refDate = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const { endUtc } = getPeriodBounds(timezone, 'month', refDate)
    const asOfDate = new Date(endUtc.getTime() - 1)

    let total: Decimal | null = new Decimal(0)

    for (const account of accounts) {
      if (total === null) break
      const balance = await getAccountBalance(userId, account.id, asOfDate)

      if (account.currency === displayCurrency) {
        total = total.add(balance)
        continue
      }

      const historicalRate = await getHistoricalRate({ base: 'USD', quote: 'VND' }, asOfDate, providerOverride)
      if (!historicalRate) {
        total = null // no rate available for this date — the whole point becomes a gap
        break
      }
      total = total.add(applyVndPerUsdRate(balance, account.currency, displayCurrency, new Decimal(historicalRate.rate)))
    }

    points.push({ month: refDate.toISOString().slice(0, 7), netWorth: total?.toNumber() ?? null })
  }

  return points
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/server/services/account-balance-history.test.ts`
Expected: PASS, all 3 tests, including the account-creation-date exclusion case.

- [ ] **Step 5: Commit**

```bash
git add lib/server/services/account-balance-history.ts lib/server/services/account-balance-history.test.ts
git commit -m "feat: add Account Balance Over Time with historical-gap FX handling"
```

---

## Task 5: Dashboard page

**Files:**
- Create: `components/dashboard/kpi-tile.tsx`, `components/dashboard/cash-flow-trend-chart.tsx`, `components/dashboard/income-vs-expense-chart.tsx`, `components/dashboard/account-balance-history-chart.tsx`, `components/dashboard/expense-by-category-chart.tsx`, `components/dashboard/account-distribution-chart.tsx`, `components/dashboard/recent-transactions.tsx`, `components/dashboard/fx-rate-status.tsx`
- Modify: `app/(app)/dashboard/page.tsx`

**Interfaces:**
- Consumes: Tasks 2–4, `listTransactions` (Phase 2)
- Produces: nothing new — assembles everything built so far into the dashboard

- [ ] **Step 1: Install Recharts**

```bash
npm install recharts
```

- [ ] **Step 2: KPI tile**

`components/dashboard/kpi-tile.tsx`:
```tsx
export function KpiTile({ label, value, currency }: { label: string; value: number; currency: string }) {
  const formatted = new Intl.NumberFormat('vi-VN').format(value)
  const isNegative = value < 0
  return (
    <div className="rounded-md border p-4">
      <p className="text-sm text-foreground/60">{label}</p>
      <p className={`tabular-nums text-2xl font-semibold ${isNegative ? 'text-negative' : ''}`}>
        {formatted} {currency}
      </p>
    </div>
  )
}
```

- [ ] **Step 3: Charts**

`components/dashboard/cash-flow-trend-chart.tsx`:
```tsx
'use client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

type Point = { month: string; income: number; expense: number; netIncome: number }

export function CashFlowTrendChart({ data }: { data: Point[] }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Cash Flow Trend</h3>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--foreground) / 0.1)" />
          <XAxis dataKey="month" fontSize={12} />
          <YAxis fontSize={12} />
          <Tooltip />
          <Line type="monotone" dataKey="income" stroke="hsl(var(--positive))" name="Income" />
          <Line type="monotone" dataKey="expense" stroke="hsl(var(--negative))" name="Expense" />
          <Line type="monotone" dataKey="netIncome" stroke="hsl(var(--brand))" name="Net Income" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

`components/dashboard/account-balance-history-chart.tsx`:
```tsx
'use client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

export function AccountBalanceHistoryChart({ data }: { data: { month: string; netWorth: number | null }[] }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Account Balance Over Time</h3>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--foreground) / 0.1)" />
          <XAxis dataKey="month" fontSize={12} />
          <YAxis fontSize={12} />
          <Tooltip />
          {/* Recharts skips null values by default, leaving a visual gap rather than a fabricated point */}
          <Line type="monotone" dataKey="netWorth" stroke="hsl(var(--brand))" connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

`components/dashboard/expense-by-category-chart.tsx`:
```tsx
'use client'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

export function ExpenseByCategoryChart({ data }: { data: { name: string; total: number }[] }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Expense by Category</h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--foreground) / 0.1)" />
          <XAxis type="number" fontSize={12} />
          <YAxis type="category" dataKey="name" width={100} fontSize={12} />
          <Tooltip />
          <Bar dataKey="total" fill="hsl(var(--negative))" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
```

`components/dashboard/account-distribution-chart.tsx`:
```tsx
'use client'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

export function AccountDistributionChart({ data }: { data: { name: string; balance: number }[] }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Account Balance Distribution</h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--foreground) / 0.1)" />
          <XAxis dataKey="name" fontSize={12} />
          <YAxis fontSize={12} />
          <Tooltip />
          <Bar dataKey="balance" fill="hsl(var(--accent))" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
```

`components/dashboard/recent-transactions.tsx`:
```tsx
type Row = { id: string; type: string; amount: unknown; currency: string; date: Date; category: { name: string } | null; account: { name: string } }

export function RecentTransactions({ transactions }: { transactions: Row[] }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Recent Transactions</h3>
      <ul className="flex flex-col gap-2">
        {transactions.slice(0, 5).map((t) => (
          <li key={t.id} className="flex justify-between text-sm">
            <span>{t.category?.name ?? t.type} · {t.account.name}</span>
            <span className="tabular-nums">{String(t.amount)} {t.currency}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 3a: Income vs Expense comparison chart (distinct from the Cash Flow Trend time series)**

The product scope lists Cash Flow Trend and Income vs Expense as two separate views. Cash Flow Trend is a six-month *time series*; this widget is a *direct comparison* for the current period against the previous one — a compact grouped bar chart, not another line chart.

`components/dashboard/income-vs-expense-chart.tsx`:
```tsx
'use client'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts'

type Row = { period: string; income: number; expense: number }

export function IncomeVsExpenseChart({ data }: { data: Row[] }) {
  return (
    <div className="rounded-md border p-4">
      <h3 className="mb-3 text-sm font-medium">Income vs Expense</h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--foreground) / 0.1)" />
          <XAxis dataKey="period" fontSize={12} />
          <YAxis fontSize={12} />
          <Tooltip />
          <Legend />
          <Bar dataKey="income" name="Income" fill="hsl(var(--positive))" />
          <Bar dataKey="expense" name="Expense" fill="hsl(var(--negative))" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 3b: FX rate status indicator**

Every current-position figure on this page is converted through the shared `getUsableCurrentRate` policy (Phase 2 Task 8). The user must be able to see which rate was used, when it's from, and whether it's a fallback.

`components/dashboard/fx-rate-status.tsx`:
```tsx
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'

export function FxRateStatus({ fx }: { fx: UsableRateResult | null }) {
  if (!fx) {
    return <p className="text-sm text-negative">FX rate unavailable — currency-converted figures are hidden.</p>
  }
  return (
    <p className="text-sm text-foreground/60">
      FX rate: <span className="tabular-nums">{fx.rate.toLocaleString('vi-VN')} VND/USD</span> · updated{' '}
      {fx.fetchedAt.toLocaleString()}
      {fx.isFallback && <span className="ml-2 text-warning">(using a recent cached rate — live rate unavailable)</span>}
    </p>
  )
}
```
Also update `KpiTile` (Step 2) to accept `value: number | null` and render "—" for `null`, so a KPI that needs conversion can degrade instead of crashing the page.

- [ ] **Step 4: Assemble the dashboard page**

`app/(app)/dashboard/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { getTotalAccountBalance, getNetWorth, getAccountDistribution } from '@/lib/server/services/net-worth'
import { getAccountBalanceOverTime } from '@/lib/server/services/account-balance-history'
import { getMonthlyIncomeExpense, getCashFlowTrend, getExpenseByCategory } from '@/lib/server/services/activity'
import { listTransactions } from '@/lib/server/services/transaction'
import { getUsableCurrentRate, FxUnavailableError, type UsableRateResult } from '@/lib/currency/current-rate-policy'
import { KpiTile } from '@/components/dashboard/kpi-tile'
import { CashFlowTrendChart } from '@/components/dashboard/cash-flow-trend-chart'
import { IncomeVsExpenseChart } from '@/components/dashboard/income-vs-expense-chart'
import { AccountBalanceHistoryChart } from '@/components/dashboard/account-balance-history-chart'
import { ExpenseByCategoryChart } from '@/components/dashboard/expense-by-category-chart'
import { AccountDistributionChart } from '@/components/dashboard/account-distribution-chart'
import { RecentTransactions } from '@/components/dashboard/recent-transactions'
import { FxRateStatus } from '@/components/dashboard/fx-rate-status'

/** Current-position figures need a usable FX rate; if none exists they degrade to null ("—")
 *  rather than taking the whole dashboard down. Historical figures never depend on this. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (err) {
    if (err instanceof FxUnavailableError) return null
    throw err
  }
}

export default async function DashboardPage() {
  const user = await requireUser()
  const displayCurrency = (user as typeof user & { baseCurrency: 'VND' | 'USD' }).baseCurrency
  const timezone = (user as typeof user & { timezone: string }).timezone
  const now = new Date()
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  const [fx, totalBalance, netWorth, monthly, previous, cashFlowTrend, expenseByCategory, accountBalanceOverTime, accountBalances, recentTx] =
    await Promise.all([
      orNull<UsableRateResult>(getUsableCurrentRate({ base: 'USD', quote: 'VND' })),
      orNull(getTotalAccountBalance(user.id, displayCurrency)),
      orNull(getNetWorth(user.id, displayCurrency)),
      getMonthlyIncomeExpense(user.id, timezone, displayCurrency),
      getMonthlyIncomeExpense(user.id, timezone, displayCurrency, previousMonth),
      getCashFlowTrend(user.id, timezone, displayCurrency),
      getExpenseByCategory(user.id, timezone, displayCurrency),
      getAccountBalanceOverTime(user.id, timezone, displayCurrency),
      orNull(getAccountDistribution(user.id, displayCurrency)),
      listTransactions(user.id),
    ])

  const incomeVsExpense = [
    { period: 'Previous month', income: previous.income.toNumber(), expense: previous.expense.toNumber() },
    { period: 'This month', income: monthly.income.toNumber(), expense: monthly.expense.toNumber() },
  ]

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <KpiTile label="Total Account Balance" value={totalBalance?.toNumber() ?? null} currency={displayCurrency} />
        <KpiTile label="Net Worth" value={netWorth?.toNumber() ?? null} currency={displayCurrency} />
        <KpiTile label="Monthly Income" value={monthly.income.toNumber()} currency={displayCurrency} />
        <KpiTile label="Monthly Expense" value={monthly.expense.toNumber()} currency={displayCurrency} />
        <KpiTile label="Net Income" value={monthly.netIncome.toNumber()} currency={displayCurrency} />
      </div>
      <FxRateStatus fx={fx} />
      <div className="grid gap-4 md:grid-cols-2">
        <CashFlowTrendChart data={cashFlowTrend} />
        <IncomeVsExpenseChart data={incomeVsExpense} />
        <AccountBalanceHistoryChart data={accountBalanceOverTime} />
        <ExpenseByCategoryChart data={expenseByCategory} />
        {accountBalances && <AccountDistributionChart data={accountBalances} />}
      </div>
      <RecentTransactions transactions={recentTx} />
    </div>
  )
}
```
Monthly Income/Expense/Net Income and the two historical charts are *not* wrapped in `orNull` on purpose: they use each Transaction's immutable snapshot (or `getHistoricalRate`) and never depend on the current-rate policy, so an FX outage cannot affect them.

- [ ] **Step 5: Manual verification**

Run `npm run dev`, log in with an account that has a few transactions across at least two accounts. Confirm all five KPI tiles, the FX rate status line, and five charts (Cash Flow Trend, Income vs Expense, Account Balance Over Time, Expense by Category, Account Balance Distribution) render with real data, and "Net Income" (not "Net Cash Flow") is the label used. Temporarily point the provider at an unreachable URL (or disconnect the network) with an empty `ExchangeRate` table: confirm Total Balance/Net Worth show "—", the status line says "FX rate unavailable", and the historical charts and monthly KPIs still render. Resize to mobile width and confirm the grid reflows with no overflow.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard "app/(app)/dashboard/page.tsx" package.json package-lock.json
git commit -m "feat: build Dashboard v1 with KPIs and four chart widgets"
```

---

## Task 6: Reports page — validated period/custom range, by-account semantics (TDD)

**Files:**
- Create: `lib/reports/report-range.ts`, `lib/reports/report-range.test.ts`, `app/(app)/reports/page.tsx`, `components/reports/period-filter.tsx`
- Modify: `lib/server/services/activity.ts`, `lib/server/services/activity.test.ts`

**Interfaces:**
- Consumes: `getPeriodBounds` (Phase 0), `historicalAmountIn` (Phase 3), `date-fns-tz` (Phase 0)
- Produces:
  - `resolveReportRange(params, timezone, now?): ReportRange` and `rangeToQueryString(range): string` — the **single** place URL query parameters become a validated UTC range. Both the Reports page and Task 7's export route call it, so the filtered export always receives exactly the range the user is looking at. Throws `InvalidReportRangeError` for anything malformed; nothing from the URL is ever cast to `Period` without validation.
  - `getActivitySummary(userId, displayCurrency, range: { startUtc; endUtc })` — takes an already-resolved range; `byAccount` returns `{ name, income, expense, netIncome }` per account, never an ambiguous unsigned total.

Custom date range is an MVP requirement (spec §Reports: day/week/month/quarter/year/**custom**). It is implemented and tested here, not deferred.

**Range semantics:** `from` and `to` are calendar dates (`YYYY-MM-DD`) interpreted in `User.timezone`. `to` is *inclusive* for the user ("1 Mar – 31 Mar"), so the internal UTC upper bound is the *exclusive* start of the day after `to` — the same `date >= startUtc AND date < endUtc` convention every period query already uses.

- [ ] **Step 1: Write the failing range-resolver tests**

`lib/reports/report-range.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveReportRange, rangeToQueryString, InvalidReportRangeError } from './report-range'

const TZ = 'Asia/Ho_Chi_Minh'
const NOW = new Date('2026-03-15T10:00:00Z')

describe('resolveReportRange — named periods', () => {
  it('defaults to month when no period is given', () => {
    const r = resolveReportRange({}, TZ, NOW)
    expect(r.kind).toBe('month')
    expect(r.startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    expect(r.endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
  })

  it.each(['weekly', 'MONTH', '__proto__', 'custom;drop', ''])('rejects an unknown period %j', (p) => {
    expect(() => resolveReportRange({ period: p }, TZ, NOW)).toThrow(InvalidReportRangeError)
  })
})

describe('resolveReportRange — custom range', () => {
  it('interprets from/to in the user timezone with an inclusive user-facing end date', () => {
    const r = resolveReportRange({ period: 'custom', from: '2026-03-01', to: '2026-03-31' }, TZ, NOW)
    expect(r.kind).toBe('custom')
    // 1 Mar 00:00 +07:00
    expect(r.startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    // exclusive bound = 1 Apr 00:00 +07:00, so 31 Mar 23:59:59 local is included
    expect(r.endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
  })

  it('is timezone-aware across DST (America/New_York, single-day range in July)', () => {
    const r = resolveReportRange({ period: 'custom', from: '2026-07-01', to: '2026-07-01' }, 'America/New_York', NOW)
    expect(r.startUtc.toISOString()).toBe('2026-07-01T04:00:00.000Z') // EDT, UTC-4
    expect(r.endUtc.toISOString()).toBe('2026-07-02T04:00:00.000Z')
  })

  it('rejects from > to', () => {
    expect(() => resolveReportRange({ period: 'custom', from: '2026-03-31', to: '2026-03-01' }, TZ, NOW)).toThrow(InvalidReportRangeError)
  })

  it.each([
    ['2026-13-01', '2026-13-05'],
    ['2026-02-30', '2026-03-01'],
    ['garbage', '2026-03-01'],
    ['2026-03-01', undefined],
    ['03/01/2026', '03/31/2026'],
  ])('rejects malformed or impossible dates %j..%j', (from, to) => {
    expect(() => resolveReportRange({ period: 'custom', from, to }, TZ, NOW)).toThrow(InvalidReportRangeError)
  })

  it('round-trips through the query string so export links carry the exact same range', () => {
    const r = resolveReportRange({ period: 'custom', from: '2026-03-01', to: '2026-03-31' }, TZ, NOW)
    const qs = rangeToQueryString(r)
    expect(qs).toBe('period=custom&from=2026-03-01&to=2026-03-31')
    const again = resolveReportRange(Object.fromEntries(new URLSearchParams(qs)), TZ, NOW)
    expect(again.startUtc.getTime()).toBe(r.startUtc.getTime())
    expect(again.endUtc.getTime()).toBe(r.endUtc.getTime())
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/reports/report-range.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the range resolver**

`lib/reports/report-range.ts`:
```ts
import { fromZonedTime } from 'date-fns-tz'
import { getPeriodBounds, type Period } from '@/lib/datetime/period-bounds'

export const PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export class InvalidReportRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReportRangeError'
  }
}

export type ReportRange =
  | { kind: Period; startUtc: Date; endUtc: Date }
  | { kind: 'custom'; from: string; to: string; startUtc: Date; endUtc: Date }

export interface ReportRangeParams {
  period?: string
  from?: string
  to?: string
}

function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value)
}

/** Parses YYYY-MM-DD strictly: correct shape AND a real calendar date (rejects 2026-02-30). */
function parseCalendarDate(value: string | undefined): { y: number; m: number; d: number } | null {
  if (!value) return null
  const match = ISO_DATE.exec(value)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(y, m - 1, d))
  const isReal = probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  return isReal ? { y, m, d } : null
}

/** Local midnight of a calendar date in `timezone`, as a UTC instant. */
function localMidnightUtc(date: { y: number; m: number; d: number }, timezone: string): Date {
  // fromZonedTime treats the given Date's wall-clock components as being in `timezone`.
  return fromZonedTime(new Date(date.y, date.m - 1, date.d, 0, 0, 0, 0), timezone)
}

export function resolveReportRange(params: ReportRangeParams, timezone: string, now: Date = new Date()): ReportRange {
  const period = params.period ?? 'month'

  if (period === 'custom') {
    const from = parseCalendarDate(params.from)
    const to = parseCalendarDate(params.to)
    if (!from || !to) throw new InvalidReportRangeError('Custom range requires valid from and to dates (YYYY-MM-DD)')
    const startUtc = localMidnightUtc(from, timezone)
    const toStartUtc = localMidnightUtc(to, timezone)
    if (startUtc > toStartUtc) throw new InvalidReportRangeError('from must be on or before to')
    // Inclusive user-facing end date → exclusive UTC upper bound = start of the following local day.
    const endUtc = localMidnightUtc({ y: to.y, m: to.m, d: to.d + 1 }, timezone)
    return { kind: 'custom', from: params.from!, to: params.to!, startUtc, endUtc }
  }

  if (!isPeriod(period)) throw new InvalidReportRangeError(`Unknown period: ${period}`)
  const { startUtc, endUtc } = getPeriodBounds(timezone, period, now)
  return { kind: period, startUtc, endUtc }
}

export function rangeToQueryString(range: ReportRange): string {
  const qs = new URLSearchParams()
  qs.set('period', range.kind)
  if (range.kind === 'custom') {
    qs.set('from', range.from)
    qs.set('to', range.to)
  }
  return qs.toString()
}
```
`d + 1` in `localMidnightUtc({ ..., d: to.d + 1 })` relies on the JS `Date` constructor normalising day overflow (Mar 31 + 1 → Apr 1), which is well-defined behaviour and exactly what's wanted here. If the installed `date-fns-tz` major version still uses the v2 name, `fromZonedTime` is `zonedTimeToUtc` — match whatever Phase 0's `period-bounds.ts` already imports.

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/reports/report-range.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Add the failing by-account test to the activity suite**

Append to `lib/server/services/activity.test.ts` (reusing its existing `setup`/`cleanup`/`tx` helpers):
```ts
import { getActivitySummary } from './activity'
import { resolveReportRange } from '@/lib/reports/report-range'

describe('getActivitySummary byAccount', () => {
  let userId: string
  afterEach(() => cleanup(userId))

  it('reports income, expense and netIncome per account — never one unsigned total', async () => {
    const s = await setup()
    userId = s.userId
    const inMonth = new Date('2026-03-15T10:00:00Z')
    await tx(userId, s.accountId, s.salaryCategory.id, 'INCOME', 10_000_000, inMonth)
    await tx(userId, s.accountId, s.foodCategory.id, 'EXPENSE', 8_000_000, inMonth)

    const range = resolveReportRange({ period: 'month' }, 'Asia/Ho_Chi_Minh', inMonth)
    const summary = await getActivitySummary(userId, 'VND', range)
    const account = summary.byAccount.find((a) => a.name === 'A')
    expect(account?.income.toNumber()).toBe(10_000_000)
    expect(account?.expense.toNumber()).toBe(8_000_000)
    expect(account?.netIncome.toNumber()).toBe(2_000_000)
  })

  it('honours a custom range: a transaction on the exclusive end boundary is excluded', async () => {
    const s = await setup()
    userId = s.userId
    // 31 Mar 23:30 +07:00 is inside; 1 Apr 00:30 +07:00 is outside.
    await tx(userId, s.accountId, s.foodCategory.id, 'EXPENSE', 1_000, new Date('2026-03-31T16:30:00Z'))
    await tx(userId, s.accountId, s.foodCategory.id, 'EXPENSE', 2_000, new Date('2026-03-31T17:30:00Z'))
    const range = resolveReportRange({ period: 'custom', from: '2026-03-01', to: '2026-03-31' }, 'Asia/Ho_Chi_Minh')
    const summary = await getActivitySummary(userId, 'VND', range)
    expect(summary.expense.toNumber()).toBe(1_000)
  })
})
```

- [ ] **Step 6: Run and verify the new cases fail**

Run: `npx vitest run lib/server/services/activity.test.ts`
Expected: the two new cases FAIL — `getActivitySummary` doesn't exist yet.

- [ ] **Step 7: Implement `getActivitySummary` against a resolved range**

Add to `lib/server/services/activity.ts`:
```ts
export interface AccountActivity { name: string; income: Decimal; expense: Decimal; netIncome: Decimal }

export async function getActivitySummary(
  userId: string,
  displayCurrency: Currency,
  range: { startUtc: Date; endUtc: Date },
) {
  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: range.startUtc, lt: range.endUtc }, type: { in: ['INCOME', 'EXPENSE'] } },
    include: { account: true, category: true },
    orderBy: { date: 'asc' },
  })

  let income = new Decimal(0)
  let expense = new Decimal(0)
  const byCategory = new Map<string, Decimal>()
  const byAccount = new Map<string, { income: Decimal; expense: Decimal }>()

  for (const t of transactions) {
    const amount = historicalAmountIn(displayCurrency, t)
    const acct = byAccount.get(t.account.name) ?? { income: new Decimal(0), expense: new Decimal(0) }
    if (t.type === 'INCOME') {
      income = income.add(amount)
      acct.income = acct.income.add(amount)
    } else {
      expense = expense.add(amount)
      acct.expense = acct.expense.add(amount)
      const catName = t.category?.name ?? 'Uncategorized'
      byCategory.set(catName, (byCategory.get(catName) ?? new Decimal(0)).add(amount))
    }
    byAccount.set(t.account.name, acct)
  }

  return {
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    income,
    expense,
    netIncome: income.sub(expense),
    byCategory: [...byCategory.entries()].map(([name, total]) => ({ name, total })),
    byAccount: [...byAccount.entries()].map<AccountActivity>(([name, v]) => ({
      name, income: v.income, expense: v.expense, netIncome: v.income.sub(v.expense),
    })),
    transactions,
  }
}
```

- [ ] **Step 8: Run and verify they pass**

Run: `npx vitest run lib/server/services/activity.test.ts`
Expected: PASS, all cases (the two from Task 3 plus these two).

- [ ] **Step 9: Period filter component with a real custom mode, state kept in the URL**

`components/reports/period-filter.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PERIODS } from '@/lib/reports/report-range'

export function PeriodFilter() {
  const router = useRouter()
  const params = useSearchParams()
  const current = params.get('period') ?? 'month'
  const [from, setFrom] = useState(params.get('from') ?? '')
  const [to, setTo] = useState(params.get('to') ?? '')

  function applyCustom() {
    if (!from || !to) return
    router.push(`/reports?period=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => router.push(`/reports?period=${p}`)}
          className={`rounded-md border px-3 py-1 text-sm capitalize ${current === p ? 'bg-brand text-white' : ''}`}
        >
          {p}
        </button>
      ))}
      <div className={`flex items-center gap-1 rounded-md border px-2 py-1 ${current === 'custom' ? 'border-brand' : ''}`}>
        <label htmlFor="report-from" className="text-sm">From</label>
        <input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-sm" />
        <label htmlFor="report-to" className="text-sm">To</label>
        <input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="text-sm" />
        <button onClick={applyCustom} className="rounded-md bg-brand px-2 py-1 text-sm text-white">Apply</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 10: Reports page**

`app/(app)/reports/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { getActivitySummary } from '@/lib/server/services/activity'
import { resolveReportRange, rangeToQueryString, InvalidReportRangeError } from '@/lib/reports/report-range'
import { PeriodFilter } from '@/components/reports/period-filter'

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>
}) {
  const user = await requireUser()
  const displayCurrency = (user as typeof user & { baseCurrency: 'VND' | 'USD' }).baseCurrency
  const timezone = (user as typeof user & { timezone: string }).timezone
  const params = await searchParams

  let range
  try {
    range = resolveReportRange(params, timezone)
  } catch (err) {
    if (err instanceof InvalidReportRangeError) {
      return (
        <div className="flex flex-col gap-6 p-6">
          <PeriodFilter />
          <p className="text-sm text-negative">{err.message}</p>
        </div>
      )
    }
    throw err
  }

  const summary = await getActivitySummary(user.id, displayCurrency, range)
  const exportQuery = rangeToQueryString(range)

  return (
    <div className="flex flex-col gap-6 p-6">
      <PeriodFilter />
      <div className="flex gap-2">
        <a href={`/api/reports/export?mode=filtered&${exportQuery}`} className="rounded-md border px-3 py-1 text-sm">
          Export filtered (.xlsx)
        </a>
        <a href="/api/reports/export?mode=full" className="rounded-md border px-3 py-1 text-sm">
          Export full data (.xlsx)
        </a>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-md border p-4">
          <p className="text-sm text-foreground/60">Income</p>
          <p className="tabular-nums text-xl font-semibold">{summary.income.toString()} {displayCurrency}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-sm text-foreground/60">Expense</p>
          <p className="tabular-nums text-xl font-semibold">{summary.expense.toString()} {displayCurrency}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-sm text-foreground/60">Net Income</p>
          <p className="tabular-nums text-xl font-semibold">{summary.netIncome.toString()} {displayCurrency}</p>
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">By Category</h3>
        <ul>{summary.byCategory.map((c) => <li key={c.name} className="flex justify-between text-sm"><span>{c.name}</span><span className="tabular-nums">{c.total.toString()}</span></li>)}</ul>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">By Account</h3>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-foreground/60"><th>Account</th><th className="text-right">Income</th><th className="text-right">Expense</th><th className="text-right">Net Income</th></tr></thead>
          <tbody>
            {summary.byAccount.map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td className="tabular-nums text-right text-positive">{a.income.toString()}</td>
                <td className="tabular-nums text-right text-negative">{a.expense.toString()}</td>
                <td className="tabular-nums text-right">{a.netIncome.toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```
The export links are built from `rangeToQueryString(range)` — the *resolved* range — so the filtered export always receives exactly what the page is showing, including a custom `from`/`to`.

- [ ] **Step 11: Manual verification**

Run `npm run dev`, visit `/reports`. Switch between day/week/month/quarter/year. Enter a custom range and apply: the URL must contain `period=custom&from=…&to=…`, a reload must keep it, and totals must change. Enter `to` earlier than `from`: a clear error message, not a crash. Manually put `?period=weekly` in the URL: same. Confirm "By Account" shows income, expense and net income columns.

- [ ] **Step 12: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 13: Commit**

```bash
git add lib/reports lib/server/services/activity.ts lib/server/services/activity.test.ts "app/(app)/reports" components/reports
git commit -m "feat: add Reports page with validated period/custom ranges and per-account income/expense/net"
```

---

## Task 7: Excel export — extensible registry + filtered/full downloads

**Files:**
- Create: `lib/server/export/sheet-registry.ts`, `lib/server/export/build-summary-sheet.ts`, `lib/server/export/build-accounts-sheet.ts`, `lib/server/export/build-transactions-sheet.ts`, `lib/server/export/build-transfers-sheet.ts`, `lib/server/export/filtered-export.ts`, `lib/server/export/filtered-export.test.ts`, `app/api/reports/export/route.ts`
- (Export links were already added to `app/(app)/reports/page.tsx` in Task 6 Step 10, built from the resolved range.)

**Interfaces:**
- Consumes: everything built in this phase and Phase 2, plus `resolveReportRange`/`InvalidReportRangeError` (Task 6)
- Produces: `FULL_EXPORT_SHEET_BUILDERS: SheetBuilder[]` — Phase 5 appends a Budgets builder, Phase 6 appends Savings Goals/Debts/Debt Payments/Loans/Loan Payments/Reminders builders, to this exact array

- [ ] **Step 1: Install ExcelJS**

```bash
npm install exceljs
```

- [ ] **Step 2: Define the sheet-builder contract and registry**

`lib/server/export/sheet-registry.ts`:
```ts
import type ExcelJS from 'exceljs'

export type SheetBuilder = (workbook: ExcelJS.Workbook, userId: string) => Promise<void>

/**
 * Every module's sheet builder is appended here as it's built. Phase 4 seeds Summary,
 * Accounts, Transactions, Transfers. Phase 5 appends Budgets. Phase 6 appends Savings
 * Goals, Debts, Debt Payments, Loans, Loan Payments, Reminders — completing the full
 * workbook defined in spec §12. This array is the single source of truth for "full export."
 */
export const FULL_EXPORT_SHEET_BUILDERS: SheetBuilder[] = []

export function registerExportSheet(builder: SheetBuilder): void {
  FULL_EXPORT_SHEET_BUILDERS.push(builder)
}
```

- [ ] **Step 3: Sheet builders**

`lib/server/export/build-summary-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { prisma } from '@/lib/prisma'
import { getTotalAccountBalance, getNetWorth } from '@/lib/server/services/net-worth'
import { getMonthlyIncomeExpense } from '@/lib/server/services/activity'

registerExportSheet(async (workbook, userId) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const displayCurrency = (user as typeof user & { baseCurrency: 'VND' | 'USD' }).baseCurrency
  const timezone = (user as typeof user & { timezone: string }).timezone

  const [totalBalance, netWorth, monthly] = await Promise.all([
    getTotalAccountBalance(userId, displayCurrency),
    getNetWorth(userId, displayCurrency),
    getMonthlyIncomeExpense(userId, timezone, displayCurrency),
  ])

  const sheet = workbook.addWorksheet('Summary')
  sheet.addRows([
    ['Metric', 'Value', 'Currency'],
    ['Total Account Balance', totalBalance.toNumber(), displayCurrency],
    ['Net Worth', netWorth.toNumber(), displayCurrency],
    ['Monthly Income', monthly.income.toNumber(), displayCurrency],
    ['Monthly Expense', monthly.expense.toNumber(), displayCurrency],
    ['Net Income', monthly.netIncome.toNumber(), displayCurrency],
  ])
})
```

`lib/server/export/build-accounts-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { listAllFinancialAccounts } from '@/lib/server/services/financial-account'
import { getAccountBalance } from '@/lib/server/services/balance'

registerExportSheet(async (workbook, userId) => {
  // Uses listAllFinancialAccounts, not listActiveFinancialAccounts — a full export must include
  // archived accounts and their historical data, not just what's currently active (spec point 4).
  const accounts = await listAllFinancialAccounts(userId)
  const sheet = workbook.addWorksheet('Accounts')
  sheet.addRow(['Name', 'Type', 'Currency', 'Initial Balance', 'Current Balance', 'Status'])
  for (const a of accounts) {
    const balance = await getAccountBalance(userId, a.id)
    sheet.addRow([a.name, a.accountType.name, a.currency, a.initialBalance.toNumber(), balance.toNumber(), a.status])
  }
})
```

`lib/server/export/build-transactions-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { listTransactions } from '@/lib/server/services/transaction'

registerExportSheet(async (workbook, userId) => {
  const transactions = await listTransactions(userId)
  const sheet = workbook.addWorksheet('Transactions')
  sheet.addRow(['Date', 'Type', 'Category', 'Account', 'Amount', 'Currency', 'Note'])
  for (const t of transactions) {
    sheet.addRow([t.date, t.type, t.category?.name ?? '', t.account.name, t.amount.toNumber(), t.currency, t.note ?? ''])
  }
})
```

`lib/server/export/build-transfers-sheet.ts`:
```ts
import { registerExportSheet } from './sheet-registry'
import { listTransfers } from '@/lib/server/services/transfer'

registerExportSheet(async (workbook, userId) => {
  const transfers = await listTransfers(userId)
  const sheet = workbook.addWorksheet('Transfers')
  sheet.addRow(['Date', 'From Account', 'To Account', 'From Amount', 'To Amount', 'Rate Used', 'Note'])
  for (const t of transfers) {
    sheet.addRow([t.date, t.fromAccount.name, t.toAccount.name, t.fromAmount.toNumber(), t.toAmount.toNumber(), t.exchangeRateUsed?.toNumber() ?? '', t.note ?? ''])
  }
})
```

- [ ] **Step 4: Filtered-export builder (testable, range-driven) and its failing test**

The filtered workbook is built by a plain function that takes an already-resolved range, so it can be integration-tested without a browser or session, and so the route can't accidentally apply a different range from the page.

`lib/server/export/filtered-export.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'node:crypto'
import { buildFilteredWorkbook } from './filtered-export'
import { resolveReportRange } from '@/lib/reports/report-range'

describe('buildFilteredWorkbook', () => {
  let userId: string
  afterEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } })
    await prisma.financialAccount.deleteMany({ where: { userId } })
    await prisma.accountType.deleteMany({ where: { userId } })
    await prisma.category.deleteMany({ where: { userId } })
    await prisma.user.delete({ where: { id: userId } })
  })

  it('includes only transactions inside the exact custom range it is given', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `test-${randomUUID()}@example.com`, name: 'Test', emailVerified: false },
    })
    userId = user.id
    const type = await prisma.accountType.create({ data: { userId, name: 'Cash' } })
    const account = await prisma.financialAccount.create({
      data: { userId, name: 'A', accountTypeId: type.id, initialBalance: 0, currency: 'VND' },
    })
    const cat = await prisma.category.create({ data: { userId, name: 'Food', type: 'EXPENSE' } })
    const mk = (date: string, amount: number) => prisma.transaction.create({
      data: { userId, accountId: account.id, categoryId: cat.id, type: 'EXPENSE', amount, currency: 'VND', date: new Date(date), vndPerUsdAtEntry: 25000, fxRateTimestamp: new Date(), fxRateSource: 'test' },
    })
    await mk('2026-03-10T05:00:00Z', 1_000)   // inside
    await mk('2026-03-31T16:59:00Z', 2_000)   // inside: 31 Mar 23:59 +07:00
    await mk('2026-03-31T17:00:00Z', 4_000)   // outside: 1 Apr 00:00 +07:00 (exclusive bound)
    await mk('2026-02-28T16:59:00Z', 8_000)   // outside: 28 Feb 23:59 +07:00

    const range = resolveReportRange({ period: 'custom', from: '2026-03-01', to: '2026-03-31' }, 'Asia/Ho_Chi_Minh')
    const workbook = await buildFilteredWorkbook(userId, 'VND', range)
    const tx = workbook.getWorksheet('Transactions')!
    // header row + 2 data rows
    expect(tx.rowCount).toBe(3)
    const summary = workbook.getWorksheet('Summary')!
    expect(summary.getRow(2).getCell(2).value).toBe(3_000) // Expense = 1,000 + 2,000
  })
})
```

Run: `npx vitest run lib/server/export/filtered-export.test.ts` — expected FAIL, module does not exist.

`lib/server/export/filtered-export.ts`:
```ts
import ExcelJS from 'exceljs'
import { getActivitySummary } from '@/lib/server/services/activity'
import type { ReportRange } from '@/lib/reports/report-range'
import type { Currency } from '@/lib/currency/provider'

export async function buildFilteredWorkbook(userId: string, displayCurrency: Currency, range: ReportRange): Promise<ExcelJS.Workbook> {
  const summary = await getActivitySummary(userId, displayCurrency, range)
  const workbook = new ExcelJS.Workbook()

  const summarySheet = workbook.addWorksheet('Summary')
  summarySheet.addRows([
    ['Income', summary.income.toNumber(), displayCurrency],
    ['Expense', summary.expense.toNumber(), displayCurrency],
    ['Net Income', summary.netIncome.toNumber(), displayCurrency],
    ['Range (UTC)', range.startUtc.toISOString(), range.endUtc.toISOString()],
  ])

  const txSheet = workbook.addWorksheet('Transactions')
  txSheet.addRow(['Date', 'Type', 'Category', 'Account', 'Amount', 'Currency', 'Note'])
  for (const t of summary.transactions) {
    txSheet.addRow([t.date, t.type, t.category?.name ?? '', t.account.name, t.amount.toNumber(), t.currency, t.note ?? ''])
  }
  return workbook
}
```
Note the Summary sheet rows are `['Income', …]` on row 1 and `['Expense', …]` on row 2, which is what the test's `getRow(2).getCell(2)` reads.

Run: `npx vitest run lib/server/export/filtered-export.test.ts` — expected PASS.

- [ ] **Step 5: Route handler — same range resolver as the page**

`app/api/reports/export/route.ts`:
```ts
import ExcelJS from 'exceljs'
import { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { resolveReportRange, InvalidReportRangeError } from '@/lib/reports/report-range'
import { buildFilteredWorkbook } from '@/lib/server/export/filtered-export'
import { FULL_EXPORT_SHEET_BUILDERS } from '@/lib/server/export/sheet-registry'
import '@/lib/server/export/build-summary-sheet'
import '@/lib/server/export/build-accounts-sheet'
import '@/lib/server/export/build-transactions-sheet'
import '@/lib/server/export/build-transfers-sheet'

export async function GET(request: NextRequest) {
  const user = await requireUser()
  const displayCurrency = (user as typeof user & { baseCurrency: 'VND' | 'USD' }).baseCurrency
  const timezone = (user as typeof user & { timezone: string }).timezone
  const sp = request.nextUrl.searchParams
  const mode = sp.get('mode') === 'full' ? 'full' : 'filtered'

  let workbook: ExcelJS.Workbook
  if (mode === 'full') {
    workbook = new ExcelJS.Workbook()
    for (const build of FULL_EXPORT_SHEET_BUILDERS) {
      await build(workbook, user.id)
    }
  } else {
    let range
    try {
      range = resolveReportRange(
        { period: sp.get('period') ?? undefined, from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined },
        timezone,
      )
    } catch (err) {
      if (err instanceof InvalidReportRangeError) return new Response(err.message, { status: 400 })
      throw err
    }
    workbook = await buildFilteredWorkbook(user.id, displayCurrency, range)
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cashflow-${mode}-export.xlsx"`,
    },
  })
}
```
The route never casts a URL string to `Period`; it hands raw strings to `resolveReportRange`, the same function the Reports page uses, and returns 400 on anything invalid. The bare `import '@/lib/server/export/build-*-sheet'` lines exist purely for their registration side effect — Phase 5/6 each add one more such import line alongside their own `build-<module>-sheet.ts`, and nothing else in this route changes.

- [ ] **Step 6: Manual verification**

Run `npm run dev`, visit `/reports`. Select a custom range and click "Export filtered": the download URL must carry the same `period=custom&from=…&to=…`, and the workbook's Transactions sheet must contain only rows inside that range. Click "Export full data": Summary + Accounts + Transactions + Transfers sheets. Request `/api/reports/export?mode=filtered&period=bogus` directly: HTTP 400, not a 500.

- [ ] **Step 7: Verification before commit**

```bash
npx vitest run lib/server/export
npm run lint
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add lib/server/export app/api/reports package.json package-lock.json
git commit -m "feat: add Excel export with range-driven filtered workbook and extensible full-workbook registry"
```

---

## Phase 4 Acceptance Check

- [ ] The real `AppShell` (sidebar desktop, bottom-tab mobile with a raised Add-Transaction action) replaces every placeholder layout from Phases 1–2.
- [ ] Dashboard renders Total Account Balance (spec §5.2 name), Net Worth, Monthly Income, Monthly Expense, Net Income (correctly labeled, not "Net Cash Flow"), Cash Flow Trend, Account Balance Over Time (with gap rendering verified against Task 4's test), Expense by Category, Account Balance Distribution, and Recent Transactions.
- [ ] Reports page filters by day/week/month/quarter/year/custom using timezone-correct boundaries; custom `from`/`to` are validated (shape, real dates, `from <= to`), interpreted in `User.timezone` with an inclusive end date, kept in the URL, and unknown `period` values are rejected — proven by `report-range.test.ts`.
- [ ] "By Account" reports income, expense and net income per account, never a single unsigned total — proven by the activity test.
- [ ] Filtered export receives the exact same resolved range as the page (proven by `filtered-export.test.ts`); full export produces Summary, Accounts, Transactions, Transfers — via the extensible registry Phase 5/6 will append to.
- [ ] A distinct Income vs Expense comparison chart exists alongside the Cash Flow Trend time series; the "FX rate last updated" indicator shows rate, timestamp and fallback status, and current-position KPIs degrade to "—" (never crash) when no usable rate exists.
- [ ] The historical chart is labeled "Account Balance Over Time" and reconstructs account balances only; true historical Net Worth is documented as deferred (spec §17), not approximated.
- [ ] `npm run test`, `npm run lint`, and `npm run build` all succeed.
