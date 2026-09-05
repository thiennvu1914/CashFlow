# CashFlow Phase 8: Demo Data, Security Review & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run seed:demo` populates a dedicated, clearly-flagged demo account with data across every module so the app is immediately evaluable; `npm run seed:demo:clear` removes exactly that data; both refuse to run in production by default. A final security review pass confirms the whole application meets the spec's security requirements before calling the MVP done.

**Architecture:** The production guard is a small, independently testable function shared by both scripts — closed by default (`NODE_ENV=production` blocks execution) with a single, deliberately loud override flag. The demo user is identified only by `User.isDemo` (never by matching its email string), so `clear-demo.ts` can never be tricked into targeting the wrong account. Deletion is explicit and ordered (children before parents) rather than relying on any database cascade — consistent with Phase 2's decision not to add a direct Prisma relation from app models to Better Auth's `User` model.

**Tech Stack:** tsx (script runner, added this phase as a proper devDependency).

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§8, §13, §16)

**Depends on:** every prior phase — this is the closing phase, and its demo script exercises the full service layer built across Phases 2–6.

## Global Constraints

- No stored balance column anywhere — balance is always derived from Transaction + Transfer.
- Every financial Prisma model is scoped by `userId`; cross-user relations use tenant-scoped composite foreign keys.
- `User.isDemo` must never appear in any client-facing Zod schema — this phase is the one place it's set, via a direct Prisma call from a trusted script, never through a user-facing action.
- No background jobs/cron anywhere.
- Every server action/query calls `requireUser()` and scopes every query by the resulting `userId`.
- Package manager: npm. No `src/` directory. Import alias `@/*`. Node 20+ LTS.

---

## Task 1: Shared production guard (TDD)

**Files:**
- Create: `scripts/lib/production-guard.ts`
- Test: `scripts/lib/production-guard.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `assertNotProduction(env?: NodeJS.ProcessEnv): void` — both `seed-demo.ts` and `clear-demo.ts` call this as their very first line

- [ ] **Step 1: Install tsx as a proper devDependency**

```bash
npm install --save-dev tsx
```

- [ ] **Step 2: Write the failing tests**

`scripts/lib/production-guard.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { assertNotProduction } from './production-guard'

describe('assertNotProduction', () => {
  it('exits with code 1 when NODE_ENV=production and no override is set', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    }) as never
    expect(() => assertNotProduction({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow('process.exit called')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('does not exit when NODE_ENV=production and ALLOW_DEMO_SEED_IN_PRODUCTION=true', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not have been called')
    }) as never
    expect(() =>
      assertNotProduction({ NODE_ENV: 'production', ALLOW_DEMO_SEED_IN_PRODUCTION: 'true' } as NodeJS.ProcessEnv),
    ).not.toThrow()
    exitSpy.mockRestore()
  })

  it('does not exit when NODE_ENV is not production', () => {
    expect(() => assertNotProduction({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow()
  })
})
```

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run scripts/lib/production-guard.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement**

`scripts/lib/production-guard.ts`:
```ts
export function assertNotProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.ALLOW_DEMO_SEED_IN_PRODUCTION !== 'true') {
    console.error(
      'Refusing to run this demo data script in production. ' +
        'Set ALLOW_DEMO_SEED_IN_PRODUCTION=true to override (not recommended).',
    )
    process.exit(1)
  }
}
```

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run scripts/lib/production-guard.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib package.json package-lock.json
git commit -m "feat: add shared production guard for demo data scripts"
```

---

## Task 2: seed-demo.ts

**Files:**
- Create: `scripts/seed-demo.ts`

**Interfaces:**
- Consumes: `assertNotProduction` (Task 1), and the full service layer built in Phases 2, 5, 6
- Produces: nothing new — this is a one-shot script, not a module other code imports

- [ ] **Step 1: Write the script**

`scripts/seed-demo.ts`:
```ts
// DEVELOPMENT DEMO DATA — SAFE TO DELETE — DO NOT USE IN PRODUCTION
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { auth } from '../lib/auth/auth'
import { createFinancialAccount } from '../lib/server/services/financial-account'
import { createTransaction } from '../lib/server/services/transaction'
import { createTransfer } from '../lib/server/services/transfer'
import { createBudget } from '../lib/server/services/budget'
import { createReminder } from '../lib/server/services/reminder'
import { createSavingsGoal } from '../lib/server/services/savings-goal'
import { createDebt, recordDebtPayment } from '../lib/server/services/debt'
import { createLoan, recordLoanPayment } from '../lib/server/services/loan'
import { assertNotProduction } from './lib/production-guard'

const DEMO_EMAIL = 'demo@cashflow.local'
const DEMO_PASSWORD = 'demo-password-not-for-production'

async function main() {
  assertNotProduction()

  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } })
  if (existing) {
    console.log('Demo user already exists. Run `npm run seed:demo:clear` first to reseed from scratch.')
    return
  }

  // Creates the User row via Better Auth's own sign-up flow, which also triggers the
  // databaseHooks.user.create.after hook (Phase 2) that seeds default categories/account
  // types — do not call seedDefaultsForUser again here, or it will duplicate them.
  // Verify `auth.api.signUpEmail` works correctly when called outside a real HTTP request
  // context (no incoming headers) — if the installed Better Auth version requires headers
  // even for this internal call, pass an empty Headers object explicitly.
  const signUpResult = await auth.api.signUpEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo User' },
  })
  const userId = signUpResult.user.id
  await prisma.user.update({ where: { id: userId }, data: { isDemo: true } })

  const [cashType, bankType, savingsType] = await Promise.all([
    prisma.accountType.findFirstOrThrow({ where: { userId, name: 'Cash' } }),
    prisma.accountType.findFirstOrThrow({ where: { userId, name: 'Bank Account' } }),
    prisma.accountType.findFirstOrThrow({ where: { userId, name: 'Savings Account' } }),
  ])
  const cashAccount = await createFinancialAccount(userId, { name: 'Cash', accountTypeId: cashType.id, initialBalance: 2_000_000, currency: 'VND' })
  const bankAccount = await createFinancialAccount(userId, { name: 'Vietcombank', accountTypeId: bankType.id, initialBalance: 20_000_000, currency: 'VND' })
  await createFinancialAccount(userId, { name: 'USD Savings', accountTypeId: savingsType.id, initialBalance: 500, currency: 'USD' })

  const [salaryCategory, foodCategory, billsCategory] = await Promise.all([
    prisma.category.findFirstOrThrow({ where: { userId, name: 'Salary' } }),
    prisma.category.findFirstOrThrow({ where: { userId, name: 'Food & Dining' } }),
    prisma.category.findFirstOrThrow({ where: { userId, name: 'Bills & Utilities' } }),
  ])

  const now = new Date()
  for (let monthsAgo = 3; monthsAgo >= 0; monthsAgo--) {
    const salaryDate = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 5)
    await createTransaction(userId, { accountId: bankAccount.id, categoryId: salaryCategory.id, type: 'INCOME', amount: 25_000_000, date: salaryDate })
    await createTransaction(userId, { accountId: cashAccount.id, categoryId: foodCategory.id, type: 'EXPENSE', amount: 3_500_000, date: new Date(salaryDate.getFullYear(), salaryDate.getMonth(), 12) })
    await createTransaction(userId, { accountId: bankAccount.id, categoryId: billsCategory.id, type: 'EXPENSE', amount: 1_200_000, date: new Date(salaryDate.getFullYear(), salaryDate.getMonth(), 15) })
  }
  await createTransaction(userId, { accountId: bankAccount.id, type: 'CASH_IN', amount: 5_000_000, date: new Date(), note: 'Loan proceeds received' })
  await createTransfer(userId, { fromAccountId: bankAccount.id, toAccountId: cashAccount.id, fromAmount: 1_000_000, toAmount: 1_000_000, date: new Date() })

  await createBudget(userId, { year: now.getFullYear(), month: now.getMonth() + 1, scope: 'OVERALL', amount: 15_000_000, currency: 'VND' })
  await createBudget(userId, { year: now.getFullYear(), month: now.getMonth() + 1, scope: 'CATEGORY', categoryId: foodCategory.id, amount: 4_000_000, currency: 'VND' })

  await createReminder(userId, {
    title: 'Rent', type: 'EXPENSE', expectedAmount: 6_000_000, currency: 'VND',
    frequency: 'MONTHLY', interval: 1, dayOfMonth: 1, startDate: new Date(now.getFullYear(), now.getMonth() - 2, 1),
  })
  await createSavingsGoal(userId, { name: 'MacBook', targetAmount: 30_000_000, currency: 'VND', deadline: new Date(now.getFullYear() + 1, 11, 31) })

  const debt = await createDebt(userId, { direction: 'RECEIVABLE', person: 'Nguyen Van A', originalAmount: 5_000_000, currency: 'VND' })
  await recordDebtPayment(userId, debt.id, { amount: 2_000_000, date: new Date() })

  const loan = await createLoan(userId, {
    lender: 'ABC Bank', principal: 100_000_000, currency: 'VND', interestRate: 8.5,
    startDate: new Date(now.getFullYear(), now.getMonth() - 6, 1), termMonths: 24,
    paymentFrequency: 'MONTHLY', scheduledPaymentAmount: 4_800_000,
    nextDueDate: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  })
  await recordLoanPayment(userId, loan.id, { totalAmount: 4_800_000, principalAmount: 4_100_000, interestAmount: 700_000, paymentDate: new Date() })

  console.log(`Demo user ready. Log in with: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Add the npm script and run it**

In `package.json`:
```json
"seed:demo": "tsx scripts/seed-demo.ts"
```
```bash
npm run seed:demo
```
Expected: no errors, ends with "Demo user ready. Log in with: ...". If `auth.api.signUpEmail` throws due to a headers requirement, apply the fix noted in the script's own comment and re-run.

- [ ] **Step 3: Manual verification**

Log in with the printed demo credentials. Visit `/dashboard` — confirm every widget shows real, plausible data (KPIs, both charts with multiple months of history, category breakdown, budget progress, upcoming reminder, savings goal, debt/loan overview). This is the actual acceptance bar from the spec: "demo data so the dashboard can be evaluated immediately."

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-demo.ts package.json
git commit -m "feat: add seed-demo script covering every module"
```

---

## Task 3: clear-demo.ts

**Files:**
- Create: `scripts/clear-demo.ts`

**Interfaces:**
- Consumes: `assertNotProduction` (Task 1)
- Produces: nothing new

- [ ] **Step 1: Write the script**

`scripts/clear-demo.ts`:
```ts
// DEVELOPMENT DEMO DATA — SAFE TO DELETE — DO NOT USE IN PRODUCTION
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { assertNotProduction } from './lib/production-guard'

async function main() {
  assertNotProduction()

  const demoUser = await prisma.user.findFirst({ where: { isDemo: true } })
  if (!demoUser) {
    console.log('No demo user found — nothing to clear.')
    return
  }
  const userId = demoUser.id

  // Explicit, ordered deletion (children before parents). Not a database cascade — app
  // models have no direct FK to Better Auth's User model (Phase 2's architecture note), and
  // explicit, auditable deletion is the right shape for bulk deletion of financial data
  // regardless of that constraint.
  await prisma.loanPayment.deleteMany({ where: { userId } })
  await prisma.loan.deleteMany({ where: { userId } })
  await prisma.debtPayment.deleteMany({ where: { userId } })
  await prisma.debt.deleteMany({ where: { userId } })
  await prisma.savingsGoal.deleteMany({ where: { userId } })
  await prisma.reminderOccurrence.deleteMany({ where: { userId } })
  await prisma.recurringReminder.deleteMany({ where: { userId } })
  await prisma.budget.deleteMany({ where: { userId } })
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.transfer.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.category.deleteMany({ where: { userId } })
  await prisma.session.deleteMany({ where: { userId } })
  await prisma.account.deleteMany({ where: { userId } }) // Better Auth's own credential table
  await prisma.user.delete({ where: { id: userId } })

  console.log('Demo data cleared.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
```
Verify the field name `userId` actually matches on Better Auth's generated `Session`/`Account` models (check `prisma/schema.prisma`) — adjust if the installed version names it differently.

- [ ] **Step 2: Add the npm script**

```json
"seed:demo:clear": "tsx scripts/clear-demo.ts"
```

- [ ] **Step 3: End-to-end verification**

```bash
npm run seed:demo:clear
npm run seed:demo
npm run seed:demo:clear
```
After the final clear, verify no orphaned rows remain:
```bash
npx tsx -e "
import { prisma } from './lib/prisma'
async function main() {
  const counts = await Promise.all([
    prisma.user.count({ where: { email: 'demo@cashflow.local' } }),
    prisma.financialAccount.count(),
    prisma.transaction.count(),
  ])
  console.log('demo user count (expect 0):', counts[0])
}
main().finally(() => prisma.\$disconnect())
"
```
Expected: demo user count is 0. Also confirm any pre-existing non-demo test data (if you have a separate real account) was untouched by the clear script.

- [ ] **Step 4: Verify the production guard actually blocks execution**

```bash
NODE_ENV=production npm run seed:demo
```
Expected: exits with the "Refusing to run..." message and non-zero exit code, no database changes.

- [ ] **Step 5: Commit**

```bash
git add scripts/clear-demo.ts package.json
git commit -m "feat: add clear-demo script with production guard"
```

---

## Task 4: Golden-path E2E coverage

**Files:**
- Create: `e2e/golden-paths.spec.ts`, `e2e/i18n.spec.ts`

**Interfaces:**
- Consumes: the full application built across Phases 1–7
- Produces: nothing new — this closes the gap left by Phase 1 Task 9, which only covered the auth journey; the spec's testing strategy (§15) explicitly calls out transaction/dashboard, transfer, budget-threshold, and export as golden paths needing E2E coverage, not just auth. It also makes the E2E suite deterministic against Phase 7's Vietnamese-default locale (English-selector tests force English explicitly; a dedicated `i18n.spec.ts` covers the vi-default/en-switch behavior directly instead of leaving it untested.)

- [ ] **Step 1: Write the tests**

**Deterministic locale note:** Phase 7 makes Vietnamese the default locale, resolved from the authenticated user's saved preference once logged in (falling back to a `NEXT_LOCALE` cookie only pre-auth). The selectors below are written against English text, so `registerFreshUser` explicitly forces English at both points where it matters: the cookie for the pre-auth `/register` page itself, and a real switch through the `/settings` UI immediately after registering (which Phase 7 wires to update both the database preference and the cookie) so every page for the rest of the flow — which resolves locale from the now-logged-in session — is English too. This also happens to be genuine functional coverage of "switching to English works," which Step 1's separate locale test below covers more directly.

`e2e/golden-paths.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

async function registerFreshUser(page: import('@playwright/test').Page) {
  // Force English for the pre-auth /register page itself (no session exists yet to resolve
  // locale from, so the cookie is authoritative here). Matches playwright.config.ts's baseURL.
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', domain: 'localhost', path: '/' }])

  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  await page.goto('/register')
  await page.getByPlaceholder('Name').fill('E2E User')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill('correct-horse-battery-staple')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  // Once logged in, resolveLocale (Phase 7) prefers the session's saved preference over the
  // cookie — and a freshly-registered user defaults to 'vi'. Switch it for real through the
  // Settings UI so every subsequent page in the golden path also renders in English. This first
  // visit to /settings is itself still in Vietnamese (the switch hasn't happened yet), so the
  // save button is targeted structurally (scoped to the form containing the locale select),
  // never by its (currently Vietnamese) text label.
  await page.goto('/settings')
  const profileForm = page.locator('form').filter({ has: page.locator('select[name="locale"]') })
  await profileForm.locator('select[name="locale"]').selectOption('en')
  await profileForm.locator('button[type="submit"]').click()
}

test.describe('golden paths', () => {
  test.beforeEach(async ({ page }) => {
    await registerFreshUser(page)
  })

  test('creating an account and an expense transaction reduces the visible balance', async ({ page }) => {
    await page.goto('/accounts')
    await page.getByPlaceholder('Account name').fill('E2E Checking')
    await page.getByPlaceholder('Initial balance').fill('1000000')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText('E2E Checking')).toBeVisible()

    await page.goto('/transactions')
    await page.selectOption('select', { label: 'Expense' })
    await page.selectOption('select >> nth=1', { label: 'E2E Checking' })
    await page.getByPlaceholder('Amount').fill('50000')
    await page.getByRole('button', { name: 'Add transaction' }).click()

    await page.goto('/accounts')
    // Assert the balance decreased from the initial value, rather than a brittle exact
    // locale-formatted string match — confirm the raw number 950000 (or its locale-formatted
    // equivalent) is present near the account name. Adjust the selector once run against the
    // actual rendered DOM, since exact markup/formatting depends on final component structure.
    await expect(page.locator('body')).toContainText(/950[.,]?000/)
  })

  test('transferring between two accounts updates both balances without appearing as income/expense', async ({ page }) => {
    await page.goto('/accounts')
    for (const name of ['Source', 'Destination']) {
      await page.getByPlaceholder('Account name').fill(name)
      await page.getByPlaceholder('Initial balance').fill(name === 'Source' ? '1000000' : '0')
      await page.getByRole('button', { name: 'Create account' }).click()
      await expect(page.getByText(name)).toBeVisible()
    }

    await page.goto('/transfers')
    await page.selectOption('select >> nth=0', { label: /Source/ })
    await page.selectOption('select >> nth=1', { label: /Destination/ })
    await page.getByPlaceholder('Amount sent').fill('300000')
    await page.getByRole('button', { name: 'Transfer' }).click()

    await page.goto('/accounts')
    await expect(page.locator('body')).toContainText(/700[.,]?000/)
    await expect(page.locator('body')).toContainText(/300[.,]?000/)
  })

  test('an expense crossing 100% of its budget shows the exceeded state', async ({ page }) => {
    await page.goto('/accounts')
    await page.getByPlaceholder('Account name').fill('Budget Test Account')
    await page.getByPlaceholder('Initial balance').fill('5000000')
    await page.getByRole('button', { name: 'Create account' }).click()

    await page.goto('/budgets')
    await page.selectOption('select', { label: 'Overall' })
    await page.getByPlaceholder('Amount').fill('100000')
    await page.getByRole('button', { name: 'Add budget' }).click()

    await page.goto('/transactions')
    await page.selectOption('select', { label: 'Expense' })
    await page.getByPlaceholder('Amount').fill('150000')
    await page.getByRole('button', { name: 'Add transaction' }).click()

    await page.goto('/budgets')
    // The exceeded state renders with the bg-negative class per components/budgets/budget-progress-card.tsx
    await expect(page.locator('.bg-negative')).toBeVisible()
  })

  test('the reports export link triggers a file download', async ({ page }) => {
    await page.goto('/reports')
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Export filtered (.xlsx)' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
  })
})
```

- [ ] **Step 1a: Explicit locale-default and locale-switch coverage**

The golden-path tests above force English throughout, for selector stability — they deliberately don't exercise the default-locale behavior itself. Add a dedicated, separate test file for that:

`e2e/i18n.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test.describe('locale default and switching', () => {
  test('a fresh visit with no cookie or session defaults to Vietnamese', async ({ page }) => {
    await page.goto('/login')
    // Adjust this to whatever Phase 7's messages.vi.json actually sets for auth.login.title —
    // written here against the spec's stated default, verify the exact string once implemented.
    await expect(page.locator('h1')).toContainText('Đăng nhập')
  })

  test('switching to English in Settings persists across a full reload and a fresh login', async ({ page }) => {
    const email = `e2e-i18n-${Date.now()}@example.com`
    await page.goto('/register')
    await page.getByPlaceholder(/tên|name/i).fill('I18n Test User')
    await page.getByPlaceholder(/email/i).fill(email)
    await page.getByPlaceholder(/mật khẩu|password/i).fill('correct-horse-battery-staple')
    await page.locator('form button[type="submit"]').click()
    await expect(page).toHaveURL(/\/dashboard/)

    await page.goto('/settings')
    const profileForm = page.locator('form').filter({ has: page.locator('select[name="locale"]') })
    await profileForm.locator('select[name="locale"]').selectOption('en')
    await profileForm.locator('button[type="submit"]').click()

    await page.reload()
    await expect(page.locator('h1, h2').first()).toContainText(/settings|profile/i)

    // Log out and back in — the preference must have been saved to the database (Phase 7's
    // fix), not merely the cookie, so it survives a fresh session with no prior cookie state.
    await page.context().clearCookies()
    await page.goto('/login')
    await page.getByPlaceholder(/email/i).fill(email)
    await page.getByPlaceholder(/password|mật khẩu/i).fill('correct-horse-battery-staple')
    await page.locator('form button[type="submit"]').click()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.locator('nav, aside').first()).toContainText(/dashboard/i)
  })
})
```
The register/login form fields are matched with locale-agnostic regex placeholders (`/tên|name/i` etc.) here specifically because this test intentionally starts in the default Vietnamese locale — unlike the golden-path tests, it cannot force English first without defeating its own purpose.

- [ ] **Step 2: Run and reconcile against the real rendered app**

Run: `npx playwright test e2e/golden-paths.spec.ts`
Expected: some selector adjustments will likely be needed on the first run (exact `select` ordering, exact number formatting) — this is expected for E2E tests written against a plan rather than a running app. Fix selectors to match actual rendered output; do not weaken the assertions themselves (e.g., don't drop the "balance actually changed" check just to make the test pass).

- [ ] **Step 3: Commit**

```bash
git add e2e/golden-paths.spec.ts e2e/i18n.spec.ts
git commit -m "test: add E2E coverage for transaction, transfer, budget-threshold, export, and locale default/switch golden paths"
```

---

## Task 5: Final security review and production readiness

**Files:**
- Modify: `.env.example` (fill in any gaps found), `README.md`

**Interfaces:** none — this is a review and documentation task

- [ ] **Step 1: Invoke the security-review skill against the full branch**

Run the `security-review` skill (available in this environment) against all changes accumulated across Phases 0–8. Address any finding it surfaces before proceeding — do not defer findings to "future work" without discussing them explicitly.

- [ ] **Step 2: Manual checklist against the spec's security section (§8)**

Go through each item and note pass/fail with evidence (not just a checkmark):
- Every server action/service function calls `requireUser()` and scopes queries by its result — spot-check at least one file per module built in Phases 2, 5, 6.
- No `console.log`/`console.error` anywhere logs a full request body, password, token, or raw financial amount tied to an identifiable user beyond what error diagnostics need (error class/stack is fine; a dumped `input` object is not) — grep for `console.log(` across `lib/server` and review each hit.
- `.env` is gitignored; `git log --all --full-history -- .env` shows it was never committed.
- Production cookie flags: confirm Better Auth's session cookie config sets `secure: true` when `NODE_ENV=production` (check the installed version's default behavior, or set it explicitly in `lib/auth/auth.ts` if it doesn't default that way).
- Rate limiting (Phase 1 Task 8) is still active and untouched by later phases.
- The tenant-isolation composite FKs (Phase 2 Task 11's test) still pass after every later phase's schema additions — re-run `npx vitest run lib/server/services/tenant-isolation.test.ts` now, at the end, to confirm no later migration accidentally weakened it.
- `isDemo` remains unsettable via any client input — re-confirm `additionalFields.isDemo.input === false` in `lib/auth/auth.ts` and that `updateProfile`'s `data:` object still never spreads raw input.

- [ ] **Step 3: Fill any gaps in `.env.example`**

Compare every `process.env.X` reference across the codebase (`grep -rn "process.env\." lib app scripts`) against `.env.example` — add any missing variable with a placeholder value and a one-line comment explaining what it's for.

- [ ] **Step 4: Update the README with setup instructions**

`README.md` should cover, concretely: cloning, `npm install`, `docker compose up -d`, copying `.env.example` to `.env` and filling in real values, `npx prisma migrate deploy` for local setup from an existing migration history (applies committed migrations without generating new ones — the right command for anyone just standing up the app, as opposed to `migrate dev`, which is only for actively authoring schema changes during development), `npm run dev`, and `npm run seed:demo` for evaluating the dashboard immediately — plus a one-line pointer to the design spec at `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` for anyone who wants the full architecture rationale.

Add a separate "Deploying" section distinguishing the two Prisma commands explicitly: local development that's actively changing the schema uses `npx prisma migrate dev` (as every earlier phase's tasks did); any other environment — a fresh local checkout, staging, or production — uses `npx prisma migrate deploy`, which applies the committed migration history without prompting or generating anything new. Never document or use `prisma db push` for a deployment workflow — it was only ever the one-time empty-schema connectivity check in Phase 0.

- [ ] **Step 5: Full verification suite**

```bash
npm run test
npm run lint
npm run build
npx playwright test
```
Expected: all succeed with zero failures. This is the MVP's final gate — do not mark the project complete if any of these fail.

- [ ] **Step 6: Commit**

```bash
git add .env.example README.md
git commit -m "docs: finalize environment documentation and setup instructions"
```

---

## Phase 8 Acceptance Check

- [ ] `npm run seed:demo` produces a fully evaluable dashboard in one command; `npm run seed:demo:clear` removes exactly that data and nothing else.
- [ ] Both scripts refuse to run under `NODE_ENV=production` without the explicit override flag — proven by an actual attempted run, not just code inspection.
- [ ] E2E coverage exists for the transaction/balance, transfer, budget-threshold, and export golden paths, not just auth.
- [ ] The security-review skill has been run against the full branch and its findings addressed.
- [ ] The tenant-isolation test from Phase 2 still passes after every later phase's schema changes.
- [ ] `.env.example` documents every environment variable the app actually reads.
- [ ] `README.md` lets a new developer go from clone to a running, demo-populated app.
- [ ] `npm run test`, `npm run lint`, `npm run build`, and `npx playwright test` all succeed — this is the final MVP acceptance gate across all nine phases.
