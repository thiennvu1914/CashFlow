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

---

## Notes for Wave 2

- `postinstall: prisma generate` with `prisma` in `devDependencies` (Task 1) means `npm ci --omit=dev` fails outright — the Wave 2 Dockerfile/deploy step must install dev dependencies before pruning, or run `npm ci --ignore-scripts` followed by an explicit `prisma generate`.
- `vitest.global-setup.ts` still loads `.env` only via `dotenv`, while Playwright now resolves env through `@next/env`'s precedence (`.env.local`, `.env.test`, etc.) — reconcile the two loaders as the first Wave 2 test-harness item, before adding any new env-dependent config.

---

# Wave 2 — Security + DevOps + Operations readiness (owner approval of Wave 1 at 77baade)

## Wave 2 Global Constraints (in addition to the constraints above)

- Preserve every accepted Wave 1 outcome (postinstall generate, dependency classes, error boundaries, `useActionSubmit`, query changes, `E2E_DATABASE_URL` guard, shared bootstrap, isolated Vitest, loan split, financial semantics); revisit only if Wave 2 integration exposes a genuine defect.
- Stop rule (Wave 2): STOP if tenant isolation changes; auth/session behaviour may weaken; production secrets could become exposed; a test-only bypass becomes reachable in production; Docker needs a business-semantics change; the migration strategy risks destructive schema behaviour; CI would run against an unsafe database; security headers break core app/auth behaviour and cannot be fixed locally.
- Independent review is required for every security- or DevOps-sensitive task (8–14); the installed `security-review` skill runs after Tasks 8–11 and again after Docker/CI integration; P0/P1 fixed before certification, P2 deferred with rationale.
- Still out of scope: Kubernetes/Terraform/Helm, Redis, queues, metrics/tracing platforms, microservices, repository/DI layers, a production docker-compose for appearance, strict nonce CSP, Playwright worker increase, broad package upgrades, debt/loan payment reversal, generic user deletion, index tuning without evidence, cleanup of the 972 historical dev-DB test users (may be documented as an optional local command; never executed).
- Vendor-neutral: Docker/Node/PostgreSQL portable; Railway/Render/Fly.io only as examples in docs.
- Test cadence: targeted Vitest/Playwright per task; the complete matrix plus Docker/health/header/db:deploy verification only at the frozen Wave 2 HEAD (Task 16). Retries 0, workers 1, no skips, no arbitrary waits.

---

### Task 8: Validated environment contract (owner D)

**Files:** Create `lib/server/env.ts` (+ test) as one small server-side validation layer (zod is already a dependency; no config framework). Modify `lib/auth/production-config.ts` (or fold its checks into the new module), `lib/auth/create-auth.ts` (consume the validated secret), `.env.example`, and the README env section only if its wording becomes wrong.

**Pre-flight evidence:** C1 (`BETTER_AUTH_SECRET` never validated; the placeholder deploys silently), C5–C7 (`ALLOW_DEMO_SEED_IN_PRODUCTION` documented but read by nothing; `EMAIL_FROM` required in production but validated nowhere; no `TZ` in `.env.example`), E11.

- [ ] **D1:** in production (`NODE_ENV === 'production'`) reject a missing, blank, known-placeholder (export the placeholder constant from one place and compare) or too-short (under 32 characters, Better Auth's floor) `BETTER_AUTH_SECRET` with a clear message that never echoes the value. Tests: each rejection plus the accept case; the thrown message contains no secret material.
- [ ] **D2:** define the contract: required in production — `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `EMAIL_FROM`, the SMTP variables when the SMTP sender is selected, `TRUSTED_PROXY_CIDRS` where the existing production config requires it; optional with defaults — FX configuration, `TZ`; test-only — `TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `CASHFLOW_E2E_DISABLE_RATE_LIMIT`, `EMAIL_OUTBOX_FILE`; maintenance — `ALLOW_DEMO_SEED_IN_PRODUCTION` (made real by Task 14; document it as consumed by the demo scripts only). Remove or document every stale variable found by `git grep -n "process.env"`. Validation runs once at server start from the modules that already read env (Prisma client factory, auth factory, email sender), fails fast in production and warns in development.
- [ ] **D3:** rewrite `.env.example` in groups (Application, Database, Authentication, Email, FX, Testing, Demo/maintenance) with safe placeholder values only.
- [ ] **D4:** document `TZ=UTC` as the server/container contract (user-facing dates keep using `User.timezone`); no change to timezone calculations.
- [ ] Targeted tests (`lib/server/env.test.ts`, `lib/auth`), lint, format; commit `feat(config): validate the production environment contract at startup`.

---

### Task 9: Auth, cookie and security hardening (owner E)

**Files:** `lib/auth/create-auth.ts` (rate-limit gate) and its test, `lib/server/actions/sync-preference-cookies.ts` and any other place that sets the `cashflow-theme`/`NEXT_LOCALE` cookies (secure attribute), `components/auth/register-form.tsx` + `messages/{vi,en}/auth.json` (generic failure copy) + `e2e/phase7-auth.spec.ts`, plus fixes from the security review.

**Pre-flight evidence:** C3 (rate-limit switch not `NODE_ENV`-gated), C8 (preference cookies without `secure`), the documented registration-enumeration trade-off, the K audit list.

- [ ] **E1:** rate limiting is disabled only when `CASHFLOW_E2E_DISABLE_RATE_LIMIT === '1'` AND `NODE_ENV !== 'production'` (and, if cheap, an explicit e2e marker such as `E2E_DATABASE_URL` being set). Tests: production + flag → enabled; test/e2e + flag → disabled; flag absent → enabled. `playwright.config.ts` unchanged (it spawns `next dev`, non-production).
- [ ] **E2:** preference cookies get `secure` in production (HTTPS) and stay plain on localhost HTTP; keep `sameSite: 'lax'`, `path: '/'` and the existing lifetime. Test the attribute set in both modes.
- [ ] **E3:** registration failure shows a generic localized message that does not reveal whether the address exists (keep field validation and the 429 too-many-attempts message; keep a useful retry hint such as "check the address, or sign in / reset your password"). Update both dictionaries and migrate the e2e selector that asserted the email-taken text in the same commit. No timing equalization.
- [ ] **E4:** the controller runs the installed `security-review` skill over the Task 8–11 diff; concrete P0/P1 findings are fixed in a fix round.
- [ ] Targeted tests, lint, format; commits `fix(auth): fail closed on the e2e rate-limit switch outside test environments`, `fix(auth): secure preference cookies over HTTPS`, `fix(auth): generic registration failure copy`.

---

### Task 10: Production security headers (owner F)

**Files:** `next.config.ts` (`headers()`, `poweredByHeader: false`), a Vitest test that imports the config and asserts the header set for `/(.*)`, one Playwright assertion that a page response carries the headers (dev mode serves `headers()` too).

**Pre-flight evidence:** C2/E7 (no headers at all; `x-powered-by` on; nonce CSP cost vs MVP).

- [ ] Add `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `X-Frame-Options: DENY` plus `Content-Security-Policy: frame-ancestors 'none'` (frame-ancestors only, no script-src); a minimal `Permissions-Policy` deny list (camera, microphone, geolocation, payment, usb, browsing-topics); `Strict-Transport-Security: max-age=31536000; includeSubDomains` only when `NODE_ENV === 'production'` (document that TLS terminates at the platform proxy); `poweredByHeader: false`. `/api/health` carries them too.
- [ ] **F1 CSP decision:** no nonce CSP. Add `Content-Security-Policy-Report-Only` ONLY if a simple static policy produces zero violations on every page (dashboard charts, auth pages, dialogs) in a manual check; otherwise document CSP hardening as future work in docs/operations.md. Record the decision either way.
- [ ] Targeted tests, lint, format; commit `feat(security): production response headers`.

---

### Task 11: Health endpoint, server logging, error instrumentation (owner G)

**Files:** Create `app/api/health/route.ts` (+ test), `lib/server/log.ts` (+ test), `instrumentation.ts` at repo root with `onRequestError` (Next 16 — verify in `node_modules/next/dist/docs`); modify the production server-side `console.*` sites that should route through the logger (keep client-side fixed strings); leave `app/(app)/error.tsx` and `app/global-error.tsx` alone unless the reference-code wording must match the logged digest.

**Pre-flight evidence:** E5 (no health endpoint), E12 (43 `console.*` sites, no PII, only structure missing), A-4/A-2 (digest correlation; no `onRequestError`).

- [ ] **G1:** `GET /api/health`: `SELECT 1` through the existing Prisma client with a bounded timeout (about 2 s via `Promise.race`); 200 `{ "status": "ok" }` or 503 `{ "status": "unavailable" }`; `Cache-Control: no-store`; no version, host, connection string or stack; unauthenticated (must not call `requireUser`). Tests: 200 with the DB, 503 when the query rejects or times out (inject the query function).
- [ ] **G2:** `lib/server/log.ts`: `log.info/warn/error(event, fields?)`; development → readable line; production → one JSON object per line with `level`, `event`, `time` and fields; a redaction guard that masks keys matching password/token/secret/authorization/cookie and URLs with credentials, and never serialises `Error.stack` in production beyond message plus digest. Tests for both formats and redaction.
- [ ] **G3:** `instrumentation.ts` with `onRequestError(error, request, context)` logging `event: 'request.error'`, `digest`, method and route path (no query string, headers or body) through the shared logger; client reference codes equal the server `digest`. Test the handler with a fake error and request.
- [ ] **G4:** console audit: route server-side unexpected-error `console.error` sites in `lib/server/**` and server-only `app/**` code through `log.error`; leave client components and test/tooling output alone; record the table (site → keep/route/remove) in the report.
- [ ] Targeted tests, lint, format; commits `feat(ops): health endpoint`, `feat(ops): structured server logger and request-error instrumentation`.

---

### Task 12: Production Docker (owner H; independent review required)

**Files:** Create `Dockerfile`, `.dockerignore`, `scripts/docker-entrypoint.sh` only if needed; modify `next.config.ts` (`output: 'standalone'`), `package.json` (`db:deploy` = `prisma migrate deploy`), README Docker quick start (short; details in docs/operations.md in Task 15).

**Pre-flight evidence:** E6 (standalone is Prisma-7-WASM compatible via static requires — verify the trace; `.env` in the build context; `next/font/google` fetch at build), the Wave 1 note (prisma CLI is a devDependency so `npm ci --omit=dev` fails), E11 (Node contract).

- [ ] **H1/H2/H3:** multi-stage: `deps` (the Node image Prisma documents for the WASM client + `@prisma/adapter-pg`; alpine only if verified) with full `npm ci`; `builder`: `next build` with `output: 'standalone'`, `NEXT_TELEMETRY_DISABLED=1`, build-time env limited to what the build genuinely needs (`DATABASE_URL` set to a dummy value only if Next evaluates it at build — verify; never a real secret); a `migrator` stage that keeps `prisma`, `dotenv`, `prisma7.config.ts` and `prisma/` and runs `npm run db:deploy`; `runner`: same base, non-root `node` user, `NODE_ENV=production`, `TZ=UTC`, copies `.next/standalone`, `.next/static`, `public`, verifies the Prisma WASM client, `@prisma/adapter-pg` and `pg` are present in the standalone trace (explicit COPYs only if the trace misses them, with the reason recorded), `EXPOSE 3000`, `CMD ["node","server.js"]`, secrets only at runtime.
- [ ] **H4:** `.dockerignore`: `.git`, `node_modules`, `.next`, `e2e/.results`, `e2e/.outbox`, `playwright-report`, `test-results`, `coverage`, `*.log`, `.env*` except `.env.example`, `.superpowers`, `.claude`, `docs` — keep `prisma/`, `messages/`, `public/` and the config files.
- [ ] **H5:** `HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3` calling `/api/health` with a `node -e` fetch (no curl in slim images); 503 counts as unhealthy but the retries avoid a restart loop on transient latency.
- [ ] **H6 — actually build and run:** `docker build -t cashflow:wave2 .`; run the migrator against a dedicated local database `cashflow_docker` (never the dev database); `docker run -p 3100:3000` with a throwaway production-shaped env; assert `/api/health` 200, the security headers, `/login` renders, and `/api/health` 503 when the database is unreachable; record image sizes and the standalone trace check; stop and remove the containers afterwards.
- [ ] Commit `feat(docker): production multi-stage image with a separate migration stage`.

---

### Task 13: GitHub Actions CI (owner I; independent review required)

**Files:** Create `.github/workflows/ci.yml`; `package.json` scripts only if CI needs one that is missing. No secrets in the workflow.

**Pre-flight evidence:** E4 (CI design: Postgres service, explicit `TEST_DATABASE_URL` ≠ `DATABASE_URL`, `E2E_DATABASE_URL`, browser cache, artifacts on failure, timeouts; the build needs `DATABASE_URL` set, not reachable), E3 (the full suite runs against `next dev`; production smoke separately).

- [ ] **I1–I5:** triggers `pull_request` and `push` to `main`; `concurrency` group per ref with cancel-in-progress; Node from `.nvmrc` (`actions/setup-node` with `node-version-file` and the npm cache); a `postgres:16-alpine` service with a health check and isolated credentials; three databases — `DATABASE_URL` → `cashflow_ci` (gets `prisma migrate deploy` in the job), `TEST_DATABASE_URL` → `cashflow_ci_test`, `E2E_DATABASE_URL` → `cashflow_ci_e2e` (the suites create their own); `TZ=UTC`; steps: `npm ci` → lint → format:check → tsc → prisma validate → Vitest → Playwright (`npx playwright install --with-deps chromium`, cache `~/.cache/ms-playwright` keyed by the Playwright version; `CI=1`; retries 0; workers 1; upload `e2e/.results` and the report as artifacts on failure) → `npm run build`; job timeout about 40 minutes; `CASHFLOW_E2E_DISABLE_RATE_LIMIT` is NOT set in the workflow (playwright.config sets it for the spawned server only).
- [ ] **I6 production smoke:** a second job that builds the Docker image, starts Postgres and the container with a production-shaped env (`NODE_ENV=production`, a random 64-hex secret generated in the job, `BETTER_AUTH_URL=http://localhost:3000`, `TRUSTED_PROXY_CIDRS` as required, email configured the documented CI way), runs `db:deploy` via the migrator stage, waits for `/api/health` 200, asserts the security headers and a 200 on `/login`; no Playwright duplication.
- [ ] **I7:** `npm audit --omit=dev --audit-level=high || true` as an informational step, never blocking.
- [ ] Validate the workflow with `actionlint` (npx, if it installs offline-free) or a YAML parse; the controller cannot run GitHub Actions locally — document that the first real run happens when the owner pushes. Commit `ci: GitHub Actions pipeline with isolated databases and a production smoke job`.

---

### Task 14: Guarded demo seed / clear (owner J; independent review required)

**Files:** Create `scripts/demo-seed.ts` and `scripts/demo-clear.ts` (or one script with subcommands), `lib/server/demo/` (fixture plus a guarded reset service used only by the scripts) with tests; `package.json` scripts `demo:seed` and `demo:clear` (run with `tsx` added as an exact-version devDependency, or Node's type stripping if the Node contract allows — decide and record); the `.env.example` maintenance group.

**Pre-flight evidence:** F (isDemo fully wired; spec §13 and the 2026-09-04 demo plan never built; `ALLOW_DEMO_SEED_IN_PRODUCTION` read by nothing), B-2 (no user-deletion path; the only correct delete order lives in test fixtures).

- [ ] **J1/J2:** the script resolves the dedicated demo user by a fixed email (the spec's value, else `demo@cashflow.local`), creates it with `isDemo: true` if absent, refuses when `NODE_ENV === 'production'` unless `ALLOW_DEMO_SEED_IN_PRODUCTION === 'true'`, and before ANY delete re-reads the user and asserts `isDemo === true` (abort otherwise); deletes only rows whose `userId` equals that user's id, in FK-safe order inside one transaction (move the order from `lib/server/export/test-fixtures.ts` into the demo module so tests and demo share one list); never touches other users; refuses when the resolved database is a test database (`cashflow_test`, `cashflow_e2e`, or any name the test policy would accept).
- [ ] **J3:** fixture: 3–4 accounts across VND and USD, about 40 transactions over the last three months with categories, 3 transfers (one cross-currency through the existing service API), 3 budgets, 2 savings goals, 1 debt and 1 loan with a few payments, 4 reminders with mixed frequencies; created through the existing services (never raw inserts) so every invariant holds; idempotent reset.
- [ ] Tests: the production guard refuses without the override; the isDemo assertion aborts on a non-demo user; reset deletes only the demo user's rows (seed a second user, assert untouched); seed → reset → seed is idempotent.
- [ ] **J4:** document in docs/operations.md (Task 15) an optional local-only command to list/count historical `e2e-*@example.com` users; do NOT implement deletion of them and never run anything against the owner's dev database.
- [ ] Commit `feat(demo): guarded demo user seed and reset scripts`.

---

### Task 15: Operations and README documentation (owner K)

**Files:** `README.md` (concise, about 150 lines at most), `docs/architecture.md` (new), `docs/operations.md` (new); one-line corrections in `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` only where it describes removed files.

- [ ] **K1:** README: overview, features, stack, prerequisites (Node from `.nvmrc`, Docker Postgres on 5439), install (`npm ci` generates Prisma), env setup (`.env.example` groups), `prisma migrate dev`, run, Vitest (needs Postgres and `TEST_DATABASE_URL`), Playwright (`E2E_DATABASE_URL` required, the suite starts its own server, stop a hand-started one), production build, Docker quick start (build, migrate, run), links to the two docs.
- [ ] **K2:** docs/architecture.md: tenant isolation (`requireUser`, composite FKs), balance derivation, transaction taxonomy and sign rule, transfer semantics and conservation, FX snapshot vs current position (`historicalAmountIn`), Net Worth, budgets, savings, debts/loans (immutable payment history, K6), reminders (recurrence, timezone anchoring, materialization on read), locale/theme resolution, server/client boundary (server actions + Zod, view models emit keys, `useActionSubmit`). No line-by-line code.
- [ ] **K3–K5, K7:** docs/operations.md: environment contract table (from Task 8), TZ contract, migration procedure (backup → `npm run db:deploy` → health check; never `db push`), health endpoint semantics, Docker deployment (stages, which stage runs migrations, runtime env, healthcheck), logging format and redaction, email requirements (SMTP vs outbox), FX networking, backup (`pg_dump -Fc`), restore (fresh DB → `pg_restore` → `prisma migrate status` → health → representative counts), recovery verification, CSP future work, vendor-neutral deployment notes with Railway/Render/Fly.io/plain Docker host as examples, the optional local dev-DB listing (J4), the demo scripts and their guard.
- [ ] Commit `docs: README, architecture and operations for production ownership` (docs only; a read-through review unless a statement is wrong).

---

### Task 16: Wave 2 frozen certification and report (controller-driven)

- [ ] Tree clean; freeze HEAD; record hash; no source mutation during certification.
- [ ] Matrix from the frozen HEAD: `npm run test`; `CI=1 npx playwright test`; `npm run lint`; `npm run format:check`; `npx tsc --noEmit`; `npx prisma validate`; `npx prisma migrate status`; `npm run build`; fresh `npm ci` proof.
- [ ] Docker: the image builds; the migrator runs `db:deploy` against a dedicated local database; the container boots; `/api/health` 200 with the DB and a bounded 503 without; security headers visible on the production response; production + `CASHFLOW_E2E_DISABLE_RATE_LIMIT=1` keeps rate limiting on (probe: four sign-ups → 429).
- [ ] Deliver the 34-item Wave 2 report and STOP (no Wave 3, no push, no merge).
