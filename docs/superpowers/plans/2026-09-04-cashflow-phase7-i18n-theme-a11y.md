# CashFlow Phase 7: i18n, Theme, Responsive & Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Locale and theme preferences saved in Settings actually change what renders (a real gap left by Phases 0–6, fixed first); every hardcoded UI string moves into `messages/vi.json`/`en.json`; every form input has a real accessible label; every page is verified at mobile width with no overflow.

**Architecture:** `resolveLocale`/`resolveTheme` are extended to check the authenticated user's saved DB preference first, falling back to a cookie (for pre-auth pages) and then the hardcoded default — and `updateProfile` is extended to write that cookie alongside the DB update, so a preference change is visible on the very next render without waiting for anything else to refresh.

**Tech Stack:** next-intl (already installed, Phase 0), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§3 — i18n/theme persistence)

**Depends on:** Phase 0 (`resolveLocale`, message files), Phase 1 (`updateProfile`), Phases 2–6 (every page and form built so far).

## Global Constraints

- No stored balance column anywhere — balance is always derived from Transaction + Transfer.
- Every financial Prisma model is scoped by `userId`; cross-user relations use tenant-scoped composite foreign keys.
- Money fields are always Prisma `Decimal`, never `Float`.
- Every server action/query calls `requireUser()` and scopes every query by the resulting `userId`.
- Zod validates every mutation server-side, independent of client-side validation.
- Package manager: npm. No `src/` directory. Import alias `@/*`. Node 20+ LTS.
- Dark mode must never be pure black — it uses the warm charcoal tokens already defined in Phase 0's `globals.css` (`#171C1A`/`#202724`/`#29302D`-derived).

---

## Task 1: Wire saved locale/theme preferences into actual rendering

**Files:**
- Modify: `lib/i18n/config.ts`, `lib/server/actions/update-profile.ts`
- Create: `lib/theme/config.ts`
- Modify: `app/layout.tsx`

**Interfaces:**
- Consumes: `getOptionalSession` (Phase 1)
- Produces: `resolveTheme(): Promise<'light' | 'dark'>` — used by the root layout

- [ ] **Step 1: Extend `resolveLocale` to check the session first**

`lib/i18n/config.ts`:
```ts
import { cookies } from 'next/headers'
import { getOptionalSession } from '@/lib/auth/require-user'

export const SUPPORTED_LOCALES = ['vi', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'vi'

function isSupportedLocale(value: string | undefined): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export async function resolveLocale(): Promise<Locale> {
  const session = await getOptionalSession()
  const userLocale = (session?.user as { locale?: string } | undefined)?.locale
  if (isSupportedLocale(userLocale)) return userLocale

  const store = await cookies()
  const cookieLocale = store.get('NEXT_LOCALE')?.value
  return isSupportedLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE
}
```

- [ ] **Step 2: Write `resolveTheme` the same way**

`lib/theme/config.ts`:
```ts
import { cookies } from 'next/headers'
import { getOptionalSession } from '@/lib/auth/require-user'

export async function resolveTheme(): Promise<'light' | 'dark'> {
  const session = await getOptionalSession()
  const userTheme = (session?.user as { theme?: string } | undefined)?.theme
  if (userTheme === 'dark' || userTheme === 'light') return userTheme

  const store = await cookies()
  const cookieTheme = store.get('theme')?.value
  return cookieTheme === 'dark' ? 'dark' : 'light'
}
```

- [ ] **Step 3: Apply the resolved theme to the root layout**

In `app/layout.tsx`, alongside the existing `resolveLocale()` call:
```tsx
import { resolveTheme } from '@/lib/theme/config'
// ...
const theme = await resolveTheme()
// ...
<html lang={locale} className={theme === 'dark' ? 'dark' : undefined}>
```

- [ ] **Step 4: Make `updateProfile` write both cookies, not just the database**

In `lib/server/actions/update-profile.ts`:
```ts
import { cookies } from 'next/headers'
// ... after the existing prisma.user.update call:

const cookieStore = await cookies()
const oneYear = 60 * 60 * 24 * 365
cookieStore.set('NEXT_LOCALE', parsed.locale, { sameSite: 'lax', maxAge: oneYear })
cookieStore.set('theme', parsed.theme, { sameSite: 'lax', maxAge: oneYear })
```

- [ ] **Step 5: Manual verification**

Run `npm run dev`, log in, go to `/settings`, change locale to English and theme to dark, save. Reload the page (a full reload, not just client navigation) — confirm the page immediately renders in English with the dark palette, with no flash of the previous state. Log out and back in — confirm the preference persisted (it was saved to the database, and the cookie now also matches).

- [ ] **Step 6: Commit**

```bash
git add lib/i18n/config.ts lib/theme/config.ts lib/server/actions/update-profile.ts app/layout.tsx
git commit -m "fix: actually apply saved locale/theme preferences instead of only storing them"
```

---

## Task 2: Extract hardcoded strings into i18n messages

**Files:**
- Modify: `messages/vi.json`, `messages/en.json` (grown substantially)
- Modify: every page and form component built in Phases 1–6 (full list in Step 3)

**Interfaces:**
- Consumes: `useTranslations` / `getTranslations` from `next-intl` (already installed, Phase 0)
- Produces: nothing new — this is a mechanical migration of literal strings to message keys

- [ ] **Step 1: Design the message namespace structure and populate both files**

`messages/en.json` (structure — fill in `vi.json` with the Vietnamese equivalent of every value, not machine-translated placeholder text):
```json
{
  "common": { "appName": "CashFlow", "save": "Save", "cancel": "Cancel", "add": "Add", "delete": "Delete", "edit": "Edit", "archive": "Archive" },
  "nav": { "dashboard": "Dashboard", "transactions": "Transactions", "accounts": "Accounts", "budgets": "Budgets", "reports": "Reports", "settings": "Settings", "transfers": "Transfers", "categories": "Categories", "reminders": "Reminders", "goals": "Goals", "debts": "Debts", "loans": "Loans", "logout": "Log out" },
  "auth": {
    "register": { "title": "Create your CashFlow account", "name": "Name", "email": "Email", "password": "Password", "submit": "Create account", "submitting": "Creating account…" },
    "login": { "title": "Sign in to CashFlow", "email": "Email", "password": "Password", "submit": "Sign in", "submitting": "Signing in…", "forgotPassword": "Forgot password?", "invalidCredentials": "Invalid email or password" },
    "forgotPassword": { "title": "Reset your password", "email": "Email", "submit": "Send reset link", "sent": "If an account exists for that email, a reset link has been sent." },
    "resetPassword": { "title": "Set a new password", "newPassword": "New password", "submit": "Set new password" },
    "changePassword": { "currentPassword": "Current password", "newPassword": "New password", "submit": "Change password", "success": "Password updated" }
  },
  "accounts": { "addTitle": "Add account", "name": "Account name", "type": "Account type", "initialBalance": "Initial balance", "currency": "Currency", "description": "Description (optional)", "lockedNotice": "Currency and initial balance are locked because this account already has activity." },
  "transactions": { "type": "Type", "income": "Income", "expense": "Expense", "cashIn": "Cash In (other)", "cashOut": "Cash Out (other)", "adjustmentIncrease": "Balance Adjustment — increase", "adjustmentDecrease": "Balance Adjustment — decrease", "account": "Account", "category": "Category", "selectCategory": "Select a category", "amount": "Amount", "date": "Date", "note": "Note (optional)", "add": "Add transaction" },
  "transfers": { "amountSent": "Amount sent", "amountReceived": "Amount received", "submit": "Transfer" },
  "budgets": { "overall": "Overall", "category": "Category", "amount": "Amount", "add": "Add budget" },
  "goals": { "namePlaceholder": "Goal name (e.g. MacBook)", "target": "Target amount", "updateProgress": "Update progress" },
  "debts": { "receivable": "Someone owes me", "payable": "I owe someone", "person": "Person", "originalAmount": "Original amount", "recordPayment": "Record payment" },
  "loans": { "lender": "Lender", "principal": "Principal", "interestRate": "Interest rate (%)", "termMonths": "Term (months)", "scheduledPayment": "Scheduled payment amount" },
  "reminders": { "titlePlaceholder": "Title (e.g. Rent, Salary)", "expectedAmount": "Expected amount", "frequency": { "oneTime": "One time", "weekly": "Weekly", "monthly": "Monthly", "yearly": "Yearly" }, "dayOfMonth": "Day of month (1-31)", "acknowledge": "Acknowledge", "dismiss": "Dismiss", "add": "Add reminder" },
  "dashboard": { "totalBalance": "Total Account Balance", "netWorth": "Net Worth", "monthlyIncome": "Monthly Income", "monthlyExpense": "Monthly Expense", "netIncome": "Net Income", "cashFlowTrend": "Cash Flow Trend", "accountBalanceOverTime": "Account Balance Over Time", "incomeVsExpense": "Income vs Expense", "fxRateUpdated": "FX rate updated", "fxRateFallback": "using a recent cached rate — live rate unavailable", "fxUnavailable": "FX rate unavailable", "expenseByCategory": "Expense by Category", "accountDistribution": "Account Balance Distribution", "recentTransactions": "Recent Transactions", "upcomingReminders": "Upcoming Reminders", "debtLoanOverview": "Debt / Loan Overview", "savingsGoals": "Savings Goals", "nothingDueSoon": "Nothing due soon." },
  "reports": { "income": "Income", "expense": "Expense", "netIncome": "Net Income", "byCategory": "By Category", "byAccount": "By Account", "exportFiltered": "Export filtered (.xlsx)", "exportFull": "Export full data (.xlsx)", "periods": { "day": "Day", "week": "Week", "month": "Month", "quarter": "Quarter", "year": "Year" } },
  "settings": { "profileTitle": "Profile", "name": "Name", "changePasswordTitle": "Change password" }
}
```

- [ ] **Step 2: Full worked example — server component page (Login)**

`app/(auth)/login/page.tsx`:
```tsx
import { getTranslations } from 'next-intl/server'
import { LoginForm } from '@/components/auth/login-form'

export default async function LoginPage() {
  const t = await getTranslations('auth.login')
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <LoginForm />
    </div>
  )
}
```

- [ ] **Step 3: Full worked example — client component form (LoginForm)**

`components/auth/login-form.tsx` — replace every literal string:
```tsx
'use client'

import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { loginSchema, type LoginInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoginForm() {
  const t = useTranslations('auth.login')
  const router = useRouter()
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } =
    useForm<LoginInput>({ resolver: zodResolver(loginSchema) })

  async function onSubmit(values: LoginInput) {
    const { error } = await authClient.signIn.email({ email: values.email, password: values.password })
    if (error) {
      setError('root', { message: t('invalidCredentials') })
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm">{t('email')}</label>
        <Input id="email" type="email" {...register('email')} />
        {errors.email && <p className="text-sm text-negative">{errors.email.message}</p>}
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm">{t('password')}</label>
        <Input id="password" type="password" {...register('password')} />
        {errors.password && <p className="text-sm text-negative">{errors.password.message}</p>}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>{isSubmitting ? t('submitting') : t('submit')}</Button>
      <a href="/forgot-password" className="text-sm text-accent underline">{t('forgotPassword')}</a>
    </form>
  )
}
```
Note this same step also adds a real `<label htmlFor>` for each input — Task 3 covers the accessibility rationale in depth, but doing it together with the i18n pass here avoids touching the same JSX twice.

- [ ] **Step 4: Apply the identical pattern to every remaining page/component**

Apply exactly the transformation shown in Steps 2–3 (import the right translation hook for server vs. client components, replace every literal string with a `t('key')` call against the namespaces defined in Step 1, add a `<label htmlFor>` for every input) to each of the following. This is a mechanical repetition of one already-fully-specified pattern, not a set of new decisions:

- `app/(auth)/register/page.tsx` + `components/auth/register-form.tsx` (`auth.register`)
- `components/auth/forgot-password-form.tsx` + `app/(auth)/forgot-password/page.tsx` (`auth.forgotPassword`)
- `components/auth/reset-password-form.tsx` + `app/(auth)/reset-password/[token]/page.tsx` (`auth.resetPassword`)
- `components/settings/change-password-form.tsx`, `components/settings/profile-form.tsx`, `app/(app)/settings/page.tsx` (`auth.changePassword`, `settings`)
- `components/layout/app-shell.tsx` (`nav`)
- `components/accounts/account-form.tsx`, `components/accounts/account-list.tsx`, `app/(app)/accounts/page.tsx` (`accounts`)
- `components/transactions/transaction-form.tsx`, `components/transactions/transaction-list.tsx`, `app/(app)/transactions/page.tsx` (`transactions`)
- `components/transfers/transfer-form.tsx`, `app/(app)/transfers/page.tsx` (`transfers`)
- `components/categories/named-list-manager.tsx`, `app/(app)/categories/page.tsx` (`common`, `nav.categories`)
- `components/budgets/budget-form.tsx`, `components/budgets/budget-progress-card.tsx`, `app/(app)/budgets/page.tsx` (`budgets`)
- `components/dashboard/*.tsx`, `app/(app)/dashboard/page.tsx` (`dashboard`)
- `app/(app)/reports/page.tsx`, `components/reports/period-filter.tsx` (`reports`)
- `components/reminders/reminder-form.tsx`, `components/reminders/occurrence-list.tsx`, `app/(app)/reminders/page.tsx` (`reminders`)
- `components/goals/goal-form.tsx`, `components/goals/goal-progress-card.tsx`, `app/(app)/goals/page.tsx` (`goals`)
- `components/debts/debt-form.tsx`, `components/debts/debt-payment-form.tsx`, `app/(app)/debts/page.tsx` (`debts`)
- `components/loans/loan-form.tsx`, `components/loans/loan-payment-form.tsx`, `app/(app)/loans/page.tsx` (`loans`)

Add any message key discovered as missing during this sweep to both `messages/vi.json` and `messages/en.json` together — never add a key to one file without its counterpart, so neither locale ever falls back silently for a key the other has.

- [ ] **Step 5: Verification sweep for stragglers**

```bash
npx grep -rn --include="*.tsx" -E '>[A-Z][a-z]+ [a-z]+' app components | grep -v "t('" 
```
This is an imperfect heuristic (it flags capitalized multi-word text in JSX) — manually review its output rather than trusting it fully, and separately click through every page in both `vi` and `en` (toggle via `/settings`) confirming no English string leaks into the Vietnamese view and vice versa.

- [ ] **Step 5a: Fix Phase 1's `e2e/auth.spec.ts`, which this task's own change breaks**

Phase 1's auth E2E test was written against hardcoded English JSX (before this task's i18n sweep existed) and asserted things like `page.getByPlaceholder('Name')` and `page.getByRole('button', { name: 'Create account' })`. Now that this task makes Vietnamese the default, those selectors no longer match — this task is what breaks that test, so this task fixes it, rather than leaving a red suite for a later phase to discover. Update `e2e/auth.spec.ts`'s selectors to be locale-agnostic (regex alternating the Vietnamese and English strings, e.g. `page.getByPlaceholder(/email/i)`, `page.locator('form button[type="submit"]')` instead of matching by English button text) — apply the same pattern already used for the register/login flow in `e2e/i18n.spec.ts` (written in Phase 8, but the pattern — match structurally or with a vi/en regex alternation, never bare English text — is the one to reuse here too, applied now since this is where the breakage originates).

Run `npx playwright test e2e/auth.spec.ts` and confirm it passes against the now-Vietnamese-by-default app.

- [ ] **Step 6: Commit**

```bash
git add messages app components e2e/auth.spec.ts
git commit -m "feat: extract all UI strings into vi/en message files"
```

---

## Task 3: Accessibility — labels, focus states, contrast

**Files:**
- Verify: every form component touched in Task 2 (labels were already added there)
- Modify: `app/globals.css` (focus-visible styling)

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new — this task closes out what Task 2 started and adds what it didn't cover

- [ ] **Step 1: Confirm every input has a real label, not just a placeholder**

Task 2 Step 3 already added `<label htmlFor>` to `LoginForm` as part of its worked example, and Step 4 asked for the same on every other form. Grep for any input still relying on placeholder alone:
```bash
npx grep -rn "placeholder=" components | grep -v "htmlFor"
```
For every match, confirm a sibling `<label htmlFor="...">` exists (the grep alone can't prove this — it only flags files worth opening). Fix any that were missed during Task 2.

- [ ] **Step 2: Visible focus states**

In `app/globals.css`, add (if shadcn's defaults don't already cover it — check first, since shadcn primitives typically ship reasonable focus rings):
```css
:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
}
```

- [ ] **Step 3: Contrast check**

Using the browser's accessibility inspector (or an online contrast checker) on both light and dark themes, verify: body text on background, `text-negative`/`text-positive`/`text-warning` on their surfaces, and button text on the brand-colored button background all meet at least WCAG AA (4.5:1 for normal text, 3:1 for large text/UI components). If any combination fails, adjust that specific CSS variable's lightness slightly — do not change the documented hex values wholesale, just nudge lightness enough to pass, and note which token changed and by how much.

- [ ] **Step 4: Keyboard navigation pass**

Manually tab through the Login page, the Transaction form, and the Dashboard's nav — confirm every interactive element (inputs, buttons, nav links, the mobile Add-Transaction action) is reachable via Tab in a sensible order and shows a visible focus indicator.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css components
git commit -m "fix: ensure accessible labels, focus states, and contrast across the app"
```

---

## Task 4: Responsive verification pass

**Files:** none (verification-only task; fixes are applied inline wherever found, to whichever component needs it)

**Interfaces:** none

- [ ] **Step 1: Click through every page at mobile width (375px) and tablet width (768px)**

Run `npm run dev`, use browser devtools device emulation. For each of: `/login`, `/register`, `/dashboard`, `/transactions`, `/transfers`, `/accounts`, `/categories`, `/budgets`, `/reminders`, `/goals`, `/debts`, `/loans`, `/reports`, `/settings` — confirm:
- No horizontal scroll on the page body.
- The bottom mobile nav (from Phase 4) doesn't overlap page content (the `pb-20` on the content wrapper should already handle this — verify it actually does on every page, not just the dashboard).
- Every chart (Recharts `ResponsiveContainer`) shrinks to fit rather than overflowing.
- Every table/list wraps or scrolls horizontally within its own container rather than the whole page.
- Forms remain usable — inputs full-width, buttons reachable without zooming.

- [ ] **Step 2: Fix any issues found**

For each issue found in Step 1, apply the minimal Tailwind class fix (e.g., add `overflow-x-auto` to a wide table's wrapper, adjust a flex/grid breakpoint) directly in the affected component. There's no way to enumerate these in advance since they depend on what Step 1 actually finds — fix them as found, don't defer.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: resolve responsive layout issues found during the mobile/tablet verification pass"
```

---

## Phase 7 Acceptance Check

- [ ] Changing locale or theme in Settings takes effect immediately on the next page load, in both directions (vi↔en, light↔dark).
- [ ] No hardcoded UI string remains outside `messages/vi.json`/`en.json` (verified by the Task 2 grep sweep and manual click-through in both locales).
- [ ] Every form input has a real `<label htmlFor>`, not just a placeholder.
- [ ] Text and interactive elements meet WCAG AA contrast in both themes.
- [ ] Every page works at 375px and 768px widths with no horizontal overflow.
- [ ] `npm run test`, `npm run lint`, and `npm run build` all succeed.
