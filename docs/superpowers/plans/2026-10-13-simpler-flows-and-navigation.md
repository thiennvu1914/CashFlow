# Simpler Flows and Navigation (Group B, Parts 2–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make everyday operations quicker to do and easier to understand, and cut the sidebar from 12 to 8 entries, without schema changes.

**Architecture:** UI and service-read changes only. Remembered form defaults stay in client state; the net-worth breakdown reads the existing position figures; default category/account-type names are translated at display time (stored names unchanged); due debts/loans join the dashboard's upcoming list as read-only items; navigation groups related pages under tabs while every existing route keeps working.

**Tech Stack:** Next.js 16.3.4 App Router (read `node_modules/next/dist/docs/` before relying on any Next API), React 19.2, Prisma 7.10, next-intl 4.14, Base UI/shadcn 4.21, Vitest 5, Playwright.

**Spec:** owner-approved design in chat on 2026-10-13 (reproduced verbatim as the task requirements below) on top of `docs/superpowers/specs/2026-10-12-money-source-linking-design.md` §9 ("Part 2 / Part 3").

## Global Constraints

- Branch `fix/ux-part2-3` in `E:\Github\CashFlow` (already checked out). Never switch branches, never push. Stage only the files you changed (`git add <paths>`, never `git add -A`).
- **The local `.env` `DATABASE_URL` is the PRODUCTION Supabase database.** Never run `npm run dev`, `next start`, `node scripts/start-standalone.mjs`, `npm run demo:*`, or any `prisma migrate|db|studio` command. No schema changes in this plan. Vitest is safe (local `cashflow_test`). Playwright is safe only as `E2E_DATABASE_URL="postgresql://cashflow:cashflow_dev_password@localhost:5439/cashflow_e2e" CI=1 npx playwright test <specs>` with port 3000 free.
- Before every code commit run, in order: `npm run format:check`, `npm run lint`, `npm run test`, `npm run build` — all must pass. Never run two Vitest suites or two Playwright runs at once.
- Financial invariants unchanged (no stored balances; Decimal money; every query scoped by the session `userId`; every `(app)` page calls `requireUserOrRedirect()`, every server action `requireUser()`).
- Owner-approved look stays (AGENTS.md design line). New strings in BOTH `messages/vi` and `messages/en`. No `router.refresh(` in components (guard test). No `ul/li` skeletons; no block elements inside `<p>`.
- When a task relabels or moves UI, grep `e2e/` and update affected selectors in the same commit.
- Speed: the owner asked for faster delivery — keep each change minimal and focused; no refactors beyond what the task needs.

---

### Task 1: The transaction form remembers the last account and type

Requirement (owner-approved): after saving, the create form keeps the account and the type (income/expense/…) just used instead of resetting to the first account and EXPENSE. Applies to the /transactions create panel, the mobile sheet and the global "Thêm giao dịch" entry. Category resets only if it no longer matches the kept type; amount, note and date/time reset as today.

Files: `components/transactions/transaction-form.tsx` (the post-save `reset(defaultValues(...))` ~:148/:286), `components/transactions/transaction-create-panel.tsx` if it owns the defaults; tests next to them; `e2e/phase7-transactions.spec.ts` (add: create with a non-first account + INCOME, then the form still shows that account + INCOME).

- [ ] Failing component/pure test for the post-save defaults → implement (keep it client-side state; optionally persist the last account id in `localStorage` wrapped in try/catch so a reload remembers it — only if trivial) → e2e → four checks → commit `feat(transactions): keep the last account and type after saving`.

### Task 2: Net-worth card shows how it is computed

Requirement: the "Tài sản ròng / Net worth" KPI on /dashboard shows its parts inline — "Tổng số dư + Phải thu − Phải trả − Dư nợ vay" with each amount (formatMoney in the display currency), replacing the current one-line note (`dashboard.netWorthNote`). Lines with zero may be hidden except "Tổng số dư".

Files: `components/dashboard/summary-panel.tsx` (~:105-132), `lib/ui/dashboard-view-model.ts` (~:396 positionKpi — the position already carries `totalBalance`, `receivables`, `payables`, `loanOutstanding`; expose them to the KPI), `messages/{vi,en}/dashboard.json`, tests (`summary-panel.test.tsx`, view-model tests), dashboard e2e assertions if any read the note.

- [ ] Failing view-model + component tests → implement (no new queries) → four checks → commit `feat(dashboard): break net worth down into its parts`.

### Task 3: Default category and account-type names in the reader's language

Requirement: default categories and account types (rows with `isDefault = true`, names from `lib/server/defaults.ts`: e.g. "Food & Dining", "Bank Account", "Loan Interest & Fees") display translated ("Ăn uống", "Ngân hàng", "Lãi vay & phí", …) in the UI; stored names are unchanged; user-created or user-renamed names (not matching a known default name) are shown as stored. Excel export keeps its current behaviour (out of scope).

Files: new `lib/ui/default-names.ts` (pure: `displayCategoryName({ name, isDefault }, t)` / `displayAccountTypeName(...)`, mapping each English default name to a message key), `messages/{vi,en}/defaults.json` (or an existing namespace — follow the repo's message-file layout and the parity test), and every UI render site of category/account-type names: category selects (`components/transactions/category-select.tsx`), transaction list rows, budgets, reports charts/tables, `/categories` page, account-type select/list, goals/reminders/dashboard where names render. Find them with `grep -rn "category.name\|categoryName\|accountType.name" components app lib/ui`. Read sites may need `isDefault` added to their select — keep it one column, no extra round trip.

- [ ] Failing unit tests for the helper (every default name has a vi and en label; unknown names pass through) → wire every render site → component/e2e text assertions updated (grep e2e for English default names) → four checks → commit `feat(i18n): show default category and account-type names in the reader's language`.

### Task 4: Debt and loan due dates in the dashboard's upcoming list

Requirement: the dashboard's upcoming/"Sắp tới" area (find it in `app/(app)/dashboard/page.tsx` + `messages/vi/dashboard.json`; it currently lists reminder occurrences) also shows active loans' `nextDueDate` and active debts' `dueDate` within the same window it uses for reminders, read-only, each linking to `/loans` or `/debts` (with the row anchor if one exists), sorted by date with the reminders, labelled clearly ("Trả góp: {lender}", "Hạn nợ: {person}" / "Thu nợ: {person}" by direction) with the amount (loan scheduled payment; debt outstanding). No new round trips if the dashboard loader already reads debts/loans (it does for net worth — reuse those rows); otherwise one parallel read.

Files: `lib/server/services/dashboard.ts` and/or `lib/ui/dashboard-view-model.ts`, the upcoming widget component, messages, tests, dashboard e2e.

- [ ] Failing view-model tests (merge + sort + window + labels) → implement → four checks → commit `feat(dashboard): show debt and loan due dates among upcoming items`.

### Task 5: Part 1 leftovers

Requirements (from the Part 1 final review, parked items):
1. "Record in an account" with "ghi bù" ticked must SKIP unlinked payments dated after today (in the user's zone) instead of refusing the whole link (`FUTURE_PAYMENT` in `lib/server/services/debt.ts` ~1252-1263 and `loan.ts` ~1548-1560); the transaction-size `_count` uses the same filter; the dialog's "Ghi bù N" count (`components/debts/link-to-account-form.tsx` ~118) counts only those, and adds one line when M future-dated payments are left for later. Remove the now-unused error code + copy if nothing else uses it.
2. Unlink pre-read (`debt.ts` ~1372-1383, `loan.ts` ~1669-1681) uses `OR t."id" IN (<correlated subquery>)` — rewrite as a `UNION` of the linked ids joined to Transaction so Postgres uses the `(userId, id)` index; same results (tests stay green).
3. Stale text: `lib/server/services/account-lock.ts:51-53` ("No caller passes custom transaction options"); `docs/operations.md` "Known constraints" (~488-489, says payment history is immutable / no correction flow) and `docs/architecture.md` K6 (~63-72) — update to the current behaviour (payments editable/deletable; Record in / Remove from account).
4. Copy: the archived-account refusal for unlink and payment delete reuses `errors.{debt,loan}.ARCHIVED_ACCOUNT` ("Choose an active account, or 'Don't record…'"), which reads oddly when there is nothing to choose — give those two paths their own copy (e.g. "Tài khoản này đã lưu trữ nên không thể thay đổi giao dịch của nó." / en).

Files: as listed + tests (`lib/server/services/legacy-linking.test.ts`, debt/loan action tests, link form tests).

- [ ] TDD per item → four checks → ONE commit per item (4 commits): `fix(linking): skip future-dated payments when recording in an account`, `perf(linking): read unlink targets through the id index`, `docs: describe editable payments and account linking`, `fix(linking): explain archived-account refusals on unlink and payment delete`.

### Task 6: Navigation — 8 entries with tabs

Requirement (owner-approved):

| Sidebar | Contains |
|---|---|
| Tổng quan | /dashboard |
| Giao dịch | tabs: Giao dịch (/transactions) / Chuyển tiền (/transfers) |
| Tài khoản | /accounts |
| Ngân sách | /budgets |
| Tiết kiệm | /goals |
| Vay & nợ | tabs: Công nợ (/debts) / Khoản vay (/loans) |
| Nhắc nhở | /reminders |
| Báo cáo | /reports |
| Cài đặt | /settings, with a "Danh mục / Categories" section or link to /categories |

All old URLs keep working (no redirects needed — they are the tab targets). The sidebar item is active for any of its tab routes (`isActiveNavItem` extended with a `matches: string[]` on the nav item). A small shared tab header component (links styled as tabs, `aria-current="page"` on the active one) renders at the top of /transactions + /transfers and /debts + /loans; /categories shows a back link to Cài đặt. Mobile: bottom tabs and the "More" sheet use the same grouped list (`MOBILE_TAB_HREFS` updated sensibly — keep Dashboard, Transactions, Accounts and the More sheet). Messages: new `nav.debtsLoans` ("Vay & nợ" / "Debts & loans") and tab labels; keep existing keys used elsewhere.

Files: `components/layout/nav-items.ts`, `components/layout/app-shell.tsx` / rail link, `components/layout/mobile-nav.tsx`, new `components/common/section-tabs.tsx` (or similar), the four pages' headers, `app/(app)/settings/page.tsx` (categories entry), messages, tests (`nav-items` tests, shell tests), e2e shell/nav/responsive specs (`grep -ln "nav\.\|Chuyển tiền\|Công nợ\|Khoản vay\|Danh mục" e2e/*.spec.ts`).

- [ ] Failing nav-items tests (8 entries, active matching across tab routes, mobile lists) → implement → update e2e selectors → run e2e shell/responsive/a11y + any spec navigating via the sidebar → four checks → commit `feat(nav): group pages into 8 sidebar entries with tabs`.
