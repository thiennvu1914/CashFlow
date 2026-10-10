# CashFlow Latency Fixes (Group A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the time between a click and the updated UI in the live app (Render Free in Singapore → Supabase in Sydney, ~100 ms per DB round trip) without changing any financial behaviour.

**Architecture:** Every task removes waiting, not features: fewer sequential DB round trips per request, no duplicate server renders, warm DB connections, a session cookie cache, streamed/lazy UI so the first useful pixels arrive before slow sections, and smaller client payloads. No schema migrations. Each task is one commit.

**Tech Stack:** Next.js 16.3.4 (App Router, Turbopack; read `node_modules/next/dist/docs/` before asserting any Next API), React 19.2, Prisma 7.10 WASM client + `@prisma/adapter-pg` 7.10 + `pg` 8.23, Better Auth 1.7.2, next-intl 4.14, zod 4.5.4, recharts 3.10, Vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (financial invariants) and the 2026-10-10 audit findings summarised per task below. Owner approvals (2026-10-10): Group A approved as a whole; Better Auth session cookie cache approved with the trade-off that sign-out/password-reset revocation on other devices lags by up to the cache max-age.

## Global Constraints

- Work on branch `fix/web-fixes-2026-10` in `E:\Github\CashFlow`. Never push. Never switch branches. Stage only the files your task names (`git add <paths>`, never `git add -A`).
- **The local `.env` `DATABASE_URL` is the PRODUCTION Supabase database.** Never run `npm run dev`, `next start`, `node scripts/start-standalone.mjs`, any `prisma migrate|db|studio` command, or `npm run demo:*` with the default env. Vitest is safe (it uses `cashflow_test` on local Docker, port 5439). Playwright is safe only when run as: `E2E_DATABASE_URL="postgresql://cashflow:cashflow_dev_password@localhost:5439/cashflow_e2e" CI=1 npx playwright test <spec>` (its config overrides `DATABASE_URL` for the server it spawns). Check port 3000 is free first.
- Before every commit run, in order: `npm run format:check`, `npm run lint`, `npm run test`, `npm run build` — all must pass. If exactly one DB-backed test times out under load and passes when its file is re-run alone, re-run that file and note it; anything else is a real failure.
- Financial invariants (never weaken): no stored account balance — always derived from Transaction + Transfer; money is Prisma `Decimal`, never Float; `Transaction.amount ≥ 0`, sign only from `type`; every Transaction snapshots `vndPerUsdAtEntry`/`fxRateFetchedAt`/`fxRateEffectiveAt`/`fxRateSource` via the real FX policy — never a fabricated rate; `historicalAmountIn()` is the only historical conversion; every query scoped by the session `userId` via `requireUser()`; every `(app)` page calls `requireUserOrRedirect()`.
- Match the surrounding code's comment density and style (this repo explains *why* in comments). Commit messages: Conventional Commits, detailed body explaining what changed and why, ending with the session's attribution trailer if one is provided.
- Design: the owner kept the current redesign look (2026-10-10) — do not restyle anything in these tasks.

---

### Task 1: Remove redundant `router.refresh()` after server actions

**Why:** Next 16 re-renders the current route inside the server-action response whenever the action calls `revalidatePath`/`updateTag`/`refresh`, mutates cookies, or redirects (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md` § "A single response carries data and UI"). A client `router.refresh()` afterwards renders the whole page a second time — ~4–7 extra DB round trips per click on the 0.1-CPU instance.

**Files (call sites; verify each):**
- Modify: `components/accounts/account-edit-form.tsx:99`, `account-form.tsx:74`, `account-list.tsx:112`
- Modify: `components/budgets/budget-form.tsx:111`, `budget-row-actions.tsx:57,131`
- Modify: `components/debts/debt-form.tsx:74`, `debt-row-actions.tsx:132,227,341`
- Modify: `components/goals/goal-form.tsx:64`, `goal-row-actions.tsx:117,187,264`
- Modify: `components/loans/loan-edit-form.tsx:73`, `loan-form.tsx:81`, `loan-payment-form.tsx:100`, `loan-row-actions.tsx:141`
- Modify: `components/reminders/occurrence-actions.tsx:80`, `reminder-form.tsx:186`, `reminder-toggle.tsx:42`
- Modify: `components/settings/profile-form.tsx:112`
- Modify: `components/transactions/transaction-form.tsx:287`, `transaction-list.tsx:112`
- Modify: `components/transfers/transfer-form.tsx:176`, `transfer-list.tsx:88`
- Tests to update: the matching `*.test.tsx` files that assert `refresh` was called (`account-form`, `account-list`, `budget-form`, `debt-form`, `goal-form`, `loan-form`, `reminder-form`, `profile-form`, `transaction-form`, `transfer-form`).
- **Out of scope — leave unchanged:** `app/(app)/error.tsx:20`, `app/global-error.tsx:48` (retry buttons), and `components/auth/*` (login/register/reset/logout go through the Better Auth client over HTTP, not server actions).

- [ ] **Step 1:** For each call site, open the server action it calls (`lib/server/actions/*-actions.ts`) and confirm the success path calls `revalidatePath(...)` (any path), `refresh()`, sets/deletes a cookie, or `redirect()`s. Record the evidence (action name → line) in your report. If an action does none of these, keep that site's `router.refresh()` and say so.
- [ ] **Step 2:** Update the tests first: replace "calls router.refresh on success" expectations with `expect(refresh).not.toHaveBeenCalled()` (keep every other assertion — reset, onCreated/onDone callbacks, closing dialogs, error display). Run `npx vitest run components/` → the updated tests FAIL.
- [ ] **Step 3:** Remove the `router.refresh()` calls (and the now-unused `useRouter`/`router` variables and imports). Keep every other success-side effect in the same order.
- [ ] **Step 4:** `npx vitest run components/` → PASS. Then run the freshness-sensitive e2e specs with the safe Playwright command from Global Constraints: `e2e/phase2.spec.ts`, `e2e/phase4.spec.ts`, `e2e/phase5.spec.ts`, `e2e/phase6.spec.ts` (use `ls e2e` to confirm names; run every spec that creates/edits/deletes then asserts the list updates). All must pass.
- [ ] **Step 5:** Full pre-commit checks, then commit, e.g. `perf(ui): drop router.refresh after revalidating server actions`.

### Task 2: Keep database connections warm (pg pool tuning)

**Why:** `lib/prisma.ts:20` passes only a connection string, so pg-pool defaults apply (`node_modules/pg-pool/index.js:89-100`: `max` 10, `idleTimeoutMillis` 10000, no connect timeout). A user who pauses >10 s between clicks pays a fresh TCP+TLS+Supavisor handshake (~3–4 round trips to Sydney) on every connection the next request fans out to.

**Files:**
- Modify: `lib/prisma.ts`
- Test: `lib/prisma.test.ts` (create if absent) — or extend the existing prisma/env test if there is one (`ls lib/*.test.ts`).

**Interfaces:** Produces an exported `PRISMA_POOL_OPTIONS` constant (object) so the test can assert values without a database.

- [ ] **Step 1: failing test** — assert `PRISMA_POOL_OPTIONS` equals `{ max: 6, idleTimeoutMillis: 300_000, connectionTimeoutMillis: 5_000, keepAlive: true }` (import from `@/lib/prisma`; mock `@/lib/server/env` if importing constructs the client).
- [ ] **Step 2:** Run it → FAIL (not exported).
- [ ] **Step 3:** Implement:

```ts
/**
 * pg-pool settings for one long-lived Node process talking to Supabase's
 * session-mode pooler in another region. The defaults (10 connections, closed
 * after 10 s idle, no connect timeout) made every click after a short pause
 * re-handshake TCP+TLS+auth across the Singapore→Sydney link.
 * `max` stays well under the Supavisor session pool; `connectionTimeoutMillis`
 * turns an unreachable database into a fast error instead of a hung request.
 */
export const PRISMA_POOL_OPTIONS = {
  max: 6,
  idleTimeoutMillis: 300_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
} as const

// in createPrismaClient():
return new PrismaClient({
  adapter: new PrismaPg({ connectionString, ...PRISMA_POOL_OPTIONS }),
})
```

Confirm `PrismaPg` accepts a `pg.PoolConfig` (`node_modules/@prisma/adapter-pg/dist/index.d.ts:42`) and that these keys exist on `pg.PoolConfig` (`node_modules/@types/pg` or `pg` typings). Do not add `statement_timeout` in this task.
- [ ] **Step 4:** Test → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Full pre-commit checks, commit `perf(db): keep pooled Supabase connections warm`.

### Task 3: Better Auth session cookie cache

**Why:** `lib/auth/create-auth.ts:126-266` configures no `session.cookieCache`, so `getOptionalSession()` (`lib/auth/require-user.ts`) costs a session read plus a user read on every page render and every server action (actions run outside React render, so `React.cache` cannot share the lookup with the re-render). Owner approved the revocation lag trade-off.

**Files:**
- Modify: `lib/auth/create-auth.ts` (add `session.cookieCache`, and the `nextCookies()` plugin from `better-auth/next-js` so server actions can write the refreshed cookie — verify the export path in `node_modules/better-auth/package.json` `exports`)
- Modify: the profile update server action (`grep -rn "updateProfile" lib/server/actions`) so that after a successful update it refreshes the cached session data (Better Auth 1.7.2: call `auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } })` — verify the option name in `node_modules/better-auth/dist` before using it). Without this, locale/theme/baseCurrency/timezone would stay stale for up to max-age.
- Test: `lib/auth/*.test.ts` (existing suites call `createAuth` with an in-memory adapter) — add a test that two `getSession` calls with the cookie returned by sign-in hit the adapter's session lookup only once; add a test for the profile action refresh if the action has a test file.

- [ ] **Step 1:** Read Better Auth 1.7.2's cookie-cache implementation (`grep -rn "cookieCache" node_modules/better-auth/dist --include=*.mjs | head`) and note: option shape, cookie name, how `getSession` validates it, `disableCookieCache`, interaction with `revokeSessionsOnPasswordReset`.
- [ ] **Step 2:** Write the failing test(s) described above; run → FAIL.
- [ ] **Step 3:** Configure:

```ts
session: {
  // Owner-approved trade-off (2026-10-10): a signed cookie caches the session
  // and user for 5 minutes so page renders and server actions skip two
  // sequential DB reads across the Singapore→Sydney link. The cost: a session
  // revoked elsewhere (sign-out on another device, password reset) stays
  // usable on a device that still holds a fresh cache cookie for up to 5 min.
  cookieCache: { enabled: true, maxAge: 5 * 60 },
},
plugins: [nextCookies()],
```

Keep `nextCookies()` as the last plugin (Better Auth requirement — verify in its docs/source). Then add the profile-action refresh.
- [ ] **Step 4:** Tests → PASS. Run `e2e/auth.spec.ts` and the settings/profile e2e spec (`grep -ln "settings" e2e/*.spec.ts`) with the safe Playwright command: sign-in, sign-out, password reset, locale/theme change must all behave as before (theme/locale change visible immediately after saving).
- [ ] **Step 5:** Full pre-commit checks, commit `perf(auth): cache sessions in a signed cookie`.

### Task 4: FX lookups off the critical path

**Why:** Every create and every multi-currency page reads today's rate row from the DB (`lib/currency/fx-service.ts:109-111`) although that row never changes once written; the provider call waits up to 10 s (`lib/currency/open-er-api-provider.ts:37`) and nothing remembers a failure, so during an outage every create stalls 10 s before the fallback (`lib/currency/current-rate-policy.ts:114-126`); right after 00:00 UTC the provider still reports yesterday, so each request re-fetches until it rolls over (`fx-service.ts:88-94`).

**Files:**
- Modify: `lib/currency/fx-service.ts`, `lib/currency/open-er-api-provider.ts`, `lib/currency/current-rate-policy.ts`
- Tests: the existing FX tests next to them (`ls lib/currency/*.test.ts`).

**Rules (invariants):** results must be byte-identical to what the uncached path returns — same `rate`, `effectiveDate`, `fetchedAt` (never `new Date()` substituted), same `source`; a fallback is still tagged `cache-fallback:<source>` and logged `fx.live_rate_fallback`; nothing fabricates a rate. The memo is per process and must be resettable for tests (export `resetFxMemoForTests()`), because the FX tests delete `ExchangeRate` rows in `afterEach`. Bypass the memo when a `providerOverride` is passed.

- [ ] **Step 1: failing tests** — (a) two `getLatestRate` calls on the same UTC day with a cached row perform one DB read (spy on the query or count provider/DB calls via the existing test seams); (b) when the provider returns an `effectiveDate` earlier than today, a second call within 10 minutes does not call the provider again and returns the same `fetchedAt`; (c) after a provider failure, `getUsableCurrentRate` within 60 s goes straight to `getLastKnownGoodCurrentRate` without calling the provider; (d) provider fetch uses a 3 s timeout.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: a module-level `Map<string, { result: CachedRateResult; expiresAt: number }>` keyed `${base}/${quote}/${utcDayIso}` — a DB-cache hit for *today* is memoised until the end of that UTC day; a provider result whose effective day is *before* today is memoised for 10 minutes; a failure memo `Map<pairKey, number>` (until-timestamp, 60 s) consulted by `getUsableCurrentRate` before calling `getLatestRate`. Change `AbortSignal.timeout(10_000)` to `3_000` and update the comment.
- [ ] **Step 4:** `npx vitest run lib/currency` → PASS (run it alone — FX tests race if two suites run concurrently).
- [ ] **Step 5:** Full pre-commit checks, commit `perf(fx): memoise today's rate and fail fast on provider outages`.

### Task 5: Run independent queries in parallel; drop unused relation reads

**Why:** Prisma's interpreter runs `include`d relations as a second sequential round trip, and several loaders `await` one query before starting an independent one. Each removed hop is ~100 ms on every load.

**Files / changes (verify each line before editing):**
- `lib/server/services/position.ts:204-215`, `lib/server/services/account-overview.ts:24-34`, `lib/server/services/dashboard.ts:29-37` — start the debt/loan reads concurrently with the accounts + balance-timeline reads (`Promise.all`), keeping the same calculators.
- `lib/server/services/budget.ts:339-342` (`getBudgetProgressForMonth`) — load budgets and expense rows with `Promise.all`.
- `app/(app)/transactions/page.tsx:85` — the balances call waits for the account list; fold it so balances come from one call that does not need the awaited accounts list first (e.g. a `getAccountBalancesForUser(userId, now)` in `lib/server/services/balance.ts` built on the existing single-SQL balance timeline, then join by id). Keep `Decimal` end to end.
- `lib/server/services/financial-account.ts:215` — the `include: { accountType }` is unused by the transaction/transfer/reminder pickers; add a picker-specific `select` (or a separate lean function) that skips the relation, used by those pickers only.
- Do **not** move activity/budget totals into SQL — `historicalAmountIn()` must remain the only historical conversion.
- Tests: existing service tests (`lib/server/services/*.test.ts`) must stay green unchanged in their expectations; add a test for any new function (e.g. `getAccountBalancesForUser` returns the same values as `getAccountBalancesForAccounts` for the same user).

- [ ] **Step 1:** Write the failing test(s) for new functions; run → FAIL.
- [ ] **Step 2:** Make the changes above, one file at a time, running that file's tests after each.
- [ ] **Step 3:** `npx vitest run lib/server` → PASS.
- [ ] **Step 4:** Full pre-commit checks, commit `perf(server): parallelise independent loader queries`.

### Task 6: Show the "Thêm giao dịch" form before the ledger

**Why:** The global add button links to `/transactions#new` (`components/layout/nav-items.ts:77`, `mobile-nav.tsx:99`). `app/(app)/transactions/page.tsx` awaits the 200-row `listTransactions` and the month summary before rendering anything, so the form appears only after the slowest query.

**Files:**
- Modify: `app/(app)/transactions/page.tsx`
- Create: `components/transactions/transaction-ledger-section.tsx` (async server component that loads `listTransactions` + monthly summary and renders `TransactionList`)
- Possibly modify: `components/transactions/transaction-create-panel.tsx` if the provider needs the list split from the panel.
- Tests: `app/(app)/transactions/*.test.tsx` if present; e2e transaction specs.

- [ ] **Step 1:** Read `node_modules/next/dist/docs/01-app/01-getting-started/` streaming/Suspense guide (find with `grep -rln "Suspense" node_modules/next/dist/docs/01-app | head`).
- [ ] **Step 2:** Restructure: the page awaits only what the create panel needs (session, accounts, categories, balances); the ledger and the month-total description move into `<Suspense fallback={<list skeleton reusing components/common/page-skeleton.tsx pieces>}>` around the new async `TransactionLedgerSection`. The header description that needs the month total can move into the section or get its own small Suspense boundary. Preserve the empty-state (no accounts) branch and the 7/12 + 5/12 grid.
- [ ] **Step 3:** Update/add tests; run `npx vitest run components/transactions app` → PASS; run the transaction e2e specs (safe command) → PASS, including the `#new` deep link opening the create panel/sheet.
- [ ] **Step 4:** Full pre-commit checks, commit `perf(transactions): stream the ledger behind the create form`.

### Task 7: Snappier transaction list (formatter cache, optimistic delete)

**Why:** 200 client rows each own a Base UI menu; delete state lives in the list (`components/transactions/transaction-list.tsx:84-85`) so every dialog/pending change re-renders every row; `lib/ui/format-date.ts:89` builds a new `Intl.DateTimeFormat` on every call.

**Files:**
- Modify: `lib/ui/format-date.ts` (cache formatters in a `Map` keyed by locale+options+timeZone, like `lib/ui/format-money.ts` already does)
- Modify: `components/transactions/transaction-list.tsx` (move the confirm dialog + its state into a sibling component; `memo` the row component; `useOptimistic` to hide the deleted row immediately and restore it with the error message if the action fails)
- Tests: `lib/ui/format-date.test.ts`, `components/transactions/transaction-list.test.tsx`

- [ ] **Step 1: failing tests** — format-date returns identical strings for repeated calls and constructs one `Intl.DateTimeFormat` per (locale, options, tz) (spy on the constructor); the list hides a row as soon as delete is confirmed and shows it again plus the error when the action returns `{ ok: false }`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Tests + transaction e2e (safe command) → PASS.
- [ ] **Step 5:** Full pre-commit checks, commit `perf(transactions): cache date formatters and delete optimistically`.

### Task 8: Dashboard — lazy charts and streamed sections

**Why:** five recharts charts are imported eagerly (409 KB raw chunk) and the whole page awaits `getDashboardData` (`app/(app)/dashboard/page.tsx:85`); there is no `Suspense` in the repo.

**Files:**
- Create: `components/dashboard/lazy-charts.tsx` (`'use client'`; `next/dynamic(() => import(...), { ssr: false, loading: () => <fixed-height skeleton> })` for each chart component in `components/dashboard/*-chart.tsx`)
- Modify: `app/(app)/dashboard/page.tsx` to import charts from `lazy-charts.tsx`; if the data loader allows, split KPI data from chart data and wrap the chart region in `<Suspense>`.
- Tests: dashboard component tests; `e2e` dashboard specs.

- [ ] **Step 1:** Confirm chart heights are fixed (no layout shift) and that `ResponsiveContainer` renders nothing meaningful on the server today.
- [ ] **Step 2:** Implement lazy wrappers with skeletons of the same height; keep `var(--color-…)` chart tokens untouched.
- [ ] **Step 3:** Tests + dashboard e2e (safe command) → PASS. Compare `/dashboard` client JS before/after from the build output and report the numbers.
- [ ] **Step 4:** Full pre-commit checks, commit `perf(dashboard): lazy-load charts`.

### Task 9: Loading skeletons for the three routes without one

**Why:** `/categories`, `/goals`, `/settings` have no `loading.tsx`, so a click shows nothing until the server answers and the links are not prefetched (`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`).

**Files:**
- Create: `app/(app)/categories/loading.tsx`, `app/(app)/goals/loading.tsx`, `app/(app)/settings/loading.tsx` — same shape as `app/(app)/budgets/loading.tsx`:

```tsx
import { PageSkeleton } from '@/components/common/page-skeleton'

export default function Loading() {
  return <PageSkeleton rows={4} />
}
```

(pick `rows` to resemble each page.)
- Optional in the same task: a pending indicator on sidebar links via `useLinkStatus` (check it exists in `node_modules/next/dist/docs`) in the rail link component (`grep -rn "RailLink" components/layout`).
- [ ] Steps: add files → `npm run build` shows the routes → shell/nav tests pass → full checks → commit `perf(nav): add loading skeletons for categories, goals and settings`.

### Task 10: Right-size brand images

**Why:** `app/icon.png` is 310 KB at 1254²; `public/brand/cashflow-mark.png` (310 KB) is shown at 48 px (`components/layout/app-shell.tsx:60`, `mobile-nav.tsx:41`); `public/brand/cashflow-logo.png` (339 KB, 2172 px wide) is shown at ~188 px (`app/(auth)/layout.tsx:43`) and embedded in every reset email (`lib/email/send-reset-password-email.ts:94`). sharp resizes them on 0.1 CPU and its cache is wiped on every spin-down.

**Files:**
- Modify (binary): `app/icon.png` → 64×64; `public/brand/cashflow-mark.png` → 2× its largest display size; `public/brand/cashflow-logo.png` → 2× its display width (≈ 400 px). Keep file names and aspect ratios so no references change. Use a one-off script in the session scratchpad (not in the repo) with the `sharp` package already in `node_modules`, PNG output with palette/compression.
- Add `apple-icon.png` (180×180) only if `app/` has none and Next's metadata docs recommend it.
- Remove leftover create-next-app assets only if unreferenced: `public/{file,globe,next,vercel,window}.svg`, `public/cashflow-transparent.png` (grep the repo first).
- [ ] Steps: record before/after sizes → resize → run the e2e branding/shell checks (`grep -ln "logo\|brand" e2e/*.spec.ts`) → full checks → commit `perf(assets): ship right-sized brand images`.

### Task 11: Trim zod from client bundles

**Why:** chunk `3pg9mkvl7z2i1.js` (412 KB raw / 95 KB gz) is zod 4.5.4 including all 63 locales (`node_modules/zod/v4/classic/external.js:13` `export * as locales`), loaded on 12 of 16 routes including `/login`; forms stay disabled until hydration (`lib/ui/use-hydrated.ts`).

**Files:** `lib/validation/*.ts` (client-imported schemas), possibly `next.config.ts`.

- [ ] **Step 1:** Measure the baseline: after `npm run build`, list the chunk sizes containing zod (`grep -l "zod" .next/static/chunks/*.js | xargs ls -la`).
- [ ] **Step 2:** Try, in order, keeping only the first that measurably shrinks the client chunk without changing validation messages: (a) `import * as z from 'zod/v4/core'`-free approach — named imports / `import { z } from 'zod/v4'` variants that let Turbopack drop `locales`; (b) `zod/mini` for the client-side schemas with identical rules and messages; (c) `experimental.optimizePackageImports: ['zod']` in `next.config.ts` (check the docs for Turbopack support).
- [ ] **Step 3:** Validation-message tests (`lib/validation/*.test.ts`, form tests) must pass unchanged. Report before/after gzip sizes. If no option gives a real (>30 KB gz) win without behaviour change, revert everything and report "no change" — do not commit.
- [ ] **Step 4:** Full pre-commit checks, commit `perf(client): keep zod locales out of client bundles`.
