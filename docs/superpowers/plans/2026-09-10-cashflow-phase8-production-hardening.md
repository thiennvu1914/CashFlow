# CashFlow Phase 8 — Production Hardening Implementation Plan (Wave 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CashFlow repository comfortable for an experienced engineer to own, review, deploy and maintain — a production-ready MVP, not enterprise cosplay. Wave 1 is senior-engineering cleanup only; Waves 2 (security + DevOps) and 3 (production certification) are appended after the owner approves Wave 1.

**Architecture:** Next.js 16 App Router + React 19, Prisma 7 (WASM client + PrismaPg adapter) on PostgreSQL, Better Auth, next-intl, Tailwind v4, Vitest (real Postgres `cashflow_test`), Playwright (webServer spawns `next dev`). Wave 1 changes no schema, no financial formula, no auth semantics; it removes proven dead code, centralises the client mutation-submission pattern, trims evidence-backed query waste, and makes the test harness safe and shared.

**Tech Stack:** unchanged. Node contract narrowed to what Prisma 7 supports.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (financial invariants, tenant isolation, i18n, export contract) plus the pre-flight audit findings in the plan workspace `.superpowers/sdd/2026-09-10-cashflow-phase8-production-hardening/preflight/{A..F}-*.md` (git-ignored; evidence with file:line for every finding referenced below).

## Global Constraints

- Owner rulings (final for Phase 8): no delete/correction/reversal flows for debt or loan payments (payment history immutable; `nextDueDate` semantics untouched); demo seed/clear is Wave 2; vendor-neutral (no Railway/Render/Fly-specific code); registration enumeration copy is later security work; mutation-handler cleanup uses ONE shared helper/hook, migrated incrementally in focused, tested commits — never a single 26-file rewrite.
- Frozen: account-balance and Net Worth formulas, transaction/transfer semantics, FX snapshot/current-position semantics, budget/savings/debt/loan math, reminder recurrence/timezone anchoring, report range semantics, the Excel workbook contract (11 sheets, English maps), tenant isolation (`requireUser()` everywhere, composite `(userId, id)` FKs), auth/session security semantics, Prisma schema and migrations (no new migration in Wave 1).
- Wave 2 boundary — do NOT implement in Wave 1: validated env module, secret validation, security headers, CSP, secure preference cookies, rate-limit `NODE_ENV` gate, `/api/health`, structured logging, `instrumentation.ts`/`onRequestError`, Dockerfile, `.dockerignore`, standalone output, `db:deploy`, GitHub Actions, demo scripts, backup/restore or deployment docs, pg pool tuning, Playwright worker count, index migrations, a generic `deleteUserData` service.
- Stop rule: STOP the wave if financial semantics, tenant isolation or auth/session semantics appear to change; if a "mechanical" refactor creates broad architectural uncertainty; if a query change alters financial results; if a test optimisation creates nondeterminism; or if a reviewer finds a P0/P1 regression that cannot be fixed locally.
- Execution: inspect → targeted tests → implement → targeted verification → independent review (required for Tasks 3, 4, 5) → fix important findings → focused commit. One writer at a time; reviewers never mutate. Full matrix only at the frozen Wave 1 HEAD. No test weakening: retries 0, no skips, no arbitrary waits, no loosened assertions.
- Repo rules (AGENTS.md): npm only; `app/`, `components/`, `lib/`, `prisma/` at root; `@/*` alias; never commit `.env*` except `.env.example`; Prisma via `migrate dev` never `db push`; Tailwind v4 oklch tokens; shadcn base-nova with `@base-ui/react`.
- Copy changes go through next-intl keys in both `messages/vi` and `messages/en` (parity test `lib/i18n/messages.test.ts`), and any stale `e2e/` selector is migrated in the same commit.

---

### Task 1: Install and dependency correctness

**Files:**
- Modify: `package.json` (scripts, engines, dependency classes), `package-lock.json`
- Create: `.nvmrc`
- Test: fresh-install verification (commands below), `npx tsc --noEmit`, `npx vitest run lib/server/export lib/ui/format-money.test.ts`

**Pre-flight evidence:** E1 (no `postinstall`, `npm ci` leaves no Prisma client — 45 suites failed to load on main), D "jszip undeclared" (`lib/server/export/test-fixtures.ts:7`), D "shadcn under dependencies" (`package.json:38`), E11 (`engines >=20` admits Node versions Prisma 7 rejects: `^20.19 || ^22.12 || >=24`).

- [ ] **Step 1 (D1):** Add a standard lifecycle step so `npm ci` produces a usable Prisma client — `"postinstall": "prisma generate"` — and confirm it is compatible with Prisma 7 + `prisma7.config.ts` (the CLI reads `dotenv/config` there; `prisma generate` must not require a reachable database). Keep `build` as `prisma generate && next build` only if still needed; do not duplicate work needlessly — decide and record why.
- [ ] **Step 2 (D2):** Declare `jszip` in `devDependencies` at the exact version currently hoisted (`npm ls jszip`), since only test fixtures import it.
- [ ] **Step 3 (D3):** Confirm `shadcn` is CLI-only (`git grep -n "from 'shadcn"` returns nothing) and move it to `devDependencies`. Generated UI must not change.
- [ ] **Step 4 (D4):** Set `engines.node` to the honest Prisma 7 contract (`^20.19.0 || ^22.12.0 || >=24.0.0`) and add `.nvmrc` with the current major (`node -v`). No version-manager dependency.
- [ ] **Step 5 (D5) — fresh-install proof:** in the worktree, move `node_modules` aside (rename, do not delete, so it can be restored on failure), run `npm ci`, then prove without running `prisma generate` by hand: `ls node_modules/.prisma/client` exists, `npx tsc --noEmit` passes, `npx vitest run lib/server/export lib/ui/format-money.test.ts` passes. Record the exact commands and outputs in the report. Remove the renamed directory afterwards.
- [ ] **Step 6:** `npm run lint`, `npm run format:check`; commit `fix(build): generate Prisma client after install and declare tooling dependencies`.

---

### Task 2: Dead code and error-boundary cleanup

**Files:**
- Modify/Delete: `lib/server/actions/transaction-actions.ts` (`updateTransactionAction`), its test in `lib/server/actions/transaction-actions.test.ts`
- Create: `app/global-error.tsx`, `app/not-found.tsx` (and `app/(app)/not-found.tsx` only if the app-shell layout makes a nested one materially better)
- Modify: `app/globals.css` (`--chart-1..5` ramp) only if proven unconsumed
- Modify: `messages/{vi,en}/errors.json` (or `common.json`) for the new boundary copy
- Test: Vitest for the boundary components (static markup: heading, safe copy, recovery action, no stack trace), `lib/i18n/messages.test.ts` parity, targeted Playwright `e2e/phase7-enum-sweep.spec.ts` + one new not-found e2e case

**Pre-flight evidence:** A-1 (live unused `updateTransactionAction`, `lib/server/actions/transaction-actions.ts:93`), A-2 (only `app/(app)/error.tsx` exists; no `global-error.tsx`, no `not-found.tsx`), A-8 (`--chart-1..5` contradicts `chart-theme.ts`'s four-slot rule).

- [ ] **Step 1 (E1):** Repository-wide search for `updateTransactionAction` (app, components, lib, e2e). If the only non-definition hit is its own test, delete the action and the test cases that exercise it; keep every other test-only service export untouched.
- [ ] **Step 2 (E2):** Add `app/global-error.tsx` (must include its own `<html>`/`<body>`, CashFlow tokens via `globals.css`, a heading, one sentence, a "Try again" (`reset()`) button and a link home; no `error.message`/stack rendered; `error.digest` may be shown as a short reference code) and `app/not-found.tsx` (same visual language, link to `/dashboard` and `/login`). Copy via next-intl where the render path allows it (`global-error` renders outside providers — use `resolveLocale()` server-side or a minimal vi/en literal pair with a comment explaining why); no logging infrastructure (Wave 2).
- [ ] **Step 3 (E3):** `git grep -n "chart-[1-5]\|--chart-"` across app/components/lib/e2e; if the only hits are the token declarations in `globals.css`, remove the ramp declarations and their `@theme` mappings; do not rename any other token.
- [ ] **Step 4:** Targeted tests, lint, format; commit `refactor(errors): remove dead transaction mutation and add product error boundaries` (split the token removal into its own commit if it lands).

---

### Task 3: Mutation submission and error refactor (highest risk; independent review required)

**Files:**
- Inspect first: every client component calling a server action (`git grep -ln "Action(" components app | xargs grep -l "catch"`), `lib/ui/use-submit-state.ts`, `lib/ui/action-error-messages.ts`, `components/common/row-error-context.tsx`, the 8 `mapError` functions in `lib/server/actions/*-actions.ts`
- Create: one small hook (likely `lib/ui/use-action-submit.ts`) + test, and one shared server-side `mapError` tail helper (likely `lib/server/actions/map-action-error.ts`) + test
- Modify: the ~26 client handlers in four groups; the 8 action files' `mapError`
- Test: Vitest for the hook (pending/locked, success path, refused-code path, thrown path preserving `digest`, duplicate-submit guard); targeted Playwright per group

**Pre-flight evidence:** A-3 (26 hand-copied handlers), A-4 (bare `catch {}` logs a fixed string and discards `error.digest`), A-5 (identical 4-line `ZodError`/`P2025`/`throw e` tail in 8 `mapError`s).

- [ ] **Step 1 (F1) — design before migration:** read all handlers and write a one-page design in the report: the hook's signature, what it owns (pending/locked via `useSubmitState`, `aria-busy`, duplicate-submit guard, refused-code → localized key, thrown → generic key + preserved `digest`, optional `onSuccess` for navigation/refresh/close), what it deliberately does not own. No Redux, no global mutation context, no DI, no generic request framework, no Result monads.
- [ ] **Step 2:** TDD the hook (RED → GREEN) in `lib/ui/use-action-submit.test.tsx`, including a test that a thrown error's `digest` is retained on the error state / passed to the caller's error callback.
- [ ] **Step 3 (F3) — migrate group 1:** Transactions / Transfers / Accounts / Categories. Run `npx vitest run components/transactions components/transfers components/accounts components/categories` and `CI=1 npx playwright test e2e/phase7-transactions.spec.ts e2e/phase7-transfers.spec.ts e2e/phase7-accounts-categories.spec.ts e2e/phase7-confirm-dialogs.spec.ts`. Commit.
- [ ] **Step 4 — group 2:** Budgets / Savings goals. Targeted Vitest + `e2e/phase7-budgets-goals.spec.ts`. Commit.
- [ ] **Step 5 — group 3:** Debts / Loans / Reminders. Targeted Vitest + `e2e/phase7-debts-loans.spec.ts e2e/phase7-reminders.spec.ts`. Commit.
- [ ] **Step 6 — group 4:** Settings / Auth / remaining. Targeted Vitest + `e2e/phase7-auth.spec.ts e2e/settings-form-hydration.spec.ts`. Commit.
- [ ] **Step 7 (F4):** centralise the shared `mapError` tail only where the 8 tails are byte-equivalent; keep domain-specific branches in each action. Targeted Vitest `lib/server/actions`. Commit.
- [ ] **Step 8 (F2) — behaviour preservation checklist in the report:** `useHydrated` gate, in-flight locking, `aria-busy`, friendly validation, redirect/navigation, server-action errors, localization, focus, duplicate-submit protection, `digest` preserved. Run `e2e/transaction-form-hydration.spec.ts` and `e2e/phase7-a11y.spec.ts` once at the end of the task.

---

### Task 4: Query and performance cleanup (independent review required)

**Files:**
- Modify: `lib/server/services/reminder.ts` (`materializeDueOccurrences`, `listUpcomingOccurrences`), `lib/server/services/position.ts` (+ callers using `WITH_PAYMENTS` for totals), `lib/server/export/full-export.ts` (or the export context builder that fetches payments twice), `lib/server/services/balance.ts` / `account-balance-history.ts` (repeated ownership reads)
- Test: regression tests written BEFORE each change asserting values and externally meaningful behaviour; a bounded query-count assertion (e.g. "does not grow per reminder") only where it proves the regression

**Pre-flight evidence:** B-3 (one `createMany` per active reminder inside a loop, `reminder.ts:575`), B-6 (`listUpcomingOccurrences` unbounded, `reminder.ts:620`, widget shows 5), B-7 (`WITH_PAYMENTS` arrays fetched and discarded for totals in `position.ts`; full export fetches DebtPayment/LoanPayment twice), B-4 (`getAccountBalanceOverTime` ≈ 25 queries with 6 identical ownership reads via `balance.ts:88`).

- [ ] **Step 1 (G1):** regression tests for materialization semantics (unique `(reminderId, dueAt)`, one-time overdue behaviour, recurrence windows, timezone anchoring, acknowledged/dismissed untouched) → then batch into one `createMany` (or one per frequency group if a single batch is impossible) with `skipDuplicates`; identical rows produced (assert set equality against the old algorithm's output in the test).
- [ ] **Step 2 (G2):** bound `listUpcomingOccurrences` with a `take` that still honours the dashboard's overdue cap + upcoming display max (read the widget's constants; take ≥ overdue cap + display max; ordering unchanged). Test: with more occurrences than the cap, the dashboard set/order is unchanged.
- [ ] **Step 3 (G3):** replace fetched-and-discarded payment arrays with `aggregate`/`groupBy` sums (Decimal) where only totals are needed; outstanding values must equal the previous computation (test both paths on the same fixture).
- [ ] **Step 4 (G4):** deduplicate the full export's second payment fetch by passing the already-fetched rows through the export context; the 11-sheet workbook output must be byte-identical (existing export regression tests + a cell-level comparison test if not already present).
- [ ] **Step 5 (G5):** deduplicate the repeated ownership/account reads in balance history (load once, pass down); historical FX semantics unchanged; values unchanged in existing tests.
- [ ] **Step 6:** targeted Vitest for `lib/server/services`, `lib/server/export`, `lib/ui/dashboard-view-model`; `CI=1 npx playwright test e2e/phase7-dashboard.spec.ts e2e/phase7-reminders.spec.ts e2e/phase7-reports.spec.ts e2e/phase6.spec.ts`; commits `perf(reminders): …` and `perf(finance): …`.
- [ ] Do NOT touch pg pool size (G7), indexes, or any formula.

---

### Task 5: E2E and test-harness safety and maintainability (independent review required for the DB guard)

**Files:**
- Modify: `playwright.config.ts`, `e2e/helpers.ts`, `e2e/auth.spec.ts`, all specs carrying the copied storageState bootstrap (~20), `.env.example` (documenting `E2E_DATABASE_URL` only — no other env work), `vitest.config.*` only if H4 is adopted
- Create: `e2e/global-setup.ts` (fail-closed DB guard) reusing `lib/testing/database-url.ts`; a shared fixture/helper for the authenticated storage state
- Test: a Vitest test for the guard's decision function (missing URL, same as `DATABASE_URL`, unsafe by policy, safe); Playwright suite runs green with the guard active

**Pre-flight evidence:** C4 (e2e inherits `DATABASE_URL`, writes real users, no same-database guard, Vitest has one at `vitest.global-setup.ts:96-109`), E2 (`e2e/auth.spec.ts:46` 5 s default vs `e2e/helpers.ts:32` 30 s), A-7 (bootstrap copied in 20 specs), D "isolate: false" (~48 s potential).

- [ ] **Step 1 (H1):** introduce `E2E_DATABASE_URL`; the Playwright webServer passes it as `DATABASE_URL` to the spawned `next dev`; a `globalSetup` refuses to run when the variable is missing, equals the app `DATABASE_URL`, or fails the established safety policy (database name must carry the test marker the Vitest policy uses) — fail closed, clear message. Local `.env` gets the value (never committed); `.env.example` documents it. The test DB is created/migrated the way `vitest.global-setup.ts` does it (reuse, do not copy).
- [ ] **Step 2 (H2):** give `e2e/auth.spec.ts:46` the same bounded 30 s navigation expectation the helper uses (or route it through the helper); no global timeout increase.
- [ ] **Step 3 (H3):** extract the storageState bootstrap into one shared helper/fixture in `e2e/helpers.ts` (or `e2e/fixtures.ts`) and migrate the ~20 specs; each spec's test count unchanged; no custom framework.
- [ ] **Step 4 (H4, optional):** benchmark Vitest `isolate: false`: full suite twice from unchanged HEAD with and without; adopt only if meaningfully faster, both runs green, and no order dependency appears; otherwise keep isolation and record the numbers.
- [ ] **Step 5:** `CI=1 npx playwright test` targeted specs touched (`e2e/auth.spec.ts` plus three migrated specs) — the full suite runs at the frozen HEAD; commits `test(e2e): isolate browser tests from the development database` and `test(e2e): centralize authenticated browser bootstrap`. Workers stay 1, retries 0.

---

### Task 6: Small type and module cleanups

**Files:**
- Modify: `components/transactions/transaction-form.tsx` (two `as never` resolver casts), `components/loans/loan-row-actions.tsx` (split only if boundaries improve), the one non-null assertion and any unsafe cast flagged in A-structure-quality.md §H4
- Test: existing Vitest for the touched components (`components/transactions`, `components/loans`), targeted Playwright `e2e/phase7-transactions.spec.ts e2e/phase7-debts-loans.spec.ts`

**Pre-flight evidence:** A-6 (`transaction-form.tsx:80-99` `as never` switch off the Resolver contract; RHF 7.87 three-generic `Resolver` fixes it), A-9 (`loan-row-actions.tsx` 678 lines, five components + payment arithmetic), A §H4 (one non-null `!`, 13 casts of which 10 are the accepted `Map.get() as Decimal` idiom).

- [ ] **Step 1 (I1):** align the resolver generics so both `as never` disappear without new generic machinery; if RHF's types make it impossible cleanly, record why and leave them.
- [ ] **Step 2 (I2):** split `loan-row-actions.tsx` into at most a handful of sibling files under `components/loans/` (e.g. the payment dialog and its arithmetic helper with a `.tsx` test) only where it separates responsibilities; behaviour and Decimal semantics byte-identical; tests moved with the code.
- [ ] **Step 3 (I3):** review the non-null assertion and the non-idiom casts; fix only unsafe ones; leave the `Map.get() as Decimal` idiom.
- [ ] **Step 4:** targeted tests, lint, format; commit `refactor(types): remove remaining justified frontend type escapes`. No index migrations (I4), no `deleteUserData` (I5).

---

### Task 7: Wave 1 frozen verification and report (controller-driven)

- [ ] Tree clean; freeze HEAD; record hash.
- [ ] Run from the frozen HEAD: `npm run test`; `CI=1 npx playwright test` (workers 1, retries 0); `npm run lint` (0 errors, 0 warnings); `npm run format:check`; `npx tsc --noEmit`; `npx prisma validate`; `npx prisma migrate status`; `npm run build`.
- [ ] Clean-install proof: rename `node_modules`, `npm ci` alone, confirm the Prisma client exists and `npx tsc --noEmit` passes; restore.
- [ ] Deliver the 29-item Wave 1 report and STOP (no Wave 2, no push, no merge).
