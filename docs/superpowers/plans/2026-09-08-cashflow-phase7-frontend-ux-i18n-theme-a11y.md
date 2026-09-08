# CashFlow Phase 7: Frontend UX/UI, i18n, Theme & Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin every CashFlow screen into one Calm Premium Fintech design system — Vietnamese-first and fully English, light and dark, desktop and phone, accessible — without changing a single financial semantic, service, action, validation rule or Excel cell.

**Architecture:** A small set of reusable primitives (`components/common/*`) plus three shadcn/base-ui additions (`dialog`, `select`, `menu`) carry the whole redesign; every page is rewritten to compose them. Tasks are numbered with letters where one deliverable split into independently reviewable pieces (1a/1b/1c, 2a/2b/2c, 5a/5b), so a cross-reference to "Task 4" or "Task 11" still means what it says. Theme is server-rendered from `resolveTheme()` (session user → `cashflow-theme` cookie → light) so the first paint is already correct and no client script flips it. Copy moves out of components and view models into per-domain message files merged in `i18n/request.ts`, with enum→key functions in `lib/ui/labels.ts` so view models keep returning keys/enums and components do the translating; the Zod schemas keep their English literals and are translated at the render boundary, in `FieldError`, through `messages/{vi,en}/validation.json`. Forms keep their `useHydrated()` gate and gain a shared `useSubmitState()` in-flight lock.

**Tech Stack:** Next 16.3.4 (App Router, `LayoutProps<'/'>`), React 19.2.8, Tailwind v4 CSS-first (`app/globals.css` oklch tokens), shadcn 4.21 with `@base-ui/react` 1.8 (base-nova preset), next-intl 4.14, react-hook-form 7.87 + zod 4.5, recharts 3.10, lucide-react 1.41, Vitest 5 (no jsdom, no Testing Library — component tests use `renderToStaticMarkup`), Playwright 1.63. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-cashflow-phase7-frontend-design.md` (binding). Parent spec: `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§3 i18n/theme, §9 routes, §11 design system, §16 acceptance). The earlier four-task plan `docs/superpowers/plans/2026-09-04-cashflow-phase7-i18n-theme-a11y.md` is superseded and is historical context only; its `resolveLocale`/`resolveTheme`/`updateProfile` code is reused (with the cookie name corrected to `cashflow-theme`) in Task 2.

---

## Global Constraints

Every task's requirements implicitly include this section. The first block is copied verbatim from `AGENTS.md`; the second from the spec's non-goals.

**Financial invariants (never weaken, `AGENTS.md`):**

- No stored account balance — always derived from Transaction + Transfer.
- Money is Prisma `Decimal`, never Float.
- `Transaction.amount ≥ 0`, sign comes only from `type`.
- Every Transaction snapshots `vndPerUsdAtEntry`/`fxRateFetchedAt`/`fxRateEffectiveAt`/`fxRateSource` via the real FX policy — never a fabricated rate.
- `historicalAmountIn()` is the only historical conversion.
- `User.baseCurrency` is display-only.
- Every query is scoped by the session `userId` via `requireUser()`.
- Cross-user relations use composite `(userId, id)` foreign keys.
- `User.isDemo` never appears in client-facing Zod.
- No cron/background jobs.
- Layouts are not an auth boundary — every `(app)` page calls `requireUserOrRedirect()` and every service/server action calls `requireUser()`.

**Project rules (`AGENTS.md`):**

- Package manager npm only; no `src/` — `app/`, `components/`, `lib/`, `prisma/` at repo root; import alias `@/*`; Node ≥ 20.
- Run `npm run format:check`, `npm run lint`, `npm run test`, `npm run build` before every commit.
- Tailwind v4 CSS-first — tokens live in `app/globals.css` as oklch; use `var(--color-brand)` etc. in charts, never `hsl(var(--brand))`.
- shadcn 4.21 with `@base-ui/react` (base-nova preset) — add components with `npx shadcn add`, never hand-copied Radix snippets; check any menu/select/command component's hover fill (`bg-accent` is CashFlow's Muted Blue).
- Calm Premium Fintech: no gradients/glassmorphism/large shadows/giant radii/emoji icons.
- i18n: Vietnamese default, English via `NEXT_LOCALE` cookie / profile; `lib/i18n/config.ts` `resolveLocale()` is the single source; no `[locale]` routes.
- Timezone: store UTC, compute periods with `getPeriodBounds` in the user's IANA zone (Monday weeks, exclusive `endUtc`); `TZ=UTC` in CI/production.
- Prisma 7.10 needs a driver adapter at runtime; `prisma7.config.ts` is CLI-only. **Phase 7 touches no Prisma schema and runs no migration.**
- Never commit `.env*` except `.env.example`.

**Phase 7 non-goals (spec §1, verbatim):** "new financial features; changing service/action/validation semantics; renaming Excel sheets or columns; custom date-picker; custom swipe gestures; animation systems; a generic component framework; Phase 8 demo/security work."

**Phase 7 hard boundaries:**

- **No financial semantics change.** Nothing under `lib/server/services/`, `lib/server/actions/`, `lib/validation/`, `lib/currency/`, `lib/datetime/`, `lib/money/` or `prisma/` changes, with exactly **three** exceptions, every one additive, every one named in the task that owns it:
  1. `lib/server/actions/update-profile.ts` gains two `cookies().set(...)` calls (Task 2a) and `lib/server/actions/sync-preference-cookies.ts` is added (Task 2a). Neither reads client input; neither writes a financial row.
  2. The `lib/ui/*` view models gain an **optional trailing `locale`** parameter, defaulting to `vi` so no existing caller or test moves — added by Task 4 (`dashboard-view-model`), Task 7 (`budget-view-model`, `savings-goal-view-model`), Task 8 (`debt-view-model`, `loan-view-model`) and Task 9 (`reminder-view-model`); Task 13 only *passes* it from the pages.
  3. `lib/datetime/calendar-date.ts` gains `calendarDaysBetween(from, to)` and `lib/datetime/calendar-date.test.ts` gains three cases for it (Task 7). This is a **move**, not new arithmetic: the function already exists as a private helper in `lib/ui/reminder-view-model.ts:89-104` and two modules now need it, so it moves down to the layer it belongs to rather than being copied. Its behaviour, its doc comment and its carrier-arithmetic reasoning are unchanged.

  If a task appears to need any other change under those paths, STOP and report instead.
- **No export contract change.** `lib/server/export/**` and `app/api/reports/export/route.ts` are read-only for this phase. Sheet names, column headers and cell values stay exactly as they are; `lib/server/export/filtered-export.test.ts`, `full-export.test.ts` and `app/api/reports/export/route.test.ts` must stay green untouched.
- **Never push.** Commit locally on the worktree branch only. No `git push`, no PR, no remote operation.
- **No Phase 8.** No demo mode, no seed/demo user work, no security hardening, no rate limiting, no observability.
- **Every task ends green — Vitest *and* Playwright.** `AGENTS.md` requires `npm run format:check`, `npm run lint`, `npm run test` and `npm run build` before every commit, and the phase-checkpoint workflow requires green incremental commits; this plan adds `npx playwright test` to that list, because a redesign that moves selectors can only be verified end to end. **No task may end with a known-red suite.** Where a task changes a label, a control or a row's structure that an existing e2e spec asserts, that same task migrates that spec — each such task has a step that enumerates the affected files by grepping `e2e/` and lists what each selector becomes.
- **A full-suite Playwright run means `$env:CI="1"; npx playwright test`** (PowerShell; `CI=1 npx playwright test` under bash). `playwright.config.ts` has `reuseExistingServer: !process.env.CI`, so setting `CI` makes the run start its own dev server instead of trusting whichever one is already on port 3000 — which is what keeps a green run honest. Every `Run: npx playwright test` below means that form; a single-file run (`npx playwright test e2e/x.spec.ts`) during a task's own iteration may reuse a running server.

---

## Design tokens quick reference (spec §2 — every task uses these words)

| Concept | Value |
|---|---|
| Fonts | Manrope only, weights 400 / 500 / 600 (never 700) |
| Page title `h1` | `text-[1.75rem]/[2.125rem] font-semibold` (mobile `text-2xl/[1.875rem]`) |
| Section `h2` | `text-[1.125rem]/[1.625rem] font-semibold` |
| Card title | `text-[0.8125rem]/[1.125rem] font-semibold uppercase tracking-[0.04em] text-muted-foreground` |
| Body | `text-sm/[1.25rem]` (14/20), weight 400 |
| Secondary / meta | `text-[0.8125rem]/[1.125rem]` and `text-xs/[1rem]`, `text-muted-foreground` |
| Money in rows | `text-[0.9375rem]/[1.25rem] font-semibold tabular-nums` |
| KPI value | `text-[1.875rem]/[2.25rem] font-semibold tabular-nums` (mobile `text-[1.625rem]/[2rem]`) |
| Dominant KPI | `text-4xl/[2.5rem] font-semibold tabular-nums` (mobile `text-[1.875rem]/[2.25rem]`) |
| Spacing scale | 4 / 8 / 12 / 16 / 24 / 32 / 48 only |
| Page padding | `p-4 md:p-6 lg:p-8` |
| Max widths | dashboard & reports `max-w-[75rem]` (1200); list pages `max-w-[60rem]` (960); single-column forms `max-w-[30rem]` (480) |
| Radii | `rounded-md` = 6 px, `rounded-lg` = 10 px, `rounded-full` = 999 px — nothing else |
| Card surface | `border border-border bg-surface rounded-lg` — **no shadow, never a card inside a card** |
| Raised surface | `bg-surface-2` + `shadow-[0_8px_24px_rgba(25,33,30,0.10)]` (dark: `rgba(0,0,0,0.40)`) — popovers, dialogs, sheets only |
| Buttons | primary `h-10` (compact `h-9`), `rounded-md`, one primary per view region, never `w-full` at ≥ 768 |
| Inputs | `h-10 md:h-10 max-md:h-11`, `border-input rounded-md`, visible `<label>` above (13/500), helper `text-xs text-muted-foreground`, error `text-xs text-negative` |
| Focus ring | `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]` |
| Icons | lucide only — `size-4` in rows/nav, `size-5` in headers, `size-6` in empty states |
| Motion | none beyond 150 ms opacity/transform on sheets & dialogs; `prefers-reduced-motion` respected |

Vietnamese glossary (binding, spec §4): Tổng quan, Giao dịch, Chuyển tiền, Tài khoản, Danh mục, Ngân sách, Mục tiêu tiết kiệm, Công nợ, Khoản vay, Nhắc nhở, Báo cáo, Cài đặt, Tài sản ròng, Tổng số dư, Thu nhập tháng, Chi tiêu tháng, Thu nhập ròng, Khoản phải thu, Khoản phải trả, Dư nợ gốc, Kỳ tới, Trả góp, Gốc, Lãi, Đã thanh toán, Trả một phần, Quá hạn, Đã xóa nợ, Đã đóng, Đang thực hiện, Đạt mục tiêu, Đã lưu trữ, Sắp đến hạn, Hôm nay, Ngày mai, Chi tiêu, Thu nhập, Tiền vào (khác), Tiền ra (khác), Điều chỉnh tăng, Điều chỉnh giảm, Ghi nhận thanh toán, Xóa nợ, Đóng khoản vay, Tạm dừng, Tiếp tục, Xác nhận, Bỏ qua, Lưu trữ, Xóa, Hủy.

---

## File Structure

### Created

**Primitives — `components/common/` (CashFlow design system; deliberately NOT `components/ui/`, which `npx shadcn add` owns and may overwrite):**

| File | Responsibility |
|---|---|
| `components/common/page-header.tsx` | `PageHeader` — the one `h1` per page + description + right-side actions |
| `components/common/section-header.tsx` | `SectionHeader` — `h2`/`h3` with optional caption and right slot |
| `components/common/money-text.tsx` | `MoneyText` — tabular figure + currency code, tone, no-wrap, six sizes (`meta`/`row`/`md`/`lg`/`kpi`/`hero`) |
| `components/common/status-badge.tsx` | `StatusBadge`, `StatusTone` — six tinted tones, always text |
| `components/common/progress.tsx` | `Progress` — 6 px bar with `role="progressbar"` + `aria-valuetext` |
| `components/common/empty-state.tsx` | `EmptyState` — icon, title, one sentence, one action |
| `components/common/inline-alert.tsx` | `InlineAlert` — `role="alert"` tone banner for form/page errors and success |
| `components/common/form-field.tsx` | `FormField`, `Label`, `FieldError`, `SELECT_CLASS` — visible label + `aria-describedby` wiring, and the one native-select class string |
| `components/common/dialog.tsx` | `Dialog` — re-skinned wrapper over the shadcn dialog; bottom sheet < 640 |
| `components/common/confirm-dialog.tsx` | `ConfirmDialog` — the only destructive-confirmation UI |
| `components/common/sheet.tsx` | `Sheet` — right sheet ≥ 640, bottom sheet < 640; focus trap/return |
| `components/common/financial-list-row.tsx` | `FinancialListRow` — ledger row: title/meta/note + fixed amount column + actions |
| `components/common/planning-row.tsx` | `PlanningRow` — title + badge + figure line + progress + meta + actions |
| `components/common/chart-container.tsx` | `ChartContainer` — one visual language for all ten dashboard/report widgets |
| `components/common/segmented-control.tsx` | `SegmentedControl` — link-based segmented tabs with `aria-current` |
| `components/common/row-actions-menu.tsx` | `RowActionsMenu` — keyboard-operable `…` menu over the shadcn menu |

**shadcn additions (via `npx shadcn add`, base-nova, Task 1a):** `components/ui/dialog.tsx`, `components/ui/select.tsx`, `components/ui/menu.tsx`.

**Which sub-task builds which primitive:** Task 1a the tokens and the three shadcn files; Task 1b the eleven static primitives (`PageHeader`, `SectionHeader`, `MoneyText`, `StatusBadge`, `Progress`, `EmptyState`, `InlineAlert`, `FormField`/`Label`/`FieldError`/`SELECT_CLASS`, `Skeleton`, `FinancialListRow`, `PlanningRow`, `ChartContainer`, `SegmentedControl`); Task 1c the four overlays (`Dialog`, `ConfirmDialog`, `Sheet`, `RowActionsMenu`) and `useSubmitState`.

**Library:**

| File | Responsibility |
|---|---|
| `lib/theme/config.ts` | `resolveTheme()`, `THEME_COOKIE`, `Theme` |
| `lib/ui/validation-messages.ts` | `validationMessageKey(message)` — the Zod-literal → `validation.*` key mapper, plus the literal-extraction regex its test shares |
| `lib/ui/format-date.ts` | `formatDate()` — the only locale-aware date presenter in the UI |
| `lib/ui/labels.ts` | enum → message-key functions, one per enum family — the names spec §4 now fixes (`paymentFrequencyLabelKey`, `recurrenceLabelKey`, `debtDirectionLabelKey`, …) |
| `lib/ui/labels.test.ts` | exhaustiveness: every enum member has a key in vi *and* en |
| `lib/ui/use-submit-state.ts` | `useSubmitState()` — the in-flight fieldset lock |
| `lib/ui/use-submit-state.test.ts` | pure reducer test for the lock's state machine |
| `lib/ui/format-date.test.ts` | per-locale/per-zone date formatting |
| `lib/i18n/messages.ts` | `loadMessages(locale)` — merges the per-domain files into one tree |
| `lib/i18n/messages.test.ts` | vi/en key parity across every domain file |

**Messages (18 domains × 2 locales = 36 files):** `messages/vi/{common,nav,auth,dashboard,transactions,transfers,accounts,categories,budgets,goals,debts,loans,reminders,reports,settings,errors,labels,validation}.json` and the identical set under `messages/en/`. `validation.json` is the render-boundary translation of the Zod schemas' English literals (spec §4) — the schemas themselves do not change.

**Route-level loading skeletons:** `app/(app)/dashboard/loading.tsx`, `app/(app)/transactions/loading.tsx`, `app/(app)/transfers/loading.tsx`, `app/(app)/accounts/loading.tsx`, `app/(app)/categories/loading.tsx`, `app/(app)/budgets/loading.tsx`, `app/(app)/goals/loading.tsx`, `app/(app)/debts/loading.tsx`, `app/(app)/loans/loading.tsx`, `app/(app)/reminders/loading.tsx`, `app/(app)/reports/loading.tsx`, `app/(app)/settings/loading.tsx`, plus the shared `components/common/skeleton.tsx` they all use.

**Auth shell:** `app/(auth)/layout.tsx` — the centred 400 px card the four auth pages share.

**Module components created by their own tasks:** `components/layout/nav-groups.ts`, `components/layout/more-sheet.tsx` (3); `components/dashboard/summary-panel.tsx` (4); `components/transactions/transaction-type-field.tsx`, `category-select.tsx`, `account-select.tsx`, `transaction-create-panel.tsx`, `transaction-day-group.tsx` (5a); `components/accounts/account-create-button.tsx`, `components/categories/category-chip-list.tsx` (6); `components/budgets/budget-create-button.tsx`, `components/goals/goal-create-button.tsx` (7); `components/debts/debt-create-button.tsx`, `components/loans/loan-create-button.tsx` (8); `components/reminders/occurrence-group.tsx`, `reminder-create-button.tsx` (9); `components/reports/export-menu.tsx`, `category-bars.tsx`, `account-table.tsx` (10); `components/settings/settings-card.tsx` (11); `components/common/page-skeleton.tsx` (17).

**New tests:** `components/common/*.test.tsx` (StatusBadge, MoneyText, EmptyState, PageHeader, Progress, FinancialListRow, PlanningRow, PageSkeleton), `lib/ui/use-submit-state.test.tsx`, `lib/ui/validation-messages.test.ts`, `lib/ui/timezones.test.ts`, and five Playwright specs: `e2e/phase7-shell.spec.ts` (Task 3), `e2e/phase7-theme-locale.spec.ts` (11), `e2e/phase7-enum-sweep.spec.ts` (13), `e2e/phase7-responsive.spec.ts` (15), `e2e/phase7-a11y-forms.spec.ts` (16), `e2e/phase7-confirm-dialogs.spec.ts` (17).

### Modified

`app/globals.css` (tokens), `app/layout.tsx` (theme + messages), `app/(app)/layout.tsx` (shell props), `app/(app)/error.tsx`, every `app/(app)/*/page.tsx` (12), every `app/(auth)/*/page.tsx` (4), all 47 files under `components/`, `lib/i18n/config.ts`, `i18n/request.ts`, `lib/ui/format-money.ts`, `lib/ui/action-error-messages.ts`, all six `lib/ui/*-view-model.ts`, `lib/server/actions/update-profile.ts`, `e2e/helpers.ts` and the seven existing e2e specs.

### Deleted

`messages/vi.json`, `messages/en.json` (replaced by the per-domain directories in Task 2b); `components/dashboard/dashboard-section.tsx` and `components/dashboard/kpi-strip.tsx` — superseded by `ChartContainer` + `EmptyState` (Task 1b) and `SummaryPanel` (Task 4), but **deleted in Task 10**, which is where their last caller (`/reports`) goes away.

---
## Task 1a: Design tokens, the focus ring, and the three shadcn additions

**Objective:** Land the complete token layer from spec §2 in `app/globals.css` — `--surface-2`, `--border-strong`, `--focus`, `--input-bg`, the radius scale trimmed to 6/10/999, the global 2 px brand focus ring, the reduced-motion rule — with every text and UI contrast pair measured and recorded; and add the three shadcn/base-ui components the later tasks compose over. Nothing renders differently except the focus ring.

**Major files touched:** `app/globals.css`; `components/ui/dialog.tsx`, `components/ui/select.tsx`, `components/ui/menu.tsx` (all three from `npx shadcn add`).

**Reusable primitives involved:** none yet — this task is what they are built on.

**User-facing behaviour:** the only visible change is a crisper 2 px brand focus ring with a 2 px offset on every focusable element, and stillness for a user with `prefers-reduced-motion`.

**Desktop expectation:** existing screens unchanged at 1024/1280/1440 apart from the ring.

**Mobile expectation:** unchanged at 375/414/768.

**Dark-theme expectation:** every new token has a `.dark` counterpart. `--surface-2` in dark is `#29302D`-derived and visibly lighter than `--surface` (`#202724`), which is itself lighter than `--background` (`#171C1A`); `--input-bg` is the darker `#1C221F` an input sits on, so a field reads as recessed rather than as a translucent smear over whatever is behind it. Verified by rendering the gallery from Task 1c with `class="dark"` on `html`.

**Vietnamese/English expectation:** no copy in this task.

**Accessibility acceptance criteria:**
- Every text pair measures ≥ 4.5:1 and every UI pair ≥ 3:1, in **both** themes, with the numbers written into `app/globals.css` (Step 5). A pair that fails is fixed by nudging that one token's lightness, and both ratios are recorded.
- `:focus-visible` (not `:focus`) draws the ring, so a mouse click does not.
- The ring is declared once, globally, so a control added in a later task cannot ship without it.
- `prefers-reduced-motion: reduce` neutralises every animation and transition.

**Hydration/form-submission constraints:** none — this task adds no component and no form.

**Files:**
- Modify: `app/globals.css:42-56` (the `@theme inline` radius/colour block), `:92-134` (`:root`), `:136-176` (`.dark`), `:180-188` (`@layer base`)
- Create (shadcn): `components/ui/dialog.tsx`, `components/ui/select.tsx`, `components/ui/menu.tsx`

**Interfaces:**

- Consumes: nothing.
- Produces: CSS custom properties and their Tailwind utilities, which every later task uses by name —

```
--surface-2   → bg-surface-2      raised surface: popovers, dialogs, sheets, menus
--border-strong → border-border-strong  the divider inside a raised surface
--focus       → outline colour of the global :focus-visible ring
--input-bg    → the background every Input/select/textarea sits on
--radius-md   → 0.375rem (6 px)   controls
--radius-lg   → 0.625rem (10 px)  cards
--radius-full → 999px             badges, progress tracks, the raised + button
```

plus the three shadcn components, whose own exports Task 1c and Task 5a read before wrapping.

- [ ] **Step 1: Add the four new tokens and the trimmed radius scale to `app/globals.css`**

Replace the radius block at `app/globals.css:49-56` and extend the `@theme inline` colour list at `:42-48`:

```css
  /* CashFlow-specific tokens (spec §11 + Phase 7 §2), exposed as Tailwind
     utilities (bg-surface, bg-surface-2, border-border-strong, ...) */
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-brand: var(--brand);
  --color-positive: var(--positive);
  --color-negative: var(--negative);
  --color-warning: var(--warning);
  --color-border-strong: var(--border-strong);
  --color-focus: var(--focus);
  --color-input-bg: var(--input-bg);
  /* Phase 7 trims the scale to exactly three radii (spec §2): 6, 10, 999.
     `--radius-lg` is the card radius, `--radius-md` the control radius. */
  --radius-md: 0.375rem;
  --radius-lg: 0.625rem;
  --radius-full: 999px;
  --radius-DEFAULT: var(--radius-md);
```

- [ ] **Step 2: Add the light values for the three new colour tokens**

Append inside `:root` (after `--warning`, `app/globals.css:101`):

```css
  /* Phase 7 §2. `--surface-2` is the raised surface for popovers, dialogs and
     sheets — one step further from the background than a card, so a layer
     above the page reads as above it without a large shadow.
     `--border-strong` (18 %) is the divider inside a raised surface, where a
     12 % hairline disappears. `--focus` is the ring, and it is the brand
     colour rather than `--ring` so a future shadcn regeneration of `--ring`
     cannot silently change the focus indicator. */
  --surface-2: color-mix(in oklch, var(--foreground) 4%, var(--surface));
  --border-strong: color-mix(in oklch, var(--foreground) 18%, transparent);
  --focus: var(--brand);
  /* The background an input SITS on, rather than a translucent wash over
     whatever is behind it. In light this is the surface itself — a white field
     on a white card reads correctly because the 1 px `--input` border is what
     delimits it. In dark it is a distinct, darker value (see `.dark`), because
     a translucent `bg-input/30` over `--surface` and the same over
     `--surface-2` are two different colours, and a field inside a dialog then
     looked different from the identical field on the page behind it. */
  --input-bg: var(--surface);
```

- [ ] **Step 3: Add the dark values, keeping the spec's three-step ladder**

Append inside `.dark` (after `--warning`, `app/globals.css:145`) and adjust `--surface` to the spec's `#202724`:

```css
  /* Spec §3: background #171C1A → surface #202724 → surface-2 #29302D. The
     existing `--surface` was oklch(0.274 …) (#242926); the spec's ladder needs
     the middle rung a shade darker so surface-2 is visibly distinct from it. */
  --surface: oklch(0.253 0.007 164.376); /* #202724 */
  --surface-2: oklch(0.298 0.007 164.376); /* #29302D */
  --border-strong: color-mix(in oklch, var(--foreground) 22%, transparent);
  --focus: var(--brand);
  /* Spec §3: "inputs on #1C221F" — one step below `--surface` (#202724), so a
     field reads as recessed into its card. Fixed rather than translucent, so
     the same input looks the same on a card and inside a dialog. */
  --input-bg: oklch(0.20 0.006 170); /* #1C221F */
```

Also change `.dark`'s `--border` from `12%` to `14%` (spec §3: "borders 14 % white") and `--input` to sit on `#1C221F`:

```css
  --border: color-mix(in oklch, var(--foreground) 14%, transparent);
  --input: color-mix(in oklch, var(--foreground) 22%, transparent);
```

- [ ] **Step 4: Replace the base layer's focus handling with the spec's ring**

Replace `app/globals.css:178-189` entirely:

```css
@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
  /* Spec §2: 2 px brand ring, 2 px offset, on EVERY interactive element.
     Declared once here rather than per component so a control added later
     cannot ship without it. `:focus-visible` (not `:focus`) so a mouse click
     does not draw it. */
  :focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  /* Spec §2: no motion beyond 150 ms, and none at all when the user asked for
     none. */
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
}
```

- [ ] **Step 5: Verify the contrast of every text/UI pair in both themes and record it**

Compute the WCAG contrast ratio for each pair below (any tool; the oklch values are in `app/globals.css`) and write the measured numbers into a comment block directly under the existing conversion comment at `app/globals.css:60-91`. Required minimums: 4.5:1 for text, 3:1 for UI.

Pairs to record — light: `foreground`/`background`, `foreground`/`surface`, `foreground`/`surface-2`, `foreground`/`input-bg`, `muted-foreground`/`background`, `muted-foreground`/`surface`, `muted-foreground`/`input-bg` (a placeholder), `brand`/`background`, `brand`/`surface`, `positive`/`surface`, `negative`/`surface`, `warning`/`surface`, `primary-foreground`/`brand`, `border-strong`/`surface`, `input`/`input-bg` (the field's own edge — ≥ 3:1, and the one most likely to fail in dark), `focus`/`background`, `focus`/`surface-2`. Dark: the same seventeen.

If any pair fails, nudge only that token's L (as the existing comment documents for light `--negative`/`--warning`) and note the change and the new ratio. Do not restructure the palette.

- [ ] **Step 6: Add the three shadcn components**

```bash
npx shadcn add dialog select menu
git status --short components/ui
```
Expected: `components/ui/dialog.tsx`, `components/ui/select.tsx`, `components/ui/menu.tsx` created. Open each and confirm (a) it imports from `@base-ui/react/*`, not `@radix-ui/*`; (b) its hover fill is `bg-accent` — CashFlow's Muted Blue — and if that reads as a coloured wash rather than a quiet hover, change only that class to `bg-muted text-foreground` and note it in a comment. Do **not** hand-edit anything else in these three files.


- [ ] **Step 7: Confirm nothing existing changed**

Run: `npm run test` → the whole existing suite green (this task adds no test of its own; the contrast table is a recorded measurement, not an assertion).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npm run build` → succeeds.
Run: `npx playwright test` → all existing specs green — this task changed no page, so none of them can have moved.

- [ ] **Step 8: Browser visual check — the tokens and the ring, on today's screens**

`npm run dev`, and with a scratch Playwright driver outside the repo: screenshot `/dashboard`, `/transactions` and `/settings` at 1440 in light and dark (6 shots), plus one shot of each after three `Tab` presses (3 shots). Nine screenshots.

Look for: no visual change beyond the ring; the ring visible on a link, a button and an input, against `--surface` **and** `--background`; the three-step dark surface ladder distinguishable; inputs visibly recessed on `--input-bg` rather than washed; no card gaining a shadow.

**Tests required:** none new. The deliverables are the contrast table from Step 5 (written into `app/globals.css`) and the confirmation that the existing suite is untouched.

**Browser visual checks required:** the nine screenshots in Step 8.

**Explicit things NOT to change:** the existing `--background`/`--foreground`/`--brand`/`--accent`/`--positive` values and their documented conversion comments; the light `--negative`/`--warning` deviations documented at `app/globals.css:81-90` (accessibility already outranked the exact hex there, and the reasoning is recorded); `components/ui/button.tsx` and `components/ui/input.tsx` (Task 2a re-skins them); any component, page or layout.

**Completion gate:** the contrast table for **both** themes is in `app/globals.css` with every pair at or above its minimum; the three shadcn files exist and import from `@base-ui/react/*`; four commands green; nine screenshots inspected.

**Proposed commit boundary:**
1. `feat(design): add the Phase 7 token layer — surface-2, border-strong, focus, input-bg, three radii, global focus ring`
2. `chore(ui): add the shadcn dialog, select and menu components`

---

## Task 1b: The static primitives

**Objective:** Build the eleven primitives that render without state — `PageHeader`, `SectionHeader`, `MoneyText`, `StatusBadge`, `Progress`, `EmptyState`, `InlineAlert`, `FormField`/`Label`/`FieldError`/`SELECT_CLASS`, `Skeleton`, `FinancialListRow`, `PlanningRow`, `ChartContainer`, `SegmentedControl` — each with a `renderToStaticMarkup` test, so Tasks 3–12 compose rather than invent.

**Major files touched:** eleven new files under `components/common/`, and their tests.

**Reusable primitives involved:** all of the static ones — this task *is* them.

**User-facing behaviour:** none yet; nothing imports them until Task 3.

**Desktop expectation:** each primitive renders at its spec §2 metrics — verified in Task 1c's gallery at 1440.

**Mobile expectation:** `PageHeader` stacks its actions below the title under 640; `MoneyText` lets the currency code wrap away from the figure but never breaks the figure; `FinancialListRow`'s amount column holds its 8.5 rem at 375; every interactive primitive's target is ≥ 44 px.

**Dark-theme expectation:** `StatusBadge` tints at 10 % light and 18 % dark; `InlineAlert` the same; `Progress`'s track is `bg-muted` on both; nothing carries a shadow (the raised surfaces are Task 1c's).

**Vietnamese/English expectation:** no primitive calls `useTranslations`. Every one takes already-translated strings, which is what lets the same component be rendered from a server page and from inside a client row. `StatusBadge` wraps to a second line rather than truncating, because a Vietnamese status word is longer than its English original.

**Accessibility acceptance criteria:**
- `Progress` exposes `role="progressbar"`, `aria-valuemin=0`, `aria-valuemax=100`, `aria-valuenow` (clamped) and `aria-valuetext` (the true figure) — identical semantics to the four hand-rolled bars it replaces.
- `StatusBadge` always renders text; tone is never the only signal.
- `InlineAlert` with tone `negative` renders `role="alert"`.
- `FormField` renders a real `<label htmlFor>` and wires `aria-describedby` to the helper and error ids; the error carries `role="alert"`.
- `FieldError` translates a Zod message literal through `validation.*` — see the hydration/i18n note below.
- `PageHeader` renders exactly one `h1`; `SectionHeader` renders `h2` or, on request, `h3`, so a page never skips a level.
- `Skeleton` is `aria-hidden="true"`: it is decoration standing in for content, and announcing it on every navigation is worse than silence.

**Hydration/form-submission constraints:** none of these primitives holds state, so none can revert anything. One coupling matters: `FieldError` is the render boundary where a Zod message becomes Vietnamese (spec §4's amended ruling). It calls `useTranslations()` — which makes it, and therefore `FormField`, a **client** component. Every form in the app is already a client component, so this costs nothing; but a *server* page that wants a labelled read-only field must use `Label` directly, which stays server-safe. Say so in `form-field.tsx`'s doc.

**Files:**
- Create: `components/common/page-header.tsx`, `components/common/section-header.tsx`, `components/common/money-text.tsx`, `components/common/status-badge.tsx`, `components/common/progress.tsx`, `components/common/empty-state.tsx`, `components/common/inline-alert.tsx`, `components/common/form-field.tsx`, `components/common/skeleton.tsx`, `components/common/financial-list-row.tsx`, `components/common/planning-row.tsx`, `components/common/chart-container.tsx`, `components/common/segmented-control.tsx`
- Test: `components/common/status-badge.test.tsx`, `money-text.test.tsx`, `empty-state.test.tsx`, `page-header.test.tsx`, `progress.test.tsx`, `financial-list-row.test.tsx`, `planning-row.test.tsx`

**Interfaces:**

- Consumes: `cn` from `'cn'`; `Button`, `buttonVariants` from `@/components/ui/button`; `LucideIcon` from `lucide-react`; the Task 1a tokens by utility name; `validationMessageKey` from `@/lib/ui/validation-messages` (Task 2c) — **`FieldError` imports it, so Task 2c must land before this task's `FormField` can be written; if 1b runs first, write `FieldError` to render the message verbatim and add the `t(validationMessageKey(message))` call in Task 2c's step that creates the module.** Record which order was used.
- Produces:

```ts
// components/common/page-header.tsx
export function PageHeader(props: {
  title: string
  description?: string
  /** A 12 px muted line under the description — the dashboard's FX status. */
  meta?: React.ReactNode
  /** Right-hand side on ≥ 640, stacked under the title below it. */
  actions?: React.ReactNode
  className?: string
}): React.ReactElement

// components/common/section-header.tsx
export function SectionHeader(props: {
  title: string
  caption?: string
  /** `h2` (default) or `h3` — a group inside a section. */
  as?: 'h2' | 'h3'
  right?: React.ReactNode
  className?: string
}): React.ReactElement

// components/common/money-text.tsx
export type MoneySize = 'meta' | 'row' | 'md' | 'lg' | 'kpi' | 'hero'
export type MoneyTone = 'default' | 'positive' | 'negative' | 'muted'
export function MoneyText(props: {
  /** Already formatted by `formatMoney` — this component never formats. */
  value: string
  currency?: string
  tone?: MoneyTone
  /** `meta` 13/400 · `row` 15/600 · `md` 22/600 · `lg` 24/600 · `kpi` 30/600 · `hero` 36/600 */
  size?: MoneySize
  /** `'+'` / `'−'`, rendered before the figure. Ledger rows only. */
  sign?: '+' | '−'
  className?: string
}): React.ReactElement

// components/common/status-badge.tsx
export type StatusTone = 'neutral' | 'positive' | 'warning' | 'negative' | 'brand' | 'muted'
export function StatusBadge(props: { label: string; tone?: StatusTone; className?: string }): React.ReactElement

// components/common/progress.tsx
export function Progress(props: {
  /** 0–100; clamped for the bar width and `aria-valuenow`. */
  percent: number
  /** The TRUE figure, e.g. "120 %" — announced via `aria-valuetext`. */
  valueText: string
  label: string
  tone?: 'brand' | 'positive' | 'warning' | 'negative'
  className?: string
}): React.ReactElement

// components/common/empty-state.tsx
export function EmptyState(props: {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; href: string } | { label: string; onClick: () => void }
  size?: 'widget' | 'page'
}): React.ReactElement

// components/common/inline-alert.tsx
export function InlineAlert(props: {
  tone: 'negative' | 'positive' | 'warning' | 'neutral'
  children: React.ReactNode
  className?: string
}): React.ReactElement

// components/common/form-field.tsx  ('use client' — FieldError translates)
export function FormField(props: {
  id: string
  label: string
  helper?: string
  error?: string
  children: (aria: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': true | undefined
  }) => React.ReactNode
  className?: string
}): React.ReactElement
export function Label(props: { htmlFor: string; children: React.ReactNode; className?: string }): React.ReactElement
export function FieldError(props: { id: string; children: React.ReactNode }): React.ReactElement
/** The class string every styled native `<select>` in the app uses. */
export const SELECT_CLASS: string

// components/common/skeleton.tsx
export function Skeleton(props: { className?: string }): React.ReactElement

// components/common/financial-list-row.tsx
export function FinancialListRow(props: {
  title: React.ReactNode
  meta?: React.ReactNode
  /** Single line, ellipsised, full text in `title`. */
  note?: string | null
  /** Right-hand fixed column: always a `MoneyText`. */
  amount: React.ReactNode
  actions?: React.ReactNode
  className?: string
}): React.ReactElement

// components/common/planning-row.tsx
export function PlanningRow(props: {
  title: React.ReactNode
  badge?: React.ReactNode
  figureLine: React.ReactNode
  progress?: React.ReactNode
  meta?: React.ReactNode
  extra?: React.ReactNode
  actions?: React.ReactNode
  dim?: boolean
  className?: string
}): React.ReactElement

// components/common/chart-container.tsx
export function ChartContainer(props: {
  title: string
  caption?: string
  right?: React.ReactNode
  /** Body height in px — 300, 260 or 240 per the spec's grid. */
  height?: number
  children: React.ReactNode
  className?: string
}): React.ReactElement

// components/common/segmented-control.tsx
export interface Segment { id: string; label: string; href: string }
export function SegmentedControl(props: {
  label: string
  segments: Segment[]
  activeId: string | null
  className?: string
}): React.ReactElement
```

- [ ] **Step 1: Write the failing test for `StatusBadge`**

`components/common/status-badge.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { StatusBadge } from './status-badge'

describe('StatusBadge', () => {
  it('always renders the label as text, so tone is never the only signal', () => {
    const html = renderToStaticMarkup(<StatusBadge label="Quá hạn" tone="negative" />)
    expect(html).toContain('Quá hạn')
  })

  it('tints the background rather than filling it', () => {
    const html = renderToStaticMarkup(<StatusBadge label="Đạt mục tiêu" tone="positive" />)
    expect(html).toContain('bg-positive/10')
    expect(html).toContain('text-positive')
    expect(html).not.toContain('bg-positive ')
  })

  it('defaults to the neutral tone', () => {
    const html = renderToStaticMarkup(<StatusBadge label="Đang thực hiện" />)
    expect(html).toContain('text-muted-foreground')
  })

  it('renders every tone without falling through to undefined classes', () => {
    for (const tone of ['neutral', 'positive', 'warning', 'negative', 'brand', 'muted'] as const) {
      const html = renderToStaticMarkup(<StatusBadge label={tone} tone={tone} />)
      expect(html, tone).not.toContain('undefined')
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run components/common/status-badge.test.tsx`
Expected: FAIL — `Failed to resolve import "./status-badge"`.

- [ ] **Step 3: Write `StatusBadge`**

`components/common/status-badge.tsx`:

```tsx
import { cn } from 'cn'

/**
 * The one status pill in the product (spec §2).
 *
 * Six tones, each a 10 % tint of its own colour (18 % in dark, where a 10 %
 * wash on a charcoal surface is invisible) with the colour itself as the text.
 * A tint rather than a fill because a row can carry two or three of these and
 * six saturated pills would shout louder than the figures beside them.
 *
 * `label` is always rendered. Colour is never the only signal — every caller
 * passes wording that differs per state, so a colour-blind reader and a screen
 * reader get the same fact as everyone else.
 *
 * A server component with no state: it may be rendered from a server page or
 * from inside a client row alike, which is why it takes an already-translated
 * `label` string and never calls `useTranslations` itself.
 */
const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  positive: 'bg-positive/10 text-positive dark:bg-positive/18',
  warning: 'bg-warning/10 text-warning dark:bg-warning/18',
  negative: 'bg-negative/10 text-negative dark:bg-negative/18',
  brand: 'bg-brand/10 text-brand dark:bg-brand/18',
  muted: 'bg-muted text-muted-foreground',
}

export type StatusTone = 'neutral' | 'positive' | 'warning' | 'negative' | 'brand' | 'muted'

export function StatusBadge({
  label,
  tone = 'neutral',
  className,
}: {
  label: string
  tone?: StatusTone
  className?: string
}) {
  return (
    <span
      className={cn(
        // Wraps to a second line rather than truncating (spec §4): a Vietnamese
        // status word is longer than its English original and a clipped badge
        // is a badge that says the wrong thing.
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs/[1rem] font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {label}
    </span>
  )
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run components/common/status-badge.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for `MoneyText`**

`components/common/money-text.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { MoneyText } from './money-text'

describe('MoneyText', () => {
  it('renders the figure with tabular digits and never wraps it', () => {
    const html = renderToStaticMarkup(<MoneyText value="25.000.000" currency="VND" />)
    expect(html).toContain('25.000.000')
    expect(html).toContain('tabular-nums')
    expect(html).toContain('whitespace-nowrap')
  })

  it('puts the currency code after the figure, muted and smaller', () => {
    const html = renderToStaticMarkup(<MoneyText value="100,00" currency="USD" />)
    const figureIndex = html.indexOf('100,00')
    const codeIndex = html.indexOf('USD')
    expect(figureIndex).toBeGreaterThan(-1)
    expect(codeIndex).toBeGreaterThan(figureIndex)
    expect(html).toContain('text-muted-foreground')
  })

  it('omits the code entirely when the caller gives none', () => {
    const html = renderToStaticMarkup(<MoneyText value="1.500" />)
    expect(html).toContain('1.500')
    expect(html).not.toContain('undefined')
  })

  it('renders the sign before the figure for ledger rows', () => {
    const html = renderToStaticMarkup(<MoneyText value="200.000" sign="−" tone="negative" />)
    expect(html).toMatch(/−\s*200\.000|−200\.000/)
    expect(html).toContain('text-negative')
  })

  it('scales from meta to hero without an undefined class', () => {
    for (const size of ['meta', 'row', 'md', 'lg', 'kpi', 'hero'] as const) {
      const html = renderToStaticMarkup(<MoneyText value="1" size={size} />)
      expect(html, size).not.toContain('undefined')
    }
  })

  it('gives md and lg their own sizes, between row and kpi', () => {
    // The dashboard's summary panel puts all three in one card, so a shared
    // class here would flatten the hierarchy spec §6.1 asks for.
    const md = renderToStaticMarkup(<MoneyText value="72.100.000" size="md" />)
    const lg = renderToStaticMarkup(<MoneyText value="30.000.000" size="lg" />)
    expect(md).toContain('text-[1.375rem]/[1.75rem]')
    expect(lg).toContain('text-[1.5rem]/[1.875rem]')
    expect(md).not.toContain('text-[1.5rem]')
  })
})
```

- [ ] **Step 6: Run it, watch it fail, then write `MoneyText`**

Run: `npx vitest run components/common/money-text.test.tsx` → FAIL (unresolved import).

`components/common/money-text.tsx`:

```tsx
import { cn } from 'cn'

/**
 * A money figure on screen (spec §2).
 *
 * It never formats: `value` is already the output of `formatMoney`, which is
 * the single place a `Prisma.Decimal` becomes a string. This component owns
 * only the *typography* of a figure — tabular digits so a column lines up, no
 * mid-number wrap, the currency code trailing at 12/500 muted, and the sign
 * (which comes from the transaction's `type`, never from arithmetic).
 *
 * Expense and neutral figures are `foreground`, not red: only income is
 * positive-toned and only a negative *total* is negative-toned (spec §2), so a
 * page of ordinary spending does not read as a page of errors.
 */
/**
 * Six sizes, all from spec §2's type scale — and `md`/`lg` exist because the
 * dashboard's summary panel needs three distinct weights of figure in one card
 * (§6.1): Net Worth `hero` 36/40, Total Balance `md` 22/28 beneath it, and the
 * three monthly metrics `lg` 24/30 beside it. `kpi` 30/36 is Reports' three
 * equal figures. A panel built from one size has no headline, which was the
 * pre-flight finding.
 */
const SIZE_CLASSES: Record<MoneySize, string> = {
  meta: 'text-[0.8125rem]/[1.125rem] font-normal',
  row: 'text-[0.9375rem]/[1.25rem] font-semibold',
  md: 'text-[1.375rem]/[1.75rem] font-semibold',
  lg: 'text-[1.5rem]/[1.875rem] font-semibold',
  kpi: 'text-[1.625rem]/[2rem] font-semibold md:text-[1.875rem]/[2.25rem]',
  hero: 'text-[1.875rem]/[2.25rem] font-semibold md:text-4xl/[2.5rem]',
}

const TONE_CLASSES: Record<MoneyTone, string> = {
  default: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-negative',
  muted: 'text-muted-foreground',
}

export type MoneySize = 'meta' | 'row' | 'md' | 'lg' | 'kpi' | 'hero'
export type MoneyTone = 'default' | 'positive' | 'negative' | 'muted'

export function MoneyText({
  value,
  currency,
  tone = 'default',
  size = 'row',
  sign,
  className,
}: {
  value: string
  currency?: string
  tone?: MoneyTone
  size?: MoneySize
  sign?: '+' | '−'
  className?: string
}) {
  return (
    // `flex-wrap` with a `whitespace-nowrap` figure: the number may never break
    // mid-digit, but the code is allowed to drop to a second line on a narrow
    // phone rather than force the figure out of its column.
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-1', className)}>
      <span className={cn('whitespace-nowrap tabular-nums', SIZE_CLASSES[size], TONE_CLASSES[tone])}>
        {sign}
        {value}
      </span>
      {currency && (
        <span className="text-xs/[1rem] font-medium text-muted-foreground">{currency}</span>
      )}
    </span>
  )
}
```

Run: `npx vitest run components/common/money-text.test.tsx` → PASS (5 tests).

- [ ] **Step 7: Write the failing test for `EmptyState`**

`components/common/empty-state.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Wallet } from 'lucide-react'

import { EmptyState } from './empty-state'

describe('EmptyState', () => {
  it('says what is missing and offers exactly one way forward', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon={Wallet}
        title="Chưa có tài khoản"
        description="Thêm tài khoản đầu tiên để bắt đầu theo dõi."
        action={{ label: 'Đến Tài khoản', href: '/accounts' }}
      />,
    )
    expect(html).toContain('Chưa có tài khoản')
    expect(html).toContain('Thêm tài khoản đầu tiên để bắt đầu theo dõi.')
    expect(html).toContain('href="/accounts"')
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it('hides its icon from assistive technology — the title carries the meaning', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Wallet} title="Trống" />)
    expect(html).toContain('aria-hidden="true"')
  })

  it('renders without an action or a description', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Wallet} title="Trống" />)
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('undefined')
  })
})
```

- [ ] **Step 8: Run it, watch it fail, then write `EmptyState`**

Run: `npx vitest run components/common/empty-state.test.tsx` → FAIL.

`components/common/empty-state.tsx`:

```tsx
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { cn } from 'cn'
import { buttonVariants } from '@/components/ui/button'
import { Button } from '@/components/ui/button'

/**
 * What a list, widget or filtered view shows instead of nothing (spec §10).
 *
 * Icon, title, one sentence, one action — and never more than one action: an
 * empty screen is where a user is least sure what to do, and two buttons is a
 * question rather than an answer.
 *
 * `size="widget"` is the dashboard's variant (it lives inside a
 * `ChartContainer`, which already draws the border), `size="page"` is a whole
 * list's variant.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'widget',
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; href: string } | { label: string; onClick: () => void }
  size?: 'widget' | 'page'
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        size === 'widget' ? 'min-h-24 py-4' : 'min-h-40 py-8',
      )}
    >
      <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="max-w-[36ch] text-[0.8125rem]/[1.125rem] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action &&
        ('href' in action ? (
          <Link href={action.href} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {action.label}
          </Link>
        ) : (
          <Button type="button" variant="outline" size="lg" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  )
}
```

Run: `npx vitest run components/common/empty-state.test.tsx` → PASS (3 tests).

- [ ] **Step 9: Write `PageHeader`, `SectionHeader` and their test**

`components/common/page-header.tsx`:

```tsx
import { cn } from 'cn'

/**
 * The one `h1` on a page, plus what qualifies it and what can be done from it
 * (spec §5: "every page renders a PageHeader — including Transactions,
 * Transfers, Accounts, Categories and Settings, which have none today").
 *
 * `actions` sits to the right from 640 up and stacks under the title below it
 * (spec §7), so a phone never has a title and a button competing for one line.
 * `meta` is the 12 px line the dashboard's FX status was demoted to.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: string
  description?: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl/[1.875rem] font-semibold md:text-[1.75rem]/[2.125rem]">{title}</h1>
        {description && (
          <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{description}</p>
        )}
        {meta && <div className="text-xs/[1rem] text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
```

`components/common/section-header.tsx`:

```tsx
import { cn } from 'cn'

/**
 * A section's heading inside a page. `as="h3"` for a group *inside* a section
 * (the Reminders page's "Quá hạn" under "Sắp đến hạn"), so the heading order
 * stays h1 → h2 → h3 with nothing skipped (spec §8).
 */
export function SectionHeader({
  title,
  caption,
  as: Tag = 'h2',
  right,
  className,
}: {
  title: string
  caption?: string
  as?: 'h2' | 'h3'
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-2', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <Tag
          className={cn(
            Tag === 'h2'
              ? 'text-[1.125rem]/[1.625rem] font-semibold'
              : 'text-sm/[1.25rem] font-medium',
          )}
        >
          {title}
        </Tag>
        {caption && <p className="text-xs/[1rem] text-muted-foreground">{caption}</p>}
      </div>
      {right}
    </div>
  )
}
```

`components/common/page-header.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { PageHeader } from './page-header'
import { SectionHeader } from './section-header'

describe('PageHeader', () => {
  it('renders exactly one h1', () => {
    const html = renderToStaticMarkup(<PageHeader title="Tổng quan" description="Tháng 9 2026" />)
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Tổng quan')
    expect(html).toContain('Tháng 9 2026')
  })

  it('omits the description, meta and action slots when unused', () => {
    const html = renderToStaticMarkup(<PageHeader title="Cài đặt" />)
    expect(html.match(/<p/g)).toBeNull()
    expect(html).not.toContain('undefined')
  })
})

describe('SectionHeader', () => {
  it('renders an h2 by default and an h3 on request', () => {
    expect(renderToStaticMarkup(<SectionHeader title="Ngân sách" />)).toContain('<h2')
    expect(renderToStaticMarkup(<SectionHeader title="Quá hạn" as="h3" />)).toContain('<h3')
  })
})
```

Run: `npx vitest run components/common/page-header.test.tsx` → PASS (3 tests).

**Check `next-intl`'s missing-key behaviour before relying on the `fallback` option above.** Read `node_modules/next-intl/dist/**` or its docs for `useTranslations`' signature in v4.14: if it does not accept a `fallback`, write the lookup as `const key = validationMessageKey(children); const translated = t.has?.(key) ? t(key) : children` — or, if `t.has` is also absent, wrap it in a try/catch that returns the literal. Whichever form the installed version supports, the behaviour is fixed: a message with no entry renders the English literal, never a key path.

- [ ] **Step 10: Write `Progress` and its test, preserving today's ARIA semantics**

`components/common/progress.tsx`:

```tsx
import { cn } from 'cn'

/**
 * The 6 px progress bar (spec §2), consolidating the three hand-rolled copies
 * in `BudgetProgressList`, `GoalList`, `DebtList` and `LoanList`.
 *
 * The ARIA contract is exactly what those four already had, and it matters:
 * `aria-valuenow` is the CLAMPED width (a bar may fill its track, never
 * overflow it) while `aria-valuetext` carries the TRUE figure — an exceeded
 * budget at 120 % must announce 120 %, not 100 %.
 */
const TONE_CLASSES = {
  brand: 'bg-brand',
  positive: 'bg-positive',
  warning: 'bg-warning',
  negative: 'bg-negative',
} as const

export function Progress({
  percent,
  valueText,
  label,
  tone = 'brand',
  className,
}: {
  percent: number
  valueText: string
  label: string
  tone?: keyof typeof TONE_CLASSES
  className?: string
}) {
  const width = Math.min(100, Math.max(0, percent))
  return (
    <div
      role="progressbar"
      aria-valuenow={width}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText}
      aria-label={label}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
    >
      <div className={cn('h-full', TONE_CLASSES[tone])} style={{ width: `${width}%` }} />
    </div>
  )
}
```

`components/common/progress.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { Progress } from './progress'

describe('Progress', () => {
  it('clamps the bar width and aria-valuenow but announces the true figure', () => {
    const html = renderToStaticMarkup(
      <Progress percent={120} valueText="120 %" label="Overall budget" tone="negative" />,
    )
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuetext="120 %"')
    expect(html).toContain('width:100%')
  })

  it('never runs backwards', () => {
    const html = renderToStaticMarkup(<Progress percent={-5} valueText="0 %" label="x" />)
    expect(html).toContain('aria-valuenow="0"')
    expect(html).toContain('width:0%')
  })

  it('carries the full progressbar contract', () => {
    const html = renderToStaticMarkup(<Progress percent={42} valueText="42 %" label="Emergency fund" />)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="100"')
    expect(html).toContain('aria-label="Emergency fund"')
  })
})
```

Run: `npx vitest run components/common/progress.test.tsx` → PASS (3 tests).

- [ ] **Step 11: Write `InlineAlert`, `FormField`/`Label`/`FieldError` and `Skeleton`**

`components/common/inline-alert.tsx`:

```tsx
import { cn } from 'cn'

/**
 * A page- or form-level message (spec §10). Tone `negative` also gets
 * `role="alert"`, so a failure that appears after a submit is announced
 * without the user having to go looking for it; the other tones are
 * informational and are not interruptions.
 */
const TONE_CLASSES = {
  negative: 'border-negative/30 bg-negative/10 text-negative dark:bg-negative/18',
  positive: 'border-positive/30 bg-positive/10 text-positive dark:bg-positive/18',
  warning: 'border-warning/30 bg-warning/10 text-warning dark:bg-warning/18',
  neutral: 'border-border bg-muted text-foreground',
} as const

export function InlineAlert({
  tone,
  children,
  className,
}: {
  tone: keyof typeof TONE_CLASSES
  children: React.ReactNode
  className?: string
}) {
  return (
    <p
      role={tone === 'negative' ? 'alert' : undefined}
      className={cn('rounded-md border px-3 py-2 text-[0.8125rem]/[1.125rem]', TONE_CLASSES[tone], className)}
    >
      {children}
    </p>
  )
}
```

`components/common/form-field.tsx`:

```tsx
'use client'

import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { validationMessageKey } from '@/lib/ui/validation-messages'

/**
 * One labelled field (spec §2, §8): a visible `<label htmlFor>` above the
 * control, optional 12 px helper, and an error bound to the control through
 * `aria-describedby` — the three things every input in this app was missing.
 *
 * The control is a render prop rather than `children`, because the ids have to
 * land ON the control and only the caller knows what it is (an `Input`, a
 * native `<select>`, a shadcn `Select`). The callback hands back exactly the
 * three attributes to spread.
 *
 * A CLIENT module, and deliberately: `FieldError` below translates a Zod
 * message literal, which needs a translator. `label` and `helper` still arrive
 * already translated from the caller; only the ERROR is translated here,
 * because only the error's text comes from a schema rather than from a message
 * file. Every form in this app is already a client component, so the boundary
 * costs nothing; a server page that wants a labelled read-only field uses
 * `Label` directly.
 */
export function FormField({
  id,
  label,
  helper,
  error,
  children,
  className,
}: {
  id: string
  label: string
  helper?: string
  error?: string
  children: (aria: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': true | undefined
  }) => React.ReactNode
  className?: string
}) {
  const helperId = helper ? `${id}-helper` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [helperId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {helper && (
        <p id={helperId} className="text-xs/[1rem] text-muted-foreground">
          {helper}
        </p>
      )}
      {error && <FieldError id={errorId!}>{error}</FieldError>}
    </div>
  )
}

export function Label({
  htmlFor,
  children,
  className,
}: {
  htmlFor: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('text-[0.8125rem]/[1.125rem] font-medium text-foreground', className)}
    >
      {children}
    </label>
  )
}

/**
 * A native `<select>` styled to match `Input` (spec §2: native is the default;
 * a custom Select is only for the transaction Category and Account pickers).
 *
 * Exported from here rather than copied into the nine forms that need it, so
 * "a select looks like an input" is one string and not nine. `appearance-none`
 * plus `pr-9` leaves room for the chevron, which the caller renders as a
 * `<ChevronDown className="pointer-events-none absolute right-3 …" />` sibling
 * inside a `relative` wrapper — an inline data-URI background image was tried
 * first and its escaping is brittle in Tailwind v4's arbitrary-value parser.
 */
export const SELECT_CLASS =
  'h-11 w-full min-w-0 appearance-none rounded-md border border-input bg-[var(--input-bg)] px-3 py-2 pr-9 text-base transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 md:h-10 md:text-sm'

/**
 * A field's error — and the render boundary where a Zod message becomes
 * Vietnamese (spec §4).
 *
 * The schemas in `lib/validation/**` keep their English literals: Phase 2–6
 * tests assert them, the server re-produces them, and changing them would be a
 * validation-semantics change this phase forbids. So the translation happens
 * HERE, keyed by the literal itself — `t('validation.Enter an amount')` — with
 * the literal as its own fallback, so a message that somehow has no entry
 * degrades to readable English rather than to a key path.
 *
 * `validationMessageKey` is what builds that key (and what the extraction test
 * in Task 2c shares), so the escaping of a literal containing a dot lives in
 * one place.
 *
 * This is why `form-field.tsx` is a client module: it needs a translator. Every
 * form in the app is already a client component, so it costs nothing — and
 * `Label` alone stays usable from a server page.
 */
export function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  const t = useTranslations()
  const message =
    typeof children === 'string' ? t(validationMessageKey(children), { fallback: children }) : children

  return (
    // `role="alert"` so a validation message that appears on submit is
    // announced, and `aria-describedby` (wired by `FormField`) so a screen
    // reader also reads it when focus lands back on the field.
    <p id={id} role="alert" className="text-xs/[1rem] text-negative">
      {message}
    </p>
  )
}
```

`components/common/skeleton.tsx`:

```tsx
import { cn } from 'cn'

/**
 * A grey bar in the shape of the content that is coming (spec §10: "grey bars
 * in the real layout, no spinners"). `animate-pulse` is the one animation this
 * design system keeps, and the `prefers-reduced-motion` rule in
 * `app/globals.css` neutralises it for users who asked for stillness.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} />
}
```
- [ ] **Step 12: Write `FinancialListRow`, `PlanningRow`, `ChartContainer`, `SegmentedControl` and the two row tests**

`components/common/financial-list-row.tsx`:

```tsx
import { cn } from 'cn'

/**
 * A ledger row — a transaction, a transfer, an account (spec §6.2).
 *
 * The amount column is a FIXED `min-w-[8.5rem]`, right-aligned, and that is the
 * whole reason this component exists: a VND figure and a long note previously
 * shared one flexible line and collided at 375 px. The note is single-line and
 * ellipsised with its full text in `title`, so nothing is lost and nothing
 * pushes the figure off the row.
 *
 * Rows live inside ONE bordered surface and are separated by 1 px dividers —
 * never a card each (spec §2: "never a card inside a card"). The divider is the
 * parent `<ul>`'s `divide-y`, not this row's border.
 */
export function FinancialListRow({
  title,
  meta,
  note,
  amount,
  actions,
  className,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  note?: string | null
  amount: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <li className={cn('flex items-center gap-3 px-4 py-3', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-sm/[1.25rem] font-medium">{title}</div>
        {meta && (
          <div className="truncate text-xs/[1rem] text-muted-foreground">{meta}</div>
        )}
        {note && (
          // `title` carries the full text, so nothing is lost to the ellipsis.
          <div title={note} className="truncate text-xs/[1rem] text-muted-foreground">
            {note}
          </div>
        )}
      </div>
      <div className="flex min-w-[8.5rem] shrink-0 justify-end text-right">{amount}</div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </li>
  )
}
```

`components/common/planning-row.tsx`:

```tsx
import { cn } from 'cn'

/**
 * A planning row — a budget, a savings goal, a debt, a loan, a reminder
 * definition (spec §6.5).
 *
 * One shape for all five, because they are the same shape: a thing with a
 * target, a status, how far along it is, and one or two things you can do about
 * it. Before this, four files each drew their own version of it and they had
 * drifted apart on padding, badge placement and where the actions went.
 *
 * Rows sit inside one bordered surface with `divide-y` dividers, like
 * `FinancialListRow` — not one card each.
 */
export function PlanningRow({
  title,
  badge,
  figureLine,
  progress,
  meta,
  extra,
  actions,
  dim,
  className,
}: {
  title: React.ReactNode
  badge?: React.ReactNode
  figureLine: React.ReactNode
  progress?: React.ReactNode
  meta?: React.ReactNode
  extra?: React.ReactNode
  actions?: React.ReactNode
  dim?: boolean
  className?: string
}) {
  return (
    <li className={cn('flex flex-col gap-2 px-4 py-3', dim && 'opacity-70', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm/[1.25rem] font-medium">{title}</span>
          {badge}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
        </div>
      </div>
      <div className="text-[0.9375rem]/[1.25rem] tabular-nums">{figureLine}</div>
      {progress}
      {meta && <div className="text-xs/[1rem] text-muted-foreground">{meta}</div>}
      {extra}
    </li>
  )
}
```

`components/common/chart-container.tsx`:

```tsx
import { cn } from 'cn'

/**
 * One widget's frame, and the one visual language every chart and list widget
 * on the dashboard and Reports shares (spec §6.1: "no chart forest ... one
 * visual language, no nested cards").
 *
 * Replaces `components/dashboard/dashboard-section.tsx`. Same card title
 * treatment (13/600 uppercase muted), same hairline border, no shadow — plus an
 * explicit body `height`, because the spec's grid specifies 300 / 260 / 240 per
 * row and a ragged row of charts was one of the pre-flight findings.
 */
export function ChartContainer({
  title,
  caption,
  right,
  height,
  children,
  className,
}: {
  title: string
  caption?: string
  right?: React.ReactNode
  height?: number
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col rounded-lg border border-border bg-surface p-4', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[0.8125rem]/[1.125rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {title}
          </h2>
          {caption && <p className="text-xs/[1rem] text-muted-foreground">{caption}</p>}
        </div>
        {right}
      </div>
      {/* `min-w-0` so a recharts ResponsiveContainer inside a grid cell can
          shrink below its content width instead of widening the page. */}
      <div className="mt-3 min-w-0 flex-1" style={height ? { height } : undefined}>
        {children}
      </div>
    </section>
  )
}
```

`components/common/segmented-control.tsx`:

```tsx
import Link from 'next/link'
import { cn } from 'cn'

/**
 * A real segmented control (spec §6.8): one bordered track, the active segment
 * visibly *selected* rather than merely tinted — which was the pre-flight
 * finding against the Reports period filter and the Reminders tabs.
 *
 * Ordinary links, so the address bar stays the single source of truth for which
 * segment is showing and the control works before (and without) JavaScript —
 * the same reasoning `components/reports/period-filter.tsx` and
 * `components/budgets/month-nav.tsx` already gave for their links.
 */
export interface Segment {
  id: string
  label: string
  href: string
}

export function SegmentedControl({
  label,
  segments,
  activeId,
  className,
}: {
  label: string
  segments: Segment[]
  activeId: string | null
  className?: string
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        'inline-flex max-w-full overflow-x-auto rounded-md border border-border bg-surface p-0.5',
        className,
      )}
    >
      {segments.map((segment) => {
        const active = segment.id === activeId
        return (
          <Link
            key={segment.id}
            href={segment.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm whitespace-nowrap',
              active
                ? 'bg-muted font-medium text-brand'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {segment.label}
          </Link>
        )
      })}
    </nav>
  )
}
```

`components/common/financial-list-row.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { FinancialListRow } from './financial-list-row'
import { MoneyText } from './money-text'

describe('FinancialListRow', () => {
  it('gives the amount a fixed column so a long note can never push it out', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow
        title="Ăn uống"
        meta="Cash · 12:40"
        note={'x'.repeat(300)}
        amount={<MoneyText value="200.000" currency="VND" sign="−" tone="negative" />}
      />,
    )
    expect(html).toContain('min-w-[8.5rem]')
    expect(html).toContain('200.000')
  })

  it('keeps the whole note in `title` while showing one ellipsised line', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow title="Ăn uống" note="Bữa trưa với khách hàng" amount={<span>1</span>} />,
    )
    expect(html).toContain('title="Bữa trưa với khách hàng"')
    expect(html).toContain('truncate')
  })

  it('renders no note element at all when there is none', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow title="Ăn uống" note={null} amount={<span>1</span>} />,
    )
    expect(html).not.toContain('title="')
    expect(html).not.toContain('undefined')
  })
})
```

`components/common/planning-row.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { PlanningRow } from './planning-row'
import { Progress } from './progress'
import { StatusBadge } from './status-badge'

describe('PlanningRow', () => {
  it('renders title, badge, figure line, progress and meta in that order', () => {
    const html = renderToStaticMarkup(
      <PlanningRow
        title="Ăn uống"
        badge={<StatusBadge label="Sắp vượt" tone="warning" />}
        figureLine="3.720.000 / 20.000.000 VND · còn 16.280.000 · 19 %"
        progress={<Progress percent={19} valueText="19 %" label="Ăn uống" tone="warning" />}
        meta="Tháng 9 2026"
      />,
    )
    const order = ['Ăn uống', 'Sắp vượt', '3.720.000', 'role="progressbar"', 'Tháng 9 2026'].map(
      (needle) => html.indexOf(needle),
    )
    expect(order.every((index) => index > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('dims an archived row without hiding it', () => {
    const html = renderToStaticMarkup(<PlanningRow title="Cũ" figureLine="0" dim />)
    expect(html).toContain('opacity-70')
    expect(html).toContain('Cũ')
  })
})
```

Run: `npx vitest run components/common` → PASS (all seven primitive test files).


- [ ] **Step 13: Full verification**

Run: `npx vitest run components/common` → PASS (all seven primitive test files).
Run: `npm run test` → the whole suite green, every Phase 2–6 test included.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green; this task changed no page.
Run: `npm run build` → succeeds.

**Tests required:**
- Vitest: `status-badge.test.tsx` (4), `money-text.test.tsx` (6 — the five below plus one asserting `md` and `lg` render their own sizes), `empty-state.test.tsx` (3), `page-header.test.tsx` (3), `progress.test.tsx` (3), `financial-list-row.test.tsx` (3), `planning-row.test.tsx` (2).
- Playwright: none — this task ships no user-reachable UI.

**Browser visual checks required:** none of its own; Task 1c's gallery is where all of these are seen together, and it is the checkpoint's evidence.

**Explicit things NOT to change:** `app/globals.css` (Task 1a owns it); `components/ui/*`; any page, layout or module component; the ARIA contract of the four hand-rolled progress bars this task's `Progress` replaces — it must be preserved exactly, which is what its test asserts.

**Completion gate:** all five commands green; every primitive has a test and every test passes; no primitive imports `useTranslations` except `FieldError`, and its reason is documented.

**Proposed commit boundary:**
1. `feat(design): add the static frontend primitives with static-markup tests`

---

## Task 1c: The overlay primitives, the submit lock, and the gallery

**Objective:** Build the four primitives that need client state — `Dialog`, `ConfirmDialog`, `Sheet`, `RowActionsMenu` — plus `useSubmitState`, the in-flight lock every mutating form uses; then stand up a temporary gallery route, screenshot every primitive at three widths in both themes, and delete it.

**Major files touched:** `components/common/dialog.tsx`, `confirm-dialog.tsx`, `sheet.tsx`, `row-actions-menu.tsx`; `lib/ui/use-submit-state.ts`; a temporary `app/(app)/__gallery/page.tsx`.

**Reusable primitives involved:** the four overlays; the eleven static ones from Task 1b are the gallery's subjects.

**User-facing behaviour:** none yet — nothing imports the overlays until Task 3's More sheet.

**Desktop expectation:** `Dialog` is a centred card at most 480 px from 640 up; `Sheet` is a right-hand 480 px panel from 640 up; `RowActionsMenu`'s trigger is 36×36 and its popup is anchored bottom-end.

**Mobile expectation:** both `Dialog` and `Sheet` are bottom-anchored below 640, at most 85 vh, scrolling inside themselves; the menu trigger's touch box is ≥ 44 px.

**Dark-theme expectation:** all four sit on `--surface-2` with the one soft shadow the design system allows (`0 8px 24px rgba(0,0,0,.40)` in dark), and `--border-strong` divides inside them where a 14 % hairline would disappear.

**Vietnamese/English expectation:** every string is a prop — titles, descriptions, the close label, the confirm/cancel labels, the pending label, each action's label. No overlay calls `useTranslations`.

**Accessibility acceptance criteria:**
- `Dialog` and `Sheet` render `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at their title; they trap focus, restore focus to the opener on close, and close on Escape and on an overlay click. All six come from Base UI's Dialog, which is exactly why it is used rather than a hand-rolled overlay.
- `ConfirmDialog`'s initial focus is **not** the confirm button — a destructive dialog must not confirm on a stray Enter. Verify where Base UI puts it and, if it lands on Confirm, set the initial focus to Cancel explicitly.
- `RowActionsMenu`'s trigger has an `aria-label` naming its row; the menu is arrow-key navigable, closes on Escape and returns focus to the trigger.
- Motion is ≤ 150 ms opacity/transform and is neutralised by Task 1a's `prefers-reduced-motion` rule.

**Hydration/form-submission constraints:** `useSubmitState` is a hook, not a component, and introduces no controlled state. It never touches `useHydrated`'s gate — a form's fieldset is disabled when `!hydrated || locked`, two independent reasons expressed on the same `<fieldset>`. `run` always unlocks, success or failure: a form that stayed locked after a rejected submit would strand the user with their own typing.

**Files:**
- Create: `components/common/dialog.tsx`, `components/common/confirm-dialog.tsx`, `components/common/sheet.tsx`, `components/common/row-actions-menu.tsx`, `lib/ui/use-submit-state.ts`, `lib/ui/use-submit-state.test.tsx`
- Create then **delete**: `app/(app)/__gallery/page.tsx`
- Test: `lib/ui/use-submit-state.test.tsx`

**Interfaces:**

- Consumes: `components/ui/dialog.tsx`, `components/ui/menu.tsx` (Task 1a); `Button` from `@/components/ui/button`; every Task 1b primitive (the gallery renders them).
- Produces:

```ts
// components/common/dialog.tsx  ('use client')
export function Dialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  /** Rendered in the footer, right-aligned. */
  footer?: React.ReactNode
}): React.ReactElement

// components/common/confirm-dialog.tsx  ('use client')
export function ConfirmDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  /** May be async; the dialog shows `pendingLabel` and locks both buttons. */
  onConfirm: () => void | Promise<void>
  pendingLabel: string
  tone?: 'negative' | 'brand'
}): React.ReactElement

// components/common/sheet.tsx  ('use client')
export function Sheet(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  closeLabel: string
  children: React.ReactNode
}): React.ReactElement

// components/common/row-actions-menu.tsx  ('use client')
export interface RowAction {
  id: string
  label: string
  onSelect: () => void
  tone?: 'default' | 'negative'
  disabled?: boolean
}
export function RowActionsMenu(props: { label: string; actions: RowAction[] }): React.ReactElement

// lib/ui/use-submit-state.ts
export interface SubmitState {
  pending: boolean
  /** `disabled` for the `<fieldset>` — true while pending. */
  locked: boolean
  /** `aria-busy` for the `<fieldset>` — `true` while pending, else `undefined`. */
  busy: true | undefined
  /** Wraps a submit handler: locks, awaits, always unlocks. */
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>
}
export function useSubmitState(): SubmitState
```

- [ ] **Step 1: Write `Dialog`, `ConfirmDialog`, `Sheet` and `RowActionsMenu` over the shadcn primitives**

`components/common/dialog.tsx`:

```tsx
'use client'

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from 'cn'

/**
 * The app's modal (spec §2, §7, §8).
 *
 * Base UI's Dialog already gives the whole accessibility contract — `role`,
 * `aria-modal`, the focus trap, focus restoration to the opener, Escape and
 * overlay dismissal — so this file adds only CashFlow's surface: `--surface-2`,
 * the one soft shadow the design system allows, radius 10, and the
 * below-640 behaviour the spec asks for (a dialog becomes a bottom sheet).
 *
 * `aria-labelledby` is wired by rendering the title through
 * `DialogPrimitive.Title`, and the description through `.Description`, rather
 * than by hand-written ids that a later edit could unpick.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-foreground/20 transition-opacity duration-150 dark:bg-black/50" />
        <DialogPrimitive.Popup
          className={cn(
            'fixed z-50 flex flex-col gap-4 border border-border bg-surface-2 p-6 shadow-[0_8px_24px_rgba(25,33,30,0.10)] transition-transform duration-150 dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]',
            // Below 640 it is a bottom sheet (spec §7); from 640 up, a centred
            // card at most 480 px wide.
            'inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-lg',
            'sm:top-1/2 sm:left-1/2 sm:bottom-auto sm:inset-x-auto sm:w-[30rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogPrimitive.Title className="text-[1.125rem]/[1.625rem] font-semibold">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label={title}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </DialogPrimitive.Close>
          </div>
          {children}
          {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
```

If `components/ui/dialog.tsx` (Step 6) already exports a composed `Dialog`/`DialogContent`/`DialogTitle` set over the same Base UI primitive, import those instead of `@base-ui/react/dialog` directly and keep this file's classes — read that file first and follow whichever shape it actually has. Do not hand-copy Radix.

`components/common/confirm-dialog.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from './dialog'

/**
 * The only destructive confirmation in the product (spec §10). It replaces
 * every `window.confirm` — a native dialog that cannot be styled, cannot be
 * translated, cannot be tested without a `page.once('dialog')` handler, and
 * says nothing about what the action actually does.
 *
 * The confirm button is the ONE place a solid `negative` fill is allowed
 * (spec §2); in a row, a destructive action is a ghost.
 *
 * `onConfirm` may be async: both buttons lock and the confirm button shows
 * `pendingLabel` until it settles, so a slow server action cannot be
 * double-submitted from here. The dialog closes on success and stays open on
 * failure, where the caller's own `InlineAlert` explains why.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  pendingLabel,
  tone = 'negative',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void | Promise<void>
  pendingLabel: string
  tone?: 'negative' | 'brand'
}) {
  const [pending, setPending] = useState(false)

  async function confirm() {
    setPending(true)
    try {
      await onConfirm()
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={pending}
            onClick={confirm}
            className={
              tone === 'negative'
                ? 'bg-negative text-white hover:bg-negative/90'
                : undefined
            }
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
```

`components/common/sheet.tsx`:

```tsx
'use client'

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from 'cn'

/**
 * The side/bottom panel (spec §5, §6): a right-hand 480 px sheet from 640 up,
 * a bottom sheet below it. Used for every creation form except the
 * always-visible Transactions one, and for the mobile "More" navigation.
 *
 * Built on the same Base UI Dialog as `Dialog`, and for the same reason: the
 * focus trap, focus restoration, Escape and overlay dismissal are the whole
 * point of the primitive, and the spec requires all four. There are no swipe
 * gestures here and none are coming (spec §1 non-goals).
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  closeLabel: string
  children: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-foreground/20 transition-opacity duration-150 dark:bg-black/50" />
        <DialogPrimitive.Popup
          className={cn(
            'fixed z-50 flex flex-col gap-4 border-border bg-surface-2 p-6 shadow-[0_8px_24px_rgba(25,33,30,0.10)] transition-transform duration-150 dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]',
            'inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-lg border-t',
            'sm:inset-y-0 sm:right-0 sm:left-auto sm:bottom-auto sm:w-[30rem] sm:max-w-full sm:rounded-none sm:border-t-0 sm:border-l',
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogPrimitive.Title className="text-[1.125rem]/[1.625rem] font-semibold">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label={closeLabel}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
```

`components/common/row-actions-menu.tsx`:

```tsx
'use client'

import { Menu } from '@base-ui/react/menu'
import { MoreHorizontal } from 'lucide-react'
import { cn } from 'cn'

/**
 * A row's `…` menu (spec §6): everything that is not the row's one primary
 * inline action.
 *
 * Base UI's Menu carries the keyboard contract — arrow keys, Home/End,
 * type-ahead, Escape, and focus back to the trigger — which is why this is not
 * a hand-rolled `useState` dropdown. The trigger is a 36×36 icon button with an
 * `aria-label` naming the row, so a page of ten of them does not present ten
 * buttons called "More".
 */
export interface RowAction {
  id: string
  label: string
  onSelect: () => void
  tone?: 'default' | 'negative'
  disabled?: boolean
}

export function RowActionsMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="z-50 min-w-40 rounded-lg border border-border bg-surface-2 p-1 shadow-[0_8px_24px_rgba(25,33,30,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]">
            {actions.map((action) => (
              <Menu.Item
                key={action.id}
                disabled={action.disabled}
                onClick={action.onSelect}
                className={cn(
                  'flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-disabled:opacity-50',
                  action.tone === 'negative' ? 'text-negative' : 'text-foreground',
                )}
              >
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
```

Read `components/ui/menu.tsx` from Step 6 first: if it already wraps these Base UI parts with CashFlow classes, import its exports here and keep only the trigger/`aria-label` and tone logic in this file.
- [ ] **Step 2: Write `useSubmitState` and its test**

`lib/ui/use-submit-state.ts`:

```ts
import { useCallback, useState } from 'react'

/**
 * The in-flight lock every mutating form uses (spec §9).
 *
 * `useHydrated()` answers "may the user touch this form yet?"; this answers
 * "is a submission already on its way?". They are independent reasons to
 * disable the same `<fieldset>`, and both are expressed there:
 *
 *   <fieldset disabled={!hydrated || locked} aria-busy={busy}>
 *
 * A `<fieldset disabled>` is the one native mechanism that disables everything
 * inside it, submit button included, so a second submit is impossible while the
 * first is running — without any per-control `disabled` prop, and without
 * introducing controlled state (which would trip the Base UI warning the spec
 * forbids silencing that way).
 *
 * `run` always unlocks, success or failure: a form that stayed locked after a
 * rejected submit would strand the user with their own typing.
 */
export interface SubmitState {
  pending: boolean
  locked: boolean
  busy: true | undefined
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>
}

export function useSubmitState(): SubmitState {
  const [pending, setPending] = useState(false)

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    // A guard, not just an optimisation: `run` can be reached from a keyboard
    // Enter and a click in the same tick before React has re-rendered the
    // disabled fieldset.
    if (pending) return undefined
    setPending(true)
    try {
      return await work()
    } finally {
      setPending(false)
    }
  }, [pending])

  return { pending, locked: pending, busy: pending ? true : undefined, run }
}
```

`lib/ui/use-submit-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { useSubmitState } from './use-submit-state'

/**
 * No jsdom and no Testing Library in this repo, so the hook is exercised the
 * one way a server render allows: its INITIAL state, which is the state the
 * server HTML is built from and therefore the one a hydration bug would
 * expose. The in-flight transition itself is covered end-to-end by
 * `e2e/phase7-a11y-forms.spec.ts`'s double-submit test, which is where a lock
 * can actually be observed.
 */
function Probe() {
  const { pending, locked, busy } = useSubmitState()
  return (
    <fieldset data-pending={String(pending)} disabled={locked} aria-busy={busy}>
      <button type="submit">go</button>
    </fieldset>
  )
}

describe('useSubmitState', () => {
  it('starts unlocked, so the server HTML is never a disabled form', () => {
    const html = renderToStaticMarkup(<Probe />)
    expect(html).toContain('data-pending="false"')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('aria-busy')
  })
})
```

Rename the file to `lib/ui/use-submit-state.test.tsx` (it contains JSX; `vitest.config.mts:17-28` includes `lib/**/*.test.tsx`).

Run: `npx vitest run lib/ui/use-submit-state.test.tsx` → PASS.
- [ ] **Step 3: Confirm nothing existing changed**

Run: `npm run test`
Expected: the whole suite green, including every Phase 2–6 test, with the new primitive tests added.

Run: `npm run lint && npm run format:check && npx tsc --noEmit`
Expected: all clean.

Run: `npx playwright test`
Expected: all existing specs green — this task changed no page, so none of them can have moved.

- [ ] **Step 4: Browser visual check — the primitive gallery**

Create a scratch page **outside the repo** is not possible for a Next route, so use a temporary route and delete it in the same step:

1. `npm run dev`
2. Create `app/(app)/__gallery/page.tsx`. It is a real `(app)` page, so it opens with `await requireUserOrRedirect()` like every other one — a layout is not an auth boundary (`app/(app)/settings/page.tsx:7-11`), and a scaffold that skips the redirect is a scaffold that renders for a signed-out visitor. Then, in one column at `max-w-[60rem] p-8`: a `PageHeader` with actions; a `SectionHeader`; all six `StatusBadge` tones in a row; `MoneyText` at all four sizes with VND and USD; `Progress` at 19 %, 84 % and 120 %; an `EmptyState` (page size); all four `InlineAlert` tones; a `FormField` with helper and with error wrapping an `Input` (the gallery page must be a client component, or must render the `FormField` block from a small client child, because `FormField` is one — Task 1b's doc says why); a `<ul className="divide-y divide-border rounded-lg border border-border bg-surface">` holding three `FinancialListRow`s and three `PlanningRow`s; a `ChartContainer` with a grey box inside; a `SegmentedControl`; a `RowActionsMenu`; buttons that open a `Dialog`, a `ConfirmDialog` and a `Sheet`.
3. With a scratch Playwright driver written **outside the repo** (e.g. in the session scratchpad directory), screenshot `/​__gallery` at widths 375, 768 and 1440, in light and in dark (`document.documentElement.classList.add('dark')`), into that same scratch directory. Six screenshots.
4. Inspect them and confirm: no gradient, no glassmorphism, no shadow on any card (only on the dialog/sheet/menu popups), no radius above 10 px except the `rounded-full` badge/progress track, every badge legible in dark, the focus ring visible when tabbing (take one extra screenshot after `page.keyboard.press('Tab')` three times), the dialog centred at 1440 and bottom-anchored at 375, the sheet right-anchored at 1440 and bottom-anchored at 375.
5. `rm -r "app/(app)/__gallery"` — the gallery is a visual-check scaffold and must not be committed. Confirm with `git status --short app` that nothing under `app/(app)/__gallery` remains, and that `npm run build`'s route table no longer lists it.

**Tests required:** `components/common/status-badge.test.tsx` (4), `money-text.test.tsx` (5), `empty-state.test.tsx` (3), `page-header.test.tsx` (3), `progress.test.tsx` (3), `financial-list-row.test.tsx` (3), `planning-row.test.tsx` (2), `lib/ui/use-submit-state.test.tsx` (1). No Playwright spec — this task ships no user-reachable UI.

**Browser visual checks required:** the six-screenshot primitive gallery in Step 22 (375/768/1440 × light/dark) plus one focus-ring screenshot. Look for: shadow only on raised surfaces; the three-step dark surface ladder actually visible; badge and money contrast; dialog/sheet anchoring at each width.

**Explicit things NOT to change:** no page, layout or module component; no view model; `components/ui/button.tsx` and `components/ui/input.tsx` stay as they are (Task 2 re-skins them to the 40/44 px heights); the existing `--background`/`--foreground`/`--brand`/`--accent`/`--positive` values and their documented conversion comments; the `--negative`/`--warning` light-mode deviations documented at `app/globals.css:81-90`.

**Completion gate:** `npm run test`, `npm run lint`, `npm run format:check`, `npx tsc --noEmit` and `npx playwright test` all green; the contrast table from Step 5 is written into `app/globals.css` with every pair ≥ its minimum; the seven screenshots exist and have been inspected; `app/(app)/__gallery` is gone.

**Proposed commit boundary:**
1. `feat(design): add the Phase 7 token layer — surface-2, border-strong, focus, three radii, global focus ring`
2. `feat(design): add the reusable frontend primitives with static-markup tests`

---
## Task 2a: Theme and locale resolution, the root layout, and the control re-skin

**Objective:** Make the saved `User.theme` and `User.locale` actually change what renders — server-side, on the first paint, with no client flip — by adding `resolveTheme()`, extending `resolveLocale()` to prefer the session, mirroring both preferences into cookies from `updateProfile` and from login, and rendering `<html class="dark" lang="…" style="color-scheme:…">` from the root layout. Also re-skin `Button`/`Input` to the spec's 40/44 px control sizes, because every form task from here on depends on them.

**Major files touched:** `lib/theme/config.ts` (new), `lib/i18n/locale.ts` (new), `lib/i18n/config.ts`, `app/layout.tsx`, `lib/server/actions/update-profile.ts`, `lib/server/actions/sync-preference-cookies.ts` (new), `components/auth/login-form.tsx`, `components/ui/button.tsx`, `components/ui/input.tsx`.

**Reusable primitives involved:** none rendered here; this task sizes the two controls every `FormField` wraps.

**User-facing behaviour:** changing Giao diện in Settings and reloading paints in the new theme immediately with no flash of the old one; changing Ngôn ngữ switches the UI language on the next server render; logging in on a fresh browser paints in the theme and language saved on the account rather than the defaults. Control heights become 40 px on desktop and 44 px on touch.

**Desktop expectation:** at 1440, `<html>` carries `class="… dark"` in the very first HTML byte when the theme is dark; `color-scheme: dark` makes native scrollbars and the `<input type="date">` picker dark too.

**Mobile expectation:** inputs are 44 px tall (touch target ≥ 44 px, spec §8); the `theme-color` meta makes the browser chrome match the app background.

**Dark-theme expectation:** this task is what *delivers* dark theme. `resolveTheme()` returns `'dark'` → `<html class="dark" style="color-scheme:dark">` → every Task 1a token flips. No `useEffect` anywhere touches the class on load. Inputs sit on `--input-bg` (Task 1a) rather than a translucent `bg-input/30`, so a field on `--surface-2` reads the same as one on `--surface`.

**Vietnamese/English expectation:** `resolveLocale()` prefers the session user's `locale`, then the `NEXT_LOCALE` cookie, then `vi`. `<html lang>` is the resolved locale. No copy moves in this task — Task 2b owns the message files.

**Accessibility acceptance criteria:**
- `color-scheme` is set from the resolved theme, so native form controls and scrollbars honour it.
- `<html lang>` is the resolved locale, so a screen reader pronounces Vietnamese as Vietnamese.
- `Input` is ≥ 44 px tall below `md` and 40 px from `md` up.
- `Button`'s default size is 40 px (`h-10`), compact 36 px (`h-9`), icon 36×36 — every icon button keeps its `aria-label`.
- Task 1a's global focus ring is not overridden: `Button`'s and `Input`'s own `focus-visible:ring-3` stacks are **removed** in favour of it.

**Hydration/form-submission constraints:** no theme class is ever written from the client on load. The one client-side write is the *optimistic* toggle after a successful Settings save (Task 11), which is a user action and not a load-time flip. `syncPreferenceCookies()` is called from the login form only after a successful sign-in and before `router.push('/dashboard')`, so the very first authenticated render already has both cookies.

**Files:**
- Create: `lib/theme/config.ts`, `lib/theme/config.test.ts`, `lib/i18n/locale.ts`, `lib/server/actions/sync-preference-cookies.ts`
- Modify: `lib/i18n/config.ts:1-13` (whole file), `lib/i18n/config.test.ts:1-25`, `app/layout.tsx:1-30` (whole file), `lib/server/actions/update-profile.ts:20-37`, `lib/server/actions/update-profile.test.ts`, `components/auth/login-form.tsx:21-40`, `components/ui/button.tsx:6-33`, `components/ui/input.tsx:10-13`

**Interfaces:**

- Consumes: `getOptionalSession` (`lib/auth/require-user.ts:30`), `requireUser` (`:40`); `USER_FIELD_DEFAULTS`; `profileSchema`/`ProfileInput`; `loadMessages` from `@/lib/i18n/messages` — **which Task 2b creates.** If 2a runs first, keep `app/layout.tsx`'s existing `(await import(`@/messages/${locale}.json`)).default` for one commit and swap it in 2b's Step for `i18n/request.ts`; record which order was used.
- Produces:

```ts
// lib/i18n/locale.ts — NO `next/headers` import, so client components may import it
export const SUPPORTED_LOCALES: readonly ['vi', 'en']
export type Locale = 'vi' | 'en'
export const DEFAULT_LOCALE: Locale
export const LOCALE_COOKIE = 'NEXT_LOCALE'
/** The BCP-47 tag `Intl` gets, per app locale. */
export const INTL_LOCALE: Record<Locale, string> // { vi: 'vi-VN', en: 'en-US' }
export function isSupportedLocale(value: string | undefined): value is Locale

// lib/i18n/config.ts — server only; re-exports everything from ./locale
export * from './locale'
export async function resolveLocale(): Promise<Locale>

// lib/theme/config.ts
export const THEME_COOKIE = 'cashflow-theme'
export type Theme = 'light' | 'dark'
export const DEFAULT_THEME: Theme
export async function resolveTheme(): Promise<Theme>

// lib/server/actions/sync-preference-cookies.ts   ('use server')
export async function syncPreferenceCookies(): Promise<void>
```

- [ ] **Step 1: Write the failing test for `resolveTheme`**

`lib/theme/config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getMock, sessionMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  sessionMock: vi.fn(),
}))

vi.mock('next/headers', () => ({ cookies: async () => ({ get: getMock }) }))
vi.mock('@/lib/auth/require-user', () => ({ getOptionalSession: sessionMock }))

import { resolveTheme, THEME_COOKIE } from './config'

describe('resolveTheme', () => {
  beforeEach(() => {
    getMock.mockReset()
    sessionMock.mockReset()
  })

  it('prefers the signed-in user’s saved theme over the cookie', async () => {
    sessionMock.mockResolvedValue({ user: { theme: 'dark' } })
    getMock.mockReturnValue({ value: 'light' })
    expect(await resolveTheme()).toBe('dark')
  })

  it('falls back to the cookie on a pre-auth page', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockImplementation((name: string) =>
      name === THEME_COOKIE ? { value: 'dark' } : undefined,
    )
    expect(await resolveTheme()).toBe('dark')
  })

  it('falls back to light when neither says anything', async () => {
    sessionMock.mockResolvedValue(null)
    getMock.mockReturnValue(undefined)
    expect(await resolveTheme()).toBe('light')
  })

  it('ignores a stored value that is not one of the two themes', async () => {
    sessionMock.mockResolvedValue({ user: { theme: 'solarized' } })
    getMock.mockReturnValue({ value: 'midnight' })
    expect(await resolveTheme()).toBe('light')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/theme/config.test.ts`
Expected: FAIL — `Failed to resolve import "./config"`.

- [ ] **Step 3: Write `lib/theme/config.ts`**

```ts
import { cookies } from 'next/headers'
import { getOptionalSession } from '@/lib/auth/require-user'
import { USER_FIELD_DEFAULTS } from '@/lib/auth/user-defaults'

/**
 * Which theme this request renders in (spec §3).
 *
 * `User.theme` is the source of truth; the cookie mirrors it so a PRE-AUTH page
 * — login, register, forgot/reset password — can paint in the user's theme
 * before there is a session to ask. The order is therefore session → cookie →
 * light, exactly as `resolveLocale` resolves the locale.
 *
 * `cashflow-theme`, not `theme`: a one-word cookie name on a shared dev host
 * collides with every other app on `localhost`, and the earlier draft of this
 * work used the short name. The spec names this one.
 *
 * Better Auth's additional-fields inference types `theme` on the session user
 * as plain `string` (the same limitation `lib/validation/profile.ts:57-69`
 * documents for `resolveProfileDefaults`), so it is narrowed here rather than
 * trusted.
 */
export const THEME_COOKIE = 'cashflow-theme'

export type Theme = 'light' | 'dark'

export const DEFAULT_THEME: Theme = USER_FIELD_DEFAULTS.theme

function isTheme(value: string | undefined): value is Theme {
  return value === 'light' || value === 'dark'
}

export async function resolveTheme(): Promise<Theme> {
  const session = await getOptionalSession()
  const userTheme = (session?.user as { theme?: string } | undefined)?.theme
  if (isTheme(userTheme)) return userTheme

  const store = await cookies()
  const cookieTheme = store.get(THEME_COOKIE)?.value
  return isTheme(cookieTheme) ? cookieTheme : DEFAULT_THEME
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/theme/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Split the locale constants out of `lib/i18n/config.ts` so client components can import them**

`lib/ui/format-money.ts` is imported by client components (`components/transactions/transaction-list.tsx:1`, and others), and it is about to need `INTL_LOCALE`. `lib/i18n/config.ts` imports `next/headers`, which a client component may not. So the constants move to a headers-free module.

`lib/i18n/locale.ts`:

```ts
/**
 * The locale constants, with NO server-only import — so a client component
 * (`TransactionList`, every form) can reach `Locale`/`INTL_LOCALE` without
 * dragging `next/headers` into the browser bundle, which is a build error.
 *
 * `lib/i18n/config.ts` re-exports all of this and adds `resolveLocale`, which
 * is the server-only half. Server code may import from either; client code
 * imports from here.
 */
export const SUPPORTED_LOCALES = ['vi', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'vi'
export const LOCALE_COOKIE = 'NEXT_LOCALE'

/**
 * The BCP-47 tag every `Intl` formatter gets. Separate from the app locale
 * because `'vi'` alone leaves the region to the runtime, and grouping is a
 * regional convention — `vi-VN` is what produces `25.000.000`, `en-US` what
 * produces `25,000,000` (spec §14, open decision 1: follow the locale).
 */
export const INTL_LOCALE: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' }

export function isSupportedLocale(value: string | undefined): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
```

Replace `lib/i18n/config.ts:1-13` entirely:

```ts
import { cookies } from 'next/headers'
import { getOptionalSession } from '@/lib/auth/require-user'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale, type Locale } from './locale'

/**
 * Which language this request renders in.
 *
 * `User.locale` is the source of truth and the `NEXT_LOCALE` cookie mirrors it,
 * so a pre-auth page still renders in the language the user chose last time on
 * this browser. Phase 7 adds the session lookup: until now a saved preference
 * was stored and then ignored, which is the gap the spec calls out (§4).
 *
 * The session lookup is `getOptionalSession`, which is `cache`d per request, so
 * asking here and again in the page costs one query.
 */
export * from './locale'

export async function resolveLocale(): Promise<Locale> {
  const session = await getOptionalSession()
  const userLocale = (session?.user as { locale?: string } | undefined)?.locale
  if (isSupportedLocale(userLocale)) return userLocale

  const store = await cookies()
  const cookieLocale = store.get(LOCALE_COOKIE)?.value
  return isSupportedLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE
}
```

- [ ] **Step 6: Extend `lib/i18n/config.test.ts` for the new precedence**

Add the session mock to the existing file (which currently mocks only `next/headers`, `lib/i18n/config.test.ts:1-8`), add `sessionMock.mockResolvedValue(null)` to each of its three existing cases, and add three more:

```ts
const { getMock, sessionMock } = vi.hoisted(() => ({ getMock: vi.fn(), sessionMock: vi.fn() }))

vi.mock('next/headers', () => ({ cookies: async () => ({ get: getMock }) }))
vi.mock('@/lib/auth/require-user', () => ({ getOptionalSession: sessionMock }))

it('prefers the signed-in user’s saved locale over the cookie', async () => {
  sessionMock.mockResolvedValue({ user: { locale: 'en' } })
  getMock.mockReturnValue({ value: 'vi' })
  expect(await resolveLocale()).toBe('en')
})

it('ignores an unsupported stored locale and falls through to the cookie', async () => {
  sessionMock.mockResolvedValue({ user: { locale: 'de' } })
  getMock.mockReturnValue({ value: 'en' })
  expect(await resolveLocale()).toBe('en')
})

it('falls back to vi with no session and no cookie', async () => {
  sessionMock.mockResolvedValue(null)
  getMock.mockReturnValue(undefined)
  expect(await resolveLocale()).toBe('vi')
})
```

Run: `npx vitest run lib/i18n/config.test.ts` → PASS (6 tests).


- [ ] **Step 7: Point `i18n/request.ts` and the root layout at the loader**

Replace `i18n/request.ts:1-12`:

```ts
import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/config'
import { loadMessages } from '@/lib/i18n/messages'

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  return { locale, messages: await loadMessages(locale) }
})
```

- [ ] **Step 8: Render the theme and the messages from the root layout**

Replace `app/layout.tsx:1-30`:

```tsx
import type { Metadata, Viewport } from 'next'
import { Manrope } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { resolveLocale } from '@/lib/i18n/config'
import { loadMessages } from '@/lib/i18n/messages'
import { resolveTheme } from '@/lib/theme/config'
import './globals.css'

const manrope = Manrope({
  variable: '--font-manrope',
  subsets: ['latin', 'vietnamese'],
  // Spec §2: 400/500/600 only. Naming them keeps the served font from carrying
  // the 700/800 faces nothing in the design system uses.
  weight: ['400', '500', '600'],
})

export const metadata: Metadata = {
  title: 'CashFlow',
  description: 'Personal finance management',
}

/**
 * The browser chrome colour follows the resolved theme, so the address bar on a
 * phone matches the page instead of framing a dark app in a white bar. It has
 * to be `generateViewport` rather than a static `viewport` export because the
 * value depends on this request's user.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = await resolveTheme()
  return { themeColor: theme === 'dark' ? '#171C1A' : '#F6F7F5' }
}

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const [locale, theme] = await Promise.all([resolveLocale(), resolveTheme()])
  const messages = await loadMessages(locale)

  return (
    // The `dark` class is decided on the SERVER and shipped in the first HTML
    // byte (spec §3), so there is no flash by construction and no client script
    // to flip it. `colorScheme` is what makes native chrome — scrollbars, the
    // `<input type="date">` picker, form control defaults — follow the theme
    // too; without it a dark app has a white date picker.
    <html
      lang={locale}
      className={`${manrope.variable} ${manrope.className} h-full antialiased${theme === 'dark' ? ' dark' : ''}`}
      style={{ colorScheme: theme }}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
```

Before writing this, read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-viewport.md` and confirm `generateViewport` is the Next 16 API for a dynamic `themeColor`. If it is not, put a static `viewport` export with the light colour and set `theme-color` from the resolved theme with a `<meta>` inside `<head>` rendered by this layout instead — and say which in a comment.

- [ ] **Step 9: Make `updateProfile` mirror both preferences into cookies**

Add two imports and insert after the `prisma.user.update` call at `lib/server/actions/update-profile.ts:34`:

```ts
import { cookies } from 'next/headers'
import { LOCALE_COOKIE } from '@/lib/i18n/config'
import { THEME_COOKIE } from '@/lib/theme/config'

// ... inside updateProfile, after the update and before `return { ok: true }`:

  // The database row is the source of truth; these two cookies are its mirror,
  // and they exist for the pages that have no session to ask — login, register,
  // forgot/reset password (spec §3, §4). Written here because this action is
  // the only client-reachable writer of `locale`/`theme`, so the mirror cannot
  // drift from the row.
  //
  // Not `httpOnly`: both are presentation preferences with nothing to protect,
  // and a flag that guards nothing only blocks a future client-side read.
  // `sameSite: 'lax'` and `path: '/'` are what make them arrive on every
  // navigation, including the very next one.
  const cookieStore = await cookies()
  const oneYearSeconds = 60 * 60 * 24 * 365
  cookieStore.set(LOCALE_COOKIE, parsed.data.locale, {
    path: '/',
    sameSite: 'lax',
    maxAge: oneYearSeconds,
  })
  cookieStore.set(THEME_COOKIE, parsed.data.theme, {
    path: '/',
    sameSite: 'lax',
    maxAge: oneYearSeconds,
  })
```

Run: `npx vitest run lib/server/actions/update-profile.test.ts`. If the existing test's harness does not provide a cookie store, wrap the two writes' failure mode: it must not throw. Read `lib/server/actions/update-profile.test.ts` first and, if it calls the action outside a request scope, add `vi.mock('next/headers', …)` to that test file with a `set: vi.fn()` store and one new assertion that both cookies were set with the parsed values.

- [ ] **Step 10: Add `syncPreferenceCookies` and call it from the login form**

`lib/server/actions/sync-preference-cookies.ts`:

```ts
'use server'

import { cookies } from 'next/headers'
import { requireUser } from '@/lib/auth/require-user'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale } from '@/lib/i18n/config'
import { DEFAULT_THEME, THEME_COOKIE } from '@/lib/theme/config'

/**
 * Writes the signed-in user's saved locale and theme into their mirror cookies
 * (spec §3: the cookie "is written by `updateProfile` and on login").
 *
 * Called by the login form immediately after a successful sign-in and before it
 * navigates, so the first authenticated render already paints in the theme and
 * language on the account rather than the browser's stale cookie or the
 * defaults — and so a user signing in on a new device does not have to visit
 * Settings to get their own theme back.
 *
 * Reads NOTHING from the client: the values come from `requireUser()`, so this
 * action cannot set a cookie for another user or to a value the user never
 * saved. It writes no database row and changes no financial state.
 */
export async function syncPreferenceCookies(): Promise<void> {
  const user = await requireUser()
  const rawLocale = (user as { locale?: string }).locale
  const rawTheme = (user as { theme?: string }).theme
  const locale = isSupportedLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE
  const theme = rawTheme === 'dark' || rawTheme === 'light' ? rawTheme : DEFAULT_THEME

  const store = await cookies()
  const oneYearSeconds = 60 * 60 * 24 * 365
  store.set(LOCALE_COOKIE, locale, { path: '/', sameSite: 'lax', maxAge: oneYearSeconds })
  store.set(THEME_COOKIE, theme, { path: '/', sameSite: 'lax', maxAge: oneYearSeconds })
}
```

In `components/auth/login-form.tsx`, add the import and one call between the error handling and the navigation (replacing `components/auth/login-form.tsx:33-39`):

```tsx
import { syncPreferenceCookies } from '@/lib/server/actions/sync-preference-cookies'

    } catch {
      console.error('Sign-in request failed')
      setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }
    // Best-effort: a failure here means the next render falls back to the
    // cookie or the default, which is a cosmetic miss and not a broken
    // sign-in — so it must never block the navigation below.
    try {
      await syncPreferenceCookies()
    } catch {
      console.error('Preference cookie sync failed')
    }
    router.push('/dashboard')
    router.refresh()
```

The literal error strings in this form stay as they are; Task 12 is the one task that rewrites the auth screens, so the auth copy moves exactly once.

- [ ] **Step 11: Re-skin `Button` and `Input` to the spec's control sizes**

`components/ui/button.tsx` — change the base string at `:6` and the `size` variants at `:21-33`, leaving every `variant` at `:9-20` untouched:

- base: change `rounded-lg` to `rounded-md` (6 px — a button is a control, not a card) and delete `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` (the global `:focus-visible` outline from Task 1 is the ring now, on every element rather than only the ones that remembered to ask). Keep `aria-invalid:*`, `disabled:*`, `[&_svg]:*`, `transition-all`, `select-none`.
- sizes:

```ts
      size: {
        // Spec §2: primary 40 px, compact 36 px, icon 36×36. `default` is 40
        // because that is what a page's one primary action is; `sm` is the row
        // action. The old 32 px `default` was below every touch guideline.
        default: 'h-10 gap-2 px-4',
        sm: 'h-9 gap-1.5 px-3 text-[0.8125rem]',
        lg: 'h-10 gap-2 px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
```

Before deleting the `xs`, `icon-xs` and `icon-lg` sizes, run:
```bash
grep -rn "size=\"xs\"\|size=\"icon-xs\"\|size=\"icon-lg\"\|size: 'xs'" components app
```
Map each hit to `sm`/`icon-sm`/`icon` in this same commit; if there are none, delete the three sizes.

`components/ui/input.tsx` — replace the class string at `:11`:

```tsx
        'h-11 w-full min-w-0 rounded-md border border-input bg-[var(--input-bg)] px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-negative md:h-10 md:text-sm',
```

44 px on touch and 40 px from `md` (spec §2, §8); radius 6; the global focus outline instead of the `ring-3` stack; `aria-invalid` uses CashFlow's `--negative` rather than shadcn's `--destructive`. The `file:` classes go — no input in this app takes a file.

**The background is `bg-[var(--input-bg)]`, not `bg-transparent` + `dark:bg-input/30`** (Task 1a's token). A translucent wash renders as two different colours over `--surface` and over `--surface-2`, so the same field looked different on a card and inside a dialog; a fixed token makes it one field everywhere. The `disabled:bg-input/50` and `dark:disabled:bg-input/80` variants go with it — `disabled:opacity-50` alone is the disabled treatment now, and it composes correctly on either surface.

Apply the same `bg-[var(--input-bg)]` to `SELECT_CLASS` in `components/common/form-field.tsx` (Task 1b) so a select and an input match; if 1b has not run yet, note it as a one-line follow-up in that task's step.


- [ ] **Step 12: Full verification**

Run: `npm run test` → green (`lib/theme/config.test.ts` +4, `lib/i18n/config.test.ts` +3, `update-profile.test.ts` +1, and every existing test).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npm run build` → succeeds. This is the first task to change `app/layout.tsx`, so a build is the only proof `generateViewport` compiles.
Run: `npx playwright test` → green. This task changes control heights and radii but no selector, no label and no copy, so every existing spec must still pass unchanged. If one fails, record which and why *before* touching it.



**Tests required:**
- Vitest: `lib/theme/config.test.ts` (4 new), `lib/i18n/config.test.ts` (3 new, 6 total), `lib/server/actions/update-profile.test.ts` (1 new assertion: both cookies written with the parsed values).
- Playwright: none new here. The permanent theme/locale spec lands in Task 11, once the Settings form can change them through the redesigned UI; Step 13's driver checks are its dry run.

**Browser visual checks required:** Step 13 — `/dashboard` and `/login` in dark and light at 1440 and 375, plus the first-paint video.

**Explicit things NOT to change:** `USER_FIELD_DEFAULTS`; `profileSchema`; `resolveProfileDefaults`'s fallback logic; any service, action or validation beyond the two additive cookie writes and the new read-only `syncPreferenceCookies`; the Excel export; the existing English copy inside components (Task 2b/2c and each module task move their own); `components/ui/button.tsx`'s `variant` definitions; the `useHydrated` gate on any form.

**Completion gate:** four commands green; the raw `/dashboard` HTML carries `dark` on `<html>` for a dark-theme user; the first-paint video shows no light frame; `Input` measures 44 px at 375 and 40 px at 1024 (measured in the driver).

**Proposed commit boundary:**
1. `feat(theme): server-render the saved theme on <html> and mirror both preferences into cookies`
2. `feat(ui): re-skin Button and Input to the 40/44 px control scale on --input-bg`

---

## Task 2b: The message tree

**Objective:** Replace the two flat message files with eighteen per-domain files in each locale, merged into one namespace tree by `loadMessages`, and prove vi/en key parity with a test. This is the file layer every later task appends its own keys to.

**Major files touched:** `messages/vi/*.json` and `messages/en/*.json` (36 new files), `lib/i18n/messages.ts` (new), `i18n/request.ts`, `messages/vi.json` + `messages/en.json` (deleted).

**Reusable primitives involved:** none — no component changes.

**User-facing behaviour:** none visible. Nothing renders a key until Task 3.

**Desktop expectation:** unchanged — no component reads a key yet.

**Mobile expectation:** unchanged. One thing is decided here that only bites on a phone: `nav.json`'s labels are chosen to fit the bottom tab bar at 11 px without an ellipsis (spec §4), and Task 3's `nav-groups.test.ts` asserts the ≤ 12-character rule against this file.

**Dark-theme expectation:** unchanged.

**Vietnamese/English expectation:** this task *is* the expectation. `t('nav.dashboard')`, `t('errors.generic')`, `t('labels.transactionType.CASH_OUT')` and `t('validation.Enter an amount')` all resolve, in both locales, with identical key sets.

**Accessibility acceptance criteria:** none directly — but the `nav.json` labels are chosen to fit the constraints spec §4 sets (nav labels ≤ 12 characters, bottom tab labels never ellipsised), and `nav-groups.test.ts` in Task 3 asserts the first of those against this file.

**Hydration/form-submission constraints:** none. A JSON file cannot revert a form field.

**Files:**
- Create: `lib/i18n/messages.ts`, `lib/i18n/messages.test.ts`, and 36 files `messages/{vi,en}/{common,nav,auth,dashboard,transactions,transfers,accounts,categories,budgets,goals,debts,loans,reminders,reports,settings,errors,labels,validation}.json`
- Modify: `i18n/request.ts:1-12` (whole file), `app/layout.tsx` (its message import, if Task 2a left the old one)
- Delete: `messages/vi.json`, `messages/en.json`
- Test: `lib/i18n/messages.test.ts`

**Interfaces:**

- Consumes: `Locale` from `@/lib/i18n/locale` (Task 2a).
- Produces:

```ts
// lib/i18n/messages.ts
export const MESSAGE_DOMAINS: readonly string[] // the 18 domain names, in this order
export async function loadMessages(locale: Locale): Promise<Record<string, unknown>>
```

**Note:** `errors.json` and `labels.json` are created here with their full content (they are message files), but the *code* that keys into them — `lib/ui/labels.ts`, the `*_ERROR_KEYS` maps, `lib/ui/validation-messages.ts` — is Task 2c's. `validation.json` is created here **empty of guesses**: Task 2c's extraction step is what fills it, from the literals it reads out of `lib/validation/**`, and its test is what proves the fill is complete. Create it as `{}` in both locales and say so in the commit message; `messages.test.ts`'s no-empty-value assertion skips an empty *object* (it walks leaves, and `{}` has none).

- [ ] **Step 1: Create the 36 message files — `common` and `nav`**

Create `messages/vi/` and `messages/en/` with these seventeen basenames in each: `common.json`, `nav.json`, `auth.json`, `dashboard.json`, `transactions.json`, `transfers.json`, `accounts.json`, `categories.json`, `budgets.json`, `goals.json`, `debts.json`, `loans.json`, `reminders.json`, `reports.json`, `settings.json`, `errors.json`, `labels.json`.

Each file's top-level object is its namespace *content* (the domain name is added by the loader), so `messages/vi/nav.json` is `{ "dashboard": "Tổng quan", … }` and resolves as `nav.dashboard`.

`messages/vi/common.json`:
```json
{
  "appName": "CashFlow",
  "tagline": "Quản lý tài chính cá nhân",
  "save": "Lưu",
  "saving": "Đang lưu…",
  "cancel": "Hủy",
  "close": "Đóng",
  "add": "Thêm",
  "adding": "Đang thêm…",
  "edit": "Sửa",
  "delete": "Xóa",
  "deleting": "Đang xóa…",
  "archive": "Lưu trữ",
  "archiving": "Đang lưu trữ…",
  "confirm": "Xác nhận",
  "actions": "Tác vụ",
  "rowActions": "Tác vụ cho {name}",
  "optional": "(tùy chọn)",
  "viewAll": "Xem tất cả",
  "retry": "Thử lại",
  "loading": "Đang tải…",
  "noValue": "—",
  "currency": "Tiền tệ",
  "amount": "Số tiền",
  "date": "Ngày",
  "dateTime": "Ngày và giờ",
  "note": "Ghi chú",
  "today": "Hôm nay",
  "yesterday": "Hôm qua",
  "tomorrow": "Ngày mai",
  "inDays": "Còn {count, plural, other {# ngày}}",
  "overdue": "Quá hạn",
  "rateLine": "1 {from} = {rate} {to}"
}
```

`messages/en/common.json`: the same keys — `"appName": "CashFlow"`, `"tagline": "Personal finance management"`, `"save": "Save"`, `"saving": "Saving…"`, `"cancel": "Cancel"`, `"close": "Close"`, `"add": "Add"`, `"adding": "Adding…"`, `"edit": "Edit"`, `"delete": "Delete"`, `"deleting": "Deleting…"`, `"archive": "Archive"`, `"archiving": "Archiving…"`, `"confirm": "Confirm"`, `"actions": "Actions"`, `"rowActions": "Actions for {name}"`, `"optional": "(optional)"`, `"viewAll": "View all"`, `"retry": "Retry"`, `"loading": "Loading…"`, `"noValue": "—"`, `"currency": "Currency"`, `"amount": "Amount"`, `"date": "Date"`, `"dateTime": "Date and time"`, `"note": "Note"`, `"today": "Today"`, `"yesterday": "Yesterday"`, `"tomorrow": "Tomorrow"`, `"inDays": "In {count, plural, one {# day} other {# days}}"`, `"overdue": "Overdue"`, `"rateLine": "1 {from} = {rate} {to}"`.

`messages/vi/nav.json` (every nav label ≤ 12 characters, spec §4):
```json
{
  "dashboard": "Tổng quan",
  "transactions": "Giao dịch",
  "transfers": "Chuyển tiền",
  "accounts": "Tài khoản",
  "categories": "Danh mục",
  "budgets": "Ngân sách",
  "goals": "Tiết kiệm",
  "debts": "Công nợ",
  "loans": "Khoản vay",
  "reminders": "Nhắc nhở",
  "reports": "Báo cáo",
  "settings": "Cài đặt",
  "logout": "Đăng xuất",
  "addTransaction": "Thêm giao dịch",
  "more": "Thêm",
  "primary": "Điều hướng chính",
  "compact": "Điều hướng nhanh",
  "moreSheetTitle": "Tất cả mục",
  "groupOverview": "Tổng quan",
  "groupMoney": "Tiền",
  "groupPlanning": "Kế hoạch",
  "groupReports": "Báo cáo",
  "groupSettings": "Cài đặt"
}
```

`messages/en/nav.json`: `"dashboard": "Dashboard"`, `"transactions": "Transactions"`, `"transfers": "Transfers"`, `"accounts": "Accounts"`, `"categories": "Categories"`, `"budgets": "Budgets"`, `"goals": "Savings"`, `"debts": "Debts"`, `"loans": "Loans"`, `"reminders": "Reminders"`, `"reports": "Reports"`, `"settings": "Settings"`, `"logout": "Log out"`, `"addTransaction": "Add transaction"`, `"more": "More"`, `"primary": "Primary"`, `"compact": "Primary (compact)"`, `"moreSheetTitle": "All sections"`, `"groupOverview": "Overview"`, `"groupMoney": "Money"`, `"groupPlanning": "Planning"`, `"groupReports": "Reports"`, `"groupSettings": "Settings"`.

- [ ] **Step 2: Create `errors.json` in both locales**

`messages/vi/errors.json` — one key per action-error code across all eight maps, plus the generic and error-boundary copy. The Vietnamese wording carries the same meaning as the English literals currently at `lib/ui/action-error-messages.ts:29-123`:

```json
{
  "generic": "Đã xảy ra lỗi. Vui lòng thử lại.",
  "boundaryTitle": "Không tải được trang này.",
  "boundaryBody": "Dữ liệu của bạn chưa bị thay đổi. Hãy thử lại sau một lát.",
  "account": {
    "NON_ZERO_BALANCE": "Tài khoản phải có số dư bằng 0 trước khi lưu trữ. Hãy chuyển hoặc điều chỉnh số dư trước.",
    "ACCOUNT_LOCKED": "Không thể đổi tiền tệ và số dư ban đầu sau khi tài khoản đã có phát sinh.",
    "ARCHIVED_ACCOUNT": "Tài khoản này đã lưu trữ và không thể sửa.",
    "INVALID_ACCOUNT_TYPE": "Hãy chọn một loại tài khoản hợp lệ.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Tài khoản này không còn tồn tại."
  },
  "transaction": {
    "FX_UNAVAILABLE": "Tỷ giá tạm thời không khả dụng. Vui lòng thử lại sau một lát.",
    "ARCHIVED_ACCOUNT": "Tài khoản này đã lưu trữ.",
    "CURRENCY_MISMATCH": "Hãy chuyển giao dịch sang tài khoản cùng loại tiền, hoặc xóa và nhập lại.",
    "INVALID_CATEGORY": "Hãy chọn danh mục hợp lệ cho loại giao dịch này.",
    "CONFLICT": "Bản ghi đã thay đổi trong lúc bạn đang sửa. Hãy tải lại và thử lại.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Bản ghi này không còn tồn tại."
  },
  "transfer": {
    "SAME_ACCOUNT": "Hãy chọn hai tài khoản khác nhau.",
    "ARCHIVED_ACCOUNT": "Một trong hai tài khoản đã lưu trữ.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Bản ghi này không còn tồn tại."
  },
  "budget": {
    "DUPLICATE_BUDGET": "Tháng này đã có ngân sách cho phạm vi hoặc danh mục đó.",
    "INVALID_CATEGORY": "Hãy chọn một danh mục chi đang hoạt động.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Ngân sách này không còn tồn tại."
  },
  "goal": {
    "ARCHIVED": "Mục tiêu này đã lưu trữ và không thể thay đổi.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Mục tiêu này không còn tồn tại."
  },
  "debt": {
    "OVERPAYMENT": "Khoản thanh toán lớn hơn số còn nợ.",
    "NOT_ACTIVE": "Khoản nợ này đã được xóa nợ và không thể thay đổi.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Khoản nợ này không còn tồn tại."
  },
  "loan": {
    "OVERPAYMENT": "Phần gốc thanh toán lớn hơn dư nợ gốc còn lại.",
    "NOT_ACTIVE": "Khoản vay này đã đóng và không thể thay đổi.",
    "SPLIT_MISMATCH": "Tổng phải bằng gốc cộng lãi.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Khoản vay này không còn tồn tại."
  },
  "reminder": {
    "INVALID_CATEGORY": "Hãy chọn danh mục phù hợp với loại nhắc nhở.",
    "INVALID_ACCOUNT": "Hãy chọn một trong các tài khoản đang hoạt động của bạn.",
    "INVALID_INPUT": "Kiểm tra lại các trường được đánh dấu.",
    "NOT_FOUND": "Nhắc nhở này không còn tồn tại."
  }
}
```

`messages/en/errors.json`: the identical key tree, with every value taken **verbatim** from the current literals in `lib/ui/action-error-messages.ts` (`GENERIC_ERROR_MESSAGE:29` → `generic`; each `*_ERROR_MESSAGES` entry → its code's key), plus `"boundaryTitle": "Something went wrong loading this page."` and `"boundaryBody": "Your data has not been changed. Try again in a moment."` (both verbatim from `app/(app)/error.tsx:40-43`). Taking them verbatim is what keeps `e2e/phase5.spec.ts:102,125` and `e2e/phase6.spec.ts:537,643` — which import the maps and assert their exact text — green.

- [ ] **Step 3: Create `labels.json` in both locales**

`messages/vi/labels.json`:

```json
{
  "transactionType": {
    "INCOME": "Thu nhập",
    "EXPENSE": "Chi tiêu",
    "CASH_IN": "Tiền vào (khác)",
    "CASH_OUT": "Tiền ra (khác)",
    "ADJUSTMENT_INCREASE": "Điều chỉnh tăng",
    "ADJUSTMENT_DECREASE": "Điều chỉnh giảm"
  },
  "categoryType": { "INCOME": "Thu nhập", "EXPENSE": "Chi tiêu" },
  "recordStatus": { "ACTIVE": "Đang hoạt động", "ARCHIVED": "Đã lưu trữ" },
  "budgetScope": { "OVERALL": "Tổng thể", "CATEGORY": "Theo danh mục" },
  "budgetStatus": {
    "ok": "Trong hạn mức",
    "warning_50": "Đã dùng hơn nửa",
    "warning_80": "Sắp vượt hạn mức",
    "at_100": "Đã đến hạn mức",
    "exceeded": "Vượt hạn mức"
  },
  "goalStatus": { "ACTIVE": "Đang thực hiện", "ACHIEVED": "Đạt mục tiêu", "ARCHIVED": "Đã lưu trữ" },
  "debtDirection": { "RECEIVABLE": "Họ nợ bạn", "PAYABLE": "Bạn nợ họ" },
  "debtStatus": {
    "OPEN": "Đang mở",
    "PARTIALLY_PAID": "Trả một phần",
    "PAID": "Đã thanh toán",
    "OVERDUE": "Quá hạn",
    "WRITTEN_OFF": "Đã xóa nợ"
  },
  "loanStatus": {
    "ACTIVE": "Đang trả",
    "OVERDUE": "Quá hạn kỳ trả",
    "PAID_OFF": "Đã trả hết",
    "CLOSED": "Đã đóng"
  },
  "paymentFrequency": { "WEEKLY": "Hàng tuần", "MONTHLY": "Hàng tháng", "YEARLY": "Hàng năm" },
  "reminderType": { "INCOME": "Thu nhập", "EXPENSE": "Hóa đơn" },
  "recurrence": {
    "ONE_TIME": "Một lần",
    "WEEKLY": "Hàng tuần",
    "WEEKLY_N": "Mỗi {count} tuần",
    "MONTHLY": "Hàng tháng",
    "MONTHLY_N": "Mỗi {count} tháng",
    "YEARLY": "Hàng năm",
    "YEARLY_N": "Mỗi {count} năm"
  },
  "occurrenceStatus": {
    "PENDING": "Chờ xử lý",
    "ACKNOWLEDGED": "Đã ghi nhận",
    "DISMISSED": "Đã bỏ qua"
  },
  "currency": { "VND": "VND", "USD": "USD" }
}
```

`messages/en/labels.json`: the identical key tree with the wording the view models use today, so no existing e2e assertion moves —

```json
{
  "transactionType": {
    "INCOME": "Income",
    "EXPENSE": "Expense",
    "CASH_IN": "Cash In (other)",
    "CASH_OUT": "Cash Out (other)",
    "ADJUSTMENT_INCREASE": "Balance Adjustment — increase",
    "ADJUSTMENT_DECREASE": "Balance Adjustment — decrease"
  },
  "categoryType": { "INCOME": "Income", "EXPENSE": "Expense" },
  "recordStatus": { "ACTIVE": "Active", "ARCHIVED": "Archived" },
  "budgetScope": { "OVERALL": "Overall", "CATEGORY": "Category" },
  "budgetStatus": {
    "ok": "Healthy",
    "warning_50": "Over half used",
    "warning_80": "Approaching limit",
    "at_100": "At limit",
    "exceeded": "Exceeded"
  },
  "goalStatus": { "ACTIVE": "In progress", "ACHIEVED": "Achieved", "ARCHIVED": "Archived" },
  "debtDirection": { "RECEIVABLE": "Owes you", "PAYABLE": "You owe" },
  "debtStatus": {
    "OPEN": "Open",
    "PARTIALLY_PAID": "Partly paid",
    "PAID": "Paid",
    "OVERDUE": "Overdue",
    "WRITTEN_OFF": "Written off"
  },
  "loanStatus": {
    "ACTIVE": "Active",
    "OVERDUE": "Payment overdue",
    "PAID_OFF": "Paid off",
    "CLOSED": "Closed"
  },
  "paymentFrequency": { "WEEKLY": "Weekly", "MONTHLY": "Monthly", "YEARLY": "Yearly" },
  "reminderType": { "INCOME": "Income", "EXPENSE": "Bill" },
  "recurrence": {
    "ONE_TIME": "One time",
    "WEEKLY": "Every week",
    "WEEKLY_N": "Every {count} weeks",
    "MONTHLY": "Monthly",
    "MONTHLY_N": "Every {count} months",
    "YEARLY": "Yearly",
    "YEARLY_N": "Every {count} years"
  },
  "occurrenceStatus": {
    "PENDING": "Pending",
    "ACKNOWLEDGED": "Acknowledged",
    "DISMISSED": "Dismissed"
  },
  "currency": { "VND": "VND", "USD": "USD" }
}
```

(Sources for the English values: `lib/ui/budget-view-model.ts:50-56`, `lib/ui/savings-goal-view-model.ts:72-76`, `lib/ui/debt-view-model.ts:89-106`, `lib/ui/loan-view-model.ts:118-135`, `lib/ui/reminder-view-model.ts:56-87`, `components/transactions/transaction-form.tsx:192-197`.)

- [ ] **Step 4: Create the fourteen remaining domain files with their page-identity keys**

Each module task appends the rest of its own keys; these are the ones Task 3's shell and the `PageHeader` work need to exist now.

- `messages/vi/auth.json`: `{"loginTitle":"Đăng nhập CashFlow","registerTitle":"Tạo tài khoản CashFlow","forgotTitle":"Đặt lại mật khẩu","resetTitle":"Đặt mật khẩu mới","invalidTokenTitle":"Liên kết đặt lại không hợp lệ hoặc đã hết hạn"}` — en: `{"loginTitle":"Sign in to CashFlow","registerTitle":"Create your CashFlow account","forgotTitle":"Reset your password","resetTitle":"Set a new password","invalidTokenTitle":"Reset link is invalid or expired"}`
- `messages/vi/dashboard.json`: `{"title":"Tổng quan"}` — en: `{"title":"Dashboard"}`
- `messages/vi/transactions.json`: `{"title":"Giao dịch"}` — en: `{"title":"Transactions"}`
- `messages/vi/transfers.json`: `{"title":"Chuyển tiền"}` — en: `{"title":"Transfers"}`
- `messages/vi/accounts.json`: `{"title":"Tài khoản"}` — en: `{"title":"Accounts"}`
- `messages/vi/categories.json`: `{"title":"Danh mục"}` — en: `{"title":"Categories"}`
- `messages/vi/budgets.json`: `{"title":"Ngân sách"}` — en: `{"title":"Budgets"}`
- `messages/vi/goals.json`: `{"title":"Mục tiêu tiết kiệm"}` — en: `{"title":"Savings"}`
- `messages/vi/debts.json`: `{"title":"Công nợ"}` — en: `{"title":"Debts"}`
- `messages/vi/loans.json`: `{"title":"Khoản vay"}` — en: `{"title":"Loans"}`
- `messages/vi/reminders.json`: `{"title":"Nhắc nhở"}` — en: `{"title":"Reminders"}`
- `messages/vi/reports.json`: `{"title":"Báo cáo"}` — en: `{"title":"Reports"}`
- `messages/vi/settings.json`: `{"title":"Cài đặt"}` — en: `{"title":"Settings"}`

Then remove the two flat files:
```bash
git rm messages/vi.json messages/en.json
```

- [ ] **Step 5: Write the failing key-parity test**

`lib/i18n/messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadMessages, MESSAGE_DOMAINS } from './messages'

/** Every leaf key in a nested message object, as dotted paths. */
function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

function at(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree)
}

describe('message files', () => {
  it('merges every domain under its own namespace', async () => {
    const vi = await loadMessages('vi')
    expect(Object.keys(vi).sort()).toEqual([...MESSAGE_DOMAINS].sort())
    expect(at(vi, 'nav.dashboard')).toBe('Tổng quan')
    expect(at(vi, 'labels.transactionType.CASH_OUT')).toBe('Tiền ra (khác)')
  })

  it('has identical key sets in vi and en — no locale silently falls back', async () => {
    const viKeys = leafKeys(await loadMessages('vi')).sort()
    const enKeys = leafKeys(await loadMessages('en')).sort()
    expect({
      onlyVi: viKeys.filter((key) => !enKeys.includes(key)),
      onlyEn: enKeys.filter((key) => !viKeys.includes(key)),
    }).toEqual({ onlyVi: [], onlyEn: [] })
  })

  it('has no empty value anywhere — an empty string renders as a missing label', async () => {
    for (const locale of ['vi', 'en'] as const) {
      const messages = await loadMessages(locale)
      const empties = leafKeys(messages).filter((key) => at(messages, key) === '')
      expect(empties, locale).toEqual([])
    }
  })
})
```

Run: `npx vitest run lib/i18n/messages.test.ts` → FAIL (unresolved `./messages`).

- [ ] **Step 6: Write `lib/i18n/messages.ts`**

```ts
import type { Locale } from './locale'

/**
 * The seventeen message domains (spec §4), in a fixed order so the merged tree
 * is deterministic and a diff of it is readable.
 *
 * Split per domain rather than one file per locale because the two flat files
 * this replaces were about to become a thousand-line merge conflict: every
 * module task in Phase 7 adds keys, and a per-domain file means two tasks
 * touching two modules never touch the same file.
 */
export const MESSAGE_DOMAINS = [
  'common',
  'nav',
  'auth',
  'dashboard',
  'transactions',
  'transfers',
  'accounts',
  'categories',
  'budgets',
  'goals',
  'debts',
  'loans',
  'reminders',
  'reports',
  'settings',
  'errors',
  'labels',
] as const

/**
 * One namespace tree for `next-intl`, keyed by domain.
 *
 * A static `import()` per domain, written out rather than built from a template
 * literal: a `` import(`@/messages/${locale}/${domain}.json`) `` inside a loop
 * makes the bundler emit every JSON file in both directories and give up on
 * splitting them. Two locales × seventeen domains is 34 explicit specifiers,
 * and being explicit is what keeps the request cheap.
 */
const LOADERS: Record<Locale, () => Promise<Record<string, unknown>>> = {
  vi: async () => ({
    common: (await import('@/messages/vi/common.json')).default,
    nav: (await import('@/messages/vi/nav.json')).default,
    auth: (await import('@/messages/vi/auth.json')).default,
    dashboard: (await import('@/messages/vi/dashboard.json')).default,
    transactions: (await import('@/messages/vi/transactions.json')).default,
    transfers: (await import('@/messages/vi/transfers.json')).default,
    accounts: (await import('@/messages/vi/accounts.json')).default,
    categories: (await import('@/messages/vi/categories.json')).default,
    budgets: (await import('@/messages/vi/budgets.json')).default,
    goals: (await import('@/messages/vi/goals.json')).default,
    debts: (await import('@/messages/vi/debts.json')).default,
    loans: (await import('@/messages/vi/loans.json')).default,
    reminders: (await import('@/messages/vi/reminders.json')).default,
    reports: (await import('@/messages/vi/reports.json')).default,
    settings: (await import('@/messages/vi/settings.json')).default,
    errors: (await import('@/messages/vi/errors.json')).default,
    labels: (await import('@/messages/vi/labels.json')).default,
  }),
  en: async () => ({
    common: (await import('@/messages/en/common.json')).default,
    nav: (await import('@/messages/en/nav.json')).default,
    auth: (await import('@/messages/en/auth.json')).default,
    dashboard: (await import('@/messages/en/dashboard.json')).default,
    transactions: (await import('@/messages/en/transactions.json')).default,
    transfers: (await import('@/messages/en/transfers.json')).default,
    accounts: (await import('@/messages/en/accounts.json')).default,
    categories: (await import('@/messages/en/categories.json')).default,
    budgets: (await import('@/messages/en/budgets.json')).default,
    goals: (await import('@/messages/en/goals.json')).default,
    debts: (await import('@/messages/en/debts.json')).default,
    loans: (await import('@/messages/en/loans.json')).default,
    reminders: (await import('@/messages/en/reminders.json')).default,
    reports: (await import('@/messages/en/reports.json')).default,
    settings: (await import('@/messages/en/settings.json')).default,
    errors: (await import('@/messages/en/errors.json')).default,
    labels: (await import('@/messages/en/labels.json')).default,
  }),
}

export async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  return LOADERS[locale]()
}
```

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS (3 tests).


- [ ] **Step 7: Point `i18n/request.ts` at the loader**

Replace `i18n/request.ts:1-12`:

```ts
import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/config'
import { loadMessages } from '@/lib/i18n/messages'

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  return { locale, messages: await loadMessages(locale) }
})
```

And if Task 2a left `app/layout.tsx`'s own message import on the old flat file, swap it for `loadMessages(locale)` now.

- [ ] **Step 8: Full verification**

Run: `npx vitest run lib/i18n` → PASS (`messages.test.ts` 3, `config.test.ts` 6).
Run: `npm run test` → the whole suite green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npm run build` → succeeds; this is the proof the 36 static `import()` specifiers all resolve.
Run: `npx playwright test` → green; no component renders a key yet.

**Tests required:**
- Vitest: `lib/i18n/messages.test.ts` (3 new: every domain merged under its namespace, identical vi/en key sets, no empty value anywhere).
- Playwright: none.

**Browser visual checks required:** none — nothing renders differently. Confirm in the dev server's console that no `next-intl` missing-message warning appears on any page.

**Explicit things NOT to change:** the English wording of any value taken verbatim from existing code (`errors.json` from `lib/ui/action-error-messages.ts`, `labels.json` from the six view models) — two e2e specs import those maps and assert their exact text, and Task 13 is where they stop doing so.

**Completion gate:** 36 files exist with identical key sets (proved by the test); the two flat files are deleted; five commands green; no missing-message warning in the console.

**Proposed commit boundary:**
1. `feat(i18n): split messages into eighteen per-domain files per locale, merged by loadMessages`

---

## Task 2c: Locale-aware formatting, enum label keys, and the error/validation dictionaries

**Objective:** Build the code layer over Task 2b's files: `formatDate`, a locale-aware `formatMoney`/`formatRate`/`formatCompactAmount`, `lib/ui/labels.ts`'s fourteen enum→key functions with an exhaustiveness test, the `*_ERROR_KEYS` maps, and — per spec §4's amended ruling — `lib/ui/validation-messages.ts` plus the extraction test that proves every Zod message literal in `lib/validation/**` has a vi and an en entry.

**Major files touched:** `lib/ui/format-date.ts` (new), `lib/ui/format-money.ts`, `lib/ui/labels.ts` (new), `lib/ui/validation-messages.ts` (new), `lib/ui/action-error-messages.ts`, `messages/{vi,en}/validation.json`.

**Reusable primitives involved:** `FieldError` (Task 1b) consumes `validationMessageKey`; `MoneyText` renders what `formatMoney` returns.

**User-facing behaviour:** none visible yet — no component calls these until Task 3. What it enables: figures grouped for the reader's locale, dates in the reader's format, every enum rendered as a product label, and every Zod message rendered in Vietnamese.

**Desktop expectation:** unchanged; these are pure functions.

**Mobile expectation:** unchanged — but `formatCompactAmount` exists for the one mobile case that needs it, a chart axis at 375 where "10.000.000" repeated down a column says less than "10 Tr" does. It is a LABEL, never a value: every KPI and every tooltip keeps `formatMoney`'s full digits (spec §14, decision 3).

**Dark-theme expectation:** unchanged.

**Vietnamese/English expectation:** `formatMoney(25_000_000, 'VND', 'en')` is `25,000,000` and `…, 'vi')` is `25.000.000`; `formatDate` gives `09/09/2026` in vi and `Sep 9, 2026` in en; every `labels.*` key resolves in both; every Zod literal resolves in both.

**Accessibility acceptance criteria:** none directly. One consequence matters: because `FieldError` translates through `validationMessageKey`, a field error is announced in the reader's language — an English `role="alert"` on a Vietnamese page is a screen-reader-only defect that no visual sweep would find.

**Hydration/form-submission constraints:** `formatMoney`'s new `locale` parameter is **optional and last**, defaulting to `vi`, so every pre-existing caller and every Phase 2–6 test keeps working untouched. It is threaded into the view models by Tasks 4/7/8/9 and passed from the pages by Task 13. None of that touches a `defaultValue`: a mapper's output feeds a *row*, and its `editable` block's `toFixed(2)` strings — which do feed form inputs — stay unformatted.

**Files:**
- Create: `lib/ui/format-date.ts`, `lib/ui/format-date.test.ts`, `lib/ui/labels.ts`, `lib/ui/labels.test.ts`, `lib/ui/validation-messages.ts`, `lib/ui/validation-messages.test.ts`
- Modify: `lib/ui/format-money.ts:30-108`, `lib/ui/format-money.test.ts`, `lib/ui/action-error-messages.ts:1-124` (whole file), `messages/vi/validation.json`, `messages/en/validation.json`
- Test: all four new test files

**Interfaces:**

- Consumes: `Locale`, `DEFAULT_LOCALE`, `INTL_LOCALE` from `@/lib/i18n/locale` (Task 2a); `messages/{vi,en}/labels.json` and `errors.json` (Task 2b); the Prisma enum types and the three display-status unions.
- Produces:

```ts
// lib/ui/format-date.ts
export type DateStyle = 'date' | 'dateTime' | 'monthYear' | 'weekday' | 'dayMonth'
export function formatDate(
  instantOrCarrier: Date | string,
  options: { locale: Locale; timeZone: string; style: DateStyle },
): string
export function toDateInputValue(instant: Date, timeZone: string): string

// lib/ui/format-money.ts (extended — third parameter OPTIONAL, defaulting to vi)
export function formatMoney(value: Prisma.Decimal | string | number, currency: Currency, locale?: Locale): string
export function formatChartValue(value: unknown, currency: Currency, locale?: Locale): string
export function formatRate(rate: Prisma.Decimal | string | number, locale?: Locale): string
export function formatCompactAmount(value: number, locale?: Locale): string

// lib/ui/labels.ts — every function returns a FULL dotted key from the message root
export function transactionTypeLabelKey(type: TransactionType): string
export function categoryTypeLabelKey(type: CategoryType): string
export function recordStatusLabelKey(status: RecordStatus): string
export function budgetScopeLabelKey(scope: BudgetScope): string
export function budgetStatusLabelKey(status: BudgetStatus): string
export function goalStatusLabelKey(status: SavingsGoalStatus): string
export function debtDirectionLabelKey(direction: DebtDirection): string
export function debtStatusLabelKey(status: DebtDisplayStatus): string
export function loanStatusLabelKey(status: LoanDisplayStatus): string
export function paymentFrequencyLabelKey(frequency: PaymentFrequency): string
export function reminderTypeLabelKey(type: ReminderType): string
export function recurrenceLabelKey(frequency: RecurrenceFrequency, interval: number): string
export function occurrenceStatusLabelKey(status: OccurrenceStatus): string
export function currencyLabelKey(currency: Currency): string

// lib/ui/validation-messages.ts
/** The `validation.*` key for a Zod message literal, e.g. `'validation.Enter an amount'`. */
export function validationMessageKey(message: string): string
/**
 * The regex the extraction test uses to find every message literal in
 * `lib/validation/**`. Exported so the test and any future tooling read the
 * same definition of "a Zod message".
 */
export const ZOD_MESSAGE_PATTERN: RegExp

// lib/ui/action-error-messages.ts (rewritten as key maps; the `*_MESSAGES`
// English maps stay as temporary aliases until Task 13 deletes them)
export const GENERIC_ERROR_KEY = 'errors.generic'
export const ACCOUNT_ERROR_KEYS: Record<FinancialAccountActionError, string>
export const TRANSACTION_ERROR_KEYS: Record<TransactionActionError, string>
export const TRANSFER_ERROR_KEYS: Record<TransferActionError, string>
export const BUDGET_ERROR_KEYS: Record<BudgetActionError, string>
export const SAVINGS_GOAL_ERROR_KEYS: Record<SavingsGoalActionError, string>
export const DEBT_ERROR_KEYS: Record<DebtActionError, string>
export const LOAN_ERROR_KEYS: Record<LoanActionError, string>
export const REMINDER_ERROR_KEYS: Record<ReminderActionError, string>
```

The label-function names above are the ones spec §4 now fixes — including `paymentFrequencyLabelKey` and `recurrenceLabelKey` as **two** functions, because `PaymentFrequency` (a loan's cadence: WEEKLY/MONTHLY/YEARLY) and `RecurrenceFrequency` (a reminder's, which adds ONE_TIME and takes an interval) are two different enums with two different label sets, and `debtDirectionLabelKey` rather than a generic `directionLabel`.

- [ ] **Step 1: Write the failing `formatDate` test**

`lib/ui/format-date.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatDate } from './format-date'

const HCM = 'Asia/Ho_Chi_Minh'
/** 2026-09-08T17:30Z is 2026-09-09 00:30 in Ho Chi Minh City. */
const INSTANT = new Date('2026-09-08T17:30:00.000Z')

describe('formatDate', () => {
  it('reads an instant in the user’s zone, not the server’s', () => {
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: HCM, style: 'date' })).toBe('09/09/2026')
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: 'UTC', style: 'date' })).toBe('08/09/2026')
  })

  it('formats a date per locale', () => {
    expect(formatDate(INSTANT, { locale: 'en', timeZone: HCM, style: 'date' })).toBe('Sep 9, 2026')
  })

  it('formats a date and time', () => {
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: HCM, style: 'dateTime' })).toBe(
      '09/09/2026, 00:30',
    )
  })

  it('formats a month and year for a page header', () => {
    expect(formatDate(INSTANT, { locale: 'en', timeZone: HCM, style: 'monthYear' })).toBe(
      'September 2026',
    )
  })

  it('reads a yyyy-MM-dd carrier as that calendar day everywhere', () => {
    // A `CalendarDate` carrier is UTC midnight by construction, so it must be
    // read in UTC and never shifted into the reader's zone — otherwise a due
    // date of the 9th displays as the 8th for anyone west of UTC.
    expect(formatDate('2026-09-09', { locale: 'vi', timeZone: HCM, style: 'date' })).toBe(
      '09/09/2026',
    )
    expect(
      formatDate('2026-09-09', { locale: 'en', timeZone: 'America/New_York', style: 'date' }),
    ).toBe('Sep 9, 2026')
  })

  it('formats a weekday for a day-group header and a bare day/month for a compact row', () => {
    expect(formatDate('2026-09-09', { locale: 'en', timeZone: HCM, style: 'weekday' })).toContain(
      'Wednesday',
    )
    expect(formatDate('2026-09-09', { locale: 'vi', timeZone: HCM, style: 'dayMonth' })).toBe('09/09')
    expect(formatDate('2026-09-09', { locale: 'en', timeZone: HCM, style: 'dayMonth' })).toBe('Sep 9')
  })
})
```

Run: `npx vitest run lib/ui/format-date.test.ts` → FAIL.

Vietnamese `Intl` output varies across ICU versions. If a produced string differs from an expectation by a comma, a space or a case that `Intl` in this Node genuinely emits, fix the **expectation** to the observed value and add a one-line comment naming the Node version that produced it — never hand-build the string with `padStart` to force a shape.

- [ ] **Step 2: Write `lib/ui/format-date.ts`**

```ts
import { formatInTimeZone } from 'date-fns-tz'
import { INTL_LOCALE, type Locale } from '@/lib/i18n/locale'

/**
 * The one locale-aware date presenter in the UI (spec §4).
 *
 * It replaces the ad-hoc `formatInTimeZone(…, 'yyyy-MM-dd')` calls scattered
 * through the components — but ONLY in the UI. Services, the Excel export and
 * every `CalendarDate` carrier keep `yyyy-MM-dd`, because that is a data format
 * with a contract, not something a reader looks at.
 *
 * Two input shapes, and the difference matters:
 *
 *  - a `Date` is an INSTANT (a `Transaction.date`), so it is read in the user's
 *    own zone — the rule the whole codebase follows (ruling R6-7);
 *  - a `yyyy-MM-dd` string is a CALENDAR-DATE CARRIER (a due date, a deadline),
 *    which is UTC midnight by construction. Reading that in the reader's zone
 *    would show the 8th to anyone west of UTC for a date that is the 9th, so a
 *    carrier is always read in UTC.
 *
 * `Intl.DateTimeFormat`, not date-fns tokens, because the ORDER of the parts is
 * a locale decision (`09/09/2026` vs `Sep 9, 2026`) and a token string
 * hard-codes one language's order into every language.
 */
export type DateStyle = 'date' | 'dateTime' | 'monthYear' | 'weekday' | 'dayMonth'

const CARRIER_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: 'numeric', month: '2-digit', day: '2-digit' },
  dateTime: {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  },
  monthYear: { year: 'numeric', month: 'long' },
  weekday: { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' },
  dayMonth: { month: '2-digit', day: '2-digit' },
}

/**
 * English reads better with a named month at these four styles, and the
 * two-digit forms above are the Vietnamese convention — so the option set is
 * per locale, not global.
 */
const EN_OVERRIDES: Partial<Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  dateTime: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' },
  dayMonth: { month: 'short', day: 'numeric' },
}

export function formatDate(
  instantOrCarrier: Date | string,
  { locale, timeZone, style }: { locale: Locale; timeZone: string; style: DateStyle },
): string {
  const isCarrier = typeof instantOrCarrier === 'string' && CARRIER_PATTERN.test(instantOrCarrier)
  const instant = isCarrier
    ? new Date(`${instantOrCarrier}T00:00:00.000Z`)
    : new Date(instantOrCarrier)
  const options = { ...OPTIONS[style], ...(locale === 'en' ? EN_OVERRIDES[style] : undefined) }

  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    ...options,
    // A carrier is UTC midnight and means one calendar day everywhere; an
    // instant means "the moment", and which day that is depends on the reader.
    timeZone: isCarrier ? 'UTC' : timeZone,
    hourCycle: 'h23',
  }).format(instant)
}

/**
 * The `yyyy-MM-dd` a native `<input type="date">` is specified to take, for the
 * one caller that genuinely needs it — a `defaultValue`. Exported here so no
 * component reaches for `date-fns-tz` itself and accidentally localises a value
 * the browser then rejects.
 */
export function toDateInputValue(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd')
}
```

Run: `npx vitest run lib/ui/format-date.test.ts` → PASS (6 tests).

- [ ] **Step 3: Make `formatMoney` and friends locale-aware without breaking a single existing call**

Replace `lib/ui/format-money.ts:30-108`, keeping the module doc at `:1-28` with its "Grouping is Vietnamese in both currencies" paragraph rewritten to:

```
 * Grouping follows the READER's locale (spec §4, open decision 1): `vi-VN`
 * gives `1.234.567,89` and `en-US` gives `1,234,567.89`. Precision still
 * belongs to the currency — VND has no minor unit, so a whole number of dong
 * is shown whole rather than padded with a meaningless ",00".
 *
 * `locale` is the LAST parameter and defaults to `vi`, deliberately: every
 * pre-Phase-7 caller — and every Phase 2–6 test asserting Vietnamese grouping —
 * keeps working untouched, and a caller that knows the reader's locale passes
 * it. Task 13 threads it through the view models.
```

```ts
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from '@/lib/i18n/locale'

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return new Intl.NumberFormat(INTL_LOCALE[locale], options)
}

const FORMATTERS: Record<Locale, Record<Currency, Intl.NumberFormat>> = {
  vi: {
    VND: numberFormat('vi', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.VND,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
    USD: numberFormat('vi', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.USD,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
  },
  en: {
    VND: numberFormat('en', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.VND,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
    USD: numberFormat('en', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.USD,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
  },
}

export function formatMoney(
  value: Prisma.Decimal | string | number,
  currency: Currency,
  locale: Locale = DEFAULT_LOCALE,
): string {
  // The one sanctioned `Number()` on a money value in the codebase. `String()`
  // first so a `Decimal` goes through its own exact serialisation.
  return FORMATTERS[locale][currency].format(Number(String(value)))
}

const NO_VALUE = '—'

export function formatChartValue(
  value: unknown,
  currency: Currency,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const scalar = Array.isArray(value) ? value[0] : value
  if (scalar === null || scalar === undefined || scalar === '') return NO_VALUE
  if (typeof scalar !== 'number' && typeof scalar !== 'string') return NO_VALUE
  const asNumber = Number(scalar)
  if (!Number.isFinite(asNumber)) return NO_VALUE
  return `${FORMATTERS[locale][currency].format(asNumber)} ${currency}`
}

const RATE_FORMATTERS: Record<Locale, Intl.NumberFormat> = {
  vi: numberFormat('vi', { maximumFractionDigits: 2 }),
  en: numberFormat('en', { maximumFractionDigits: 2 }),
}

export function formatRate(
  rate: Prisma.Decimal | string | number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return RATE_FORMATTERS[locale].format(Number(String(rate)))
}

const COMPACT_FORMATTERS: Record<Locale, Intl.NumberFormat> = {
  vi: numberFormat('vi', { notation: 'compact', maximumFractionDigits: 1 }),
  en: numberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }),
}

export function formatCompactAmount(value: number, locale: Locale = DEFAULT_LOCALE): string {
  return COMPACT_FORMATTERS[locale].format(value)
}
```

- [ ] **Step 4: Add the English cases to `lib/ui/format-money.test.ts`**

Append (every existing expectation in that file stays exactly as it is, as the `vi` default's regression test):

```ts
describe('locale-aware formatting', () => {
  it('groups with commas in English and dots in Vietnamese', () => {
    expect(formatMoney(25_000_000, 'VND', 'en')).toBe('25,000,000')
    expect(formatMoney(25_000_000, 'VND', 'vi')).toBe('25.000.000')
    expect(formatMoney(25_000_000, 'VND')).toBe('25.000.000')
  })

  it('keeps currency precision independent of the reader’s locale', () => {
    expect(formatMoney(1234.5, 'USD', 'en')).toBe('1,234.50')
    expect(formatMoney(1234.5, 'USD', 'vi')).toBe('1.234,50')
  })

  it('formats a rate per locale', () => {
    expect(formatRate('25969.5', 'en')).toBe('25,969.5')
    expect(formatRate('25969.5', 'vi')).toBe('25.969,5')
  })

  it('formats a chart tooltip value per locale and still refuses a non-number', () => {
    expect(formatChartValue(1_500_000, 'VND', 'en')).toBe('1,500,000 VND')
    expect(formatChartValue(null, 'VND', 'en')).toBe('—')
  })

  it('abbreviates an axis label in each locale’s own short scale', () => {
    expect(formatCompactAmount(25_000_000, 'en')).toBe('25M')
    // Vietnamese compact notation is ICU-dependent; this is what this Node
    // emits. If it changes, change the expectation and note the version.
    expect(formatCompactAmount(25_000_000, 'vi')).toBe('25 Tr')
  })
})
```

Run: `npx vitest run lib/ui/format-money.test.ts` → PASS.

- [ ] **Step 5: Write `lib/ui/labels.ts`**

```ts
import type {
  BudgetScope,
  CategoryType,
  Currency,
  DebtDirection,
  OccurrenceStatus,
  PaymentFrequency,
  RecordStatus,
  RecurrenceFrequency,
  ReminderType,
  SavingsGoalStatus,
  TransactionType,
} from '@prisma/client'
import type { BudgetStatus } from '@/lib/server/services/budget'
import type { DebtDisplayStatus } from '@/lib/server/services/debt'
import type { LoanDisplayStatus } from '@/lib/server/services/loan'

/**
 * Every enum family's message KEY, in one place (spec §4).
 *
 * Not the text — the key. A view model returns keys and enum values; the
 * component that renders them calls `t(key)`. That split is what lets a view
 * model stay a pure function with a unit test, and it is why no raw enum
 * (`CASH_OUT`, `ADJUSTMENT_DECREASE`, `WRITTEN_OFF`, `PARTIALLY_PAID`) can
 * reach the DOM: there is no path from an enum to a screen that does not pass
 * through one of these functions.
 *
 * Keys are FULL dotted paths from the message root, so a caller uses the root
 * translator (`useTranslations()` / `getTranslations()` with no namespace) and
 * `t(transactionTypeLabelKey(tx.type))` just works.
 *
 * `Record<Enum, string>` for each map rather than a template literal: a new
 * enum member is then a compile error until it has a key, instead of a silent
 * `undefined` that next-intl renders as the key path itself.
 */
const TRANSACTION_TYPE_KEYS: Record<TransactionType, string> = {
  INCOME: 'labels.transactionType.INCOME',
  EXPENSE: 'labels.transactionType.EXPENSE',
  CASH_IN: 'labels.transactionType.CASH_IN',
  CASH_OUT: 'labels.transactionType.CASH_OUT',
  ADJUSTMENT_INCREASE: 'labels.transactionType.ADJUSTMENT_INCREASE',
  ADJUSTMENT_DECREASE: 'labels.transactionType.ADJUSTMENT_DECREASE',
}
export function transactionTypeLabelKey(type: TransactionType): string {
  return TRANSACTION_TYPE_KEYS[type]
}

const CATEGORY_TYPE_KEYS: Record<CategoryType, string> = {
  INCOME: 'labels.categoryType.INCOME',
  EXPENSE: 'labels.categoryType.EXPENSE',
}
export function categoryTypeLabelKey(type: CategoryType): string {
  return CATEGORY_TYPE_KEYS[type]
}

const RECORD_STATUS_KEYS: Record<RecordStatus, string> = {
  ACTIVE: 'labels.recordStatus.ACTIVE',
  ARCHIVED: 'labels.recordStatus.ARCHIVED',
}
export function recordStatusLabelKey(status: RecordStatus): string {
  return RECORD_STATUS_KEYS[status]
}

const BUDGET_SCOPE_KEYS: Record<BudgetScope, string> = {
  OVERALL: 'labels.budgetScope.OVERALL',
  CATEGORY: 'labels.budgetScope.CATEGORY',
}
export function budgetScopeLabelKey(scope: BudgetScope): string {
  return BUDGET_SCOPE_KEYS[scope]
}

const BUDGET_STATUS_KEYS: Record<BudgetStatus, string> = {
  ok: 'labels.budgetStatus.ok',
  warning_50: 'labels.budgetStatus.warning_50',
  warning_80: 'labels.budgetStatus.warning_80',
  at_100: 'labels.budgetStatus.at_100',
  exceeded: 'labels.budgetStatus.exceeded',
}
export function budgetStatusLabelKey(status: BudgetStatus): string {
  return BUDGET_STATUS_KEYS[status]
}

const GOAL_STATUS_KEYS: Record<SavingsGoalStatus, string> = {
  ACTIVE: 'labels.goalStatus.ACTIVE',
  ACHIEVED: 'labels.goalStatus.ACHIEVED',
  ARCHIVED: 'labels.goalStatus.ARCHIVED',
}
export function goalStatusLabelKey(status: SavingsGoalStatus): string {
  return GOAL_STATUS_KEYS[status]
}

const DEBT_DIRECTION_KEYS: Record<DebtDirection, string> = {
  RECEIVABLE: 'labels.debtDirection.RECEIVABLE',
  PAYABLE: 'labels.debtDirection.PAYABLE',
}
export function debtDirectionLabelKey(direction: DebtDirection): string {
  return DEBT_DIRECTION_KEYS[direction]
}

const DEBT_STATUS_KEYS: Record<DebtDisplayStatus, string> = {
  OPEN: 'labels.debtStatus.OPEN',
  PARTIALLY_PAID: 'labels.debtStatus.PARTIALLY_PAID',
  PAID: 'labels.debtStatus.PAID',
  OVERDUE: 'labels.debtStatus.OVERDUE',
  WRITTEN_OFF: 'labels.debtStatus.WRITTEN_OFF',
}
export function debtStatusLabelKey(status: DebtDisplayStatus): string {
  return DEBT_STATUS_KEYS[status]
}

const LOAN_STATUS_KEYS: Record<LoanDisplayStatus, string> = {
  ACTIVE: 'labels.loanStatus.ACTIVE',
  OVERDUE: 'labels.loanStatus.OVERDUE',
  PAID_OFF: 'labels.loanStatus.PAID_OFF',
  CLOSED: 'labels.loanStatus.CLOSED',
}
export function loanStatusLabelKey(status: LoanDisplayStatus): string {
  return LOAN_STATUS_KEYS[status]
}

const PAYMENT_FREQUENCY_KEYS: Record<PaymentFrequency, string> = {
  WEEKLY: 'labels.paymentFrequency.WEEKLY',
  MONTHLY: 'labels.paymentFrequency.MONTHLY',
  YEARLY: 'labels.paymentFrequency.YEARLY',
}
export function paymentFrequencyLabelKey(frequency: PaymentFrequency): string {
  return PAYMENT_FREQUENCY_KEYS[frequency]
}

const REMINDER_TYPE_KEYS: Record<ReminderType, string> = {
  INCOME: 'labels.reminderType.INCOME',
  EXPENSE: 'labels.reminderType.EXPENSE',
}
export function reminderTypeLabelKey(type: ReminderType): string {
  return REMINDER_TYPE_KEYS[type]
}

/**
 * Recurrence needs the interval as well as the frequency, because "hàng tuần"
 * and "mỗi 3 tuần" are different sentences and only the second takes a count —
 * exactly the distinction `recurrenceLabel` already makes
 * (`lib/ui/reminder-view-model.ts:74-87`), preserved here as two keys instead
 * of two hard-coded English strings. The caller passes `{ count: interval }` to
 * `t`; at interval 1 the key takes no argument and an extra one is harmless.
 *
 * ONE_TIME ignores the interval entirely — `createReminderSchema` refuses
 * anything but 1 on it, and describing a one-off as happening "every 3" of
 * anything would be a schedule it does not have.
 */
const RECURRENCE_KEYS: Record<RecurrenceFrequency, { one: string; many: string }> = {
  ONE_TIME: { one: 'labels.recurrence.ONE_TIME', many: 'labels.recurrence.ONE_TIME' },
  WEEKLY: { one: 'labels.recurrence.WEEKLY', many: 'labels.recurrence.WEEKLY_N' },
  MONTHLY: { one: 'labels.recurrence.MONTHLY', many: 'labels.recurrence.MONTHLY_N' },
  YEARLY: { one: 'labels.recurrence.YEARLY', many: 'labels.recurrence.YEARLY_N' },
}
export function recurrenceLabelKey(frequency: RecurrenceFrequency, interval: number): string {
  const keys = RECURRENCE_KEYS[frequency]
  return interval === 1 ? keys.one : keys.many
}

const OCCURRENCE_STATUS_KEYS: Record<OccurrenceStatus, string> = {
  PENDING: 'labels.occurrenceStatus.PENDING',
  ACKNOWLEDGED: 'labels.occurrenceStatus.ACKNOWLEDGED',
  DISMISSED: 'labels.occurrenceStatus.DISMISSED',
}
export function occurrenceStatusLabelKey(status: OccurrenceStatus): string {
  return OCCURRENCE_STATUS_KEYS[status]
}

const CURRENCY_KEYS: Record<Currency, string> = {
  VND: 'labels.currency.VND',
  USD: 'labels.currency.USD',
}
export function currencyLabelKey(currency: Currency): string {
  return CURRENCY_KEYS[currency]
}
```

- [ ] **Step 6: Write the exhaustiveness test against the real message files**

`lib/ui/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import viLabels from '@/messages/vi/labels.json'
import enLabels from '@/messages/en/labels.json'
import {
  budgetScopeLabelKey,
  budgetStatusLabelKey,
  categoryTypeLabelKey,
  currencyLabelKey,
  debtDirectionLabelKey,
  debtStatusLabelKey,
  goalStatusLabelKey,
  loanStatusLabelKey,
  occurrenceStatusLabelKey,
  paymentFrequencyLabelKey,
  recordStatusLabelKey,
  recurrenceLabelKey,
  reminderTypeLabelKey,
  transactionTypeLabelKey,
} from './labels'

/**
 * The guarantee this file exists for (spec §4): every member of every enum the
 * UI renders has a real label in BOTH locales. A missing key surfaces as
 * next-intl echoing the key path into the DOM — which is the "raw enum on
 * screen" defect Phase 7 is fixing, wearing a different hat.
 *
 * The members are listed literally rather than read off `@prisma/client` at
 * runtime: the Prisma client here is WASM-based and needs a driver adapter, and
 * importing it for a key-shape test would pull a database driver into a pure
 * unit test. The lists are checked against `prisma/schema.prisma` by hand, and
 * the `Record<Enum, …>` types in `labels.ts` are what make a schema change a
 * compile error rather than a silently unchecked member here.
 */
function resolve(tree: unknown, key: string): unknown {
  return key
    .replace(/^labels\./, '')
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree)
}

const CASES: [string, string[]][] = [
  [
    'transactionType',
    (
      ['INCOME', 'EXPENSE', 'CASH_IN', 'CASH_OUT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE'] as const
    ).map(transactionTypeLabelKey),
  ],
  ['categoryType', (['INCOME', 'EXPENSE'] as const).map(categoryTypeLabelKey)],
  ['recordStatus', (['ACTIVE', 'ARCHIVED'] as const).map(recordStatusLabelKey)],
  ['budgetScope', (['OVERALL', 'CATEGORY'] as const).map(budgetScopeLabelKey)],
  [
    'budgetStatus',
    (['ok', 'warning_50', 'warning_80', 'at_100', 'exceeded'] as const).map(budgetStatusLabelKey),
  ],
  ['goalStatus', (['ACTIVE', 'ACHIEVED', 'ARCHIVED'] as const).map(goalStatusLabelKey)],
  ['debtDirection', (['RECEIVABLE', 'PAYABLE'] as const).map(debtDirectionLabelKey)],
  [
    'debtStatus',
    (['OPEN', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WRITTEN_OFF'] as const).map(debtStatusLabelKey),
  ],
  ['loanStatus', (['ACTIVE', 'OVERDUE', 'PAID_OFF', 'CLOSED'] as const).map(loanStatusLabelKey)],
  ['paymentFrequency', (['WEEKLY', 'MONTHLY', 'YEARLY'] as const).map(paymentFrequencyLabelKey)],
  ['reminderType', (['INCOME', 'EXPENSE'] as const).map(reminderTypeLabelKey)],
  [
    'recurrence',
    (['ONE_TIME', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).flatMap((frequency) => [
      recurrenceLabelKey(frequency, 1),
      recurrenceLabelKey(frequency, 3),
    ]),
  ],
  [
    'occurrenceStatus',
    (['PENDING', 'ACKNOWLEDGED', 'DISMISSED'] as const).map(occurrenceStatusLabelKey),
  ],
  ['currency', (['VND', 'USD'] as const).map(currencyLabelKey)],
]

describe('label keys', () => {
  for (const [family, keys] of CASES) {
    it(`${family}: every member resolves to a non-empty label in vi and en`, () => {
      for (const key of keys) {
        expect(resolve(viLabels, key), `vi ${key}`).toBeTypeOf('string')
        expect(resolve(viLabels, key), `vi ${key}`).not.toBe('')
        expect(resolve(enLabels, key), `en ${key}`).toBeTypeOf('string')
        expect(resolve(enLabels, key), `en ${key}`).not.toBe('')
      }
    })
  }

  it('has no label in the files that no function points at — dead copy rots', () => {
    const reachable = new Set(
      CASES.flatMap(([, keys]) => keys.map((key) => key.replace(/^labels\./, ''))),
    )
    function leaves(node: unknown, prefix = ''): string[] {
      if (typeof node !== 'object' || node === null) return [prefix]
      return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    }
    expect(leaves(viLabels).filter((key) => !reachable.has(key))).toEqual([])
  })
})
```

Run: `npx vitest run lib/ui/labels.test.ts` → PASS (15 tests).

- [ ] **Step 7: Convert `lib/ui/action-error-messages.ts` into key maps, keeping the English maps as temporary aliases**

Keep the module doc's first four paragraphs (`lib/ui/action-error-messages.ts:10-26`) and replace its final "Phase 7 replaces these literals with i18n keys" paragraph with a statement that it did. Every value becomes a key:

```ts
export const GENERIC_ERROR_KEY = 'errors.generic'

export const ACCOUNT_ERROR_KEYS: Record<FinancialAccountActionError, string> = {
  NON_ZERO_BALANCE: 'errors.account.NON_ZERO_BALANCE',
  ACCOUNT_LOCKED: 'errors.account.ACCOUNT_LOCKED',
  ARCHIVED_ACCOUNT: 'errors.account.ARCHIVED_ACCOUNT',
  INVALID_ACCOUNT_TYPE: 'errors.account.INVALID_ACCOUNT_TYPE',
  INVALID_INPUT: 'errors.account.INVALID_INPUT',
  NOT_FOUND: 'errors.account.NOT_FOUND',
}

export const TRANSACTION_ERROR_KEYS: Record<TransactionActionError, string> = {
  FX_UNAVAILABLE: 'errors.transaction.FX_UNAVAILABLE',
  ARCHIVED_ACCOUNT: 'errors.transaction.ARCHIVED_ACCOUNT',
  CURRENCY_MISMATCH: 'errors.transaction.CURRENCY_MISMATCH',
  INVALID_CATEGORY: 'errors.transaction.INVALID_CATEGORY',
  CONFLICT: 'errors.transaction.CONFLICT',
  INVALID_INPUT: 'errors.transaction.INVALID_INPUT',
  NOT_FOUND: 'errors.transaction.NOT_FOUND',
}

export const TRANSFER_ERROR_KEYS: Record<TransferActionError, string> = {
  SAME_ACCOUNT: 'errors.transfer.SAME_ACCOUNT',
  ARCHIVED_ACCOUNT: 'errors.transfer.ARCHIVED_ACCOUNT',
  INVALID_INPUT: 'errors.transfer.INVALID_INPUT',
  NOT_FOUND: 'errors.transfer.NOT_FOUND',
}

export const BUDGET_ERROR_KEYS: Record<BudgetActionError, string> = {
  DUPLICATE_BUDGET: 'errors.budget.DUPLICATE_BUDGET',
  INVALID_CATEGORY: 'errors.budget.INVALID_CATEGORY',
  INVALID_INPUT: 'errors.budget.INVALID_INPUT',
  NOT_FOUND: 'errors.budget.NOT_FOUND',
}

export const SAVINGS_GOAL_ERROR_KEYS: Record<SavingsGoalActionError, string> = {
  ARCHIVED: 'errors.goal.ARCHIVED',
  INVALID_INPUT: 'errors.goal.INVALID_INPUT',
  NOT_FOUND: 'errors.goal.NOT_FOUND',
}

export const DEBT_ERROR_KEYS: Record<DebtActionError, string> = {
  OVERPAYMENT: 'errors.debt.OVERPAYMENT',
  NOT_ACTIVE: 'errors.debt.NOT_ACTIVE',
  INVALID_INPUT: 'errors.debt.INVALID_INPUT',
  NOT_FOUND: 'errors.debt.NOT_FOUND',
}

export const LOAN_ERROR_KEYS: Record<LoanActionError, string> = {
  OVERPAYMENT: 'errors.loan.OVERPAYMENT',
  NOT_ACTIVE: 'errors.loan.NOT_ACTIVE',
  SPLIT_MISMATCH: 'errors.loan.SPLIT_MISMATCH',
  INVALID_INPUT: 'errors.loan.INVALID_INPUT',
  NOT_FOUND: 'errors.loan.NOT_FOUND',
}

export const REMINDER_ERROR_KEYS: Record<ReminderActionError, string> = {
  INVALID_CATEGORY: 'errors.reminder.INVALID_CATEGORY',
  INVALID_ACCOUNT: 'errors.reminder.INVALID_ACCOUNT',
  INVALID_INPUT: 'errors.reminder.INVALID_INPUT',
  NOT_FOUND: 'errors.reminder.NOT_FOUND',
}

/**
 * TEMPORARY (Phase 7, Tasks 2–13). Eleven components and two e2e specs still
 * render/assert this English text literally until their own task switches to
 * `t(KEY)`. The maps are DERIVED from `messages/en/errors.json`, so the literal
 * and the translation can never disagree, and Task 13 deletes this block along
 * with the last literal caller.
 */
import enErrors from '@/messages/en/errors.json'

function englishMap<T extends string>(keys: Record<T, string>): Record<T, string> {
  return Object.fromEntries(
    Object.entries(keys).map(([code, key]) => [
      code,
      (key as string)
        .replace(/^errors\./, '')
        .split('.')
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          enErrors as unknown,
        ) as string,
    ]),
  ) as Record<T, string>
}

export const GENERIC_ERROR_MESSAGE: string = enErrors.generic
export const ACCOUNT_ERROR_MESSAGES = englishMap(ACCOUNT_ERROR_KEYS)
export const TRANSACTION_ERROR_MESSAGES = englishMap(TRANSACTION_ERROR_KEYS)
export const TRANSFER_ERROR_MESSAGES = englishMap(TRANSFER_ERROR_KEYS)
export const BUDGET_ERROR_MESSAGES = englishMap(BUDGET_ERROR_KEYS)
export const SAVINGS_GOAL_ERROR_MESSAGES = englishMap(SAVINGS_GOAL_ERROR_KEYS)
export const DEBT_ERROR_MESSAGES = englishMap(DEBT_ERROR_KEYS)
export const LOAN_ERROR_MESSAGES = englishMap(LOAN_ERROR_KEYS)
export const REMINDER_ERROR_MESSAGES = englishMap(REMINDER_ERROR_KEYS)
```

Move the `import enErrors` to the top of the file with the other imports (ESLint will insist); the comment stays above the alias block.


- [ ] **Step 8: Write the failing extraction test for the validation dictionary**

Spec §4's amended ruling: the Zod schemas keep their English literals, and the UI translates them at the render boundary. The proof that the dictionary is complete is a test that reads the schemas' source.

`lib/ui/validation-messages.test.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import viValidation from '@/messages/vi/validation.json'
import enValidation from '@/messages/en/validation.json'
import { ZOD_MESSAGE_PATTERN, validationMessageKey } from './validation-messages'

/**
 * Every Zod message literal in `lib/validation/**` has a Vietnamese and an
 * English entry (spec §4).
 *
 * It reads the SOURCE rather than importing the schemas, for two reasons: a
 * schema's message is only reachable at runtime by making it fail, which would
 * mean constructing an invalid input per rule; and the Prisma client these
 * modules pull in is WASM-based and needs a driver adapter, which a pure unit
 * test should not require.
 *
 * A literal the regex cannot see is the one way this can pass while the UI
 * still shows English — so when a message is added in a shape the pattern
 * misses, the fix is the PATTERN, and this comment is the reminder.
 */
function validationSourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return validationSourceFiles(full)
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
      return [full]
    })
}

function literals(): string[] {
  const found = new Set<string>()
  for (const file of validationSourceFiles(path.join(process.cwd(), 'lib', 'validation'))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(ZOD_MESSAGE_PATTERN)) {
      const literal = match.groups?.message
      if (literal) found.add(literal)
    }
  }
  return [...found].sort()
}

function at(tree: unknown, key: string): unknown {
  return key
    .replace(/^validation\./, '')
    .split('\u0000')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree)
}

describe('validation message dictionary', () => {
  it('finds the schemas’ literals at all — a zero-hit regex would pass vacuously', () => {
    const all = literals()
    expect(all.length).toBeGreaterThan(15)
    // Three the schemas definitely carry today, as canaries.
    expect(all).toContain('Enter an amount')
    expect(all).toContain('Name is required')
    expect(all).toContain('Timezone is required')
  })

  it('has a vi and an en entry for every literal', () => {
    const missingVi: string[] = []
    const missingEn: string[] = []
    for (const literal of literals()) {
      const key = validationMessageKey(literal)
      if (typeof at(viValidation, key) !== 'string') missingVi.push(literal)
      if (typeof at(enValidation, key) !== 'string') missingEn.push(literal)
    }
    expect({ missingVi, missingEn }).toEqual({ missingVi: [], missingEn: [] })
  })

  it('has no entry that no schema emits — dead copy rots', () => {
    const live = new Set(literals())
    const stale = Object.keys(viValidation as Record<string, string>).filter(
      (literal) => !live.has(literal),
    )
    expect(stale).toEqual([])
  })

  it('keys a literal containing a dot without splitting it', () => {
    // next-intl treats `.` as a path separator, so a message like "Total must
    // equal principal plus interest." cannot be a bare key.
    const key = validationMessageKey('Total must equal principal plus interest.')
    expect(key.startsWith('validation.')).toBe(true)
    expect(key.slice('validation.'.length)).not.toContain('.')
  })
})
```

Run: `npx vitest run lib/ui/validation-messages.test.ts` → FAIL (`Failed to resolve import "./validation-messages"`).

- [ ] **Step 9: Write `lib/ui/validation-messages.ts`**

```ts
/**
 * The bridge between the Zod schemas' English literals and their Vietnamese
 * renderings (spec §4).
 *
 * The schemas do NOT change. Their messages are asserted by Phase 2–6 tests,
 * they are re-produced server-side on every submit, and moving message text
 * into the validation layer would be exactly the semantics change this phase
 * forbids. So the literal *is* the key, and the translation happens where the
 * message is rendered — in `FieldError`.
 *
 * Two escaping problems make this a function rather than a template literal at
 * each call site:
 *
 *  1. next-intl reads `.` as a path separator, so "Total must equal principal
 *     plus interest." would look up `validation.Total must equal principal plus
 *     interest` → `''` and find nothing. Dots become `\u2024` (ONE DOT LEADER),
 *     a character no schema message contains.
 *  2. A message may contain `{` or `}` (none does today), which ICU would read
 *     as an argument. Those are stripped from the KEY, and the value in
 *     `validation.json` is what carries the readable text.
 *
 * `messages/{vi,en}/validation.json` is therefore keyed by the ESCAPED literal,
 * and `validation-messages.test.ts` is what keeps the two in step.
 */
const DOT = '\u2024'

export function validationMessageKey(message: string): string {
  return `validation.${message.replaceAll('.', DOT).replaceAll('{', '').replaceAll('}', '')}`
}

/**
 * Every shape a Zod message takes in `lib/validation/**`, as of Phase 7:
 *
 *   z.string().min(1, 'Name is required')          → the 2nd argument
 *   z.number().positive('Enter an amount')         → the only argument
 *   .refine(fn, 'Enter a valid IANA timezone, e.g. Asia/Ho_Chi_Minh')
 *                                                  → the 2nd argument
 *   z.enum([...], { error: 'Choose a type' })      → the `error:` property
 *
 * One pattern for all four: a single-quoted string that follows either a comma
 * or `error:` inside a call. Deliberately conservative — it will miss a message
 * written as a template literal or a variable, and the test's canary assertions
 * are what surface that, because a regex that silently finds nothing is worse
 * than one that finds too much.
 */
export const ZOD_MESSAGE_PATTERN =
  /(?:,\s*|error:\s*)'(?<message>[^'\\]{4,120})'/g
```

Run: `npx vitest run lib/ui/validation-messages.test.ts` → the first and fourth cases PASS, the second FAILS listing every literal (because `validation.json` is `{}` from Task 2b). That list is the work item for Step 10.

- [ ] **Step 10: Fill `messages/{vi,en}/validation.json` from the failing test's own output**

Run the test, take the `missingEn` list, and write **every** literal into `messages/en/validation.json` as its own value — the English file's value for a literal is the literal, which is what makes the fallback and the translation agree:

```json
{
  "Enter an amount": "Enter an amount",
  "Name is required": "Name is required",
  "Timezone is required": "Timezone is required"
}
```
(keys escaped by `validationMessageKey`'s rule — a literal with a dot has `\u2024` where the dot was).

Then write `messages/vi/validation.json` with the Vietnamese for each. The ones the schemas carry today, from a read of `lib/validation/*.ts`:

- `"Name is required"` → `"Vui lòng nhập tên"`
- `"Timezone is required"` → `"Vui lòng chọn múi giờ"`
- `"Enter a valid IANA timezone, e.g. Asia/Ho_Chi_Minh"` → `"Múi giờ không hợp lệ, ví dụ Asia/Ho_Chi_Minh"`
- `"Current password is required"` → `"Vui lòng nhập mật khẩu hiện tại"`
- `"Password must be at least 8 characters"` → `"Mật khẩu phải có ít nhất 8 ký tự"`
- `"Total must equal principal plus interest"` → `"Tổng phải bằng gốc cộng lãi"`

**Do not guess the rest.** Run the test, take its list, and translate each literal it names — the list is authoritative and the file is the only place these strings exist twice. Any literal whose Vietnamese is not obvious from the field it guards: read the schema, read the field's label in its module's message file, and write copy that matches that field's wording.

Run: `npx vitest run lib/ui/validation-messages.test.ts` → PASS (4 tests).

- [ ] **Step 11: Wire `FieldError` to it**

If Task 1b already wrote `FieldError`'s `t(validationMessageKey(message))` call, verify it against the module above and move on. If 1b ran first and left `FieldError` rendering the message verbatim, add the call now, exactly as Task 1b's step specifies, and re-run `npx vitest run components/common`.

- [ ] **Step 12: Full verification**

Run: `npm run test` → green (`format-date.test.ts` 6, `labels.test.ts` 15, `format-money.test.ts` +5, `validation-messages.test.ts` 4, and every existing test — including every Phase 2–6 validation test, which must be **untouched**).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.
Run: `git diff --stat main -- lib/validation` → **empty**. That is this task's headline claim: Vietnamese validation copy with no schema change.

**Tests required:**
- Vitest: `lib/ui/format-date.test.ts` (6 new), `lib/ui/labels.test.ts` (15 new), `lib/ui/format-money.test.ts` (5 new), `lib/ui/validation-messages.test.ts` (4 new).
- Playwright: none. Task 13 Step 6a is where the three rendered validation messages are checked in the browser.

**Browser visual checks required:** none — no component renders these yet.

**Explicit things NOT to change:** `lib/validation/**` — not one schema, not one message literal, and `git diff --stat` is the gate; the existing Vietnamese-grouping expectations in `lib/ui/format-money.test.ts` (they are the default locale's regression test); `formatRate`'s "always VND per 1 USD" contract; the English values in `errors.json`/`labels.json` that two e2e specs assert.

**Completion gate:** four commands green plus the empty `lib/validation` diff; `validation.json` has an entry per extracted literal in both locales, proved by the test rather than by inspection; the canary assertions confirm the extraction regex actually finds messages.

**Proposed commit boundary:**
1. `feat(i18n): locale-aware formatDate/formatMoney and the enum label-key functions`
2. `feat(i18n): translate Zod messages at the render boundary, with an extraction test proving the dictionary complete`

---

## Task 3: App shell and navigation

**Objective:** Rebuild the frame every signed-in page renders inside, per spec §5: a 240 px grouped desktop rail with the user's name and a ghost Log out at the bottom, a 64 px icon rail with tooltips at tablet, and on phones a top bar plus a five-slot bottom tab bar whose "Thêm" opens the accessible `Sheet` — replacing today's hand-rolled disclosure panel. Every nav label comes from `nav.json`.

**Major files touched:** `components/layout/nav-groups.ts` (new), `components/layout/nav-items.ts`, `components/layout/app-shell.tsx`, `components/layout/mobile-nav.tsx`, `components/layout/more-sheet.tsx` (new), `components/auth/logout-button.tsx`, `app/(app)/layout.tsx`, `app/(app)/error.tsx`, `messages/{vi,en}/nav.json`, `e2e/phase4.spec.ts`, `e2e/phase5.spec.ts`, `e2e/phase6.spec.ts`.

**Reusable primitives involved:** `Sheet` (the mobile More panel), `InlineAlert` + `Button` (the error boundary), `Skeleton` (not yet — Task 17).

**User-facing behaviour:** the rail groups twelve destinations under five muted headers; the primary "Thêm giao dịch" button sits under the wordmark; the user's name and a ghost Log out sit at the bottom. On a tablet the rail is icons only, each with an accessible name. On a phone the bottom bar has five slots — Tổng quan, Giao dịch, a raised brand `+`, Tài khoản, Báo cáo — and the top bar's "Thêm" opens a bottom sheet with the remaining routes in a two-column icon grid plus Settings and Log out. The sheet closes on its close button, Escape, an overlay tap, or a navigation, and returns focus to the trigger.

**Desktop expectation (≥ 1024):** rail 240 px on `bg-surface` with a right hairline; wordmark 16/600 brand; group headers 12/500 muted with 16 px above each; items 14 px, 36 px tall, active = `bg-muted text-brand` plus a 2 px brand bar on the left edge; content area centred by each page's own max width; no bottom bar.

**Mobile expectation (< 768):** top bar with wordmark + page-agnostic "Thêm" trigger; bottom bar 60 px plus `env(safe-area-inset-bottom)`; five slots; the `+` is a 52 px raised brand circle ringed in `border-surface`; tab labels 11 px with no `text-ellipsis` (the Vietnamese labels are chosen to fit — spec §4); `main` keeps bottom padding equal to the bar so no content sits under it.

**Tablet expectation (768–1023):** the rail collapses to 64 px, icons only, each `Link` carrying `aria-label` and `title`; group headers become a 1 px divider between groups; no bottom bar (this is today's behaviour at 768 and must not regress — `e2e/phase4.spec.ts:217-229` asserts it).

**Dark-theme expectation:** rail is `bg-surface` (#202724) against `bg-background` (#171C1A) so the frame is visible without a border-heavy look; the active item's `bg-muted` is legible; the raised `+` keeps the brand at dark L≈0.60 with `border-surface` and no glow; the More sheet is `bg-surface-2`.

**Vietnamese/English expectation:** every label, group header and `aria-label` comes from `nav.json` (Task 2a). Vietnamese labels are ≤ 12 characters, so the bottom tab labels fit at 11 px at 375 px without truncation; the rail's "Chuyển tiền" (11) and "Thêm giao dịch" (14, a button not a tab) are the longest. English labels are shorter and cannot overflow.

**Accessibility acceptance criteria:**
- Exactly two `<nav>` landmarks, with distinct accessible names: `t('nav.primary')` (rail) and `t('nav.compact')` (bottom bar).
- Group headers are real elements associated with their list: each group is `<div role="group" aria-labelledby={headerId}>` wrapping an `<h2 id>` + `<ul>`.
- Active item carries `aria-current="page"`.
- The icon-only tablet rail gives every link an `aria-label`; the `+` action and the More trigger have `aria-label`s.
- The More `Sheet` traps focus, restores it to the trigger, closes on Escape and overlay click, and exposes `role="dialog"` with `aria-labelledby` on its title.
- Every touch target in the bottom bar is ≥ 44 px tall.
- Skip-to-content: the shell renders a visually hidden "Đến nội dung" link as the first focusable element, targeting `#main`.

**Hydration/form-submission constraints:** none — the shell contains no form. `AppShell` stays a client component only because the active item needs `usePathname`; `children` are still passed through untouched so every page stays a server component and no page data crosses the boundary.

**Files:**
- Create: `components/layout/nav-groups.ts`, `components/layout/more-sheet.tsx`
- Modify: `components/layout/nav-items.ts:29-79` (labels become keys), `components/layout/app-shell.tsx:1-92` (whole file), `components/layout/mobile-nav.tsx:1-203` (whole file), `components/auth/logout-button.tsx:22-26`, `app/(app)/layout.tsx:1-13`, `app/(app)/error.tsx:30-50`, `messages/vi/nav.json` + `messages/en/nav.json` (add `skipToContent`)
- Create: `e2e/phase7-shell.spec.ts`
- Test: `components/layout/nav-groups.test.ts` (new), `e2e/phase7-shell.spec.ts` (new); modify `e2e/phase4.spec.ts:70-230`, `e2e/phase5.spec.ts:73-77,305-312`, `e2e/phase6.spec.ts:396-436,855-880`

**Interfaces:**

- Consumes: `Sheet` from `@/components/common/sheet` (Tasks 1a–1c); `useTranslations` from `next-intl`; `LucideIcon` from `lucide-react`.
- Produces:

```ts
// components/layout/nav-items.ts (labels become message keys)
export interface NavItem {
  href: string
  /** A key in `nav.json`, e.g. `'nav.dashboard'` — never display text. */
  labelKey: string
  icon: LucideIcon
}
export const NAV_ITEMS: NavItem[]
export const MOBILE_TAB_HREFS: readonly string[] // ['/dashboard','/transactions','/accounts','/reports']
export const MOBILE_MORE_ITEMS: NavItem[]
export const MOBILE_TAB_ITEMS: NavItem[]
export const ADD_TRANSACTION_HREF = '/transactions#new'
export function isActiveNavItem(pathname: string, href: string): boolean

// components/layout/nav-groups.ts
export interface NavGroup {
  id: string
  /** A key in `nav.json`, e.g. `'nav.groupMoney'`. */
  headerKey: string
  items: NavItem[]
}
export const NAV_GROUPS: NavGroup[]

// components/layout/more-sheet.tsx  ('use client')
export function MoreSheet(props: { open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement

// components/layout/app-shell.tsx  ('use client')
export function AppShell(props: { userName: string; children: React.ReactNode }): React.ReactElement

// components/layout/mobile-nav.tsx  ('use client')
export function MobileTopBar(): React.ReactElement
export function MobileTabBar(): React.ReactElement

// components/auth/logout-button.tsx  ('use client') — gains one prop
export function LogoutButton(props: {
  /** Icon-only until `lg`, for the collapsible rail. The More sheet and every
   *  other caller omit it and get the label at every width. */
  compact?: boolean
}): React.ReactElement
```

- [ ] **Step 1: Write the failing test for the group structure**

`components/layout/nav-groups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import viNav from '@/messages/vi/nav.json'
import enNav from '@/messages/en/nav.json'
import { NAV_GROUPS } from './nav-groups'
import { MOBILE_MORE_ITEMS, MOBILE_TAB_ITEMS, NAV_ITEMS } from './nav-items'

function navKey(tree: Record<string, unknown>, key: string): unknown {
  return tree[key.replace(/^nav\./, '')]
}

describe('navigation', () => {
  it('groups every destination exactly once, in the spec’s five groups', () => {
    expect(NAV_GROUPS.map((group) => group.id)).toEqual([
      'overview',
      'money',
      'planning',
      'reports',
      'settings',
    ])
    const grouped = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href))
    expect(grouped).toHaveLength(NAV_ITEMS.length)
    expect(new Set(grouped).size).toBe(NAV_ITEMS.length)
    expect([...grouped].sort()).toEqual(NAV_ITEMS.map((item) => item.href).sort())
  })

  it('puts the money and planning modules in the spec’s order (§5)', () => {
    const byId = Object.fromEntries(NAV_GROUPS.map((group) => [group.id, group.items.map((i) => i.href)]))
    expect(byId.overview).toEqual(['/dashboard'])
    expect(byId.money).toEqual(['/transactions', '/transfers', '/accounts', '/categories'])
    expect(byId.planning).toEqual(['/budgets', '/goals', '/debts', '/loans', '/reminders'])
    expect(byId.reports).toEqual(['/reports'])
    expect(byId.settings).toEqual(['/settings'])
  })

  it('names every item and group header with a key that exists in both locales', () => {
    const keys = [
      ...NAV_ITEMS.map((item) => item.labelKey),
      ...NAV_GROUPS.map((group) => group.headerKey),
    ]
    for (const key of keys) {
      expect(navKey(viNav, key), `vi ${key}`).toBeTypeOf('string')
      expect(navKey(enNav, key), `en ${key}`).toBeTypeOf('string')
    }
  })

  it('keeps every Vietnamese nav label within twelve characters (spec §4)', () => {
    for (const item of NAV_ITEMS) {
      const label = navKey(viNav, item.labelKey) as string
      expect(label.length, `${item.href} → "${label}"`).toBeLessThanOrEqual(12)
    }
  })

  it('shows exactly four routes in the bottom bar and the other eight behind More', () => {
    expect(MOBILE_TAB_ITEMS.map((item) => item.href)).toEqual([
      '/dashboard',
      '/transactions',
      '/accounts',
      '/reports',
    ])
    expect(MOBILE_MORE_ITEMS).toHaveLength(NAV_ITEMS.length - 4)
    expect(MOBILE_MORE_ITEMS.map((item) => item.href)).not.toContain('/dashboard')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run components/layout/nav-groups.test.ts`
Expected: FAIL — `Failed to resolve import "./nav-groups"`, and (once that exists) `NAV_ITEMS[…].labelKey` is `undefined` because `nav-items.ts` still carries `label`.

- [ ] **Step 3: Turn `nav-items.ts`'s labels into keys**

Replace `components/layout/nav-items.ts:29-48`, keeping the module doc at `:17-28` and adding a sentence about why keys:

```ts
/**
 * `labelKey`, not `label`: the rail, the bottom bar and the More sheet all
 * render the same item, and Phase 7 renders it in the reader's language — so
 * the item carries the KEY and whichever component draws it calls `t`. A
 * display string here would have to be translated three times, or once in a
 * place that has no translator.
 */
export interface NavItem {
  href: string
  labelKey: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
  { href: '/transactions', labelKey: 'nav.transactions', icon: Receipt },
  { href: '/transfers', labelKey: 'nav.transfers', icon: ArrowLeftRight },
  { href: '/accounts', labelKey: 'nav.accounts', icon: Wallet },
  { href: '/budgets', labelKey: 'nav.budgets', icon: Target },
  { href: '/goals', labelKey: 'nav.goals', icon: PiggyBank },
  { href: '/debts', labelKey: 'nav.debts', icon: HandCoins },
  { href: '/loans', labelKey: 'nav.loans', icon: Landmark },
  { href: '/reminders', labelKey: 'nav.reminders', icon: BellRing },
  { href: '/categories', labelKey: 'nav.categories', icon: Tags },
  { href: '/reports', labelKey: 'nav.reports', icon: ChartColumn },
  { href: '/settings', labelKey: 'nav.settings', icon: Settings },
]
```

`MOBILE_TAB_HREFS`, `MOBILE_MORE_ITEMS`, `MOBILE_TAB_ITEMS`, `ADD_TRANSACTION_HREF` and `isActiveNavItem` (`:50-79`) stay exactly as they are — the four-route bottom bar is unchanged and its "typo in `MOBILE_TAB_HREFS` fails at module load" guard is still the right guard.

- [ ] **Step 4: Write `components/layout/nav-groups.ts`**

```ts
import { NAV_ITEMS, type NavItem } from './nav-items'

/**
 * The rail's five groups (spec §5), so twelve destinations read as a structure
 * rather than a list: Tổng quan, then the things money moves through, then the
 * things you plan with, then Báo cáo, then Cài đặt.
 *
 * Built by looking each href up in `NAV_ITEMS` rather than re-declaring items,
 * so a group and the flat list cannot disagree about an icon or a label — and
 * a typo fails at module load, exactly as `MOBILE_TAB_ITEMS` does.
 *
 * `NAV_ITEMS` stays the flat source of truth: the mobile bar and the More sheet
 * use it directly, and `nav-groups.test.ts` asserts the groups partition it
 * exactly (every destination once, nothing invented, nothing lost).
 */
export interface NavGroup {
  id: string
  headerKey: string
  items: NavItem[]
}

function itemsFor(hrefs: string[]): NavItem[] {
  return hrefs.map((href) => {
    const item = NAV_ITEMS.find((candidate) => candidate.href === href)
    if (!item) throw new Error(`NAV_GROUPS references an unknown route: ${href}`)
    return item
  })
}

export const NAV_GROUPS: NavGroup[] = [
  { id: 'overview', headerKey: 'nav.groupOverview', items: itemsFor(['/dashboard']) },
  {
    id: 'money',
    headerKey: 'nav.groupMoney',
    items: itemsFor(['/transactions', '/transfers', '/accounts', '/categories']),
  },
  {
    id: 'planning',
    headerKey: 'nav.groupPlanning',
    items: itemsFor(['/budgets', '/goals', '/debts', '/loans', '/reminders']),
  },
  { id: 'reports', headerKey: 'nav.groupReports', items: itemsFor(['/reports']) },
  { id: 'settings', headerKey: 'nav.groupSettings', items: itemsFor(['/settings']) },
]
```

Run: `npx vitest run components/layout/nav-groups.test.ts` → PASS (5 tests).

- [ ] **Step 5: Add the skip-link key to both `nav.json` files**

`messages/vi/nav.json`: add `"skipToContent": "Đến nội dung"`.
`messages/en/nav.json`: add `"skipToContent": "Skip to content"`.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS (key parity holds).

- [ ] **Step 6: Rewrite `components/layout/app-shell.tsx`**

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { LogoutButton } from '@/components/auth/logout-button'
import { buttonVariants } from '@/components/ui/button'
import { MobileTabBar, MobileTopBar } from './mobile-nav'
import { NAV_GROUPS } from './nav-groups'
import { ADD_TRANSACTION_HREF, isActiveNavItem, type NavItem } from './nav-items'

/**
 * The frame every signed-in page renders inside (spec §5).
 *
 * Three navigations, not one responsive one:
 *
 *  - ≥ 1024: a 240 px rail with grouped destinations, the primary "Thêm giao
 *    dịch" action under the wordmark, and the user's name above a ghost Log out
 *    at the bottom (spec §14, decision 4).
 *  - 768–1023: the same rail at 64 px, icons only with accessible names. NOT a
 *    bottom bar — a tablet has the vertical space and `e2e/phase4.spec.ts`
 *    asserts the bar stays hidden at 768.
 *  - < 768: a top bar and a five-slot bottom bar, in `mobile-nav.tsx`.
 *
 * A client component only because the active item depends on `usePathname`. It
 * renders `children` untouched, so every page underneath stays a server
 * component and no page data crosses this boundary. `userName` is a plain
 * string the `(app)` layout reads from the session — never the session object.
 */
export function AppShell({ userName, children }: { userName: string; children: React.ReactNode }) {
  const pathname = usePathname()
  const t = useTranslations()

  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      {/* First focusable element on the page (spec §8): a keyboard user should
          not have to walk twelve rail links to reach the content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2 focus:text-sm"
      >
        {t('nav.skipToContent')}
      </a>

      {/* `sticky h-screen` keeps the rail in place while the page scrolls
          without taking the content out of normal flow. 64 px at md, 240 px
          from lg — one element, two widths, so there is no second rail to keep
          in step. */}
      <aside className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col border-r border-border bg-surface p-2 md:flex lg:w-60 lg:p-4">
        <Link
          href="/dashboard"
          className="flex h-9 items-center justify-center rounded-md text-base font-semibold text-brand lg:justify-start lg:px-2"
        >
          {/* The wordmark's first letter alone on the icon rail: "CashFlow" at
              64 px would either clip or shrink to unreadable. */}
          <span className="lg:hidden" aria-hidden="true">
            C
          </span>
          <span className="sr-only lg:not-sr-only">{t('common.appName')}</span>
        </Link>

        <Link
          href={ADD_TRANSACTION_HREF}
          aria-label={t('nav.addTransaction')}
          title={t('nav.addTransaction')}
          className={cn(
            buttonVariants({ size: 'default' }),
            'mt-6 w-full justify-center gap-2 lg:justify-start',
          )}
        >
          <Plus aria-hidden="true" className="size-4" />
          <span className="sr-only lg:not-sr-only">{t('nav.addTransaction')}</span>
        </Link>

        <nav aria-label={t('nav.primary')} className="mt-6 min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4">
            {NAV_GROUPS.map((group) => (
              // `role="group"` + `aria-labelledby` is what makes the header
              // belong to its items for a screen reader; a bare `<p>` above a
              // `<ul>` is only a visual grouping. On the icon rail the header
              // is hidden and a divider stands in for it.
              <div
                key={group.id}
                role="group"
                aria-labelledby={`nav-group-${group.id}`}
                className="flex flex-col gap-0.5 border-t border-border pt-4 first:border-t-0 first:pt-0 lg:border-t-0 lg:pt-0"
              >
                <h2
                  id={`nav-group-${group.id}`}
                  className="sr-only px-2 pb-1 text-xs/[1rem] font-medium tracking-[0.04em] text-muted-foreground uppercase lg:not-sr-only"
                >
                  {t(group.headerKey)}
                </h2>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <RailLink item={item} active={isActiveNavItem(pathname, item.href)} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        {/* Spec §14, decision 4: the user's name above a ghost Log out, at the
            bottom of the rail — not a solid outline button competing with the
            one primary action at the top. */}
        <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4">
          <p className="hidden truncate px-2 text-[0.8125rem]/[1.125rem] text-muted-foreground lg:block">
            {userName}
          </p>
          <LogoutButton />
        </div>
      </aside>

      <MobileTopBar />

      {/* `min-w-0` stops a wide child (a chart, a table) forcing the flex row
          wider than the viewport; the bottom padding reserves exactly the fixed
          mobile bar's height so it never covers the last row of content. */}
      <main id="main" className="min-w-0 flex-1 pb-24 md:pb-0">
        {children}
      </main>

      <MobileTabBar />
    </div>
  )
}

/**
 * One rail row. The 2 px brand bar on the left edge is the active marker
 * (spec §5) and it is drawn with a `before:` pseudo-element rather than a
 * border, so an inactive row's text does not shift by 2 px when it becomes
 * active.
 */
function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useTranslations()
  const label = t(item.labelKey)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      className={cn(
        'relative flex h-9 items-center justify-center gap-2.5 rounded-md text-sm lg:justify-start lg:px-2',
        active
          ? 'bg-muted font-medium text-brand before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      {/* Hidden on the icon rail, shown from lg. `aria-label` above carries
          the name at both widths, so a tablet user's screen reader is not left
          with an unnamed link. */}
      <span className="sr-only lg:not-sr-only">{label}</span>
    </Link>
  )
}
```

- [ ] **Step 7: Rewrite `components/layout/mobile-nav.tsx` with the five-slot bar**

```tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { MoreSheet } from './more-sheet'
import { ADD_TRANSACTION_HREF, MOBILE_TAB_ITEMS, isActiveNavItem, type NavItem } from './nav-items'

/**
 * The phone navigation (spec §5): a top bar carrying the wordmark and the
 * "Thêm" trigger, and a fixed bottom bar with five slots — two destinations, a
 * raised brand `+`, two more destinations.
 *
 * The "More" panel is now the shared `Sheet` primitive rather than the
 * hand-rolled disclosure this file used to contain. That disclosure wired
 * Escape, outside-pointer-down and `popstate` by hand and still had no focus
 * trap and no focus restoration — which is exactly what the spec requires and
 * what Base UI's Dialog gives for free.
 */
export function MobileTopBar() {
  const [open, setOpen] = useState(false)
  const t = useTranslations()

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface md:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="text-base font-semibold text-brand">
          {t('common.appName')}
        </Link>
        <button
          type="button"
          aria-label={t('nav.more')}
          onClick={() => setOpen(true)}
          className="flex h-11 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t('nav.more')}
        </button>
      </div>
      {/* Always mounted, `open`-driven: Base UI's Dialog needs to own the open
          transition to restore focus to the trigger, which a conditionally
          rendered panel cannot do. */}
      <MoreSheet open={open} onOpenChange={setOpen} />
    </header>
  )
}

/**
 * The bottom tab bar. Fixed, so it survives scrolling — which is why the shell
 * gives its content bottom padding: the bar must sit beside the page, never on
 * top of its last row. `env(safe-area-inset-bottom)` keeps the targets clear of
 * a home indicator.
 */
export function MobileTabBar() {
  const pathname = usePathname()
  const t = useTranslations()

  return (
    <nav
      // Distinct from the rail's name: a screen reader listing landmarks should
      // be able to tell the two navigations apart, and only one of them carries
      // the full set of destinations.
      aria-label={t('nav.compact')}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5 items-end">
        {MOBILE_TAB_ITEMS.slice(0, 2).map((item) => (
          <MobileTab key={item.href} item={item} pathname={pathname} />
        ))}
        <li className="flex justify-center">
          <Link
            href={ADD_TRANSACTION_HREF}
            aria-label={t('nav.addTransaction')}
            // Raised out of the bar and ringed in the bar's own colour rather
            // than lifted with a drop shadow — the same visual separation
            // without the glow this design system does not use. The ring is
            // `border-surface`, matching the bar it overlaps; `border-background`
            // drew a visible seam across it.
            className="-mt-5 flex size-13 items-center justify-center rounded-full border-4 border-surface bg-brand text-primary-foreground"
          >
            <Plus aria-hidden="true" className="size-6" />
          </Link>
        </li>
        {MOBILE_TAB_ITEMS.slice(2).map((item) => (
          <MobileTab key={item.href} item={item} pathname={pathname} />
        ))}
      </ul>
    </nav>
  )
}

function MobileTab({ item, pathname }: { item: NavItem; pathname: string }) {
  const t = useTranslations()
  const active = isActiveNavItem(pathname, item.href)
  const Icon = item.icon
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        // `min-h-11` is the 44 px touch target (spec §8); no `truncate` on the
        // label, because the Vietnamese nav words were chosen to fit at 11 px
        // and an ellipsis on a tab label is a label that says nothing (spec §4).
        className={cn(
          'flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[0.6875rem]/[0.875rem]',
          active ? 'text-brand' : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
        <span>{t(item.labelKey)}</span>
      </Link>
    </li>
  )
}
```

- [ ] **Step 8: Write `components/layout/more-sheet.tsx`**

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { LogoutButton } from '@/components/auth/logout-button'
import { Sheet } from '@/components/common/sheet'
import { MOBILE_MORE_ITEMS, isActiveNavItem } from './nav-items'

/**
 * The phone "Thêm" panel (spec §5): the eight destinations the bottom bar has
 * no room for, as a two-column icon grid, plus Log out.
 *
 * A `Sheet` — so it closes by its own button, by Escape, by an overlay tap and
 * by a navigation, traps focus while open and hands focus back to the trigger
 * afterwards. No swipe gestures, now or later (spec §1 non-goals).
 *
 * A tap on a link also closes it explicitly: tapping the link for the page you
 * are already on changes no route, so nothing else would.
 */
export function MoreSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const pathname = usePathname()
  const t = useTranslations()

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('nav.moreSheetTitle')}
      closeLabel={t('common.close')}
    >
      <ul className="grid grid-cols-2 gap-2">
        {MOBILE_MORE_ITEMS.map((item) => {
          const active = isActiveNavItem(pathname, item.href)
          const Icon = item.icon
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => onOpenChange(false)}
                className={cn(
                  'flex min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm',
                  active ? 'bg-muted text-brand' : 'text-foreground hover:bg-muted',
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                <span>{t(item.labelKey)}</span>
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="border-t border-border pt-4">
        <LogoutButton />
      </div>
    </Sheet>
  )
}
```

- [ ] **Step 9: Make `LogoutButton` a translated ghost item**

Replace `components/auth/logout-button.tsx:22-26`:

```tsx
  const t = useTranslations()

  return (
    // Ghost, and full width in the rail: it is the last thing in a column of
    // links, not a call to action (spec §5, §14 decision 4). The `justify-start`
    // aligns its text with the nav items above it at lg; at the 64 px icon rail
    // and inside the More sheet it centres.
    <Button
      variant="ghost"
      size="sm"
      onClick={handleLogout}
      aria-label={t('nav.logout')}
      title={t('nav.logout')}
      className="w-full justify-center text-muted-foreground lg:justify-start"
    >
      <LogOut aria-hidden="true" className="size-4" />
      <span className="sr-only lg:not-sr-only">{t('nav.logout')}</span>
    </Button>
  )
```

Add `import { LogOut } from 'lucide-react'` and `import { useTranslations } from 'next-intl'`. Keep `handleLogout` and its comment (`:10-20`) exactly as they are — the "navigate anyway on failure" behaviour is deliberate and unrelated.

**Careful:** inside `MoreSheet` the `lg:not-sr-only` never applies (the sheet only exists below `md`), so the label would be screen-reader-only there. Pass a `variant` prop instead: add `{ compact }: { compact?: boolean }` to `LogoutButton`, use `className={cn('w-full', compact ? 'justify-center lg:justify-start' : 'justify-start')}` and render the text with `<span className={compact ? 'sr-only lg:not-sr-only' : undefined}>`. `AppShell` passes `compact`, `MoreSheet` does not.

- [ ] **Step 10: Pass the user's name from the `(app)` layout**

Replace `app/(app)/layout.tsx:5-13`:

```tsx
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // UX only — the redirect that actually guards the data is in each page (see
  // the note in `app/(app)/settings/page.tsx`): a layout is not an auth
  // boundary. The session lookup is memoized per request, so asking here and
  // again in the page costs one query.
  const session = await getOptionalSession()
  if (!session?.user) redirect('/login')
  // The NAME only, never the session object: `AppShell` is a client component,
  // and handing it the session would ship the whole user record — email,
  // `isDemo`, preferences — into the browser bundle to render one line of text.
  return <AppShell userName={session.user.name}>{children}</AppShell>
}
```

- [ ] **Step 11: Translate the error boundary**

Replace `app/(app)/error.tsx:37-49` (keeping the whole module doc at `:6-29`, which explains `retry` vs `reset` and why `error` is never rendered — both still true):

```tsx
export default function AppError({ retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations()

  useEffect(() => {
    console.error('An app route failed to render')
  }, [])

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[30rem] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-[1.125rem]/[1.625rem] font-semibold">{t('errors.boundaryTitle')}</h1>
        <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
          {t('errors.boundaryBody')}
        </p>
      </div>
      <Button type="button" onClick={() => retry()}>
        {t('common.retry')}
      </Button>
    </div>
  )
}
```

Add `import { useTranslations } from 'next-intl'`.

- [ ] **Step 12: Update the three e2e specs whose nav selectors this task moves**

The default locale is Vietnamese, so every English nav label these specs match is now gone. Fix them with a **vi/en regex alternation** so the same spec passes in either locale rather than pinning one — and keep the landmark lookups role-based instead of attribute-based, because the landmark's accessible name is now translated too.

`e2e/phase4.spec.ts`:
- `:73` and `:217-218` and `:167-168`: replace `page.locator('nav[aria-label="Primary"]')` with
  ```ts
  const rail = page.getByRole('navigation', { name: /Điều hướng chính|^Primary$/ })
  ```
  and `page.locator('nav[aria-label="Primary (compact)"]')` with
  ```ts
  const bar = page.getByRole('navigation', { name: /Điều hướng nhanh|Primary \(compact\)/ })
  ```
- `:85-98`: replace the twelve English labels with regex alternations, in the same order:
  ```ts
  for (const label of [
    /Tổng quan|Dashboard/, /Giao dịch|Transactions/, /Chuyển tiền|Transfers/,
    /Tài khoản|Accounts/, /Ngân sách|Budgets/, /Tiết kiệm|Savings/,
    /Công nợ|Debts/, /Khoản vay|Loans/, /Nhắc nhở|Reminders/,
    /Danh mục|Categories/, /Báo cáo|Reports/, /Cài đặt|Settings/,
  ]) {
    await expect(rail.getByRole('link', { name: label })).toBeVisible()
  }
  ```
- `:174-176`: `bar.getByRole('link', { name: /Thêm giao dịch|Add transaction/ })`.
- `:178-187`: the More disclosure is now a `Sheet`, so replace the `aria-controls`/`#panelId` dance with a dialog lookup:
  ```ts
  await page.getByRole('button', { name: /^Thêm$|^More$/ }).click()
  const morePanel = page.getByRole('dialog', { name: /Tất cả mục|All sections/ })
  await expect(morePanel.getByRole('link', { name: /Chuyển tiền|Transfers/ })).toBeVisible()
  await expect(morePanel.getByRole('link', { name: /Ngân sách|Budgets/ })).toBeVisible()
  await expect(morePanel.getByRole('link', { name: /Danh mục|Categories/ })).toBeVisible()
  await expect(morePanel.getByRole('link', { name: /Cài đặt|Settings/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(morePanel).toBeHidden()
  ```
- `:196-207`: the same alternation for the Accounts, Reports and Dashboard tab links.
- `:80`, `:205`: the `h1` assertions (`'Dashboard'`, `'Reports'`) belong to Tasks 4 and 10, which change those page titles. Leave them for now — this task does not touch either page — and they still pass because the pages are unchanged.
- `:129-134`, `:153`: dashboard KPI/section headings belong to Task 4. Untouched here.

`e2e/phase5.spec.ts`:
- `:73-77`: `const rail = page.getByRole('navigation', { name: /Điều hướng chính|^Primary$/ })` and `rail.getByRole('link', { name: /Ngân sách|Budgets/ })`.
- `:305-312`: the same More-sheet rewrite as above.

`e2e/phase6.spec.ts`:
- `:396-410`: `allTextContents()` on the rail's links now returns Vietnamese *and* includes five group headers' worth of structure — but the headers are `<h2>`, not links, so `getByRole('link').allTextContents()` still returns exactly the twelve labels in order. Replace the `indexOf('Budgets')` block with:
  ```ts
  const labels = await rail.getByRole('link').allTextContents()
  const budgetsIndex = labels.findIndex((label) => /Ngân sách|Budgets/.test(label))
  expect(budgetsIndex).toBeGreaterThanOrEqual(0)
  expect(labels.slice(budgetsIndex + 1, budgetsIndex + 5)).toEqual(
    labels.slice(budgetsIndex + 1, budgetsIndex + 5).filter((label) =>
      /Tiết kiệm|Savings|Công nợ|Debts|Khoản vay|Loans|Nhắc nhở|Reminders/.test(label),
    ),
  )
  expect(labels.slice(budgetsIndex + 1, budgetsIndex + 5)).toHaveLength(4)
  ```
  **Careful:** the rail's links now include the "Thêm giao dịch" action and the wordmark link, which are outside the `<nav>` — so scope `allTextContents()` to the `nav` (as `rail` already does) and note that the icon-rail `sr-only` span means `allTextContents()` still yields the label text at 1280.
- `:415-433`: `destination.label` becomes a regex per row (`/Tiết kiệm|Savings/`, `/Công nợ|Debts/`, `/Khoản vay|Loans/`, `/Nhắc nhở|Reminders/`); `destination.heading` and `destination.empty` belong to Tasks 7–9 and stay as they are for now.
- `:855-877`: `bar.locator('a span').allTextContents()` now also picks up the `+` link's `sr-only`-free structure. Replace with an explicit per-tab check:
  ```ts
  for (const label of [/Tổng quan|Dashboard/, /Giao dịch|Transactions/, /Tài khoản|Accounts/, /Báo cáo|Reports/]) {
    await expect(bar.getByRole('link', { name: label })).toBeVisible()
  }
  await expect(bar.getByRole('link', { name: /Thêm giao dịch|Add transaction/ })).toBeVisible()
  ```
  and the More block with the dialog lookup above.

Run: `npx playwright test e2e/phase4.spec.ts e2e/phase5.spec.ts e2e/phase6.spec.ts`
Expected: green. Any remaining failure must be a nav selector this step missed — fix it the same way, never by reverting a label to English.

- [ ] **Step 13: Write the shell's own Playwright spec, including the More sheet's focus behaviour**

The More sheet replaces a hand-rolled disclosure with a focus-trapping overlay, and the four dismissal paths plus focus restoration are the whole reason for the change — so they are asserted here, in this task, rather than deferred to a later sweep.

`e2e/phase7-shell.spec.ts`:

```ts
import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { registerNewUser } from './helpers'

/**
 * The app shell (spec §5): the rail's three widths, and the mobile More sheet's
 * accessibility contract.
 *
 * The sheet's four dismissals — its own button, Escape, an overlay tap and a
 * navigation — plus the focus trap and the focus return are what the `Sheet`
 * primitive was adopted for; the disclosure it replaces had none of the last
 * three. Asserting them here means a regression in `components/common/sheet.tsx`
 * fails the task that owns it rather than a sweep four tasks later.
 *
 * No `waitForTimeout` and no retry helper: every assertion is an
 * auto-retrying matcher or a focus check on an element the previous action
 * already awaited.
 */
const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-shell-${process.pid}.json`)

test.describe.serial('Phase 7 — app shell', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-shell' })
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('the rail is 240 px at 1280, 64 px at 768, and absent at 375', async ({ page }) => {
    const rail = page.getByRole('navigation', { name: /Điều hướng chính|^Primary$/ })

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/dashboard')
    await expect(rail).toBeVisible()
    // The <nav> sits inside the <aside> that carries the width, so measure the
    // aside — the rail's own box is its content box.
    expect((await page.locator('aside').first().boundingBox())!.width).toBe(240)

    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/dashboard')
    await expect(rail).toBeVisible()
    expect((await page.locator('aside').first().boundingBox())!.width).toBe(64)
    await expect(
      page.getByRole('navigation', { name: /Điều hướng nhanh|Primary \(compact\)/ }),
    ).toBeHidden()

    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    await expect(rail).toBeHidden()
    await expect(
      page.getByRole('navigation', { name: /Điều hướng nhanh|Primary \(compact\)/ }),
    ).toBeVisible()
  })

  test('the skip link is the first focusable element and reaches the content', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/dashboard')
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: /Đến nội dung|Skip to content/ })
    await expect(skip).toBeFocused()
    await skip.press('Enter')
    await expect(page.locator('#main')).toBeVisible()
  })

  test('the More sheet traps focus and Escape returns it to the trigger', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    const trigger = page.getByRole('button', { name: /^Thêm$|^More$/ })
    await trigger.click()

    const sheet = page.getByRole('dialog', { name: /Tất cả mục|All sections/ })
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveAttribute('aria-modal', 'true')

    // Focus lands inside on open, and twenty tabs never leave.
    for (let index = 0; index < 20; index += 1) {
      const inside = await page.evaluate(() => {
        const active = document.activeElement
        const dialog = document.querySelector('[role="dialog"]')
        return active !== null && dialog !== null && dialog.contains(active)
      })
      expect(inside, `after ${index} tabs`).toBe(true)
      await page.keyboard.press('Tab')
    }

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('the More sheet closes on its own button and on an overlay tap', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    const trigger = page.getByRole('button', { name: /^Thêm$|^More$/ })

    await trigger.click()
    const sheet = page.getByRole('dialog', { name: /Tất cả mục|All sections/ })
    await sheet.getByRole('button', { name: /^Đóng$|^Close$/ }).click()
    await expect(sheet).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.click()
    await expect(sheet).toBeVisible()
    // The sheet is bottom-anchored below 640, so the top-left corner of the
    // viewport is the backdrop.
    await page.mouse.click(5, 5)
    await expect(sheet).toBeHidden()
  })

  test('the More sheet closes on navigation and lists the eight non-tab routes', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /^Thêm$|^More$/ }).click()
    const sheet = page.getByRole('dialog', { name: /Tất cả mục|All sections/ })

    for (const label of [
      /Chuyển tiền|Transfers/,
      /Danh mục|Categories/,
      /Ngân sách|Budgets/,
      /Tiết kiệm|Savings/,
      /Công nợ|Debts/,
      /Khoản vay|Loans/,
      /Nhắc nhở|Reminders/,
      /Cài đặt|Settings/,
    ]) {
      await expect(sheet.getByRole('link', { name: label })).toBeVisible()
    }

    await sheet.getByRole('link', { name: /Chuyển tiền|Transfers/ }).click()
    await expect(page).toHaveURL(/\/transfers/)
    await expect(sheet).toBeHidden()
  })
})
```

Run: `npx playwright test e2e/phase7-shell.spec.ts` → green (5 tests).

- [ ] **Step 14: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → all seven spec files green.
Run: `npm run build` → succeeds.

- [ ] **Step 15: Browser visual check — the shell at every width, both themes, both locales**

`npm run dev` and a scratch Playwright driver outside the repo. Sign in as a seeded user with at least two accounts and a handful of transactions.

Screenshot `/dashboard` at: **1440×900**, **1280×800**, **1024×768**, **768×1024**, **414×896**, **375×812** — in light and in dark (12 shots) — plus `/dashboard` at 375 with the More sheet open, in both themes (2 shots), plus 1440 light in English (1 shot). Fifteen screenshots.

Look for:
- 1440/1280: rail exactly 240 px; five group headers; the active item's 2 px brand bar; the user's name above Log out; "Thêm giao dịch" the only filled button in the rail.
- 1024: rail still 240 px (`lg` starts at 1024 in Tailwind v4 — confirm; if `lg` is 1024 then 1024 gets the wide rail and 768–1023 the icon rail, which is what the spec asks).
- 768: 64 px icon rail, no labels, no bottom bar, no horizontal overflow.
- 375/414: bottom bar five slots, `+` raised and centred, labels not truncated, nothing hidden behind the bar at the bottom of the page (scroll to the end and check).
- More sheet: anchored to the bottom, `bg-surface-2`, two-column grid, close button top-right, and — press Tab repeatedly — focus stays inside it and returns to the "Thêm" trigger after Escape.
- Dark: rail visibly distinct from the background; the raised `+` has no glow; the sheet's shadow is soft.
- English: no label wraps in the rail.

- [ ] **Step 16: 🛑 VISUAL CHECKPOINT 1 — primitives + shell (spec §11)**

**The controller STOPS here and does not start Task 4 until the product owner approves.**

Produce and hand over, from the scratch directory:
1. `/dashboard` desktop light 1440 — the rail, grouped, with the name and Log out.
2. `/dashboard` desktop dark 1440.
3. `/dashboard` tablet 768 light — the 64 px icon rail, no bottom bar.
4. `/dashboard` mobile 375 light — top bar and five-slot bottom bar.
5. `/dashboard` mobile 375 light with the More sheet open.
6. `/dashboard` mobile 375 dark with the More sheet open.
7. The Task 1 primitive gallery at 1440 light and 1440 dark (from Task 1c Step 4, re-produced if the gallery route was already deleted — recreate it, screenshot, delete again).

Report alongside them: the contrast table from Task 1a Step 5, and the confirmation that focus is trapped in and restored from the More sheet.

**Tests required:**
- Vitest: `components/layout/nav-groups.test.ts` (5 new).
- Playwright: `e2e/phase7-shell.spec.ts` (5 new) — the three rail widths, the skip link, and the More sheet's focus trap, focus return and four dismissal paths. Task 15's responsive spec adds the no-overflow widths; the sheet's accessibility is asserted **here**, in the task that introduces it.

**Browser visual checks required:** the fifteen screenshots in Step 15 and the seven-image checkpoint package in Step 16.

**Explicit things NOT to change:** `MOBILE_TAB_HREFS` (the four bottom-bar routes are a settled prioritisation); `isActiveNavItem`'s prefix-match semantics; `ADD_TRANSACTION_HREF`; `LogoutButton`'s `handleLogout` behaviour (it must still navigate on failure); `app/(app)/layout.tsx`'s redirect and its "a layout is not an auth boundary" comment; any page body — every `app/(app)/*/page.tsx` is untouched by this task; `app/(app)/error.tsx`'s `retry`-not-`reset` choice and its "nothing about `error` is rendered or logged" rule.

**Completion gate:** all four commands green, including `e2e/phase7-shell.spec.ts`; the fifteen screenshots taken and inspected; no horizontal overflow at any of the six widths (assert it in the driver with `document.documentElement.scrollWidth <= window.innerWidth`); the More sheet's focus trap, focus return and four dismissals green in the spec rather than merely eyeballed; checkpoint package delivered and **approved**.

**Proposed commit boundary:**
1. `feat(shell): group the desktop rail, add the icon rail and the skip link, translate every nav label`
2. `feat(shell): replace the mobile More disclosure with the accessible Sheet, assert its focus contract, and update the nav e2e selectors`

---
## Task 4: Dashboard

**Objective:** Rebuild `/dashboard` to spec §6.1 exactly: one bordered summary panel (Net Worth dominant 4/12 with Total Balance beneath it, three monthly metrics across 8/12) instead of five floating cards, then the seven-row 12-column grid with the specified widget widths and heights, the FX line demoted to 12 px muted under the header, per-widget `EmptyState`s, and a mobile stack with a 2×2 metric grid and **no horizontal scrolling of metrics**. Every string comes from `dashboard.json`, and no raw enum reaches the DOM.

**Major files touched:** `app/(app)/dashboard/page.tsx`, `components/dashboard/summary-panel.tsx` (new), `components/dashboard/fx-rate-status.tsx`, `components/dashboard/recent-transactions.tsx`, `components/dashboard/debt-loan-overview.tsx`, the five chart components, `components/dashboard/chart-theme.ts`, `lib/ui/dashboard-view-model.ts`, `lib/ui/dashboard-view-model.test.ts`, `messages/{vi,en}/dashboard.json`, `e2e/phase4.spec.ts`, `e2e/phase5.spec.ts`, `e2e/phase6.spec.ts`. **Nothing is deleted here:** `dashboard-section.tsx` and `kpi-strip.tsx` are superseded by `ChartContainer` and `SummaryPanel` but stay until Task 10, whose `/reports` rewrite removes their last caller.

**Reusable primitives involved:** `PageHeader`, `ChartContainer`, `EmptyState`, `MoneyText`, `Progress` (via `PlanningRow` in the Budget/Savings widgets), `StatusBadge`, `SectionHeader` (none — widget titles are `ChartContainer`'s own `h2`).

**User-facing behaviour:** the page opens on a header, one summary panel and the top of Cash Flow Trend at 1440×900. KPI figures show **full digits** (spec §14, decision 3) — `formatCompactAmount`'s "25 Tr" form is a chart-axis label and appears nowhere else. Planning widgets read as secondary (muted titles, smaller figures). Each empty widget says what is missing and offers one action. The balance-history widget shows an empty state rather than a flat zero line. FX unavailability shows "—" plus a hint in the affected cells only, never across the page.

**Desktop expectation (≥ 1280, max-w 1200, 24 px gutters):** exactly the spec's rows — (1) header; (2) summary panel; (3) Cash Flow Trend 8/12 h300 + Expense by Category 4/12 h300; (4) Account Balance Over Time 8/12 h260 + Income vs Expense 4/12 h260; (5) Account Balance Distribution 4/12 + Budget Progress 4/12 + Savings Goals 4/12, each ≤ 3 rows with a "Xem tất cả" link, h ≤ 240; (6) Debt / Loan Overview 4/12 + Upcoming Reminders 8/12 (≤ 5 rows, overdue count line); (7) Recent Transactions 12/12, eight rows.

**Tablet expectation (768–1279):** the tablet composition, **by design, all the way to 1279** — the spec fixes the 12-column desktop grid at ≥ 1280 (Tailwind `xl`), so 1024–1279 gets the same two-per-row shape as 768–1023 rather than a third layout nobody specified. Summary panel: Net Worth top-left with Total Balance beneath it, the three monthly metrics as one row on the right; charts two per row; planning two per row; Recent Transactions full width.

**Mobile expectation (< 768):** summary panel = Net Worth full width, then **one `grid-cols-2` grid holding exactly four cells** in this reading order: Tổng số dư, Thu nhập ròng, Thu nhập tháng, Chi tiêu tháng — all four visible, no horizontal scroll, nothing behind a swipe. Stacking order exactly: header → summary → Cash Flow Trend (h220) → Recent Transactions (5 rows) → Budget Progress → Upcoming Reminders → Expense by Category → Savings Goals → Debt / Loan Overview → Income vs Expense → Account Balance Over Time → Account Balance Distribution. Axis labels abbreviate ("25 Tr").

**Dark-theme expectation:** the summary panel is one `bg-surface` card with `divide-border` internal rules — no card-in-card; chart grid lines use `--color-border` at 14 % white and stay visible; the recharts tooltip is `--color-surface-2`; every chart series colour is a `var(--color-*)` token so it follows the theme with no chart-specific dark branch.

**Typography (spec §6.1, item 16):** Net Worth is `MoneyText size="hero"` (36/40, mobile 30/36); Total Balance is `size="md"` (22/28) — the spec's "below it, Tổng số dư 22/600"; the three monthly metrics are `size="lg"` (24/30) — the spec's "13 label + 24/600 value". Reports' flat variant keeps `size="kpi"` (30/36).

**Vietnamese/English expectation:** header "Tổng quan" / "Dashboard"; the five summary labels are exactly the glossary's Tài sản ròng, Tổng số dư, Thu nhập tháng, Chi tiêu tháng, Thu nhập ròng; the month label comes from `formatDate(now, { style: 'monthYear' })`; the FX line is `common.rateLine` plus a `dashboard.fxUpdatedAt` suffix; every widget title and empty state is a key. A KPI label may take two lines at 768 (spec §4) — no truncation.

**Accessibility acceptance criteria:**
- One `h1` ("Tổng quan"), then every widget title as an `h2` from `ChartContainer` — a flat, complete heading order.
- The summary panel is a `<dl>` with one `<div><dt/><dd/></div>` per figure (the shape `KpiStrip` and `DebtLoanOverview` already use, and the reason both are `dl`s: a `dl` may contain only `dt`/`dd` or `div`s of them).
- Each chart keeps its existing `aria-label` on the recharts wrapper.
- The overdue count line is text, not colour alone.
- Every "Xem tất cả" link has an accessible name that names its destination (`dashboard.viewAllBudgets`, not a bare "Xem tất cả" repeated four times).
- No `EmptyState` action duplicates a link already in the widget header.

**Hydration/form-submission constraints:** the dashboard has no form. The page stays a server component; the only client components are the recharts widgets (already `'use client'`) and nothing new.

**Files:**
- Create: `components/dashboard/summary-panel.tsx`, `components/dashboard/summary-panel.test.tsx`
- Modify: `app/(app)/dashboard/page.tsx:163-310` (the whole render), `lib/ui/dashboard-view-model.ts:111-119` (`KpiDto`), `:166-177` (`RecentTransactionDto`), `:197-268` (`DashboardViewModel`), `:288-315` (`kpis`), `:378-395` (`recentTransactions`), `lib/ui/dashboard-view-model.test.ts` (label/title assertions), `components/dashboard/fx-rate-status.tsx:15-39`, `components/dashboard/recent-transactions.tsx:16-52`, `components/dashboard/debt-loan-overview.tsx:36-72`, `components/dashboard/chart-theme.ts:23-24,53-59`, `components/dashboard/cash-flow-trend-chart.tsx`, `account-balance-history-chart.tsx`, `income-vs-expense-chart.tsx`, `expense-by-category-chart.tsx`, `account-distribution-chart.tsx`, `messages/{vi,en}/dashboard.json`
- Test: `components/dashboard/summary-panel.test.tsx`, `lib/ui/dashboard-view-model.test.ts`, `e2e/phase4.spec.ts:100-160`, `e2e/phase5.spec.ts:288-300`, `e2e/phase6.spec.ts:140-165,760-800`

**Interfaces:**

- Consumes: `PageHeader`, `ChartContainer`, `EmptyState`, `MoneyText` (Tasks 1a–1c); `formatDate` (Task 2a); `transactionTypeLabelKey` (Task 2a); `RECENT_TRANSACTION_COUNT`; `buildDashboardViewModel` (existing).
- Produces:

```ts
// lib/ui/dashboard-view-model.ts — CHANGED shapes
export interface KpiDto {
  /** A key in `dashboard.json`, e.g. `'dashboard.netWorth'` — never text. */
  labelKey: string
  value: string | null
  /** Key for the line shown in place of a null value. */
  hintKey?: string
  negative: boolean
}

export interface RecentTransactionDto {
  id: string
  /** The category name, or `null` when the type carries the meaning. */
  categoryName: string | null
  /** The raw type — the COMPONENT turns it into a label via `labels.ts`. */
  type: TransactionType
  accountName: string
  /** The instant, for the component to format with the reader's locale/zone. */
  date: Date
  amount: string
  currency: Currency
  positive: boolean
}

export interface DashboardViewModel {
  displayCurrency: Currency
  /** The month as a `Date` the page formats — no longer a pre-baked string. */
  monthStart: Date
  /** Unchanged: five entries in the order netWorth, totalBalance, income, expense, netIncome. */
  kpis: KpiDto[]
  // ... every other field unchanged (fxStatus, cashFlowTrend, incomeVsExpense,
  // balanceOverTime, expenseByCategory, distribution, recentTransactions,
  // budgets, savingsGoals, debtLoanOverview, upcomingReminders,
  // overdueReminderCount)
}

// components/dashboard/recent-transactions.tsx  (async server component)
export function RecentTransactions(props: {
  transactions: RecentTransactionDto[]
  locale: Locale
  timeZone: string
  /** Rows at or past this index carry `hidden xl:flex` — the ledger shows eight
   *  on desktop and five in the mobile stack (spec §6.1 rows 7 and the mobile
   *  order), from ONE fetch rather than two. */
  mobileLimit?: number
}): Promise<React.ReactElement>

// components/dashboard/summary-panel.tsx
export function SummaryPanel(props: {
  /** `'dashboard'`: exactly five, in the view model's order, with Net Worth
   *  dominant. `'flat'`: any number, every cell equal — what Reports needs
   *  (Task 10) and what `KpiStrip` did for it. */
  variant?: 'dashboard' | 'flat'
  /** Exactly five for `'dashboard'`, in the order the view model produces them. */
  kpis: KpiDto[]
  currency: Currency
  /** Already-translated labels, keyed by the KPI's `labelKey`. */
  labels: Record<string, string>
  hints: Record<string, string>
}): React.ReactElement
```

- [ ] **Step 1: Add the dashboard message keys**

`messages/vi/dashboard.json` (replacing the single `title` key from Task 2):

```json
{
  "title": "Tổng quan",
  "subtitle": "{month} · {currency}",
  "netWorth": "Tài sản ròng",
  "netWorthNote": "gồm phải thu, phải trả và dư nợ gốc",
  "totalBalance": "Tổng số dư",
  "monthlyIncome": "Thu nhập tháng",
  "monthlyExpense": "Chi tiêu tháng",
  "netIncome": "Thu nhập ròng",
  "fxUnavailableHint": "Chưa có tỷ giá",
  "fxUpdated": "cập nhật {time}",
  "fxEffective": "hiệu lực {date}",
  "fxCached": "tỷ giá lưu tạm",
  "fxUnavailable": "Chưa có tỷ giá — các số quy đổi được ẩn",
  "fxNotNeeded": "Không cần quy đổi",
  "cashFlowTrend": "Dòng tiền theo tháng",
  "expenseByCategory": "Chi tiêu theo danh mục",
  "expenseByCategoryOther": "Khác",
  "balanceOverTime": "Số dư theo thời gian",
  "balanceOverTimeCaption": "Chỉ số dư tài khoản — tài sản ròng quá khứ không được lưu",
  "incomeVsExpense": "Thu và chi",
  "accountDistribution": "Phân bổ số dư",
  "budgetProgress": "Tiến độ ngân sách",
  "budgetProgressCaption": "Tháng này · mỗi ngân sách theo tiền tệ của nó",
  "savingsGoals": "Mục tiêu tiết kiệm",
  "savingsGoalsCaption": "Mục tiêu tự nhập · mỗi mục tiêu theo tiền tệ của nó",
  "debtLoanOverview": "Công nợ và khoản vay",
  "debtLoanOverviewCaption": "Còn lại hôm nay · {currency}",
  "debtLoanIncluded": "Đã tính trong tài sản ròng",
  "receivables": "Khoản phải thu",
  "payables": "Khoản phải trả",
  "loanOutstanding": "Dư nợ gốc",
  "upcomingReminders": "Nhắc nhở sắp tới",
  "upcomingRemindersCaption": "Quá hạn và {days} ngày tới",
  "overdueCount": "{count, plural, other {# quá hạn}}",
  "recentTransactions": "Giao dịch gần đây",
  "viewAllTransactions": "Xem tất cả giao dịch",
  "viewAllBudgets": "Xem tất cả ngân sách",
  "viewAllGoals": "Xem tất cả mục tiêu",
  "viewAllReminders": "Xem tất cả nhắc nhở",
  "emptyTransactionsTitle": "Chưa có giao dịch",
  "emptyTransactionsBody": "Thêm giao dịch đầu tiên để thấy dòng tiền của bạn.",
  "emptyTransactionsAction": "Thêm giao dịch",
  "emptyBudgetsTitle": "Chưa có ngân sách tháng này",
  "emptyBudgetsAction": "Đặt ngân sách",
  "emptyGoalsTitle": "Chưa có mục tiêu tiết kiệm",
  "emptyGoalsAction": "Đặt mục tiêu",
  "emptyRemindersTitle": "Không có gì đến hạn trong {days} ngày tới",
  "emptyRemindersAction": "Thêm nhắc nhở",
  "emptyBalanceHistoryTitle": "Chưa có dữ liệu số dư",
  "emptyBalanceHistoryBody": "Số dư theo thời gian xuất hiện sau giao dịch đầu tiên.",
  "emptyExpenseTitle": "Chưa có chi tiêu tháng này",
  "emptyDistributionTitle": "Chưa có tài khoản nào",
  "emptyDistributionAction": "Thêm tài khoản",
  "distributionFxUnavailable": "Chưa có tỷ giá — không thể so sánh số dư các tài khoản",
  "debtLoanFxUnavailable": "Chưa có tỷ giá — không thể so sánh số còn lại"
}
```

`messages/en/dashboard.json`: the identical key tree in English. Use the wording the page has today wherever it exists so no e2e assertion needs re-deriving: `"cashFlowTrend": "Cash Flow Trend"`, `"expenseByCategory": "Expense by Category"`, `"balanceOverTime": "Account Balance Over Time"`, `"balanceOverTimeCaption": "Account balances only — historical Net Worth is not modelled"`, `"incomeVsExpense": "Income vs Expense"`, `"accountDistribution": "Account Balance Distribution"`, `"budgetProgress": "Budget Progress"`, `"budgetProgressCaption": "This month · each budget in its own currency"`, `"savingsGoals": "Savings Goals"`, `"savingsGoalsCaption": "Manual targets · each goal in its own currency"`, `"debtLoanOverview": "Debt / Loan Overview"`, `"debtLoanOverviewCaption": "Outstanding today · {currency}"`, `"debtLoanIncluded": "Included in Net Worth"`, `"receivables": "Receivables"`, `"payables": "Payables"`, `"loanOutstanding": "Outstanding loans"`, `"upcomingReminders": "Upcoming Reminders"`, `"upcomingRemindersCaption": "Overdue and the next {days} days"`, `"recentTransactions": "Recent Transactions"`, `"netWorth": "Net Worth"`, `"totalBalance": "Total Balance"`, `"monthlyIncome": "Monthly Income"`, `"monthlyExpense": "Monthly Expense"`, `"netIncome": "Net Income"`, `"netWorthNote": "includes receivables, payables and outstanding loan principal"`, `"fxUnavailableHint": "FX unavailable"`, `"fxUnavailable": "FX rate unavailable — converted figures hidden"`, `"fxNotNeeded": "No conversion needed"`, `"fxCached": "cached rate"`, `"overdueCount": "{count, plural, one {# overdue} other {# overdue}}"`, and English equivalents for the remaining `empty*`/`viewAll*`/`fx*` keys.

**Note on one deliberate wording change:** the KPI is now labelled **Total Balance** ("Tổng số dư"), not "Total Account Balance". The spec's §6.1 summary panel names it that and the Vietnamese glossary fixes "Tổng số dư"; the reason the old label spelled out "Account" was that it sat beside Net Worth in a flat strip of five, and in the new panel it sits *underneath* Net Worth where the relationship is structural. `e2e/phase4.spec.ts:153` and `:104` assert the old string and are updated in Step 10. The **export's Summary sheet keeps "Total Account Balance"** — the export contract does not change.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS (parity).

- [ ] **Step 2: Write the failing view-model test for the two changed DTOs**

Add to `lib/ui/dashboard-view-model.test.ts`:

```ts
it('labels every KPI with a message key, never display text', () => {
  const vm = buildDashboardViewModel(baseInput())
  expect(vm.kpis.map((kpi) => kpi.labelKey)).toEqual([
    'dashboard.netWorth',
    'dashboard.totalBalance',
    'dashboard.monthlyIncome',
    'dashboard.monthlyExpense',
    'dashboard.netIncome',
  ])
  for (const kpi of vm.kpis) {
    expect(kpi).not.toHaveProperty('label')
  }
})

it('puts Net Worth first — the panel’s dominant figure (spec §6.1)', () => {
  const vm = buildDashboardViewModel(baseInput())
  expect(vm.kpis[0].labelKey).toBe('dashboard.netWorth')
  expect(vm.kpis[1].labelKey).toBe('dashboard.totalBalance')
})

it('hands a null KPI a hint KEY rather than English text', () => {
  const vm = buildDashboardViewModel({ ...baseInput(), position: null })
  expect(vm.kpis[0].value).toBeNull()
  expect(vm.kpis[0].hintKey).toBe('dashboard.fxUnavailableHint')
})

it('never puts a raw transaction type in a recent-transaction row', () => {
  const vm = buildDashboardViewModel(baseInput())
  for (const row of vm.recentTransactions) {
    expect(row).not.toHaveProperty('title')
    expect(row).toHaveProperty('type')
    // `categoryName` may be null — the COMPONENT then renders the type's label.
    expect(row.categoryName === null || typeof row.categoryName === 'string').toBe(true)
  }
  const uncategorised = vm.recentTransactions.find((row) => row.categoryName === null)
  expect(uncategorised?.type).toMatch(/^[A-Z_]+$/)
})

it('hands the month out as an instant, not a pre-baked English string', () => {
  const vm = buildDashboardViewModel(baseInput())
  expect(vm.monthStart).toBeInstanceOf(Date)
  expect(vm).not.toHaveProperty('monthLabel')
  expect(vm).not.toHaveProperty('subtitle')
})
```

Reuse whatever fixture builder the existing file already has for its input (read `lib/ui/dashboard-view-model.test.ts` first; the helper there is what `baseInput()` above stands for — use the real name). Make sure the fixture includes at least one `CASH_OUT` transaction with no category, so the last assertion has something to find.

Run: `npx vitest run lib/ui/dashboard-view-model.test.ts` → FAIL on all five.

- [ ] **Step 3: Change the two DTOs and the builder**

`lib/ui/dashboard-view-model.ts`:

- `:111-119` — `KpiDto`:
```ts
export interface KpiDto {
  /**
   * A key in `dashboard.json`. The view model is a pure function with a unit
   * test and no translator; the component that renders the panel has one.
   */
  labelKey: string
  /** The formatted figure, or `null` when there is no honest one to show. */
  value: string | null
  /** Key for the line rendered in place of a `null` value, explaining the gap. */
  hintKey?: string
  /** Below zero — rendered in the negative colour. */
  negative: boolean
}
```

- `:166-177` — `RecentTransactionDto`:
```ts
export interface RecentTransactionDto {
  id: string
  /** The category name when there is one; `null` when the TYPE is the meaning. */
  categoryName: string | null
  /**
   * The raw type. Rendered through `transactionTypeLabelKey` by the component —
   * which is what stopped `CASH_OUT` appearing on the dashboard verbatim.
   */
  type: TransactionType
  accountName: string
  /** The instant; the component formats it in the reader's locale and zone. */
  date: Date
  /** Already signed — the sign comes from `type`, never from the amount. */
  amount: string
  currency: Currency
  positive: boolean
}
```

- `:197-206` — replace `monthLabel: string` and `subtitle: string` with `monthStart: Date`, and document why: the header's month and currency line is now assembled by the page from `formatDate(monthStart, { locale, timeZone, style: 'monthYear' })` and `dashboard.subtitle`, because "September 2026 · VND" is a sentence in one language and a view model has no locale.

- `:287` — `const monthLabel = formatInTimeZone(now, timezone, 'LLLL yyyy')` is deleted; `monthStart: now` is returned instead. (`formatInTimeZone` is still used further down for the chart axis labels — those are Task 4 Step 7's problem and get `formatDate(..., 'dayMonth'|'monthYear')` there.)

- `:288-315` — `positionKpi` and `kpis`:
```ts
  /** A current-position KPI: a figure, or a gap with the reason for it. */
  function positionKpi(labelKey: string, value: Prisma.Decimal | undefined): KpiDto {
    if (!position || value === undefined) {
      return { labelKey, value: null, hintKey: FX_UNAVAILABLE_HINT_KEY, negative: false }
    }
    return { labelKey, value: formatMoney(value, currency), negative: value.isNegative() }
  }

  // Net Worth FIRST: it is the panel's dominant figure (spec §6.1), with Total
  // Balance beneath it, and the three monthly metrics after. The old order put
  // Total Account Balance first because the five sat in a flat strip where
  // nothing was dominant.
  const kpis: KpiDto[] = [
    positionKpi('dashboard.netWorth', position?.netWorth),
    positionKpi('dashboard.totalBalance', position?.totalBalance),
    {
      labelKey: 'dashboard.monthlyIncome',
      value: formatMoney(monthly.income, currency),
      negative: false,
    },
    // Expense is stored and aggregated as a positive magnitude, so it is never
    // "negative" — red by meaning, not by sign, and the panel does not colour it.
    {
      labelKey: 'dashboard.monthlyExpense',
      value: formatMoney(monthly.expense, currency),
      negative: false,
    },
    {
      labelKey: 'dashboard.netIncome',
      value: formatMoney(monthly.netIncome, currency),
      negative: monthly.netIncome.isNegative(),
    },
  ]
```
and replace `const FX_UNAVAILABLE_HINT = 'FX unavailable'` (`:268`) with `const FX_UNAVAILABLE_HINT_KEY = 'dashboard.fxUnavailableHint'`.

- `:378-395` — `recentTransactions`:
```ts
    recentTransactions: recentTransactions.map((tx) => {
      const positive = isBalanceIncreasing(tx.type)
      return {
        id: tx.id,
        // The NAME or `null` — never `?? tx.type`, which is how `CASH_OUT`
        // used to reach the screen. The component renders the type's label.
        categoryName: tx.category?.name ?? null,
        type: tx.type,
        accountName: tx.account.name,
        date: tx.date,
        // The sign is derived from `type` here and prefixed to the formatted
        // magnitude — `amount` itself is always positive and no arithmetic
        // negates it.
        amount: `${positive ? '+' : '−'}${formatMoney(tx.amount, tx.currency)}`,
        currency: tx.currency,
        positive,
      }
    }),
```

Run: `npx vitest run lib/ui/dashboard-view-model.test.ts` → PASS. Fix any existing assertion in that file that referenced `kpi.label`, `vm.subtitle`, `vm.monthLabel` or `row.title`/`row.when` by updating it to the new field — never by adding the old field back.

- [ ] **Step 4: Write the failing test for `SummaryPanel`**

`components/dashboard/summary-panel.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { SummaryPanel } from './summary-panel'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'

const LABELS = {
  'dashboard.netWorth': 'Tài sản ròng',
  'dashboard.totalBalance': 'Tổng số dư',
  'dashboard.monthlyIncome': 'Thu nhập tháng',
  'dashboard.monthlyExpense': 'Chi tiêu tháng',
  'dashboard.netIncome': 'Thu nhập ròng',
  'dashboard.netWorthNote': 'gồm phải thu, phải trả và dư nợ gốc',
}
const HINTS = { 'dashboard.fxUnavailableHint': 'Chưa có tỷ giá' }

/** The view model's order, which is what `SummaryPanel` destructures. */
const KPIS: KpiDto[] = [
  { labelKey: 'dashboard.netWorth', value: '95.600.000', negative: false },
  { labelKey: 'dashboard.totalBalance', value: '72.100.000', negative: false },
  { labelKey: 'dashboard.monthlyIncome', value: '30.000.000', negative: false },
  { labelKey: 'dashboard.monthlyExpense', value: '11.200.000', negative: false },
  { labelKey: 'dashboard.netIncome', value: '18.800.000', negative: false },
]

describe('SummaryPanel', () => {
  it('is ONE bordered surface, not five cards (spec §6.1)', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    // One card border on the panel itself; the internal separation is dividers.
    expect(html.match(/rounded-lg border border-border/g)).toHaveLength(1)
    expect(html).toContain('border-t border-border')
  })

  it('names all five figures as a definition list', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html).toContain('<dl')
    expect(html.match(/<dt/g)).toHaveLength(5)
    expect(html.match(/<dd/g)).toHaveLength(5)
    for (const label of Object.values(LABELS)) {
      if (label.includes('gồm')) continue
      expect(html).toContain(label)
    }
  })

  it('renders Net Worth as the dominant figure with its note, and Total Balance a step down', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    const netWorthBlock = html.slice(html.indexOf('Tài sản ròng'), html.indexOf('Tổng số dư'))
    expect(netWorthBlock).toContain('text-4xl')
    expect(netWorthBlock).toContain('gồm phải thu, phải trả và dư nợ gốc')
    // Total Balance is `size="md"` (22/28), below the hero and above the
    // monthly metrics' `lg` (24/30) — which is deliberate: it is a supporting
    // figure for Net Worth, not a fourth monthly metric.
    const totalBlock = html.slice(html.indexOf('Tổng số dư'), html.indexOf('Thu nhập tháng'))
    expect(totalBlock).toContain('text-[1.375rem]/[1.75rem]')
    expect(totalBlock).not.toContain('text-4xl')
  })

  it('is one grid-cols-2 grid at base width, with Net Worth spanning both columns', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html).toContain('grid grid-cols-2')
    expect(html).not.toContain('overflow-x-auto')
    expect(html).not.toContain('overflow-x-scroll')
    const netWorthCell = html.slice(0, html.indexOf('Tài sản ròng'))
    expect(netWorthCell).toContain('col-span-2')
  })

  it('orders the four non-hero cells Tổng số dư → Thu nhập ròng → Thu nhập tháng → Chi tiêu tháng at base width', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    // The DOM order is the view model's (spec §6.1's order for the three
    // monthly columns at ≥ 768); `order-*` is what re-reads it as a 2×2.
    const domOrder = ['Tài sản ròng', 'Tổng số dư', 'Thu nhập tháng', 'Chi tiêu tháng', 'Thu nhập ròng'].map(
      (label) => html.indexOf(label),
    )
    expect([...domOrder].sort((a, b) => a - b)).toEqual(domOrder)

    // And the visual order comes from the `order-N` on each of the four cells.
    const orderOf = (label: string) => {
      const cellStart = html.lastIndexOf('<div class', html.indexOf(label))
      const match = /order-(\d)/.exec(html.slice(cellStart, html.indexOf(label)))
      return match ? Number(match[1]) : null
    }
    expect(orderOf('Tài sản ròng')).toBe(1)
    expect(orderOf('Tổng số dư')).toBe(2)
    expect(orderOf('Thu nhập ròng')).toBe(3)
    expect(orderOf('Thu nhập tháng')).toBe(4)
    expect(orderOf('Chi tiêu tháng')).toBe(5)
  })

  it('stacks Total Balance under Net Worth and rows the three metrics from 768 up', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={KPIS} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    // Explicit placement, not source order: the left pair occupies rows 1 and 2
    // of column 1, and each monthly metric spans both rows on the right.
    expect(html).toContain('md:col-start-1 md:col-span-3 md:row-start-1')
    expect(html).toContain('md:col-start-1 md:col-span-3 md:row-start-2')
    expect(html.match(/md:row-span-2/g)).toHaveLength(3)
    // 9ths at xl, because 12ths cannot hold three equal cells in 8 columns.
    expect(html).toContain('xl:grid-cols-9')
    expect(html.match(/xl:col-span-2/g)).toHaveLength(3)
  })

  it('shows an em dash and the hint only in the cells FX actually broke', () => {
    const degraded: KpiDto[] = [
      { labelKey: 'dashboard.netWorth', value: null, hintKey: 'dashboard.fxUnavailableHint', negative: false },
      { labelKey: 'dashboard.totalBalance', value: null, hintKey: 'dashboard.fxUnavailableHint', negative: false },
      ...KPIS.slice(2),
    ]
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={degraded} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html.match(/—/g)).toHaveLength(2)
    expect(html.match(/Chưa có tỷ giá/g)).toHaveLength(2)
    // The three monthly figures are historical and untouched by an FX outage.
    expect(html).toContain('30.000.000')
    expect(html).toContain('11.200.000')
    expect(html).toContain('18.800.000')
  })

  it('renders the flat variant as three equal cells with no dominant figure', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel variant="flat" kpis={KPIS.slice(2)} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html.match(/<dt/g)).toHaveLength(3)
    expect(html).toContain('md:grid-cols-3')
    expect(html).not.toContain('text-4xl')
  })

  it('marks a negative net income without relying on the minus sign alone', () => {
    const negative: KpiDto[] = [
      ...KPIS.slice(0, 4),
      { labelKey: 'dashboard.netIncome', value: '−2.000.000', negative: true },
    ]
    const html = renderToStaticMarkup(
      <SummaryPanel kpis={negative} currency="VND" labels={LABELS} hints={HINTS} />,
    )
    expect(html).toContain('text-negative')
  })
})
```

Run: `npx vitest run components/dashboard/summary-panel.test.tsx` → FAIL.

- [ ] **Step 5: Write `components/dashboard/summary-panel.tsx`**

```tsx
import { cn } from 'cn'
import type { Currency } from '@/lib/currency/provider'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'
import { MoneyText } from '@/components/common/money-text'

/**
 * The dashboard's five headline figures as ONE bordered panel (spec §6.1).
 *
 * The shape is the point. The five used to be a flat strip of equal cells, and
 * the pre-flight finding was that a page of five equal numbers has no headline:
 * Net Worth is the answer to "how am I doing", Total Balance is what is liquid
 * inside it, and the three monthly metrics are how this month went. So one flat
 * grid, re-placed at each breakpoint:
 *
 *   < 768  — `grid-cols-2`. Net Worth spans both columns; the other four fill
 *            the 2×2 beneath it, and `order-*` puts them in reading order:
 *            Tổng số dư, Thu nhập ròng, Thu nhập tháng, Chi tiêu tháng. All
 *            four visible at once, never a horizontally scrolling strip —
 *            metrics are the one thing on this page that may not be hidden
 *            (spec §6.1, §7).
 *   768–1279 — `grid-cols-6`. Net Worth top-left over 3 columns with Total
 *            Balance directly beneath it; the three monthly metrics as one row
 *            of three on the right, each spanning both rows. This is the
 *            composition all the way to 1279 by design: the 12-column desktop
 *            grid starts at 1280.
 *   ≥ 1280 — `grid-cols-9`, which is 12ths in thirds: Net Worth and Total
 *            Balance 3/9 (= 4/12) stacked on the left, the three monthly
 *            metrics 2/9 each (= 6/9 = 8/12) as one row on the right. A
 *            literal 12-column grid cannot hold three equal cells in 8
 *            columns, and a nested grid would break the flat `dl` a screen
 *            reader walks.
 *
 * DOM order is the view model's order — Net Worth, Total Balance, Thu nhập
 * tháng, Chi tiêu tháng, Thu nhập ròng — because that is the order spec §6.1
 * gives the three monthly columns at 768 and above. Only the base width
 * re-orders, with `order-*`, and it re-orders visually only: a screen reader
 * reads the DOM, where Total Balance still follows Net Worth.
 *
 * One card, dividers inside it — never a card per cell (spec §2, "never a card
 * inside a card"). `labels`/`hints` arrive already translated, so this stays a
 * plain server component with no translator of its own and a static-markup
 * test.
 */
export function SummaryPanel({
  variant = 'dashboard',
  kpis,
  currency,
  labels,
  hints,
}: {
  variant?: 'dashboard' | 'flat'
  kpis: KpiDto[]
  currency: Currency
  labels: Record<string, string>
  hints: Record<string, string>
}) {
  // `'flat'` is Reports' three equal figures: one row, no dominant cell, no
  // note. Same card, same dividers, same `dl` semantics — only the hierarchy
  // differs, which is why it is a variant and not a second component.
  if (variant === 'flat') {
    return (
      <dl className="grid grid-cols-1 gap-px rounded-lg border border-border bg-surface md:grid-cols-3">
        {kpis.map((kpi, index) => (
          <Cell
            key={kpi.labelKey}
            kpi={kpi}
            currency={currency}
            labels={labels}
            hints={hints}
            size="kpi"
            className={cn(index > 0 && 'border-t border-border md:border-t-0 md:border-l')}
          />
        ))}
      </dl>
    )
  }

  // The view model's order, which is also spec §6.1's order for the three
  // monthly columns at 768 and above.
  const [netWorth, totalBalance, monthlyIncome, monthlyExpense, netIncome] = kpis

  return (
    <dl className="grid grid-cols-2 gap-px rounded-lg border border-border bg-surface md:grid-cols-6 xl:grid-cols-9">
      {/* Net Worth: both columns at base, the top-left 3/6 at md, the top-left
          3/9 (= 4/12) at xl. */}
      <Cell
        kpi={netWorth}
        currency={currency}
        labels={labels}
        hints={hints}
        size="hero"
        note={labels['dashboard.netWorthNote']}
        className="order-1 col-span-2 md:col-start-1 md:col-span-3 md:row-start-1 md:border-r md:border-border xl:col-start-1 xl:col-span-3"
      />

      {/* Total Balance: directly under Net Worth from md up. `order-2` at base
          puts it first in the 2×2. */}
      <Cell
        kpi={totalBalance}
        currency={currency}
        labels={labels}
        hints={hints}
        size="md"
        className="order-2 border-t border-border md:col-start-1 md:col-span-3 md:row-start-2 md:border-r xl:col-start-1 xl:col-span-3"
      />

      {/* The three monthly metrics, in spec §6.1's order. Each spans both rows
          on the right from md up, so the left pair and the right row read as
          two blocks rather than a six-cell soup. At base they take `order-4`
          and `order-5`, which leaves Thu nhập ròng (`order-3`) beside Total
          Balance on the 2×2's first line — the reading order the spec fixes. */}
      <Cell
        kpi={monthlyIncome}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        className="order-4 border-t border-border md:col-start-4 md:col-span-1 md:row-start-1 md:row-span-2 md:border-t-0 xl:col-start-4 xl:col-span-2"
      />
      <Cell
        kpi={monthlyExpense}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        className="order-5 border-t border-l border-border md:col-start-5 md:col-span-1 md:row-start-1 md:row-span-2 md:border-t-0 xl:col-start-6 xl:col-span-2"
      />
      <Cell
        kpi={netIncome}
        currency={currency}
        labels={labels}
        hints={hints}
        size="lg"
        className="order-3 border-t border-l border-border md:col-start-6 md:col-span-1 md:row-start-1 md:row-span-2 md:border-t-0 md:border-l xl:col-start-8 xl:col-span-2"
      />
    </dl>
  )
}

/**
 * One `dt`/`dd` pair in a wrapper `div` — which is what a `dl` may contain
 * besides bare terms and descriptions, and what lets each cell be one grid item
 * carrying its own placement classes.
 */
function Cell({
  kpi,
  currency,
  labels,
  hints,
  size,
  note,
  className,
}: {
  kpi: KpiDto
  currency: Currency
  labels: Record<string, string>
  hints: Record<string, string>
  size: 'md' | 'lg' | 'kpi' | 'hero'
  note?: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1 bg-surface p-4', className)}>
      <dt className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{labels[kpi.labelKey]}</dt>
      <dd className="flex flex-col gap-1">
        <Figure kpi={kpi} currency={currency} hints={hints} size={size} />
        {note && <span className="text-xs/[1rem] text-muted-foreground">{note}</span>}
      </dd>
    </div>
  )
}

/**
 * One figure, or the em dash and the reason there is none.
 *
 * An em dash and not a zero: "we cannot say" and "nothing" are different
 * answers and only one of them is a number. The hint appears only in the cells
 * an FX outage actually broke — the three monthly metrics are historical and
 * are restated from each row's own snapshot, so they are never affected.
 */
function Figure({
  kpi,
  currency,
  hints,
  size,
}: {
  kpi: KpiDto
  currency: Currency
  hints: Record<string, string>
  size: 'md' | 'lg' | 'kpi' | 'hero'
}) {
  if (kpi.value === null) {
    return (
      <span className="flex flex-col gap-1">
        <MoneyText value="—" tone="muted" size={size} />
        {kpi.hintKey && (
          <span className="text-xs/[1rem] text-muted-foreground">{hints[kpi.hintKey]}</span>
        )}
      </span>
    )
  }
  return (
    <MoneyText
      value={kpi.value}
      currency={currency}
      tone={kpi.negative ? 'negative' : 'default'}
      size={size}
    />
  )
}
```

Run: `npx vitest run components/dashboard/summary-panel.test.tsx` → PASS (9 tests).

- [ ] **Step 6: Re-skin the FX status line, the recent list and the debt/loan overview**

`components/dashboard/fx-rate-status.tsx` — keep the module doc (`:3-14`) and rewrite the body so it renders **12 px muted, on one line, inside `PageHeader`'s `meta` slot** with the rate line coming from `common.rateLine`:

```tsx
'use client'

import { useTranslations } from 'next-intl'
import type { FxStatus } from '@/lib/ui/dashboard-view-model'

export function FxRateStatus({ status }: { status: FxStatus }) {
  const t = useTranslations()

  if (status.kind === 'unavailable') {
    return <span className="text-negative">{t('dashboard.fxUnavailable')}</span>
  }
  if (status.kind === 'not-needed') {
    return <span>{t('dashboard.fxNotNeeded')}</span>
  }
  return (
    <span>
      <span className="tabular-nums">
        {t('common.rateLine', { from: 'USD', rate: status.rate, to: 'VND' })}
      </span>
      {' · '}
      <span className="tabular-nums">{t('dashboard.fxUpdated', { time: status.updatedAt })}</span>
      {status.kind === 'fallback' && (
        <span className="ml-2 rounded-md bg-warning/10 px-1.5 py-0.5 text-warning dark:bg-warning/18">
          {t('dashboard.fxCached')}
        </span>
      )}
    </span>
  )
}
```

The effective date moves out of the visible line (spec §6.1: "FX status line demoted to a 12 px muted line under the header ... tooltip for details") and into a `title` on the wrapper: add `title={t('dashboard.fxEffective', { date: status.effectiveDate })}` to the outer `<span>` in the available/fallback branch. The component becomes `'use client'` because it needs `useTranslations` and is rendered inside a server page — alternatively keep it a server component and use `getTranslations`; pick the server variant if the page renders it directly (it does), and drop `'use client'`. Read the file's final shape before committing and make sure only one of the two is used.

`components/dashboard/recent-transactions.tsx` — rewrite to use `FinancialListRow` and translate the type:

```tsx
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { EmptyState } from '@/components/common/empty-state'
import { MoneyText } from '@/components/common/money-text'
import { Receipt } from 'lucide-react'
import type { Locale } from '@/lib/i18n/locale'
import { formatDate } from '@/lib/ui/format-date'
import { transactionTypeLabelKey } from '@/lib/ui/labels'
import type { RecentTransactionDto } from '@/lib/ui/dashboard-view-model'

/**
 * The last few entries, each with its local date-time, its account and a signed
 * amount in its own currency.
 *
 * Amounts are NOT restated in the display currency here. This is a ledger
 * excerpt, not an aggregate: the row should say what the user entered, and
 * converting it would introduce a rate where none is needed. Every aggregate on
 * the dashboard is converted; this one list is not, which is why each amount
 * carries its currency code.
 *
 * The row's title is the category name, or — when there is none — the TYPE's
 * translated label. It used to be `category?.name ?? tx.type`, which is how
 * `CASH_OUT` appeared on the dashboard verbatim.
 */
export async function RecentTransactions({
  transactions,
  locale,
  timeZone,
}: {
  transactions: RecentTransactionDto[]
  locale: Locale
  timeZone: string
}) {
  const t = await getTranslations()

  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title={t('dashboard.emptyTransactionsTitle')}
        description={t('dashboard.emptyTransactionsBody')}
        action={{ label: t('dashboard.emptyTransactionsAction'), href: '/transactions#new' }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border">
        {transactions.map((tx) => (
          <FinancialListRow
            key={tx.id}
            className="px-0"
            title={tx.categoryName ?? t(transactionTypeLabelKey(tx.type))}
            meta={
              <>
                <span className="tabular-nums">
                  {formatDate(tx.date, { locale, timeZone, style: 'dateTime' })}
                </span>
                {' · '}
                {tx.accountName}
              </>
            }
            amount={
              <MoneyText
                value={tx.amount}
                currency={tx.currency}
                tone={tx.positive ? 'positive' : 'default'}
              />
            }
          />
        ))}
      </ul>
      <Link
        href="/transactions"
        className="self-start text-[0.8125rem]/[1.125rem] text-brand underline-offset-4 hover:underline"
      >
        {t('dashboard.viewAllTransactions')}
      </Link>
    </div>
  )
}
```

Note the sign: `tx.amount` already carries `+`/`−` from the view model, so `MoneyText` gets no `sign` prop here — passing both would print it twice. Expense rows are `tone="default"` (spec §2: expense is `foreground`, not red), income rows `positive`.

`components/dashboard/debt-loan-overview.tsx` — keep the whole module doc (`:5-35`, all of which is still true) and change only the `ROWS` labels to keys plus a `labels` prop, exactly the pattern `SummaryPanel` uses:

```tsx
const ROWS = [
  { key: 'receivables', labelKey: 'dashboard.receivables', tone: 'text-positive' },
  { key: 'payables', labelKey: 'dashboard.payables', tone: 'text-negative' },
  { key: 'loanOutstanding', labelKey: 'dashboard.loanOutstanding', tone: 'text-negative' },
] as const satisfies readonly { key: keyof DebtLoanOverviewDto; labelKey: string; tone: string }[]
```
and take `labels: Record<string, string>` + `footnote: string` as props, replacing `{label}` with `{labels[labelKey]}` and `Included in Net Worth` with `{footnote}`. Update `components/dashboard/debt-loan-overview.test.tsx` accordingly: its three `>Receivables<` assertions become the translated strings the test passes in.

- [ ] **Step 7: Give every chart the spec's height and locale-aware axis labels**

`components/dashboard/chart-theme.ts`:
- `:23-24` — replace the single `CHART_HEIGHT = 240` with the spec's three, since a shared value is what made the rows ragged:
```ts
/**
 * Chart body heights, per the spec's grid (§6.1). Three values, not one: row 3
 * is 300 px, row 4 is 260, row 5 is ≤ 240, and the mobile trend is 220. A
 * single shared height is what left a two-column row landing ragged.
 */
export const CHART_HEIGHT = { tall: 300, medium: 260, short: 240, mobileTrend: 220 } as const
```
- `:53-59` — point the tooltip at the raised surface, since a popover belongs on `--surface-2` (spec §2):
```ts
export const TOOLTIP_CONTENT_STYLE = {
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  fontSize: '0.75rem',
  color: 'var(--color-foreground)',
  boxShadow: '0 8px 24px rgba(25, 33, 30, 0.10)',
} as const
```
Everything else in the file — `CHART_COLORS`, `AXIS_PROPS`, `LINE_PROPS`, `BAR_PROPS`, `BAR_CURSOR`, `LINE_CURSOR` — stays exactly as it is, including the "every colour is a `var(--color-*)` reference" rule, which is what makes dark mode free.

For each of the five chart components (`cash-flow-trend-chart.tsx`, `account-balance-history-chart.tsx`, `income-vs-expense-chart.tsx`, `expense-by-category-chart.tsx`, `account-distribution-chart.tsx`):
1. Accept a `height: number` prop and pass it to `ResponsiveContainer` instead of importing `CHART_HEIGHT` directly, so the page owns the grid's geometry.
2. Accept `locale: Locale` and pass it as the third argument to every `formatChartValue`/`formatCompactAmount` call, so a tooltip and an axis read in the reader's language.
3. Replace any `DashboardEmpty` import with the caller's `EmptyState` — the charts no longer own their empty state; the page decides (see Step 8).
4. Leave every recharts prop, series, colour, `isAnimationActive: false` and existing `aria-label` untouched.

For `expense-by-category-chart.tsx` specifically: it must show **at most 8 categories with an "Khác" bucket** (spec §6.1). Add that bucketing in the *page's* view-model mapping, not the chart — `lib/ui/dashboard-view-model.ts`'s `expenseByCategory` mapping at `:361-366` becomes:
```ts
    // At most eight slices plus an "other" bucket (spec §6.1): a horizontal bar
    // chart with twenty rows is a table pretending to be a picture. The source
    // is already largest-first with a stable tiebreak (`getActivitySummary`),
    // so the tail is genuinely the smallest categories and the bucket's total
    // is their exact sum — a `Decimal` sum taken before `toNumber()`.
    expenseByCategory: bucketExpenseCategories(monthly.byCategory),
```
with, next to the other module helpers:
```ts
/** How many category bars the widget shows before bucketing the rest. */
const EXPENSE_CATEGORY_LIMIT = 8

/** The bucket's name is a KEY; the component translates it. */
const OTHER_CATEGORY_KEY = 'dashboard.expenseByCategoryOther'

function bucketExpenseCategories(
  rows: MonthSummary['byCategory'],
): (NamedAmountDto & { nameKey?: string })[] {
  if (rows.length <= EXPENSE_CATEGORY_LIMIT) {
    return rows.map((row) => ({ name: row.name, value: row.total.toNumber() }))
  }
  const head = rows.slice(0, EXPENSE_CATEGORY_LIMIT - 1)
  const tail = rows.slice(EXPENSE_CATEGORY_LIMIT - 1)
  const tailTotal = tail.reduce((sum, row) => sum.add(row.total), new Prisma.Decimal(0))
  return [
    ...head.map((row) => ({ name: row.name, value: row.total.toNumber() })),
    { name: '', nameKey: OTHER_CATEGORY_KEY, value: tailTotal.toNumber() },
  ]
}
```
and `NamedAmountDto` (`:161-164`) gains `/** Set instead of `name` for a synthesised row the component must translate. */ nameKey?: string`. Add a view-model test: nine categories in, eight bars out, the last one carrying `nameKey` and a value equal to the exact sum of the tail.

- [ ] **Step 8: Rewrite the dashboard page's render**

Replace `app/(app)/dashboard/page.tsx:163-310`. Everything above line 163 — the auth redirect, the single `now`, the FX degradation helper, the query plan and its comments, `buildDashboardViewModel` — stays **exactly** as it is; this task changes only what is rendered.

```tsx
  const t = await getTranslations()
  const locale = await resolveLocale()

  /** Every summary label and hint, translated once for the panel. */
  const summaryLabels = {
    'dashboard.netWorth': t('dashboard.netWorth'),
    'dashboard.netWorthNote': t('dashboard.netWorthNote'),
    'dashboard.totalBalance': t('dashboard.totalBalance'),
    'dashboard.monthlyIncome': t('dashboard.monthlyIncome'),
    'dashboard.monthlyExpense': t('dashboard.monthlyExpense'),
    'dashboard.netIncome': t('dashboard.netIncome'),
  }
  const summaryHints = { 'dashboard.fxUnavailableHint': t('dashboard.fxUnavailableHint') }

  return (
    // max-w 1200 (spec §2), page padding 16/24/32, section gap 24 at the grid's
    // gutter and 32 between the header and the grid.
    <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitle', {
          month: formatDate(vm.monthStart, { locale, timeZone: timezone, style: 'monthYear' }),
          currency: vm.displayCurrency,
        })}
        meta={<FxRateStatus status={vm.fxStatus} />}
      />

      <SummaryPanel
        variant="dashboard"
        kpis={vm.kpis}
        currency={vm.displayCurrency}
        labels={summaryLabels}
        hints={summaryHints}
      />

      {/* The spec's 12-column grid (§6.1), 24 px gutters. `order-*` below lg is
          what produces the mobile stacking order the spec fixes — which is NOT
          the desktop reading order: on a phone the ledger and the planning
          widgets come before the charts, because a phone is where the user
          checks something rather than studies it. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-12">
        {/* Row 3: trend 8/12 h300 + expense breakdown 4/12 h300 */}
        <ChartContainer
          title={t('dashboard.cashFlowTrend')}
          height={CHART_HEIGHT.tall}
          className="order-1 md:col-span-2 xl:col-span-8"
        >
          <CashFlowTrendChart
            data={vm.cashFlowTrend}
            currency={vm.displayCurrency}
            locale={locale}
            height={CHART_HEIGHT.tall}
          />
        </ChartContainer>

        <ChartContainer
          title={t('dashboard.expenseByCategory')}
          height={CHART_HEIGHT.tall}
          className="order-5 md:col-span-1 xl:order-2 xl:col-span-4"
        >
          {vm.expenseByCategory.length === 0 ? (
            <EmptyState icon={PieChart} title={t('dashboard.emptyExpenseTitle')} />
          ) : (
            <ExpenseByCategoryChart
              data={vm.expenseByCategory.map((row) => ({
                ...row,
                name: row.nameKey ? t(row.nameKey) : row.name,
              }))}
              currency={vm.displayCurrency}
              locale={locale}
              height={CHART_HEIGHT.tall}
            />
          )}
        </ChartContainer>

        {/* Row 4: balance history 8/12 h260 + income vs expense 4/12 h260 */}
        <ChartContainer
          title={t('dashboard.balanceOverTime')}
          caption={t('dashboard.balanceOverTimeCaption')}
          height={CHART_HEIGHT.medium}
          className="order-10 md:col-span-2 xl:order-3 xl:col-span-8"
        >
          {/* The spec is explicit: an empty balance history shows the EMPTY
              STATE, not a flat zero line — a line at zero across six months is
              a measurement nobody took. `every(point => balance === null)` is
              the honest test: a genuine zero balance is a figure. */}
          {vm.balanceOverTime.every((point) => point.balance === null) ? (
            <EmptyState
              icon={LineChart}
              title={t('dashboard.emptyBalanceHistoryTitle')}
              description={t('dashboard.emptyBalanceHistoryBody')}
            />
          ) : (
            <AccountBalanceHistoryChart
              data={vm.balanceOverTime}
              currency={vm.displayCurrency}
              locale={locale}
              height={CHART_HEIGHT.medium}
            />
          )}
        </ChartContainer>

        <ChartContainer
          title={t('dashboard.incomeVsExpense')}
          height={CHART_HEIGHT.medium}
          className="order-9 md:col-span-1 xl:order-4 xl:col-span-4"
        >
          <IncomeVsExpenseChart
            data={vm.incomeVsExpense}
            currency={vm.displayCurrency}
            locale={locale}
            height={CHART_HEIGHT.medium}
          />
        </ChartContainer>

        {/* Row 5: three planning widgets, 4/12 each, h ≤ 240, ≤ 3 rows + a link */}
        <ChartContainer
          title={t('dashboard.accountDistribution')}
          className="order-11 md:col-span-1 xl:order-5 xl:col-span-4"
        >
          {vm.distribution === null ? (
            <EmptyState icon={Wallet} title={t('dashboard.distributionFxUnavailable')} />
          ) : vm.distribution.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title={t('dashboard.emptyDistributionTitle')}
              action={{ label: t('dashboard.emptyDistributionAction'), href: '/accounts' }}
            />
          ) : (
            <AccountDistributionChart
              data={vm.distribution}
              currency={vm.displayCurrency}
              locale={locale}
              height={CHART_HEIGHT.short}
            />
          )}
        </ChartContainer>

        <ChartContainer
          title={t('dashboard.budgetProgress')}
          caption={t('dashboard.budgetProgressCaption')}
          right={
            vm.budgets.length > 0 ? (
              <Link
                href="/budgets"
                className="text-xs/[1rem] text-brand underline-offset-4 hover:underline"
              >
                {t('dashboard.viewAllBudgets')}
              </Link>
            ) : undefined
          }
          className="order-3 md:col-span-1 xl:order-6 xl:col-span-4"
        >
          {vm.budgets.length === 0 ? (
            <EmptyState
              icon={Target}
              title={t('dashboard.emptyBudgetsTitle')}
              action={{ label: t('dashboard.emptyBudgetsAction'), href: '/budgets' }}
            />
          ) : (
            <BudgetProgressList budgets={vm.budgets.slice(0, WIDGET_ROWS)} compact />
          )}
        </ChartContainer>

        <ChartContainer
          title={t('dashboard.savingsGoals')}
          caption={t('dashboard.savingsGoalsCaption')}
          right={
            vm.savingsGoals.length > 0 ? (
              <Link
                href="/goals"
                className="text-xs/[1rem] text-brand underline-offset-4 hover:underline"
              >
                {t('dashboard.viewAllGoals')}
              </Link>
            ) : undefined
          }
          className="order-7 md:col-span-1 xl:order-7 xl:col-span-4"
        >
          {vm.savingsGoals.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title={t('dashboard.emptyGoalsTitle')}
              action={{ label: t('dashboard.emptyGoalsAction'), href: '/goals' }}
            />
          ) : (
            <GoalList goals={vm.savingsGoals.slice(0, WIDGET_ROWS)} compact />
          )}
        </ChartContainer>

        {/* Row 6: debt/loan 4/12 + reminders 8/12 */}
        <ChartContainer
          title={t('dashboard.debtLoanOverview')}
          caption={t('dashboard.debtLoanOverviewCaption', { currency: vm.displayCurrency })}
          className="order-8 md:col-span-1 xl:order-8 xl:col-span-4"
        >
          {vm.debtLoanOverview === null ? (
            <EmptyState icon={HandCoins} title={t('dashboard.debtLoanFxUnavailable')} />
          ) : (
            <DebtLoanOverview
              data={vm.debtLoanOverview}
              currency={vm.displayCurrency}
              labels={{
                'dashboard.receivables': t('dashboard.receivables'),
                'dashboard.payables': t('dashboard.payables'),
                'dashboard.loanOutstanding': t('dashboard.loanOutstanding'),
              }}
              footnote={t('dashboard.debtLoanIncluded')}
            />
          )}
        </ChartContainer>

        <ChartContainer
          title={t('dashboard.upcomingReminders')}
          caption={t('dashboard.upcomingRemindersCaption', { days: OCCURRENCE_LOOKAHEAD_DAYS })}
          right={
            vm.upcomingReminders.length > 0 ? (
              <Link
                href="/reminders"
                className="text-xs/[1rem] text-brand underline-offset-4 hover:underline"
              >
                {t('dashboard.viewAllReminders')}
              </Link>
            ) : undefined
          }
          className="order-4 md:col-span-2 xl:order-9 xl:col-span-8"
        >
          {vm.upcomingReminders.length === 0 ? (
            <EmptyState
              icon={BellRing}
              title={t('dashboard.emptyRemindersTitle', { days: OCCURRENCE_LOOKAHEAD_DAYS })}
              action={{ label: t('dashboard.emptyRemindersAction'), href: '/reminders#new' }}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {/* A muted count, not a banner — the user needs to know how much
                  of it there is (the list shows at most two) without being
                  shouted at. Only the number carries colour, and the word
                  carries the meaning. */}
              {vm.overdueReminderCount > 0 && (
                <p className="text-xs/[1rem] text-muted-foreground">
                  <span className="text-negative tabular-nums">
                    {t('dashboard.overdueCount', { count: vm.overdueReminderCount })}
                  </span>
                </p>
              )}
              {/* Only the props this component takes TODAY: Task 9 adds
                  `locale`/`timeZone` to it and updates this call site. */}
              <OccurrenceList occurrences={vm.upcomingReminders} compact />
            </div>
          )}
        </ChartContainer>

        {/* Row 7: the ledger, full width and LAST on desktop — the widgets
            above are what the user came to decide something from, and the
            ledger is what they scroll to when they want to check one of them.
            On a phone it is second (order-2), because checking one entry is
            what a phone is for. */}
        <ChartContainer
          title={t('dashboard.recentTransactions')}
          className="order-2 md:col-span-2 xl:order-10 xl:col-span-12"
        >
          <RecentTransactions
            transactions={vm.recentTransactions}
            locale={locale}
            timeZone={timezone}
          />
        </ChartContainer>
      </div>
    </div>
  )
```

Add at the top of the file: `const WIDGET_ROWS = 3` with the comment "Spec §6.1: each of the three row-5 planning widgets shows at most three rows and a link — a widget is a glance, and its page has the full list."; and change `RECENT_TRANSACTION_COUNT` (`app/(app)/dashboard/page.tsx:34`) from `5` to `8` with the comment "Spec §6.1 row 7: the ledger is full width on desktop and shows eight rows. The mobile stack shows five — sliced in the component's own render, not fetched twice." Then in the `RecentTransactions` call above, pass `transactions={vm.recentTransactions}` and let the component render all eight on desktop while hiding rows 6–8 below `xl` with `hidden xl:flex` on those three `<li>`s — implement that by passing `mobileLimit={5}` to `RecentTransactions` and having it add `index >= mobileLimit && 'hidden xl:flex'` to the row's className. Add that prop to its signature and one static-markup test asserting rows 6–8 carry `hidden xl:flex`.

New imports for the page: `PageHeader` (`@/components/common/page-header`), `ChartContainer`, `EmptyState`, `SummaryPanel`, `CHART_HEIGHT` (`@/components/dashboard/chart-theme`), `getTranslations` (`next-intl/server`), `resolveLocale` (`@/lib/i18n/config`), `formatDate` (`@/lib/ui/format-date`), and the six lucide icons `PieChart`, `LineChart`, `Wallet`, `Target`, `PiggyBank`, `HandCoins`, `BellRing`, `Receipt`. Remove the `DashboardEmpty`/`DashboardSection`/`KpiStrip` imports.

- [ ] **Step 9: Delete the two replaced components**

```bash
grep -rn "dashboard-section\|DashboardSection\|DashboardEmpty\|KpiStrip\|kpi-strip" app components lib e2e
```
Expected remaining hits: `app/(app)/reports/page.tsx:15-16,108-186` (Task 10's job). Until Task 10 runs, `/reports` still needs them — so **do not delete the files in this task**. Instead:
- leave `components/dashboard/dashboard-section.tsx` and `components/dashboard/kpi-strip.tsx` in place, add a one-line doc comment at the top of each saying "Superseded by `ChartContainer`/`SummaryPanel` (Phase 7 Task 4); the only remaining caller is `/reports`, and Task 10 deletes this file";
- record the deletion as a Task 10 step (it is already listed there).

Adjust this task's **Files** list accordingly: the two deletions move to Task 10.

- [ ] **Step 10: Update the dashboard assertions in the three e2e specs**

`e2e/phase4.spec.ts`:
- `:80` — `getByRole('heading', { name: 'Dashboard', level: 1 })` → `{ name: /Tổng quan|^Dashboard$/, level: 1 }`.
- `:100-111` — the KPI strip lookup `page.locator('dl')` still works (the panel is a `dl`), but the five labels change: replace with
  ```ts
  const summary = page.locator('dl').first()
  for (const label of [
    /Tài sản ròng|Net Worth/, /Tổng số dư|Total Balance/, /Thu nhập tháng|Monthly Income/,
    /Chi tiêu tháng|Monthly Expense/, /Thu nhập ròng|Net Income/,
  ]) {
    await expect(summary.getByText(label)).toBeVisible()
  }
  ```
  (`getByText` with a regex, not `{ exact: true }`, because "Thu nhập ròng" and "Thu nhập tháng" share a prefix and the exact-match form no longer applies to a regex.)
- `:129-134` — the eleven widget headings become regex alternations, keeping the same order: `/Dòng tiền theo tháng|Cash Flow Trend/`, `/Thu và chi|Income vs Expense/`, `/Số dư theo thời gian|Account Balance Over Time/`, `/Chi tiêu theo danh mục|Expense by Category/`, `/Phân bổ số dư|Account Balance Distribution/`, `/Tiến độ ngân sách|Budget Progress/`, `/Mục tiêu tiết kiệm|Savings Goals/`, `/Công nợ và khoản vay|Debt \/ Loan Overview/`, `/Nhắc nhở sắp tới|Upcoming Reminders/`, `/Giao dịch gần đây|Recent Transactions/`.
- `:135-137` — the Recent Transactions section filter uses the same regex; `Salary` and `Food & Dining` are category names the test created and stay literal.
- `:139-149` — the `main header p` FX lookup: `FxRateStatus` now renders a `<span>` inside `PageHeader`'s `meta` `<div>`, so replace with
  ```ts
  const fxStatusText = await page.locator('main header').getByText(/USD = |Chưa có tỷ giá|FX rate unavailable|Không cần quy đổi|No conversion needed/).first().textContent()
  ```
  and widen the regex accordingly.
- `:151-160` — the Total Account Balance cell lookup: `page.locator('dl > div').filter({ has: page.getByText('Total Account Balance', { exact: true }) })` becomes `.filter({ has: page.getByText(/Tổng số dư|Total Balance/) })`, and the `dd span.tabular-nums` read still works (`MoneyText` renders exactly that).
- **New assertion** at the end of the desktop test, encoding the spec's grid: assert Cash Flow Trend's `<section>` bounding box width is between 60 % and 70 % of the grid's width at 1440 (8/12 = 66.7 %), and Recent Transactions' is > 95 % (12/12). Use `boundingBox()`.

`e2e/phase5.spec.ts:288-300` — the Budget Progress widget: `page.getByRole('heading', { name: 'Budget Progress' })` → the regex form; the section filter and the `budgetRow` helper are unchanged (`BudgetProgressList` is untouched by this task).

`e2e/phase6.spec.ts`:
- `:140-165` — `sectionFor(page, heading)` is called with English headings; change its call sites for dashboard sections to the regex forms and widen the helper's parameter type to `string | RegExp`.
- `:760-800` — the Net Worth arithmetic test reads the KPI by label: update the two labels to the regex form and keep `digitsOnly` comparison.
- `:781` — `getByText('Included in Net Worth', { exact: true })` → `getByText(/Đã tính trong tài sản ròng|Included in Net Worth/)`.

Run: `npx playwright test e2e/phase4.spec.ts e2e/phase5.spec.ts e2e/phase6.spec.ts` → green.

- [ ] **Step 11: Full verification**

Run: `npm run test` → green (including the updated `dashboard-view-model.test.ts`, the new `summary-panel.test.tsx`, and `debt-loan-overview.test.tsx` with its translated labels).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

- [ ] **Step 12: Browser visual check — the dashboard at every width, both themes, both locales, and the empty state**

Seed two users with the scratch driver: one **full** (2 VND accounts + 1 USD account, ~15 transactions across two months, 2 budgets, 2 goals, 1 receivable + 1 payable debt, 1 loan, 3 reminders including one overdue) and one **brand new** (nothing at all).

Screenshot `/dashboard`:
- full user, light: 1440×900, 1280×800, 768×1024, 375×812 (4)
- full user, dark: the same four (4)
- full user, English, light 1440 (1)
- empty user, light: 1440, 375 (2)
- empty user, dark: 1440 (1)
- full user, light 1440, **above the fold only** — clip to the first 900 px (1)

Thirteen screenshots. Look for:
- Above the fold at 1440×900: header, the whole summary panel, and the top of Cash Flow Trend — and nothing else competing (spec §6.1).
- The summary panel is one card with internal rules, Net Worth visibly the largest number on the page, Total Balance directly beneath it, the three monthly metrics in three equal columns to the right.
- Row widths: 8/12 + 4/12, then 8/12 + 4/12, then 4+4+4, then 4/12 + 8/12, then 12/12.
- Chart heights match 300 / 300 / 260 / 260 / ≤ 240 — no ragged row.
- 375: Net Worth full width then a genuine 2×2 grid, **no horizontal scroll anywhere** (assert `document.documentElement.scrollWidth <= 375` in the driver), and the stack order exactly as the spec lists it — read it off the screenshot top to bottom and write the observed order into the report.
- Empty user: one `EmptyState` per widget, each with one action; the balance-history widget shows its empty state and **not** a flat line at zero.
- Dark: chart grid lines visible; tooltip on `--surface-2` (hover one point and screenshot); no widget with a shadow.
- English: no label wraps awkwardly; the month reads "September 2026".

- [ ] **Step 13: 🛑 VISUAL CHECKPOINT 2 — Dashboard (spec §11)**

**The controller STOPS here and does not start Task 5 until the product owner approves.**

Hand over: `/dashboard` desktop light 1440, desktop light 1440 above-the-fold clip, desktop dark 1440, tablet 768 light, mobile 375 light (full-page, showing the whole stack), mobile 375 dark, English desktop 1440 light, and the empty-user 1440 light + 375 light pair. Nine images.

Report alongside them: the observed mobile stacking order, the measured widget widths at 1440 as a fraction of the grid, and confirmation that no metric strip scrolls horizontally at 375.

**Tests required:**
- Vitest: `components/dashboard/summary-panel.test.tsx` (6 new); `lib/ui/dashboard-view-model.test.ts` (5 new + the expense-bucketing test + every existing assertion migrated to the new field names); `components/dashboard/debt-loan-overview.test.tsx` (updated to the `labels`/`footnote` props); `components/dashboard/recent-transactions.test.tsx` (new, 2 tests: the type label replaces a null category; rows 6–8 carry `hidden xl:flex`).
- Playwright: the updated dashboard sections of `e2e/phase4.spec.ts`, `phase5.spec.ts`, `phase6.spec.ts`, plus the new 8/12-vs-12/12 width assertion in `phase4.spec.ts`.

**Browser visual checks required:** the thirteen screenshots in Step 12 and the nine-image checkpoint package in Step 13.

**Explicit things NOT to change:** `BudgetProgressList`, `GoalList` and `OccurrenceList`'s signatures — Tasks 7 and 9 re-skin them and add their `locale`/`timeZone` props, and this task's three call sites pass only what those components take today (`budgets`/`goals`/`occurrences` plus `compact`); `app/(app)/dashboard/page.tsx:36-161` — the auth redirect, the single `now`, `orNullIfFxUnavailable` and its narrowing, the "resolved FIRST, on its own" position ordering, the whole `Promise.all` query plan and every comment explaining it; `TREND_MONTHS`; `buildDashboardViewModel`'s financial logic (only the two DTO shapes and the two label sources change); `WIDGET_ROW_LIMIT`/`WIDGET_OVERDUE_ROW_LIMIT` and the ruling R6-23 partitioning; `getCurrentPosition`, `getActivitySummary`, `getCashFlowTrend`, `getAccountBalanceOverTime`, `getBudgetProgressForMonth`, `listSavingsGoals`, `listUpcomingOccurrences`; `chart-theme.ts`'s colours and `isAnimationActive: false`; `BudgetProgressList` and `GoalList` (Task 7 re-skins them — this task only passes them `compact` and a slice, exactly as today).

**Completion gate:** all four commands green; thirteen screenshots taken and inspected; no horizontal overflow at 375/414/768/1024/1280/1440 on `/dashboard`; the mobile stack order matches spec §6.1 verbatim; checkpoint package delivered and **approved**.

**Proposed commit boundary:**
1. `feat(dashboard): replace the KPI strip with the one-panel summary and key-based labels`
2. `feat(dashboard): rebuild the widget grid to the spec's rows, heights and mobile stack, with a per-widget empty state`

---
## Task 5a: Transactions

**Objective:** Rebuild `/transactions` to spec §6.2 — a two-column desktop layout (list 7/12, sticky create panel 5/12 from 1280) with day-grouped rows, a fixed `min-w-[8.5rem]` amount column, product type labels, a segmented type control, custom Category and Account selects, separate native Ngày/Giờ inputs, and a mobile bottom-sheet create form. `ConfirmDialog` replaces the delete `window.confirm`. This task carries the **full code for the first module's list and form**, which later module tasks refer to for shape but never for content.

**Major files touched:** `app/(app)/transactions/page.tsx`, `components/transactions/transaction-list.tsx`, `components/transactions/transaction-form.tsx`, `components/transactions/transaction-type-field.tsx` (new), `components/transactions/category-select.tsx` (new), `components/transactions/account-select.tsx` (new), `components/transactions/transaction-create-panel.tsx` (new), `components/transactions/transaction-day-group.tsx` (new), `messages/{vi,en}/transactions.json`.

**Reusable primitives involved:** `PageHeader`, `FinancialListRow`, `MoneyText`, `EmptyState`, `InlineAlert`, `FormField`/`Label`/`FieldError`/`SELECT_CLASS`, `ConfirmDialog`, `Sheet`, `RowActionsMenu`, `useSubmitState`. The type field is a *button* segmented control, not the link-based `SegmentedControl` primitive — see Step 5.

**User-facing behaviour:** the page opens with the month's total in the header, a day-grouped list, and — at ≥ 1280 — a create form always visible in a sticky right column. Choosing a type re-filters the Category picker and clears the chosen category. Submitting locks the whole fieldset, then resets the form and refreshes the list. Deleting a row asks for confirmation in a dialog. On a phone the form opens as a bottom sheet from the `+` tab or the header button.

**Desktop expectation:** at ≥ 1280 (Tailwind `xl`) the page is `xl:grid-cols-12` with the list at `xl:col-span-7` and the create panel at `xl:col-span-5 sticky top-6 self-start`; at 1024–1279 the form drops below the list, full width — the tablet composition, by design. Page max width 1200 (`max-w-[75rem]`), because the two-column layout needs it. Amount column fixed at 8.5 rem, right-aligned, never colliding with the note.

**Mobile expectation:** the list only; a `Sheet` holds the form, opened by the header's primary button and by the bottom bar's `+` (which navigates to `/transactions#new` — the panel reads the hash on mount and opens the sheet). Rows are two lines: line one is the title with the amount right-aligned, line two is the note.

**Dark-theme expectation:** the sticky create panel is `bg-surface` with a `border-border` hairline and no shadow; the mobile sheet is `bg-surface-2`; inputs sit on `--input-bg`; the amount column's `+`/`−` colours use `--positive` at dark L≈0.635 and `--foreground` for expense (never red for an ordinary expense); the day-group header is `bg-surface` sticky inside the list card so rows scroll under it legibly.

**Vietnamese/English expectation:** type labels are the product words from `labels.json` — Chi tiêu, Thu nhập, Tiền vào (khác), Tiền ra (khác), Điều chỉnh tăng, Điều chỉnh giảm — never the enum. Day headers are "Hôm nay" / "Hôm qua" / a locale date from `formatDate(..., 'weekday')`. Every field has a Vietnamese `<label>`, including the two new ones, "Ngày" and "Giờ". The `<input type="date">` / `type="time"` browser chrome is **not** restyled and no dd/MM/yyyy display is claimed (spec §2) — only the labels are localised, and every date shown *outside* a native control goes through `formatDate`.

**Accessibility acceptance criteria:**
- One `h1` from `PageHeader`; the create panel's title is an `h2`; each day group's header is an `h3`.
- Every control has a visible `<label htmlFor>` via `FormField` — the six `aria-label`-only inputs in this form all gain one.
- The type field is a `role="radiogroup"` with `aria-labelledby`, six `role="radio"` buttons, arrow-key navigation and `aria-checked`; the four "Khác" types live in a disclosure that is `aria-expanded`-labelled.
- The Category and Account custom selects carry combobox/listbox semantics and type-ahead from Base UI, and each is wrapped in a `FormField` for its visible label; their pre-hydration stand-in is a **disabled native `<select>`**, so the label is bound to a labelable element in the first paint too.
- Delete is a `RowActionsMenu` item, and the confirmation is a `ConfirmDialog` with `role="dialog"`, a focus trap, focus restoration, Escape and overlay dismissal.
- Errors are bound with `aria-describedby` and the form-level failure is an `InlineAlert` with `role="alert"`.
- In-flight: `<fieldset disabled aria-busy="true">`.
- Touch targets ≥ 44 px on the type buttons and the row action trigger.

**Hydration/form-submission constraints (the load-bearing part of this task):**
- The `useHydrated()` gate stays on the create form, unchanged in mechanism: `<fieldset disabled={!hydrated || locked} aria-busy={busy}>`. `lib/ui/use-hydrated.ts`'s whole doc comment explains why, and Playwright's actionability check treats a control in a disabled fieldset as disabled — which is what makes `e2e/helpers.ts`'s retry-free `fill`/`selectOption` correct.
- `defaultValue` rules are preserved exactly, and the split date/time pair joins them: the type field's default is `EXPENSE` (server-rendered as the checked radio); `datePart` and `timePart` both carry a `defaultValues` entry from `nowInZone(timezone).split('T')`, so both are revertible and both are behind the gate; `accountId` needs no `defaultValue` because it is `accounts[0]`; `categoryId` keeps its `undefined`-not-`''` normalisation.
- **No controlled state is introduced to silence the Base UI warning.** The custom `Select`s are the one place a controlled value is unavoidable (a base-ui Select has no uncontrolled DOM form value), so each is registered with react-hook-form's `Controller` and rendered **only after hydration**; before hydration the fieldset is disabled anyway, and the SSR markup renders a disabled native `<select>` holding the form's actual default. That is the one deviation and it is deliberate; it is documented in the component.
- `useSubmitState().run` wraps the `onSubmit` body so a second submit is impossible while the first is in flight.

**Files:**
- Create: `components/transactions/transaction-type-field.tsx`, `components/transactions/category-select.tsx`, `components/transactions/account-select.tsx`, `components/transactions/transaction-create-panel.tsx`, `components/transactions/transaction-day-group.tsx`, `components/transactions/transaction-day-group.test.ts`
- Modify: `app/(app)/transactions/page.tsx:1-56` (whole file), `components/transactions/transaction-list.tsx:1-128` (whole file), `components/transactions/transaction-form.tsx:1-280` (whole file), `messages/{vi,en}/transactions.json`
- Test: `components/transactions/transaction-day-group.test.ts`, `components/transactions/transaction-form.test.tsx` (extend)

**Interfaces:**

- Consumes: every Task 1a–1c primitive; `formatDate`, `toDateInputValue`, `transactionTypeLabelKey`, `TRANSACTION_ERROR_KEYS`, `GENERIC_ERROR_KEY` (Task 2c); `useSubmitState`; `useHydrated`; `formatMoney`; `nowInZone` (existing).
- Produces:

```ts
// components/transactions/transaction-day-group.tsx
export interface DayGroup<T> {
  /** `yyyy-MM-dd` in the user's zone — the grouping key. */
  day: string
  /** Which header wording to use. */
  kind: 'today' | 'yesterday' | 'date'
  rows: T[]
}
export function groupByDay<T>(
  rows: T[],
  dayOf: (row: T) => string,
  today: string,
  yesterday: string,
): DayGroup<T>[]

// components/transactions/transaction-type-field.tsx  ('use client')
export function TransactionTypeField(props: {
  value: TransactionType
  onChange: (type: TransactionType) => void
  labels: Record<TransactionType, string>
  legend: string
  otherLabel: string
  disabled?: boolean
}): React.ReactElement

// components/transactions/account-select.tsx  ('use client')
export function AccountSelect(props: {
  id: string
  accounts: { id: string; name: string; currency: Currency; balance: string }[]
  value: string
  onChange: (accountId: string) => void
  placeholder: string
  /** `(account) => "Cash · 5.000.000 VND"` — already formatted and translated. */
  optionLabel: (account: { name: string; currency: string; balance: string }) => string
  'aria-describedby'?: string
  'aria-invalid'?: true
}): React.ReactElement

// components/transactions/category-select.tsx  ('use client')
export function CategorySelect(props: {
  id: string
  groups: { labelKey: string; label: string; items: { id: string; name: string }[] }[]
  value: string | undefined
  onChange: (categoryId: string | undefined) => void
  placeholder: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}): React.ReactElement

// components/transactions/transaction-form.tsx  ('use client')
export type AccountOption = { id: string; name: string; currency: Currency; balance: string }
export type CategoryOption = { id: string; name: string; type: 'INCOME' | 'EXPENSE' }
export function TransactionForm(props: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  timezone: string
  locale: Locale
  /** The sheet closes itself on success; the sticky panel passes nothing. */
  onCreated?: () => void
}): React.ReactElement

// components/transactions/transaction-create-panel.tsx  ('use client')
export function TransactionCreatePanel(props: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  timezone: string
  locale: Locale
}): React.ReactElement

// components/transactions/transaction-list.tsx  ('use client')
export interface TransactionRow {
  id: string
  type: TransactionType
  amount: string
  currency: Currency
  date: Date
  note: string | null
  fxRateSource: string
  account: { name: string }
  category: { name: string } | null
}
export function TransactionList(props: {
  transactions: TransactionRow[]
  timezone: string
  locale: Locale
  today: string
  yesterday: string
}): React.ReactElement
```

- [ ] **Step 1: Add the transactions message keys**

`messages/vi/transactions.json`:

```json
{
  "title": "Giao dịch",
  "monthTotal": "Chi tiêu tháng này {amount} {currency}",
  "createTitle": "Thêm giao dịch",
  "createAction": "Thêm giao dịch",
  "createPending": "Đang thêm…",
  "typeLegend": "Loại giao dịch",
  "typeOther": "Khác",
  "account": "Tài khoản",
  "accountPlaceholder": "Chọn tài khoản",
  "accountOption": "{name} · {balance} {currency}",
  "category": "Danh mục",
  "categoryPlaceholder": "Chọn danh mục",
  "categoryGroupExpense": "Danh mục chi",
  "categoryGroupIncome": "Danh mục thu",
  "amount": "Số tiền",
  "date": "Ngày",
  "time": "Giờ",
  "note": "Ghi chú (tùy chọn)",
  "noteHelper": "Ví dụ: bữa trưa với khách hàng",
  "dayToday": "Hôm nay",
  "dayYesterday": "Hôm qua",
  "rateFromCache": "tỷ giá lưu tạm",
  "deleteAction": "Xóa giao dịch",
  "deleteConfirmTitle": "Xóa giao dịch này?",
  "deleteConfirmBody": "Số dư tài khoản sẽ được tính lại. Không thể hoàn tác.",
  "deleteConfirm": "Xóa",
  "deletePending": "Đang xóa…",
  "emptyTitle": "Chưa có giao dịch",
  "emptyBody": "Thêm giao dịch đầu tiên để bắt đầu theo dõi dòng tiền.",
  "noAccountTitle": "Cần một tài khoản trước",
  "noAccountBody": "Bạn cần ít nhất một tài khoản để ghi giao dịch.",
  "noAccountAction": "Đến Tài khoản",
  "openCreate": "Thêm giao dịch"
}
```

`messages/en/transactions.json`: the same keys in English, keeping today's exact wording where it exists so no e2e assertion needs re-deriving — `"createAction": "Add transaction"`, `"createTitle": "Add transaction"`, `"account": "Account"`, `"category": "Category"`, `"amount": "Amount"`, `"date": "Date"`, `"time": "Time"`, `"note": "Note (optional)"`, `"typeLegend": "Transaction type"`, `"categoryPlaceholder": "Select a category"`, `"noAccountBody": "You need an account before you can add a transaction."`, `"noAccountAction": "Go to Accounts"`, `"rateFromCache": "rate from cache"`, `"dayToday": "Today"`, `"dayYesterday": "Yesterday"`, and English for the rest.

- [ ] **Step 2: Write the failing test for `groupByDay`**

`components/transactions/transaction-day-group.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { groupByDay } from './transaction-day-group'

type Row = { id: string; day: string }
const dayOf = (row: Row) => row.day

describe('groupByDay', () => {
  it('groups consecutive rows of the same day and keeps the input order', () => {
    const rows: Row[] = [
      { id: 'a', day: '2026-09-08' },
      { id: 'b', day: '2026-09-08' },
      { id: 'c', day: '2026-09-07' },
      { id: 'd', day: '2026-09-05' },
    ]
    const groups = groupByDay(rows, dayOf, '2026-09-08', '2026-09-07')
    expect(groups.map((group) => group.day)).toEqual(['2026-09-08', '2026-09-07', '2026-09-05'])
    expect(groups[0].rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(groups.map((group) => group.kind)).toEqual(['today', 'yesterday', 'date'])
  })

  it('does not merge two runs of the same day that are separated in the input', () => {
    // The list arrives ordered by date desc from the service, so this cannot
    // happen — but merging would silently reorder a user's ledger if it ever
    // did, and reordering money is worse than an extra header.
    const rows: Row[] = [
      { id: 'a', day: '2026-09-08' },
      { id: 'b', day: '2026-09-07' },
      { id: 'c', day: '2026-09-08' },
    ]
    const groups = groupByDay(rows, dayOf, '2026-09-08', '2026-09-07')
    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.rows.map((row) => row.id))).toEqual([['a'], ['b'], ['c']])
  })

  it('returns nothing for an empty list', () => {
    expect(groupByDay([], dayOf, '2026-09-08', '2026-09-07')).toEqual([])
  })

  it('labels a future-dated row as a plain date, never as today', () => {
    const groups = groupByDay([{ id: 'a', day: '2026-12-31' }], dayOf, '2026-09-08', '2026-09-07')
    expect(groups[0].kind).toBe('date')
  })
})
```

Run: `npx vitest run components/transactions/transaction-day-group.test.ts` → FAIL.

- [ ] **Step 3: Write `groupByDay`**

`components/transactions/transaction-day-group.tsx`:

```tsx
/**
 * Day grouping for the ledger (spec §6.2): "rows grouped by day headers (Hôm
 * nay, Hôm qua, then a locale date)".
 *
 * A pure function over already-computed day strings, so it has a unit test and
 * knows nothing about locale, zone or React. `today`/`yesterday` are passed in
 * as `yyyy-MM-dd` in the USER's zone — never derived from `new Date()` here,
 * for the reason `lib/datetime/calendar-date.ts` gives: this module has no user,
 * and passing the day in is what makes both branches testable without freezing
 * a clock.
 *
 * Consecutive runs only. The service returns rows date-descending so a day
 * appears once, but merging non-adjacent runs would reorder a user's ledger if
 * it ever did not — and an extra header is a cosmetic surprise while a
 * reordered ledger is a wrong one.
 */
export interface DayGroup<T> {
  day: string
  kind: 'today' | 'yesterday' | 'date'
  rows: T[]
}

export function groupByDay<T>(
  rows: T[],
  dayOf: (row: T) => string,
  today: string,
  yesterday: string,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  for (const row of rows) {
    const day = dayOf(row)
    const last = groups[groups.length - 1]
    if (last && last.day === day) {
      last.rows.push(row)
      continue
    }
    groups.push({
      day,
      kind: day === today ? 'today' : day === yesterday ? 'yesterday' : 'date',
      rows: [row],
    })
  }
  return groups
}
```

Run: `npx vitest run components/transactions/transaction-day-group.test.ts` → PASS (4 tests).

- [ ] **Step 4: Rewrite `components/transactions/transaction-list.tsx` in full**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatInTimeZone } from 'date-fns-tz'
import { useTranslations } from 'next-intl'
import { Receipt } from 'lucide-react'
import type { Currency, TransactionType } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import { deleteTransactionAction } from '@/lib/server/actions/transaction-actions'
import { GENERIC_ERROR_KEY, TRANSACTION_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatDate } from '@/lib/ui/format-date'
import { formatMoney } from '@/lib/ui/format-money'
import { transactionTypeLabelKey } from '@/lib/ui/labels'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { InlineAlert } from '@/components/common/inline-alert'
import { MoneyText } from '@/components/common/money-text'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
import { groupByDay } from './transaction-day-group'

/**
 * The ledger (spec §6.2).
 *
 * No Prisma import beyond the two enum types — the page fetches, bounds and
 * shapes the rows; this component only renders. `amount` arrives as a
 * fixed-2-decimal string (the page's `Decimal#toFixed(2)`) rather than a raw
 * `Decimal`, which cannot cross the server-to-client-component boundary.
 *
 * Three things the pre-flight review asked for and that this shape delivers:
 *
 *  - the amount lives in a FIXED `min-w-[8.5rem]` column (`FinancialListRow`),
 *    so a long note can never push a VND figure off the row or wrap it
 *    mid-number;
 *  - the note is one ellipsised line with its full text in `title`;
 *  - the row's title is the category name or the TYPE's product label — never
 *    `tx.type` verbatim, which is how `CASH_OUT` used to reach the screen.
 *
 * Delete is a `ConfirmDialog`, not `window.confirm` (spec §10): a native dialog
 * cannot be styled, cannot be translated, and says nothing about what the
 * action does to the balance.
 */
export interface TransactionRow {
  id: string
  type: TransactionType
  amount: string
  currency: Currency
  date: Date
  note: string | null
  fxRateSource: string
  account: { name: string }
  category: { name: string } | null
}

export function TransactionList({
  transactions,
  timezone,
  locale,
  today,
  yesterday,
}: {
  transactions: TransactionRow[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page). `date` is a UTC instant; formatting it in the user's own
   * zone — rather than the server's or the browser's — is what keeps what is
   * shown identical on the server render and the client hydration (no
   * mismatch) while still showing *their* wall clock, not UTC's.
   */
  timezone: string
  locale: Locale
  /** `yyyy-MM-dd` in `timezone`, from the page — see `groupByDay`. */
  today: string
  yesterday: string
}) {
  const router = useRouter()
  const t = useTranslations()
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** The row awaiting confirmation, or `null`. One dialog for the whole list. */
  const [pendingDelete, setPendingDelete] = useState<TransactionRow | null>(null)

  async function confirmDelete(row: TransactionRow) {
    setErrors((prev) => {
      const next = { ...prev }
      delete next[row.id]
      return next
    })
    try {
      const result = await deleteTransactionAction(row.id)
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [row.id]: t(TRANSACTION_ERROR_KEYS[result.error]) }))
        return
      }
      setPendingDelete(null)
      router.refresh()
    } catch {
      console.error('TransactionList: delete failed')
      setErrors((prev) => ({ ...prev, [row.id]: t(GENERIC_ERROR_KEY) }))
    }
  }

  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        size="page"
        title={t('transactions.emptyTitle')}
        description={t('transactions.emptyBody')}
      />
    )
  }

  const groups = groupByDay(
    transactions,
    (row) => formatInTimeZone(row.date, timezone, 'yyyy-MM-dd'),
    today,
    yesterday,
  )

  return (
    <>
      {/* ONE bordered surface holding every row, with 1 px dividers — never a
          card per row (spec §2). The day header is sticky inside it so a long
          month stays readable while scrolling. */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {groups.map((group) => (
          <section key={group.day}>
            <h3 className="sticky top-0 z-10 border-b border-border bg-surface px-4 py-2 text-xs/[1rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
              {group.kind === 'today'
                ? t('transactions.dayToday')
                : group.kind === 'yesterday'
                  ? t('transactions.dayYesterday')
                  : formatDate(group.day, { locale, timeZone: timezone, style: 'weekday' })}
            </h3>
            <ul className="divide-y divide-border">
              {group.rows.map((row) => {
                const positive = isBalanceIncreasing(row.type)
                // Never render the raw rate — only a fallback-source hint.
                const cacheFallback = row.fxRateSource.startsWith('cache-fallback:')
                const rowName = row.category?.name ?? t(transactionTypeLabelKey(row.type))
                return (
                  <FinancialListRow
                    key={row.id}
                    title={rowName}
                    meta={
                      <>
                        <span className="tabular-nums">
                          {formatDate(row.date, { locale, timeZone: timezone, style: 'dateTime' })}
                        </span>
                        {' · '}
                        {row.account.name}
                        {cacheFallback && ` · ${t('transactions.rateFromCache')}`}
                      </>
                    }
                    note={row.note}
                    amount={
                      <MoneyText
                        // Display only — the sign is derived from `type`, never
                        // stored or computed arithmetically; `formatMoney`'s
                        // one `Number()` only feeds the formatter, and the
                        // string it parses already came out of `Decimal`
                        // arithmetic in the service.
                        value={formatMoney(row.amount, row.currency, locale)}
                        currency={row.currency}
                        sign={positive ? '+' : '−'}
                        // Spec §2: income is positive-toned, an ordinary
                        // expense is `foreground`. A page of red spending reads
                        // as a page of errors.
                        tone={positive ? 'positive' : 'default'}
                      />
                    }
                    actions={
                      <RowActionsMenu
                        label={t('common.rowActions', { name: rowName })}
                        actions={[
                          {
                            id: 'delete',
                            label: t('transactions.deleteAction'),
                            tone: 'negative',
                            onSelect: () => setPendingDelete(row),
                          },
                        ]}
                      />
                    }
                    className={errors[row.id] ? 'bg-negative/5' : undefined}
                  />
                )
              })}
            </ul>
          </section>
        ))}
      </div>

      {/* The row-level failures, below the card: an error inside a fixed-height
          row would either clip or move every figure beside it. */}
      {Object.entries(errors).map(([id, message]) => (
        <InlineAlert key={id} tone="negative" className="mt-2">
          {message}
        </InlineAlert>
      ))}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('transactions.deleteConfirmTitle')}
        description={t('transactions.deleteConfirmBody')}
        confirmLabel={t('transactions.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('transactions.deletePending')}
        onConfirm={() => (pendingDelete ? confirmDelete(pendingDelete) : undefined)}
      />
    </>
  )
}
```

- [ ] **Step 5: Write the type field, the two custom selects, and rewrite the create form in full**

`components/transactions/transaction-type-field.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { TransactionType } from '@prisma/client'
import { cn } from 'cn'

/**
 * The transaction type, as a segmented control with a disclosure for the four
 * rarer types (spec §6.2).
 *
 * Chi tiêu and Thu nhập are what a person records all day; the other four —
 * Tiền vào (khác), Tiền ra (khác), Điều chỉnh tăng, Điều chỉnh giảm — are
 * corrections and untracked movements, and putting all six in one row of a
 * mobile form gave the two common cases a sixth of the space each.
 *
 * A `radiogroup`, not a `<select>`, and not six independent buttons: the six
 * are mutually exclusive, so the radio role is the honest one and it brings
 * arrow-key navigation with it. `aria-checked` and the visible fill both carry
 * the state, so nothing depends on seeing colour.
 *
 * This is NOT `components/common/segmented-control.tsx`: that primitive is
 * link-based (the address bar owns which segment is showing, which is right for
 * a period filter and wrong for a form field).
 */
const PRIMARY_TYPES: TransactionType[] = ['EXPENSE', 'INCOME']
const OTHER_TYPES: TransactionType[] = [
  'CASH_IN',
  'CASH_OUT',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
]

export function TransactionTypeField({
  value,
  onChange,
  labels,
  legend,
  otherLabel,
  disabled,
}: {
  value: TransactionType
  onChange: (type: TransactionType) => void
  labels: Record<TransactionType, string>
  legend: string
  otherLabel: string
  disabled?: boolean
}) {
  // Open when an "other" type is already chosen, so an edit or a rejected
  // submit never hides the field that holds the current value.
  const [showOther, setShowOther] = useState(() => OTHER_TYPES.includes(value))

  return (
    <div className="flex flex-col gap-2">
      <p id="transaction-type-legend" className="text-[0.8125rem]/[1.125rem] font-medium">
        {legend}
      </p>
      <div role="radiogroup" aria-labelledby="transaction-type-legend" className="flex flex-col gap-2">
        <div className="flex gap-2">
          {PRIMARY_TYPES.map((type) => (
            <TypeButton
              key={type}
              type={type}
              label={labels[type]}
              checked={value === type}
              onSelect={onChange}
              disabled={disabled}
            />
          ))}
          <button
            type="button"
            aria-expanded={showOther}
            disabled={disabled}
            onClick={() => setShowOther((open) => !open)}
            className="flex min-h-11 items-center gap-1 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {otherLabel}
            {/* Flipped, not animated: the design system does not animate, so
                the chevron simply IS the other way up while the panel is open. */}
            <ChevronDown aria-hidden="true" className={cn('size-4', showOther && 'rotate-180')} />
          </button>
        </div>
        {showOther && (
          <div className="grid grid-cols-2 gap-2">
            {OTHER_TYPES.map((type) => (
              <TypeButton
                key={type}
                type={type}
                label={labels[type]}
                checked={value === type}
                onSelect={onChange}
                disabled={disabled}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TypeButton({
  type,
  label,
  checked,
  onSelect,
  disabled,
}: {
  type: TransactionType
  label: string
  checked: boolean
  onSelect: (type: TransactionType) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onSelect(type)}
      className={cn(
        // `min-h-11` is the 44 px touch target; `flex-1` so the two primary
        // types share the row evenly.
        'min-h-11 flex-1 rounded-md border px-3 text-sm',
        checked
          ? 'border-brand bg-brand/10 font-medium text-brand dark:bg-brand/18'
          : 'border-border text-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  )
}
```

`components/transactions/account-select.tsx`:

```tsx
'use client'

import { Select } from '@/components/ui/select'

/**
 * The account picker (spec §2: "a custom Select only where option richness or
 * hierarchy needs it — ... account picker with balance and currency").
 *
 * A native `<option>` can hold only text, and an account is three facts — name,
 * balance, currency — that the user is choosing *between*. Every other select
 * in this app stays native.
 *
 * Controlled, and that is unavoidable: a Base UI Select has no uncontrolled DOM
 * form value, so it is driven by react-hook-form's `Controller`. The caller
 * renders it only after `useHydrated()` (the form's fieldset is disabled until
 * then anyway) and shows the selected option's label as static text in the
 * server HTML, so the pre-hydration markup still says the right thing. This is
 * the one place Phase 7 introduces a controlled control, and it is because the
 * primitive has no other mode — NOT to silence a Base UI warning, which spec §9
 * forbids.
 */
export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  placeholder,
  optionLabel,
  ...aria
}: {
  id: string
  accounts: { id: string; name: string; currency: string; balance: string }[]
  value: string
  onChange: (accountId: string) => void
  placeholder: string
  /** `(account) => "Cash · 5.000.000 VND"`, already formatted and translated. */
  optionLabel: (account: { name: string; currency: string; balance: string }) => string
  'aria-describedby'?: string
  'aria-invalid'?: true
}) {
  return (
    <Select
      id={id}
      value={value}
      onValueChange={onChange}
      placeholder={placeholder}
      items={accounts.map((account) => ({ value: account.id, label: optionLabel(account) }))}
      {...aria}
    />
  )
}
```

Read `components/ui/select.tsx` (added in Task 1a Step 6) first and match its real API — the props above (`items`, `value`, `onValueChange`, `placeholder`) are the shape base-nova's Select typically exposes, but the generated file is the authority. Adapt this wrapper's body to it and keep the wrapper's own signature exactly as declared in **Interfaces** above, so the form's call site does not depend on the shadcn shape.

`components/transactions/category-select.tsx`:

```tsx
'use client'

import { Select } from '@base-ui/react/select'
import { ChevronDown } from 'lucide-react'

/**
 * The category picker (spec §2: "a custom Select only where option richness or
 * hierarchy needs it — category picker with two groups").
 *
 * A native `<optgroup>` can hold a heading, but it cannot be styled to the
 * design system and its heading is announced inconsistently across platforms;
 * more to the point, the two groups here are the *whole* information — an
 * expense category and an income category of the same name mean different
 * things — so the hierarchy is the reason this one is custom.
 *
 * Controlled, and unavoidably so: a Base UI Select has no uncontrolled DOM form
 * value, so it is driven by react-hook-form's `Controller`. The caller renders
 * it only after `useHydrated()` (the form's fieldset is disabled until then
 * anyway) and renders a `disabled` native `<select>` holding the selected
 * option in the server HTML, so the first paint says the right thing, is
 * labelable, and looks like the other inputs. This is the one place Phase 7
 * introduces a controlled control, and it is because the primitive has no other
 * mode — NOT to silence a Base UI warning, which spec §9 forbids.
 *
 * `undefined`, never `''`, for "nothing chosen": that is what lets
 * `createTransactionFormSchema`'s friendly "Category is required for income and
 * expense transactions" refine message fire instead of the generic "at least 1
 * character" a stray `''` would trigger. The caller's `onChange` normalises,
 * and this component passes `''` to the primitive only as its own placeholder
 * value because a Base UI Select's `value` may not be `undefined`.
 */
const NONE = ''

export function CategorySelect({
  id,
  groups,
  value,
  onChange,
  placeholder,
  ...aria
}: {
  id: string
  /** One entry per group; `label` is already translated by the caller. */
  groups: { labelKey: string; label: string; items: { id: string; name: string }[] }[]
  value: string | undefined
  onChange: (categoryId: string | undefined) => void
  placeholder: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}) {
  return (
    <Select.Root
      value={value ?? NONE}
      onValueChange={(next: string) => onChange(next === NONE ? undefined : next)}
    >
      <Select.Trigger
        id={id}
        aria-describedby={aria['aria-describedby']}
        aria-invalid={aria['aria-invalid']}
        className="flex h-11 w-full items-center justify-between rounded-md border border-input bg-[var(--input-bg)] px-3 py-2 text-base md:h-10 md:text-sm"
      >
        <Select.Value placeholder={placeholder} />
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-50">
          <Select.Popup className="max-h-72 min-w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-border bg-surface-2 p-1 shadow-[0_8px_24px_rgba(25,33,30,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]">
            {groups.map((group) => (
              <Select.Group key={group.labelKey}>
                {/* The group heading is the point of this component. `px-2 pt-2`
                    rather than a divider: two headings and a rule between them
                    is more furniture than a twelve-item list needs. */}
                <Select.GroupLabel className="px-2 pt-2 pb-1 text-xs/[1rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                  {group.label}
                </Select.GroupLabel>
                {group.items.map((item) => (
                  <Select.Item
                    key={item.id}
                    value={item.id}
                    className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-selected:font-medium data-selected:text-brand"
                  >
                    <Select.ItemText>{item.name}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Group>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
```

Read `components/ui/select.tsx` (added in Task 1a) **before** writing either wrapper: if it already composes these Base UI parts with CashFlow classes, import its exports and keep only the grouping and the `undefined` normalisation here. The part names above (`Select.Root`, `.Trigger`, `.Value`, `.Portal`, `.Positioner`, `.Popup`, `.Group`, `.GroupLabel`, `.Item`, `.ItemText`) are Base UI 1.8's; confirm them against `node_modules/@base-ui/react/select` and adjust if the installed version differs — the wrapper's own signature, declared in **Interfaces**, must not change either way.

`components/transactions/transaction-form.tsx` — the full rewrite:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { Wallet } from 'lucide-react'
import type { Currency, TransactionType } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { nowInZone } from '@/lib/datetime/local-date-time'
import { createTransactionAction } from '@/lib/server/actions/transaction-actions'
import { GENERIC_ERROR_KEY, TRANSACTION_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatMoney } from '@/lib/ui/format-money'
import { transactionTypeLabelKey } from '@/lib/ui/labels'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import {
  createTransactionFormSchema,
  type CreateTransactionFormInput,
  type CreateTransactionInput,
} from '@/lib/validation/transaction'
import { EmptyState } from '@/components/common/empty-state'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccountSelect } from './account-select'
import { CategorySelect } from './category-select'
import { TransactionTypeField } from './transaction-type-field'

/**
 * The form validates and submits `createTransactionFormSchema`, whose `date` is
 * the raw `yyyy-MM-ddTHH:mm` string the `<input type="datetime-local">`
 * produced — input and output types are the same here, so no `Date` ever exists
 * client-side.
 *
 * That is deliberate: a local date and time only becomes an instant once a
 * timezone is chosen, and the browser's zone is not necessarily the user's
 * configured zone. `createTransactionAction` does the conversion in the session
 * user's IANA zone; see `lib/datetime/local-date-time.ts`.
 */
/**
 * The form's own shape: `createTransactionFormSchema`'s fields, but with `date`
 * split into the two native inputs spec §6.2 asks for.
 *
 * `date` itself is never a form field — it is derived at validation and at
 * submit by `mergeDateTime`, so the schema still sees exactly the
 * `yyyy-MM-ddTHH:mm` string it validates today and `lib/validation` does not
 * change.
 */
type FormInput = Omit<CreateTransactionFormInput, 'date'> & {
  /** `yyyy-MM-dd` from `<input type="date">`. */
  datePart: string
  /** `HH:mm` from `<input type="time">`. */
  timePart: string
}
type FormType = CreateTransactionInput['type']

/** The one string the schema and the action take, from the two the user sees. */
function mergeDateTime(values: FormInput): CreateTransactionFormInput {
  const { datePart, timePart, ...rest } = values
  return { ...rest, date: `${datePart}T${timePart}` }
}

/**
 * `zodResolver` over the MERGED values, with a `date` error re-pointed at the
 * field the user can actually see.
 *
 * The schema owns `date`; no control does. So a schema error keyed `date`
 * would land on nothing and the user would be told nothing — hence the remap
 * onto `datePart`, which is the field a bad date comes from (a time cannot be
 * out of range: `<input type="time">` will not emit one).
 */
const resolver: Resolver<FormInput> = async (values, context, options) => {
  const merged = mergeDateTime(values as FormInput)
  const result = await zodResolver(createTransactionFormSchema)(
    merged as never,
    context,
    options as never,
  )
  const errors = result.errors as Record<string, unknown>
  if (errors.date) {
    errors.datePart = errors.date
    delete errors.date
  }
  return { values: (result.values ? values : {}) as FormInput, errors } as never
}

export type AccountOption = { id: string; name: string; currency: Currency; balance: string }
export type CategoryOption = { id: string; name: string; type: 'INCOME' | 'EXPENSE' }

/**
 * The two types that hit the P&L and therefore need a matching category
 * (mirrors `CATEGORY_REQUIRED_TYPES` in `lib/validation/transaction.ts`).
 *
 * This decides only whether the Category picker is RENDERED. Clearing the
 * chosen category is deliberately not conditioned on it: the type's own change
 * handler clears on every change, so INCOME→EXPENSE — both category-requiring,
 * so this set never changes across it — cannot leave an INCOME category
 * attached to an EXPENSE transaction.
 */
const CATEGORY_REQUIRED_TYPES = new Set<FormType>(['INCOME', 'EXPENSE'])

const DEFAULT_TYPE: FormType = 'EXPENSE'

function defaultValues(accounts: AccountOption[], timezone: string): FormInput {
  // `nowInZone` returns exactly `yyyy-MM-ddTHH:mm`, so the split is the 'T' —
  // no second clock read, and therefore no chance of the date and the time
  // coming from two different instants either side of midnight.
  const [datePart, timePart] = nowInZone(timezone).split('T')
  return {
    accountId: accounts[0]?.id ?? '',
    categoryId: undefined,
    type: DEFAULT_TYPE,
    datePart,
    timePart,
    amount: 0,
    note: undefined,
  }
}

export function TransactionForm({
  accounts,
  categories,
  timezone,
  locale,
  onCreated,
}: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page) — the pre-filled date and time must be *their* now, not
   * whatever the clock reads in UTC when they open the form.
   */
  timezone: string
  locale: Locale
  /** The sheet closes itself on success; the sticky panel passes nothing. */
  onCreated?: () => void
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  /** Spec §9: the same fieldset is locked while a mutation is in flight. */
  const submit = useSubmitState()
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<FormInput>({
    resolver,
    defaultValues: defaultValues(accounts, timezone),
  })

  const type = useWatch({ control, name: 'type' })
  const accountId = useWatch({ control, name: 'accountId' })
  const needsCategory = CATEGORY_REQUIRED_TYPES.has(type)
  const selectedAccount = accounts.find((account) => account.id === accountId)

  /**
   * The form's own default, which the pre-hydration `<select>` stand-in renders
   * as its single option. Read from `defaultValues(...)` rather than written as
   * `accounts[0]?.id` a second time, so the stand-in and the form state cannot
   * disagree the first time that default changes.
   */
  const defaultAccountId = defaultValues(accounts, timezone).accountId

  /** "Cash · 5.000.000 VND" — one place, used by the Select and its stand-in. */
  function accountOptionLabel(account: AccountOption | undefined): string {
    if (!account) return ''
    return t('transactions.accountOption', {
      name: account.name,
      balance: formatMoney(account.balance, account.currency, locale),
      currency: account.currency,
    })
  }

  const typeLabels = Object.fromEntries(
    (
      ['INCOME', 'EXPENSE', 'CASH_IN', 'CASH_OUT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE'] as const
    ).map((value) => [value, t(transactionTypeLabelKey(value))]),
  ) as Record<TransactionType, string>

  /** Two groups, so the picker shows hierarchy rather than one flat list. */
  const categoryGroups = [
    {
      labelKey: 'transactions.categoryGroupExpense',
      label: t('transactions.categoryGroupExpense'),
      items: categories.filter((category) => category.type === 'EXPENSE'),
    },
    {
      labelKey: 'transactions.categoryGroupIncome',
      label: t('transactions.categoryGroupIncome'),
      items: categories.filter((category) => category.type === 'INCOME'),
    },
    // Only the group matching the chosen type is offered — the schema refuses
    // the other one anyway, and offering it would be a trap.
  ].filter((group) =>
    type === 'EXPENSE'
      ? group.labelKey === 'transactions.categoryGroupExpense'
      : group.labelKey === 'transactions.categoryGroupIncome',
  )

  async function onSubmit(values: FormInput) {
    setError(null)
    await submit.run(async () => {
      try {
        // The action takes the schema's shape, so the two parts merge here —
        // the same function the resolver used, so what was validated is what is
        // sent.
        const result = await createTransactionAction(mergeDateTime(values))
        if (!result.ok) {
          setError(t(TRANSACTION_ERROR_KEYS[result.error]))
          return
        }
        reset(defaultValues(accounts, timezone))
        router.refresh()
        onCreated?.()
      } catch {
        console.error('TransactionForm: create failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  /**
   * With no account there is nothing to add a transaction TO, so the form is
   * replaced rather than shown half-usable: an Account picker with no options
   * looks operable, and submitting it only produced a validation error under a
   * field the user could never fill.
   *
   * This lives in the component, not only in the page, on purpose. Any caller
   * that hands over an empty `accounts` list must get a usable screen — the
   * page cannot be the only place that knows this, or the next caller
   * reintroduces the empty selector. The page's job stays what it already is:
   * passing `listActiveFinancialAccounts`, so an archived account never counts
   * as one the user could pick.
   *
   * Placed after every hook above, deliberately: an early return before them
   * would call a different number of hooks depending on the prop.
   */
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        size="page"
        title={t('transactions.noAccountTitle')}
        description={t('transactions.noAccountBody')}
        action={{ label: t('transactions.noAccountAction'), href: '/accounts' }}
      />
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* TWO independent reasons to disable, on one native mechanism:
          `!hydrated` is the pre-hydration gate (`lib/ui/use-hydrated.ts`
          documents the react-hook-form/React interaction that made early input
          vanish, and why the gate can never lift before RHF's refs attach), and
          `submit.locked` is the in-flight lock spec §9 requires. A
          `<fieldset disabled>` is the one native mechanism that disables
          EVERYTHING inside it, submit button included, so a second submit is
          impossible while the first is running — with no per-control `disabled`
          prop and no controlled state. `min-w-0` neutralises a fieldset's
          default `min-inline-size: min-content`; Tailwind's preflight already
          zeroes its margin/padding/border, so nothing shifts when the gate
          lifts. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={submit.busy}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">{t('transactions.createTitle')}</legend>

        {/* `Controller`, not `register`, because `TransactionTypeField` is a
            button group with no form value of its own. The `onChange` clears
            the category on EVERY type change — INCOME→EXPENSE included, which
            a `needsCategory`-watching effect missed, leaving an INCOME category
            in form state under an EXPENSE transaction until the server rejected
            it. `undefined` (not `''`) is what lets the schema's friendly refine
            message fire. */}
        <Controller
          control={control}
          name="type"
          render={({ field }) => (
            <TransactionTypeField
              value={field.value}
              onChange={(next) => {
                field.onChange(next)
                setValue('categoryId', undefined)
              }}
              labels={typeLabels}
              legend={t('transactions.typeLegend')}
              otherLabel={t('transactions.typeOther')}
            />
          )}
        />
        {errors.type && (
          <p role="alert" className="text-xs/[1rem] text-negative">
            {errors.type.message}
          </p>
        )}

        {/* Amount FIRST after the type and dominant (spec §6.2: "Amount
            dominant (28/600 tabular input with the account's currency code
            inside the field)"). The code is a suffix inside the field, not a
            separate span, so the figure and its unit read as one value. */}
        <FormField id="transaction-amount" label={t('transactions.amount')} error={errors.amount?.message}>
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="h-14 pr-16 text-[1.75rem]/[2.125rem] font-semibold tabular-nums md:h-14 md:text-[1.75rem]"
                {...register('amount', { valueAsNumber: true })}
              />
              {/* Read-only: currency always follows the selected account, so
                  the client never sends it — display only. */}
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-muted-foreground">
                {selectedAccount?.currency ?? ''}
              </span>
            </div>
          )}
        </FormField>

        <FormField id="transaction-account" label={t('transactions.account')} error={errors.accountId?.message}>
          {(aria) =>
            hydrated ? (
              <Controller
                control={control}
                name="accountId"
                render={({ field }) => (
                  <AccountSelect
                    id={aria.id}
                    accounts={accounts}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={t('transactions.accountPlaceholder')}
                    optionLabel={(account) =>
                      accountOptionLabel(account as AccountOption)
                    }
                    aria-describedby={aria['aria-describedby']}
                    aria-invalid={aria['aria-invalid']}
                  />
                )}
              />
            ) : (
              // The pre-hydration stand-in: a DISABLED native `<select>` holding
              // the one option the form state actually has.
              //
              // A `<div>` was tried and is wrong three ways: a `<label
              // htmlFor>` may not point at one (so the field would be
              // unlabelled in the first paint, which is exactly what this phase
              // is fixing), it does not inherit the `<fieldset disabled>`
              // styling the rest of the form has, and it is a different shape
              // from every other control on the page. A disabled `<select>` is
              // labelable, is styled by `SELECT_CLASS` like its neighbours,
              // announces its value, and cannot be operated — which is the
              // whole point of the gate.
              //
              // Its option comes from the FORM's default (`defaultAccountId`),
              // not from `accounts[0]`: the two agree today, and hard-coding
              // the first account is how they would silently disagree the first
              // time a default changes.
              <select id={aria.id} disabled defaultValue={defaultAccountId} className={SELECT_CLASS}>
                <option value={defaultAccountId}>
                  {accountOptionLabel(
                    accounts.find((account) => account.id === defaultAccountId) ?? accounts[0],
                  )}
                </option>
              </select>
            )
          }
        </FormField>

        {needsCategory && (
          <FormField
            id="transaction-category"
            label={t('transactions.category')}
            error={errors.categoryId?.message}
          >
            {(aria) =>
              hydrated ? (
                <Controller
                  control={control}
                  name="categoryId"
                  render={({ field }) => (
                    <CategorySelect
                      id={aria.id}
                      groups={categoryGroups}
                      value={field.value}
                      // An emptied picker yields `undefined`, not `''`, which
                      // is what lets the schema's friendly "Category is
                      // required for income and expense transactions" refine
                      // message fire instead of the generic "at least 1
                      // character" a stray `''` would trigger.
                      onChange={(next) => field.onChange(next === '' ? undefined : next)}
                      placeholder={t('transactions.categoryPlaceholder')}
                      aria-describedby={aria['aria-describedby']}
                      aria-invalid={aria['aria-invalid']}
                    />
                  )}
                />
              ) : (
                // Same stand-in, same reasoning as the account field above. The
                // category has no default (`categoryId` starts `undefined`), so
                // the single option is the placeholder — and `value=""` keeps
                // it consistent with the hydrated Select's own placeholder
                // value.
                <select id={aria.id} disabled defaultValue="" className={SELECT_CLASS}>
                  <option value="">{t('transactions.categoryPlaceholder')}</option>
                </select>
              )
            }
          </FormField>
        )}

        {/* Two native inputs, not one `datetime-local` (spec §6.2: "Date and
            Time (native inputs, separate, defaulting to now in the user's
            timezone)").

            Separate because they are separate decisions: a user back-dating
            yesterday's lunch changes the day and leaves the time alone, and a
            single `datetime-local` makes them tab through the clock to do it.
            Its browser chrome is still not restyled and its visual format is
            still not claimed — only the two LABELS are localised.

            The pair recombines into the one `yyyy-MM-ddTHH:mm` string
            `createTransactionFormSchema` validates; see `mergeDateTime` and the
            resolver wrapper above. */}
        <div className="grid grid-cols-2 gap-3">
          <FormField
            id="transaction-date"
            label={t('transactions.date')}
            error={errors.datePart?.message}
          >
            {(aria) => <Input {...aria} type="date" {...register('datePart')} />}
          </FormField>
          <FormField
            id="transaction-time"
            label={t('transactions.time')}
            error={errors.timePart?.message}
          >
            {(aria) => <Input {...aria} type="time" {...register('timePart')} />}
          </FormField>
        </div>

        <FormField
          id="transaction-note"
          label={t('transactions.note')}
          helper={t('transactions.noteHelper')}
          error={errors.note?.message}
        >
          {(aria) => <Input {...aria} {...register('note')} />}
        </FormField>

        {/* One primary per view region, never full width at ≥ 768 (spec §2). */}
        <Button type="submit" className="self-start">
          {submit.pending ? t('transactions.createPending') : t('transactions.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
```

- [ ] **Step 6: Write `TransactionCreatePanel` — the sticky desktop panel and the mobile sheet in one component**

`components/transactions/transaction-create-panel.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'
import {
  TransactionForm,
  type AccountOption,
  type CategoryOption,
} from './transaction-form'

/**
 * The create form's two homes (spec §6.2, §14 decision 2).
 *
 * At ≥ 1280 (Tailwind `xl`) it is ALWAYS VISIBLE in a sticky 5/12 column, because recording a
 * transaction is the highest-frequency thing anyone does in this app and a
 * sheet would put a click in front of every single one. Below that — and on
 * every phone — it is a bottom sheet, opened by the header's primary button or
 * by the bottom bar's `+`.
 *
 * The `+` navigates to `/transactions#new` (the shell's `ADD_TRANSACTION_HREF`,
 * unchanged since Phase 4), so this component opens the sheet when the hash is
 * `#new` on mount and clears it afterwards — the alternative was making the
 * shell aware of a page's internal state.
 *
 * TWO mounted copies of `TransactionForm` would be two react-hook-form
 * instances fighting over one submit, so only one renders at a time: the
 * `xl:flex` panel and the sheet are mutually exclusive by breakpoint, and the
 * sheet's copy mounts on open (spec §9: "Edit/instalment/payment forms open in
 * Dialog or Sheet and mount on open — no SSR defaults problem").
 */
export function TransactionCreatePanel({
  accounts,
  categories,
  timezone,
  locale,
}: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  timezone: string
  locale: Locale
}) {
  const t = useTranslations()
  const pathname = usePathname()
  const [sheetOpen, setSheetOpen] = useState(false)

  // `#new` arriving from the shell's Add-transaction action. Read once per
  // navigation: `window.location.hash` is not reactive, and `pathname` changing
  // is the only thing that can bring a new hash to this page.
  useEffect(() => {
    if (window.location.hash === '#new') {
      setSheetOpen(true)
      // Clear it so a later reload does not reopen the sheet the user closed.
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [pathname])

  return (
    <>
      {/* Mobile/tablet: the trigger. `xl:hidden` so the desktop panel below is
          the only copy at ≥ 1280. */}
      <Button type="button" className="xl:hidden" onClick={() => setSheetOpen(true)}>
        {t('transactions.openCreate')}
      </Button>

      <Sheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={t('transactions.createTitle')}
        closeLabel={t('common.close')}
      >
        <TransactionForm
          accounts={accounts}
          categories={categories}
          timezone={timezone}
          locale={locale}
          onCreated={() => setSheetOpen(false)}
        />
      </Sheet>

      {/* Desktop: the always-visible sticky panel. `id="new"` keeps the shell's
          `/transactions#new` anchor working for a user who lands on it at a
          desktop width, where there is no sheet to open. */}
      <aside
        id="new"
        className="sticky top-6 hidden h-fit scroll-mt-6 flex-col gap-4 rounded-lg border border-border bg-surface p-4 xl:flex"
      >
        <h2 className="text-[1.125rem]/[1.625rem] font-semibold">{t('transactions.createTitle')}</h2>
        <TransactionForm
          accounts={accounts}
          categories={categories}
          timezone={timezone}
          locale={locale}
        />
      </aside>
    </>
  )
}
```

**Careful — the `id="new"` collision:** the shell's `#new` anchor and the sheet's hash trigger both use it. At `< lg` the `<aside>` is `hidden`, so the anchor cannot scroll to it and the effect above opens the sheet instead; at `≥ xl` the effect *also* opens the sheet. Gate the effect on the breakpoint with a `matchMedia('(min-width: 1280px)')` check and only open the sheet when it does not match. Write that check inside the effect and comment it.

- [ ] **Step 7: Rewrite `app/(app)/transactions/page.tsx`**

```tsx
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { getActivitySummary } from '@/lib/server/services/activity'
import { getCurrentAccountBalances } from '@/lib/server/services/balance'
import { listCategories } from '@/lib/server/services/category'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listTransactions } from '@/lib/server/services/transaction'
import { resolveLocale } from '@/lib/i18n/config'
import { formatMoney } from '@/lib/ui/format-money'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/common/page-header'
import { TransactionCreatePanel } from '@/components/transactions/transaction-create-panel'
import { TransactionList } from '@/components/transactions/transaction-list'

/** Yesterday, as a calendar date in the user's zone — for the day headers. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

export default async function TransactionsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const { baseCurrency: displayCurrency, timezone } = resolveProfileDefaults(user)
  const locale = await resolveLocale()
  const t = await getTranslations()
  // ONE `now` for the whole request, so the month total, the day headers and
  // the form's pre-filled "now" cannot straddle midnight.
  const now = new Date()
  const today = todayCalendarDateInZone(timezone, now)
  const yesterday = todayCalendarDateInZone(timezone, new Date(now.getTime() - MS_PER_DAY))

  const [transactions, accounts, expenseCategories, incomeCategories, monthly] = await Promise.all([
    listTransactions(user.id),
    listActiveFinancialAccounts(user.id),
    listCategories(user.id, 'EXPENSE'),
    listCategories(user.id, 'INCOME'),
    // The header's month total. The same call the dashboard makes for the same
    // window — historical, restated at each row's own snapshot, so it consults
    // no current rate and an FX outage cannot reach it.
    getActivitySummary(user.id, displayCurrency, getPeriodBounds(timezone, 'month', now)),
  ])

  // The account picker shows each account's balance (spec §2), so it needs one
  // batched read — never one query per account.
  const balances = await getCurrentAccountBalances(
    user.id,
    accounts.map((account) => account.id),
    now,
  )

  const accountOptions = accounts.map((account) => {
    const balance = balances.get(account.id)
    if (!balance) throw new Error(`Missing balance for account ${account.id}`)
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      // A `Prisma.Decimal` cannot cross the server-to-client-component
      // boundary, so the balance crosses as a fixed-2-decimal string and is
      // formatted for display only — no arithmetic happens on the client.
      balance: balance.toFixed(2),
    }
  })

  return (
    // max-w 1200 because the two-column desktop layout needs it; the list below
    // is capped at 960 when the form is not beside it.
    <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('transactions.title')}
        description={t('transactions.monthTotal', {
          amount: formatMoney(monthly.expense, displayCurrency, locale),
          currency: displayCurrency,
        })}
      />

      {/* 7/12 + 5/12 at ≥ 1024 (spec §6.2). Below that the panel component
          renders only its trigger and its sheet, so the list gets the row. */}
      <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <TransactionList
            transactions={transactions.map((tx) => ({
              id: tx.id,
              type: tx.type,
              // A `Prisma.Decimal` cannot cross the server-to-client-component
              // boundary, so the amount crosses as a fixed-2-decimal string and
              // is formatted for display only — no arithmetic on the client.
              amount: tx.amount.toFixed(2),
              currency: tx.currency,
              date: tx.date,
              note: tx.note,
              fxRateSource: tx.fxRateSource,
              account: { name: tx.account.name },
              category: tx.category ? { name: tx.category.name } : null,
            }))}
            timezone={timezone}
            locale={locale}
            today={today}
            yesterday={yesterday}
          />
        </div>
        <div className="flex flex-col xl:col-span-5">
          {/* `listActiveFinancialAccounts` above is what keeps archived accounts
              out of the picker; `TransactionForm` itself owns the
              no-account-yet notice, so a user with none never meets an empty
              selector no matter which caller renders the form. */}
          <TransactionCreatePanel
            accounts={accountOptions}
            categories={[...expenseCategories, ...incomeCategories].map((category) => ({
              id: category.id,
              name: category.name,
              type: category.type,
            }))}
            timezone={timezone}
            locale={locale}
          />
        </div>
      </div>
    </div>
  )
}
```

**Check `listCategories`'s return shape** before writing `category.type` — read `lib/server/services/category.ts`. If the rows do not carry `type`, tag them at the call site instead (`expenseCategories.map((c) => ({ …c, type: 'EXPENSE' as const }))`), which is what the current page's `[...expenseCategories, ...incomeCategories]` relies on the form to infer.

- [ ] **Step 8: Migrate every existing e2e selector this task's changes break**

Every committed state in this repo must build and pass Vitest **and** Playwright (`AGENTS.md`: "run `npm run format:check`, `npm run lint`, `npm run test`, `npm run build` before every commit", and the phase-checkpoint workflow's green-incremental-commits rule). So the specs move in the same task as the UI that moves them.

The enumeration below comes from grepping `e2e/` for everything this task changes — the type control, the two custom selects, the amount field's accessible name, the `datetime-local` field, the list row's structure, the day-group headers, the create panel's heading, the delete confirmation, the empty state and the no-account notice:

```bash
grep -rn "Transaction type\|'Amount'\|Add transaction\|getByLabel('Account'\|getByLabel('Category'\|No transactions yet\|Go to Accounts\|You need an account\|Enter an amount\|Food & Dining · Cash\|Delete this transaction" e2e/
```

Work through it file by file. Nothing else in `e2e/` is touched — in particular `/transfers`, `/accounts`, `/categories`, `/budgets`, `/goals`, `/debts`, `/loans` and `/reminders` selectors are **not** this task's, and their specs must still pass unchanged.

**`e2e/helpers.ts` — `createTransactionViaUi` (`:71-96`).** Every later spec seeds through it, so this is the one that matters most:

```ts
export async function createTransactionViaUi(
  page: Page,
  opts: {
    type: 'INCOME' | 'EXPENSE'
    accountName: string
    categoryName: string
    amount: number
    /** Optional; typed into the Note field when given. */
    note?: string
  },
): Promise<void> {
  await page.goto('/transactions')
  // The type is a radiogroup of buttons now (spec §6.2), not a <select>: click
  // the radio whose accessible name is the type's product label. The vi/en
  // alternation keeps this helper working in either locale.
  const typeLabel = opts.type === 'INCOME' ? /Thu nhập|^Income$/ : /Chi tiêu|^Expense$/
  await page.getByRole('radio', { name: typeLabel }).click()

  // The account and category pickers are custom Selects (base-ui comboboxes):
  // open, then pick the option by name. `getByRole('combobox', { name })` finds
  // them by their visible <label>, which every field now has — and because the
  // hydrated combobox only mounts after `useHydrated()` flips, clicking it also
  // waits for the gate to lift.
  await page.getByRole('combobox', { name: /Tài khoản|^Account$/ }).click()
  await page.getByRole('option', { name: new RegExp(opts.accountName) }).click()

  await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
  await page.getByRole('option', { name: opts.categoryName, exact: true }).click()

  const amountInput = page.getByLabel(/Số tiền|^Amount$/)
  await amountInput.fill(String(opts.amount))
  if (opts.note) await page.getByLabel(/Ghi chú|^Note/).fill(opts.note)

  // Both date fields stay at their pre-filled "now" — the seed needs "today",
  // not a specific instant, so the split into Ngày and Giờ costs this helper
  // nothing.
  await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
  // A successful submit resets the form to its defaults, which sets the amount
  // field back to `0`.
  await expect(amountInput).toHaveValue('0')
}
```
Keep the helper's existing doc comment about leaving the date at its pre-filled "now" (now two fields, both defaulted) and about **plain `fill`/`click` with no verify-and-retry wrapper** — the reasoning (Playwright's actionability check treats a control in a `<fieldset disabled>` as disabled, so every action already waits for the earliest moment the app accepts input) is still exactly true and is why this suite has no retry helper. Add the sentence about the comboboxes mounting after hydration.

**`e2e/transaction-form-hydration.spec.ts` — the reversion guard.** Read all 318 lines first; every original test must survive with its *meaning* intact.

- `:111-115` — `categoryNames(page, listTitle)` reads the **`/categories`** page's lists, not this form's. It is untouched here; Task 6 owns it. Confirm by reading the call sites before assuming.
- `:194` — `selectedOptionLabel(selectMarkup(transactions, 'Transaction type'))` expected `'Expense'`. The type is no longer a `<select>`, so this becomes a raw-HTML assertion on the checked radio:
  ```ts
  // The Type the client is about to own is the Type the server showed. The
  // control is a radiogroup now, so the marker is `aria-checked`, not
  // `selected` — same guarantee, different element.
  const typeGroup = transactions.slice(
    transactions.indexOf('role="radiogroup"'),
    transactions.indexOf('</div>', transactions.indexOf('role="radiogroup"')),
  )
  expect(typeGroup).toMatch(/aria-checked="true"[^>]*>(Chi tiêu|Expense)/)
  expect(typeGroup).not.toMatch(/aria-checked="true"[^>]*>(Thu nhập|Income)/)
  ```
- `:196` — `selectedOptionLabel(selectMarkup(transactions, 'Category'))` expected `'Select a category'`. This one **still works structurally**: the pre-hydration stand-in is a `<select disabled>` carrying exactly one option, the placeholder (Step 5). Change only the expected string to `/Chọn danh mục|Select a category/`, and add an assertion that the stand-in is disabled — which is the gate, in the bytes the browser paints first:
  ```ts
  expect(selectMarkup(transactions, 'Category')).toContain('disabled')
  ```
- `:198` — "Uncontrolled — a `value=` prop would make it controlled" applied to the type `<select>`. Re-point it at the two stand-in selects, which are the only `<select>`s in the form's first paint, and add the same claim for the radiogroup:
  ```ts
  expect(selectMarkup(transactions, 'Account')).not.toMatch(/<select[^>]*\svalue=/)
  expect(selectMarkup(transactions, 'Category')).not.toMatch(/<select[^>]*\svalue=/)
  ```
- **Add** to the same raw-HTML block: the account stand-in shows the form's own default (not `accounts[0]` by accident), and both date parts are pre-filled:
  ```ts
  expect(selectMarkup(transactions, 'Account')).toContain('Cash')
  expect(transactions).toMatch(/id="transaction-date"[^>]*value="\d{4}-\d{2}-\d{2}"/)
  expect(transactions).toMatch(/id="transaction-time"[^>]*value="\d{2}:\d{2}"/)
  ```
- `:238`, `:271`, `:311` — `const type = page.getByLabel('Transaction type')` followed by `selectOption(...)`. Each becomes a radio click, and the **pre-hydration interaction must keep whatever mechanism the file already uses** (it interacts before `load`; read it and preserve that shape exactly). A `role="radio"` button inside a `<fieldset disabled>` is not clickable, which is the *same* protection the disabled `<select>` gave — so "early input is never silently reverted" still holds by the same mechanism:
  ```ts
  const incomeRadio = page.getByRole('radio', { name: /Thu nhập|^Income$/ })
  await incomeRadio.click()
  await expect(incomeRadio).toHaveAttribute('aria-checked', 'true')
  ```
- `:260` — `page.getByLabel('Category', { exact: true }).locator('option')` read the option list off the DOM. A hydrated Base UI Select renders its list in a portal, only while open, so read it by opening the combobox:
  ```ts
  const category = page.getByRole('combobox', { name: /Danh mục|^Category$/ })
  await category.click()
  const options = await page.getByRole('option').allTextContents()
  await page.keyboard.press('Escape')
  ```
  Then keep the existing exact-list comparison against `expenseNames` / `incomeNames` — that assertion is the point of the test (a wrongly-filtered list would still satisfy a "contains" check) and it survives unchanged.
- `:272`, `:314` — `const category = page.getByLabel('Category', { exact: true })` and `toHaveCount(0)` for a non-categorised type. The hydrated control is a combobox, so:
  ```ts
  await expect(page.getByRole('combobox', { name: /Danh mục|^Category$/ })).toHaveCount(0)
  ```
- `:301-302` — `getByLabel('Amount', { exact: true })` → `getByLabel(/Số tiền|^Amount$/)`; the button → `/Thêm giao dịch|Add transaction/`.
- `:303` — `CATEGORY_REQUIRED_MESSAGE` is the Zod literal, and from Task 2c it reaches the DOM **translated** (this task is the first to put the transaction form behind `FormField`/`FieldError`). Match it with a vi/en alternation built from the two message files, using the `errorText` helper — and **add `errorText` to `e2e/helpers.ts` in this task** rather than waiting for Task 13, because this is the first spec that needs it:
  ```ts
  import viValidation from '@/messages/vi/validation.json'
  import enValidation from '@/messages/en/validation.json'

  /**
   * A vi/en alternation for one message, so a spec asserts that the right
   * message surfaced without pinning which locale is rendering. The message
   * TEXT is not what these tests are about.
   */
  export function eitherLocale(vi: string, en: string): RegExp {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`${escape(vi)}|${escape(en)}`)
  }
  ```
  and at the call site: `await expect(page.getByText(eitherLocale(viValidation[CATEGORY_REQUIRED_MESSAGE], CATEGORY_REQUIRED_MESSAGE))).toBeVisible()`. Read `validation.json`'s escaping rule (`validationMessageKey`, Task 2c) before indexing it — a literal containing a dot is keyed with `\u2024`.
- **Add three tests** to this file, which is where they belong:
  1. *the raw server HTML still carries the gate* — `page.request.get('/transactions')`, assert the body contains `<fieldset disabled` and `aria-busy="true"` (already covered by the block above; extend it rather than duplicating);
  2. *the in-flight lock prevents a second submission* (spec §9):
     ```ts
     test('a second submit is impossible while the first is in flight', async ({ page }) => {
       await page.goto('/transactions')
       await page.getByRole('radio', { name: /Chi tiêu|^Expense$/ }).click()
       await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
       await page.getByRole('option').first().click()
       await page.getByLabel(/Số tiền|^Amount$/).fill('12345')

       // Hold the server action so the lock is observable. The delay lives in
       // the ROUTE handler — a server-side pause — not in a `waitForTimeout`.
       await page.route('**/transactions', async (route) => {
         if (route.request().method() !== 'POST') return route.fallback()
         await new Promise((resolve) => setTimeout(resolve, 1500))
         await route.fallback()
       })

       const submit = page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ })
       await submit.click()
       // `.first()`: one fieldset today, but a width where both the sticky
       // panel and the sheet were mounted would match two, and a strict
       // locator throws rather than picking one.
       await expect(page.locator('form fieldset').first()).toHaveAttribute('aria-busy', 'true')
       await expect(submit).toBeDisabled()
       await page.unroute('**/transactions')
       await expect(page.getByLabel(/Số tiền|^Amount$/)).toHaveValue('0')
       // Exactly one row for that amount — a double submit would make two.
       await expect(page.getByText('12.345')).toHaveCount(1)
     })
     ```
     A Next server action posts to the page's own URL, so that route pattern is right; verify it once by logging the intercepted request's method and URL, and adjust to what the app actually sends.
  3. *the split date and time submit as one instant*:
     ```ts
     test('the split date and time submit as one instant', async ({ page }) => {
       await page.goto('/transactions')
       await page.getByRole('radio', { name: /Chi tiêu|^Expense$/ }).click()
       await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
       await page.getByRole('option').first().click()
       await page.getByLabel(/Số tiền|^Amount$/).fill('77000')
       await page.getByLabel(/^Ngày$|^Date$/).fill(TODAY)
       await page.getByLabel(/^Giờ$|^Time$/).fill('14:30')
       await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
       await expect(page.getByLabel(/Số tiền|^Amount$/)).toHaveValue('0')
       // The row's meta carries the time the two fields combined to, formatted
       // by `formatDate(..., 'dateTime')` in the user's zone.
       await expect(
         page.getByRole('listitem').filter({ hasText: '77.000' }),
       ).toContainText('14:30')
     })
     ```
     `TODAY` comes from `todayInZone(TIMEZONE)`; add the import if the file lacks it.

**`e2e/transactions-empty-state.spec.ts`.**
- `:28` — `NOTICE = 'You need an account before you can add a transaction.'` → the `EmptyState`'s body, matched in either locale: `eitherLocale('Bạn cần ít nhất một tài khoản để ghi giao dịch.', 'You need an account before you can add a transaction.')`. Update its three uses (`:60`, `:90`, `:104`).
- `:64`, `:91`, `:101`, `:143` — `getByLabel('Account', { exact: true })` and `.locator('option')`. With no account the form is replaced by the `EmptyState`, so the *absence* assertions become `await expect(page.getByRole('combobox', { name: /Tài khoản|^Account$/ })).toHaveCount(0)`. The two that read the option list (`:101`, `:143`) open the combobox and read `getByRole('option')`, as in the hydration spec above.
- `:65`, `:92`, `:129` — `getByRole('button', { name: 'Add transaction' })` → `/Thêm giao dịch|Add transaction/`. **Careful at `:65` and `:92`:** those assert the submit button is *absent*, and the page now also has a header/`+` control whose accessible name is the same phrase. Scope them to the form: `page.locator('form').getByRole('button', { name: /Thêm giao dịch|Add transaction/ })`.
- `:71` — `getByRole('link', { name: 'Go to Accounts' })` → `/Đến Tài khoản|Go to Accounts/`.
- `:83` — `page.once('dialog', …)` answers the **account archive** `window.confirm` on `/accounts`. That is Task 6's; leave it. At this task's point `/accounts` is unchanged, so it still works.
- `:113-117` — `getByText('Food & Dining · Cash', { exact: true })`: the row's title and meta are separate elements now. Replace with a row lookup plus two containment assertions:
  ```ts
  const listRow = page.getByRole('listitem').filter({ hasText: 'Food & Dining' })
  await expect(listRow).toHaveCount(1)
  await expect(listRow).toContainText('Cash')
  await expect(listRow).toContainText('50.000')
  ```
- `:126` — `getByLabel('Amount', { exact: true })` → `getByLabel(/Số tiền|^Amount$/)`.
- `:131` — `getByText('Enter an amount', { exact: true })` → `eitherLocale(…)` as above. Keep the `RAW_VALIDATION_TEXT` assertion on the next line **exactly** as it is: it is the live proof that what a user sees is product copy and not validator internals, and translating the copy does not weaken it.

**`e2e/phase4.spec.ts`.** Only its seeding (`:59`, `:65`) goes through `createTransactionViaUi`, which the helper rewrite covers. `:136-137`'s `recentSection.getByText('Salary'|'Food & Dining')` still holds — Task 4 made the dashboard row's title the category name. `:176` and `:207`'s `'Add transaction'` link is the shell's, already a regex from Task 3. **Expected change: none.** Run it and confirm rather than assuming.

**`e2e/phase5.spec.ts`.** Only its six `createTransactionViaUi` calls, covered by the helper. `:366`'s `'Amount'` is an **Excel column header**, not a selector — do not touch it. **Expected change: none.**

**`e2e/phase6.spec.ts`.** It does not import `createTransactionViaUi` (`:8`) and touches no transaction selector. **Expected change: none.**

Run: `$env:CI="1"; npx playwright test` (PowerShell) — the whole suite, green. `CI=1` makes `playwright.config.ts` start its own dev server (`reuseExistingServer: !process.env.CI`), which is what keeps the run honest against a stale one. Fix every failure at the selector, never by reverting a label.

- [ ] **Step 9: Full verification**

Run: `npm run test` → green, including the extended `transaction-form.test.tsx`: update its existing `aria-label`-based assertions to the new `<label>`-based ones, and add one assertion each that the SSR markup contains `<fieldset disabled`, that the type field renders `EXPENSE` as the checked radio, that the pre-hydration account stand-in is a `<select disabled>` carrying the form's default account, and that `datePart`/`timePart` are pre-filled from `nowInZone`.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npm run build` → succeeds.
Run: `$env:CI="1"; npx playwright test` → **the whole suite green**. Step 8 migrated everything this task moved, so a red spec here is a selector Step 8's grep missed — find it, fix it, and add the pattern it hid behind to that grep.

- [ ] **Step 10: Browser visual check — Transactions**

Seed a user with three accounts (2 VND, 1 USD) and ~20 transactions spread over today, yesterday and three earlier days, including one with a 200-character note, one `CASH_OUT` and one `ADJUSTMENT_DECREASE`.

Screenshot, light and dark: `/transactions` at 1440, 1280, 1024, 768, 375 (10); at 375 with the create sheet open (2); at 1440 with the delete `ConfirmDialog` open (2); in English at 1440 (1). Fifteen screenshots.

Look for:
- the amount column starts at the same x on every row and no note ever reaches it (measure two rows' `boundingBox().x` in the driver and assert they are equal);
- the 200-character note is one ellipsised line and its `title` holds the whole text;
- day headers read Hôm nay / Hôm qua / a weekday date, and stick while the list scrolls;
- the `CASH_OUT` and `ADJUSTMENT_DECREASE` rows read "Tiền ra (khác)" and "Điều chỉnh giảm" — **not the enum**;
- at 1440 and 1280 the form is a sticky panel on the right that stays put while the list scrolls; at 1024 it is below the list; at 768 and 375 only the trigger and the sheet exist;
- the amount field is visibly the dominant input with its currency code inside;
- Ngày and Giờ are two inputs side by side at every width, each labelled, each pre-filled with the user's own now;
- the type radiogroup: two primary buttons plus "Khác ▾", and the four extra types on expand;
- the Category picker shows one group header, and choosing a type re-filters it;
- dark: the sticky panel has a hairline and no shadow; the sheet is on `--surface-2`; expense amounts are `foreground`, income `positive`.

**Tests required:**
- Vitest: `components/transactions/transaction-day-group.test.ts` (4 new); `components/transactions/transaction-form.test.tsx` (existing assertions migrated from `aria-label` to `<label>`, plus four new: the SSR gate, the checked `EXPENSE` radio, the disabled-`<select>` stand-in carrying the form default, and the two pre-filled date/time parts).
- Playwright: `e2e/helpers.ts`'s `createTransactionViaUi` rewritten and `eitherLocale` added; `e2e/transaction-form-hydration.spec.ts` — every original test preserved with new selectors, **plus** three new ones (the raw-HTML gate extended to the radiogroup and both date parts, the in-flight double-submit, the split date/time recombination); `e2e/transactions-empty-state.spec.ts` migrated. `e2e/phase4.spec.ts`, `phase5.spec.ts` and `phase6.spec.ts` are re-run and expected to need **no** change — confirmed, not assumed.

**Browser visual checks required:** the fifteen screenshots in Step 10.

**Explicit things NOT to change:** `createTransactionFormSchema` and every Zod message it owns — the date/time split happens in the FORM, by merging the two parts back into the one `date` string the schema validates; `createTransactionAction`, `deleteTransactionAction`; `nowInZone` and the "no `Date` client-side" convention; `isBalanceIncreasing`; `CATEGORY_REQUIRED_TYPES`' membership; the `categoryId` `undefined`-not-`''` rule; `listTransactions`/`listActiveFinancialAccounts`/`listCategories`; `lib/ui/use-hydrated.ts`.

**Completion gate:** `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` **and `$env:CI="1"; npx playwright test`** all green — the suite included, because this task migrates the specs it moves and a commit may not leave them red; fifteen screenshots taken and inspected; the amount column's x position identical across rows at 375 and 1440 (measured); no raw enum on the page.

**Proposed commit boundary:**
1. `feat(transactions): day-grouped rows with a fixed amount column, product type labels, and ConfirmDialog for delete`
2. `feat(transactions): two-column create panel with the mobile sheet, labelled fields, split date/time inputs and the in-flight lock`
3. `test(transactions): migrate the ledger e2e selectors to the redesigned form`

Commits 1 and 2 are the UI; commit 3 is Step 8's spec migration. If the project's rule is a green suite at **every** commit rather than at every task, squash the three — the migration cannot precede the UI it targets, and it must not follow it across a commit boundary.

---

## Task 5b: Transfers

**Objective:** Rebuild `/transfers` to spec §6.3 — a FROM → TO composition with a readable cross-currency rate line, `ConfirmDialog` for delete, and an `EmptyState` replacing the form when fewer than two active accounts exist — and migrate the transfer-related e2e selectors this task's own changes move. Task 5a left the suite green; this task keeps it that way.

**Major files touched:** `app/(app)/transfers/page.tsx`, `components/transfers/transfer-list.tsx`, `components/transfers/transfer-form.tsx`, `messages/{vi,en}/transfers.json`, `e2e/transaction-form-hydration.spec.ts` (its `/transfers` raw-HTML assertions only).

**Reusable primitives involved:** `PageHeader`, `SectionHeader`, `FinancialListRow`, `MoneyText`, `EmptyState`, `InlineAlert`, `FormField`/`SELECT_CLASS`, `ConfirmDialog`, `RowActionsMenu`, `useSubmitState`.

**User-facing behaviour:** Transfers reads "Cash → Bank" with the sent amount, and on a cross-currency transfer also the received amount and "1 USD = 25.000 VND". Deleting asks first, naming that both balances move back. A user with fewer than two active accounts sees an `EmptyState` with a link to Accounts instead of a form with two identical selects.

**Desktop expectation:** a single 960 (`max-w-[60rem]`) column; the list is one bordered card with `divide-y` rows; FROM and TO sit side by side with a `→` between them; the amount pair is right-aligned in the row's fixed column.

**Mobile expectation:** FROM and TO stack with the arrow rotated 90°; the two amounts stack in the row's amount column; the delete confirmation is a bottom sheet.

**Dark-theme expectation:** the rate line is `text-muted-foreground` at 60 % white and stays legible; inputs sit on `--input-bg`; the received amount is `--positive` only when it is genuinely money arriving in the destination account, which on this page it always is.

**Vietnamese/English expectation:** every string from `transfers.json`; "Từ" / "Đến" as the two labels; the rate line is `common.rateLine` and is always quoted **VND per one USD**, whichever direction the transfer went.

**Accessibility acceptance criteria:** one `h1`; the create form's heading is an `h2`; every field has a visible `<label htmlFor>` (today the form has six `aria-label`-only controls); the `→` is `aria-hidden` and the route is stated in the row's title text; delete is a `RowActionsMenu` item behind a `ConfirmDialog`; the always-rendered `toAmount` error keeps its `role="alert"`.

**Hydration/form-submission constraints:** `TransferForm` keeps its `useHydrated()` gate and its `defaultValue={defaultToAccountId(accounts)}` on the TO select — deliberately the *second* account, which is exactly why it needs one. The `wasSameCurrencyRef` effect, the `payload` re-derivation at submit and the always-rendered `toAmount` error all stay verbatim: they are financial-correctness decisions, not styling. `useSubmitState` wraps the submit.

**Files:**
- Modify: `app/(app)/transfers/page.tsx:1-43` (whole file), `components/transfers/transfer-list.tsx:1-110` (whole file), `components/transfers/transfer-form.tsx:1-230` (whole file), `messages/{vi,en}/transfers.json`
- Test: `components/transfers/transfer-form.test.tsx` (extend), `e2e/transaction-form-hydration.spec.ts` (its three `/transfers` raw-HTML assertions)

**Interfaces:**

- Consumes: every Task 1a–1c primitive; `formatMoney`, `formatRate`, `formatDate` (Task 2c); `TRANSFER_ERROR_KEYS`, `GENERIC_ERROR_KEY`; `useSubmitState`; `useHydrated`; `eitherLocale` from `e2e/helpers.ts` (Task 5a). `AccountOption` is **not** shared — the transfer form keeps its own local `Account` type, because it needs no balance.
- Produces:

```ts
// components/transfers/transfer-list.tsx  ('use client')
export interface TransferRow {
  id: string
  date: Date
  fromAmount: string
  toAmount: string
  exchangeRateUsed: string | null
  fromAccount: { name: string; currency: string }
  toAccount: { name: string; currency: string }
}
export function TransferList(props: {
  transfers: TransferRow[]
  timezone: string
  locale: Locale
}): React.ReactElement
```

- [ ] **Step 1: Add the transfers message keys**

`messages/vi/transfers.json`:

```json
{
  "title": "Chuyển tiền",
  "createTitle": "Chuyển tiền",
  "createAction": "Chuyển tiền",
  "createPending": "Đang chuyển…",
  "from": "Từ",
  "to": "Đến",
  "fromPlaceholder": "Chọn tài khoản nguồn",
  "toPlaceholder": "Chọn tài khoản đích",
  "amount": "Số tiền",
  "amountSent": "Số tiền gửi",
  "amountReceived": "Số tiền nhận",
  "dateTime": "Ngày và giờ",
  "note": "Ghi chú (tùy chọn)",
  "route": "{from} → {to}",
  "deleteAction": "Xóa lệnh chuyển",
  "deleteConfirmTitle": "Xóa lệnh chuyển này?",
  "deleteConfirmBody": "Số dư của cả hai tài khoản sẽ được hoàn lại. Không thể hoàn tác.",
  "deleteConfirm": "Xóa",
  "deletePending": "Đang xóa…",
  "emptyTitle": "Chưa có lệnh chuyển nào",
  "emptyBody": "Chuyển tiền giữa hai tài khoản của bạn.",
  "needTwoAccountsTitle": "Cần ít nhất hai tài khoản đang hoạt động",
  "needTwoAccountsBody": "Chuyển tiền là chuyển giữa hai tài khoản của bạn.",
  "needTwoAccountsAction": "Đến Tài khoản"
}
```

`messages/en/transfers.json`: the English set, keeping `"amountSent": "Amount sent"`, `"amountReceived": "Amount received"`, `"createAction": "Transfer"`, `"needTwoAccountsTitle": "You need at least two active accounts"`.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS.

- [ ] **Step 2: Rewrite the Transfers list, form and page**

`components/transfers/transfer-list.tsx` — same shape as the transaction list: `FinancialListRow` inside one card with `divide-y`, `RowActionsMenu` → `ConfirmDialog` instead of `window.confirm` (replacing `components/transfers/transfer-list.tsx:45`), `EmptyState` when empty, `formatMoney(..., locale)` instead of the module-level `amountFormatter` (`:26`), `formatDate(..., 'dateTime')` instead of `formatInTimeZone` (`:72`). The row's specifics:

- title: `t('transfers.route', { from: row.fromAccount.name, to: row.toAccount.name })` — "Cash → Bank".
- amount slot: a `MoneyText` for the sent amount; on a cross-currency row a second `MoneyText` beneath it for the received amount, with the container `flex flex-col items-end gap-0.5`.
- meta: the date; on a cross-currency row also the rate line `t('common.rateLine', { from: row.fromAccount.currency, rate: formatRate(row.exchangeRateUsed, locale), to: row.toAccount.currency })` — **in the readable direction**, which for USD→VND means "1 USD = 25.000 VND" and for VND→USD still means "1 USD = 25.000 VND" (never "1 VND = 0,00004 USD"). Implement that as a helper in the same file:

```tsx
/**
 * The rate, always quoted in the direction a person reads it: VND per one USD.
 *
 * `exchangeRateUsed` is stored as destination-per-source, so a VND→USD transfer
 * carries 0.00004. Printing that is technically true and useless — nobody
 * quotes the dong that way — so the pair is normalised to USD-per-1 and the
 * reciprocal is taken when the source is VND. The figure is `formatRate`'s, and
 * nothing reads it back into a calculation.
 */
function readableRate(row: TransferRow, locale: Locale): { from: string; rate: string; to: string } | null {
  if (row.exchangeRateUsed === null) return null
  const sourceIsUsd = row.fromAccount.currency === 'USD'
  const rate = sourceIsUsd ? Number(row.exchangeRateUsed) : 1 / Number(row.exchangeRateUsed)
  return { from: 'USD', rate: formatRate(rate, locale), to: 'VND' }
}
```
with a note that `Number()` here is display-only, downstream of the service's `Decimal` arithmetic, and that the reciprocal is a presentation choice — the stored rate is untouched.

`components/transfers/transfer-form.tsx` — keep **every line of** the `wasSameCurrencyRef` effect and its comment (`components/transfers/transfer-form.tsx:87-106`), the `defaultToAccountId` helper and its comment (`:27-37`), the `payload` belt-and-suspenders in `onSubmit` (`:111-114`), and the "rendered regardless of `sameCurrency`" `toAmount` error (`:208-210`) — all four are financial-correctness decisions, not styling. Change only:
- wrap the body in `useSubmitState()` (`submit.run`, `disabled={!hydrated || submit.locked}`, `aria-busy={submit.busy}`);
- replace the two account `<select>`s with `FormField` + a native `<select className={SELECT_CLASS}>` (`SELECT_CLASS` from `@/components/common/form-field`; spec §2: native is the default, and only the *transaction* Category and Account pickers are custom) — labels `t('transfers.from')` / `t('transfers.to')`, and keep `defaultValue={defaultToAccountId(accounts)}` on the second one with its comment;
- lay them out as `grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end` with an `<ArrowRight aria-hidden className="size-4 mb-3 text-muted-foreground sm:rotate-0 rotate-90" />` between them (spec §6.3: stacked on mobile with the arrow rotated);
- wrap the amount inputs in `FormField` with `t('transfers.amount')` when same-currency and `t('transfers.amountSent')` / `t('transfers.amountReceived')` when not, each with its currency code inside the field exactly as the transaction form does;
- on a cross-currency pair, render the computed rate line under the two amounts as a 12 px muted `<p>` using `t('common.rateLine', …)` and `formatRate`, in the same readable direction as the list;
- replace the two `placeholder`-only fields (date, note) with `FormField`;
- replace the error `<p role="alert">` with `InlineAlert`;
- error text comes from `t(TRANSFER_ERROR_KEYS[result.error])` / `t(GENERIC_ERROR_KEY)`.

`app/(app)/transfers/page.tsx` — `PageHeader` with `t('transfers.title')`, `max-w-[60rem]`, page padding, the list, then a `SectionHeader` + the form. **And the < 2 accounts case** (spec §6.3): when `accounts.length < 2`, render an `EmptyState` with `icon={Wallet}`, `title={t('transfers.needTwoAccountsTitle')}`, `description={t('transfers.needTwoAccountsBody')}`, `action={{ label: t('transfers.needTwoAccountsAction'), href: '/accounts' }}` **instead of** the form. Put that check in the page (which knows the count) and keep the form's own defensive behaviour: `TransferForm` with fewer than two accounts would render two identical selects, so add the same guard at the top of the form after its hooks, exactly as `TransactionForm` guards on zero accounts and for the same stated reason.

- [ ] **Step 3: Migrate the transfer-related e2e selectors**

Task 5a migrated everything the Transactions redesign moved and left the suite green. This task moves only `/transfers`, so the migration is small — and it is done here, in the same task, for the same reason: a commit may not leave the suite red.

Grep for what this task changes — the two account selects' accessible names, the amount labels, the submit button, the row's route text and the delete confirmation:

```bash
grep -rn "From account\|To account\|Amount sent\|Amount received\|name: 'Transfer'\|New transfer\|No transfers yet\|Delete this transfer" e2e/
```

Expected hits, and what each becomes:

**`e2e/transaction-form-hydration.spec.ts`** — the only spec that touches `/transfers`, and it does so through raw HTML rather than selectors, which is why it is the only one. Its `/transfers` block asserts the SSR defaults:
- `selectedOptionLabel(selectMarkup(transfers, 'To account'))` expected the **second** account's name. The control is still a native `<select>` — spec §2 keeps native as the default and makes only the *transaction* Category and Account pickers custom — so the assertion holds structurally. Change only the accessible name it looks up: `'To account'` → the value of `transfers.to`, i.e. `/^Đến$|^To$/`. Same for `'From account'` → `/^Từ$|^From$/`.
- Keep the assertion that `toAccountId`'s select carries the `selected` marker and `fromAccountId`'s does not. That distinction is the whole point of the block (`toAccountId` defaults to the second account, so it needs a `defaultValue`; `fromAccountId` defaults to the first option and must not have one), and this task preserves both defaults.
- Keep `/transfers` in `GATED_PAGES` and its `<fieldset disabled=""` / `aria-busy="true"` assertions unchanged — the gate is untouched.
- If the file reads the labels from a constant, update the constant; if it inlines them, update each occurrence. Read it before editing.

**No other spec.** `phase4.spec.ts` explicitly documents that transfers are out of its scope ("a same-currency transfer needs two accounts in the same currency, which this seed does not have"); `phase5.spec.ts`, `phase6.spec.ts`, `transactions-empty-state.spec.ts` and `auth.spec.ts` reference nothing on `/transfers`. Confirm with the grep rather than assuming, and record the hit count in the task report.

**No `e2e/helpers.ts` change.** There is no `createTransferViaUi` and this task does not add one: Task 17's confirmation spec is the only later spec that needs a transfer, and it creates one inline through this form (its `beforeAll` already does).

Run: `$env:CI="1"; npx playwright test e2e/transaction-form-hydration.spec.ts` → green, with every original test present.


- [ ] **Step 4: Full verification**

Run: `npm run test` → green (including the extended `transaction-form.test.tsx` and `transfer-form.test.tsx`; update their existing `aria-label`-based assertions to the new `<label>`-based ones, and add one assertion each that the SSR markup contains `<fieldset disabled` and the `defaultValue` rules named in **Hydration constraints**).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → all specs green.
Run: `npm run build` → succeeds.


- [ ] **Step 5: Browser visual check — Transfers**

Seed the Task 5a user plus 4 transfers, of which 2 are cross-currency (one USD→VND, one VND→USD).

Screenshot, light and dark: `/transfers` at 1440 and 375 (4); at 1440 with the delete `ConfirmDialog` open (1 light); with fewer than two accounts at 1440 (1 light — use a second, single-account user); a cross-currency row clipped close at 1440 (1 light); in English at 1440 (1 light). Eight screenshots.

Look for: "Cash → Bank" reading as one route rather than two names; the arrow horizontal at 1440 and rotated at 375; the rate line reading "1 USD = 25.000 VND" on **both** cross-currency rows regardless of direction; the sent and received amounts stacked and right-aligned in one column; fewer than two accounts showing the `EmptyState` with a link to Accounts and **no form**; dark: the rate line legible, inputs on `--input-bg`.

**Tests required:**
- Vitest: `components/transfers/transfer-form.test.tsx` — existing `aria-label` assertions migrated to `<label>`, plus one asserting the SSR markup carries `<fieldset disabled`, one asserting `toAccountId`'s `defaultValue` is the *second* account, and one asserting the readable rate direction is USD-per-1 for both source currencies.
- Playwright: `e2e/transaction-form-hydration.spec.ts`'s `/transfers` raw-HTML block, re-pointed at the two new field labels with both `defaultValue` assertions intact. No new spec: the transfer form's own behaviour is covered by that block plus the `ConfirmDialog` sweep in Task 17, which includes the delete-transfer site.

**Browser visual checks required:** the eight screenshots in Step 5.

**Explicit things NOT to change:** `createTransferFormSchema` and its Zod messages; `createTransferAction`, `deleteTransferAction`; `defaultToAccountId` and the transfer form's same-currency `toAmount` effect, its `payload` re-derivation and its always-rendered `toAmount` error; the stored `exchangeRateUsed` (only its *display* direction is normalised); `listTransfers`/`listActiveFinancialAccounts`; anything Task 5a built — this task consumes it.

**Completion gate:** `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` and `$env:CI="1"; npx playwright test` all green — the suite was green when this task started and is green when it ends. Eight screenshots inspected. `grep -rn "window.confirm" components/transactions components/transfers` returns nothing.

**Proposed commit boundary:**
1. `feat(transfers): FROM → TO composition with a readable rate line, labelled fields and ConfirmDialog for delete`
2. `test(transfers): re-point the transfer SSR-default assertions at the new field labels`

---

## Task 6: Accounts and Categories

**Objective:** Rebuild `/accounts` and `/categories` to spec §6.4 — Accounts as a header with the base-currency total, one bordered list of rows (name, type · currency meta, right-aligned balance, `…` menu with Edit and Archive), archived accounts in a `<details>`, and creation via a header button opening a `Sheet`; Categories as three `SectionHeader` sections of chips with default items quiet, custom items carrying a `…` menu, and an inline "Thêm" input per section. `ConfirmDialog` replaces the account archive `window.confirm` and adds the missing category/account-type archive confirmation.

**Major files touched:** `app/(app)/accounts/page.tsx`, `app/(app)/categories/page.tsx`, `components/accounts/account-list.tsx`, `components/accounts/account-form.tsx`, `components/accounts/account-edit-form.tsx`, `components/categories/named-list-manager.tsx`, `components/categories/category-chip-list.tsx` (new), `messages/{vi,en}/accounts.json`, `messages/{vi,en}/categories.json`, `e2e/helpers.ts`, `e2e/transactions-empty-state.spec.ts`, `e2e/phase4.spec.ts`.

**Reusable primitives involved:** `PageHeader`, `SectionHeader`, `FinancialListRow`, `MoneyText`, `StatusBadge`, `EmptyState`, `InlineAlert`, `FormField`/`Label`/`FieldError`, `ConfirmDialog`, `Sheet`, `RowActionsMenu`, `useSubmitState`.

**User-facing behaviour:** Accounts shows the total across accounts in the user's base currency (or "—" when FX is unavailable), then one list. "Thêm tài khoản" in the header opens a right sheet with the create form. A row's `…` menu offers Sửa (opens an edit `Dialog` mounted on open) and Lưu trữ (a `ConfirmDialog` that names the zero-balance rule). Archived accounts sit in a muted `<details>`. Categories shows Loại tài khoản / Danh mục chi / Danh mục thu; default items are quiet chips with no menu, custom items have `…` with Lưu trữ; each section ends with an inline input and an Thêm button.

**Desktop expectation:** both pages `max-w-[60rem]`, `p-8`; Accounts list is one card with `divide-y` rows; the balance sits in the `min-w-[8.5rem]` column; the create sheet is 480 px on the right. Categories is a single column of three sections (not the current two-column grid, which put a two-item list beside a twenty-item one).

**Mobile expectation:** Accounts rows are two lines — name + balance on line one, type · currency on line two — via `FinancialListRow`'s existing stacking; the `…` trigger is 36×36 with a 44 px touch box. The create sheet is bottom-anchored. Category chips wrap; the inline add input is full width above its button.

**Dark-theme expectation:** the list card is `bg-surface` with `divide-border`; a negative balance is `--negative` at dark L≈0.68; default category chips are `bg-muted text-muted-foreground` with **no** border (spec §6.4: "default items as quiet chips (no border weight, muted)"); custom chips get `border-border`. The archived `<details>` content is `opacity-70`, not a different surface.

**Vietnamese/English expectation:** every label from `accounts.json`/`categories.json`; the account type name and category name are user data and are never translated; the currency code is the code. Section headers are exactly Loại tài khoản / Danh mục chi / Danh mục thu (spec §6.4).

**Accessibility acceptance criteria:** one `h1` per page; three `h2`s on Categories; every input in both create forms and the edit dialog has a visible `<label htmlFor>` via `FormField` (today `account-form.tsx` has four placeholder-only fields and `account-edit-form.tsx` two); the `…` trigger's `aria-label` names its account (`common.rowActions`); the archive confirmation is a `ConfirmDialog`; the `<details>` summary states the count; the inline add input has a visible label per section, not a shared one.

**Hydration/form-submission constraints:** `AccountForm` keeps its `useHydrated()` gate (`components/accounts/account-form.tsx:23,71-75`) and its `accountTypeId: accountTypes[0]?.id` default with the comment explaining why (`:31-40`); every `<select>` in it still defaults to its own first option, so none needs a `defaultValue` — keep that comment too. `AccountEditForm` mounts inside a `Dialog` on open, so it has no SSR-defaults problem and needs no gate (spec §9) — but it **does** get `useSubmitState`. Both forms get `disabled={!hydrated || submit.locked}` / `aria-busy={submit.busy}`.

**Files:**
- Create: `components/categories/category-chip-list.tsx`, `components/categories/category-chip-list.test.tsx`
- Modify: `app/(app)/accounts/page.tsx:90-127` (the render only), `app/(app)/categories/page.tsx:21-60` (the render only), `components/accounts/account-list.tsx:1-145` (whole file), `components/accounts/account-form.tsx:59-127` (the render), `components/accounts/account-edit-form.tsx:90-165` (the render), `components/categories/named-list-manager.tsx:1-80` (whole file), `messages/{vi,en}/accounts.json`, `messages/{vi,en}/categories.json`
- Test: `components/accounts/account-list.test.tsx` (new), `components/categories/category-chip-list.test.tsx` (new), `e2e/helpers.ts:43-56`, `e2e/transactions-empty-state.spec.ts:60,84-91,104`, `e2e/phase4.spec.ts:196-200`

**Interfaces:**

- Consumes: every Task 1a–1c primitive; `formatMoney`, `formatDate`; `ACCOUNT_ERROR_KEYS`, `GENERIC_ERROR_KEY`; `getCurrentPosition` (existing service, for the header total).
- Produces:

```ts
// components/accounts/account-list.tsx  ('use client')
export interface AccountRow {
  id: string
  name: string
  currency: Currency
  description: string | null
  initialBalance: number
  accountTypeId: string
  accountType: { name: string }
  /** `.toFixed(2)` from the page — a Decimal cannot cross the boundary. */
  balance: string
  locked: boolean
}
export function AccountList(props: {
  accounts: AccountRow[]
  accountTypes: { id: string; name: string }[]
  locale: Locale
}): React.ReactElement

// components/accounts/account-form.tsx  (unchanged signature)
export function AccountForm(props: {
  accountTypes: { id: string; name: string }[]
  onCreated?: () => void
}): React.ReactElement

// components/categories/category-chip-list.tsx  ('use client')
export function CategoryChipList(props: {
  title: string
  items: { id: string; name: string; isDefault: boolean }[]
  addLabel: string
  addPlaceholder: string
  archiveLabel: string
  confirmTitle: string
  confirmBody: string
  onCreate: (name: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
}): React.ReactElement
```

- [ ] **Step 1: Add the message keys**

`messages/vi/accounts.json`:
```json
{
  "title": "Tài khoản",
  "total": "Tổng {amount} {currency}",
  "totalUnavailable": "Tổng — (chưa có tỷ giá)",
  "asOfNow": "Số dư tính đến hiện tại; các bút toán ghi ngày tương lai chưa được tính.",
  "createTitle": "Thêm tài khoản",
  "createAction": "Tạo tài khoản",
  "createPending": "Đang tạo…",
  "openCreate": "Thêm tài khoản",
  "name": "Tên tài khoản",
  "type": "Loại tài khoản",
  "initialBalance": "Số dư ban đầu",
  "currency": "Tiền tệ",
  "description": "Mô tả (tùy chọn)",
  "lockedNotice": "Không thể đổi tiền tệ và số dư ban đầu vì tài khoản đã có phát sinh.",
  "editTitle": "Sửa {name}",
  "editAction": "Sửa",
  "archiveAction": "Lưu trữ",
  "archiveConfirmTitle": "Lưu trữ {name}?",
  "archiveConfirmBody": "Tài khoản phải có số dư bằng 0. Lịch sử giao dịch vẫn được giữ lại.",
  "archivePending": "Đang lưu trữ…",
  "archivedSection": "Tài khoản đã lưu trữ ({count})",
  "emptyTitle": "Chưa có tài khoản",
  "emptyBody": "Thêm tài khoản đầu tiên để bắt đầu ghi giao dịch."
}
```
`messages/en/accounts.json`: the same keys in English, keeping today's exact strings where they exist — `"name": "Account name"`, `"type": "Account type"`, `"initialBalance": "Initial balance"`, `"currency": "Currency"`, `"description": "Description (optional)"`, `"createAction": "Create account"`, `"archiveAction": "Archive"`, `"editAction": "Edit"`, `"archivedSection": "Archived accounts ({count})"`, `"asOfNow": "Balances are as of now; future-dated entries are excluded until their date."`, `"lockedNotice": "Currency and opening balance cannot be changed once the account has activity."`.

`messages/vi/categories.json`:
```json
{
  "title": "Danh mục",
  "description": "Loại tài khoản và danh mục thu chi của bạn.",
  "accountTypes": "Loại tài khoản",
  "expenseCategories": "Danh mục chi",
  "incomeCategories": "Danh mục thu",
  "addLabel": "Thêm {section}",
  "addPlaceholder": "Tên mới",
  "addAction": "Thêm",
  "addPending": "Đang thêm…",
  "archiveAction": "Lưu trữ",
  "archiveConfirmTitle": "Lưu trữ {name}?",
  "archiveConfirmBody": "Mục đã lưu trữ không còn xuất hiện khi chọn, nhưng các bản ghi cũ vẫn giữ nguyên.",
  "archivePending": "Đang lưu trữ…",
  "defaultBadge": "Mặc định",
  "emptyTitle": "Chưa có mục nào"
}
```
`messages/en/categories.json`: `"accountTypes": "Account Types"`, `"expenseCategories": "Expense Categories"`, `"incomeCategories": "Income Categories"`, `"addPlaceholder": "New name"`, `"addAction": "Add"`, `"archiveAction": "Archive"`, `"defaultBadge": "Default"`, and English for the rest.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS.

- [ ] **Step 2: Write the failing test for `AccountList`**

`components/accounts/account-list.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { AccountList, type AccountRow } from './account-list'

const ROWS: AccountRow[] = [
  {
    id: 'a1',
    name: 'Cash',
    currency: 'VND',
    description: null,
    initialBalance: 0,
    accountTypeId: 't1',
    accountType: { name: 'Cash' },
    balance: '5000000.00',
    locked: false,
  },
  {
    id: 'a2',
    name: 'Card',
    currency: 'VND',
    description: null,
    initialBalance: 0,
    accountTypeId: 't1',
    accountType: { name: 'Credit' },
    balance: '-1200000.00',
    locked: true,
  },
]

describe('AccountList', () => {
  it('renders every row inside ONE bordered surface with dividers', () => {
    const html = renderToStaticMarkup(
      <AccountList accounts={ROWS} accountTypes={[{ id: 't1', name: 'Cash' }]} locale="vi" />,
    )
    expect(html).toContain('divide-y')
    expect(html.match(/rounded-lg border border-border/g)).toHaveLength(1)
  })

  it('puts the balance in the fixed amount column and tones a negative one', () => {
    const html = renderToStaticMarkup(
      <AccountList accounts={ROWS} accountTypes={[{ id: 't1', name: 'Cash' }]} locale="vi" />,
    )
    expect(html).toContain('min-w-[8.5rem]')
    expect(html).toContain('5.000.000')
    expect(html).toContain('text-negative')
    expect(html).toContain('1.200.000')
  })

  it('names the row’s actions menu after the account, not "More"', () => {
    const html = renderToStaticMarkup(
      <AccountList accounts={ROWS} accountTypes={[{ id: 't1', name: 'Cash' }]} locale="vi" />,
    )
    // The mocked translator echoes the key, so the presence of the key proves
    // the row passed its own name through `common.rowActions`.
    expect(html.match(/common\.rowActions/g)).toHaveLength(2)
  })

  it('shows the empty state rather than an empty card', () => {
    const html = renderToStaticMarkup(<AccountList accounts={[]} accountTypes={[]} locale="vi" />)
    expect(html).toContain('accounts.emptyTitle')
    expect(html).not.toContain('divide-y')
  })
})
```

Run: `npx vitest run components/accounts/account-list.test.tsx` → FAIL.

- [ ] **Step 3: Rewrite `components/accounts/account-list.tsx`**

Concrete per-file change list:

1. Delete `formatBalance` (`:36-44`) — its bespoke `Intl.NumberFormat` is replaced by `formatMoney(row.balance, row.currency, locale)`, which is the codebase's single money-presentation boundary.
2. Delete `handleArchive`'s `window.confirm` (`:58`) and replace the whole flow with a `pendingArchive: AccountRow | null` state plus one `ConfirmDialog` for the list, exactly as `TransactionList` does — `title={t('accounts.archiveConfirmTitle', { name: row.name })}`, `description={t('accounts.archiveConfirmBody')}`, `confirmLabel={t('accounts.archiveAction')}`, `pendingLabel={t('accounts.archivePending')}`, `cancelLabel={t('common.cancel')}`.
3. Replace the `editingId` inline-expansion (`:54,88,106-109,123-139`) with `editing: AccountRow | null` and a `Dialog` (`title={t('accounts.editTitle', { name: editing.name })}`) containing `AccountEditForm`. The form then **mounts on open**, which is what removes its SSR-defaults problem (spec §9).
4. Replace the `<li className="rounded-md border p-3">` block (`:90-140`) with `FinancialListRow`: `title={account.name}`, `meta={`${account.accountType.name} · ${account.currency}`}`, `amount={<MoneyText value={formatMoney(account.balance, account.currency, locale)} currency={account.currency} tone={account.balance.startsWith('-') ? 'negative' : 'default'} />}`, `actions={<RowActionsMenu label={t('common.rowActions', { name: account.name })} actions={[{ id: 'edit', label: t('accounts.editAction'), onSelect: () => setEditing(account) }, { id: 'archive', label: t('accounts.archiveAction'), tone: 'negative', onSelect: () => setPendingArchive(account) }]} />}`.
5. Wrap the rows in `<ul className="divide-y divide-border">` inside `<div className="overflow-hidden rounded-lg border border-border bg-surface">`.
6. Replace the empty branch (`:80-82`) with `<EmptyState icon={Wallet} size="page" title={t('accounts.emptyTitle')} description={t('accounts.emptyBody')} />`.
7. Replace each `<p className="text-sm text-negative">` error (`:120-122`) with `InlineAlert tone="negative"` rendered below the card, keyed by account id — an error inside a fixed-height row would clip or shift the figures beside it.
8. Error text becomes `t(ACCOUNT_ERROR_KEYS[result.error])` / `t(GENERIC_ERROR_KEY)`.
9. Keep the `AccountWithBalance` type's doc comments about `.toFixed(2)` crossing the boundary (`:21-33`) verbatim — they are still exactly why the prop is a string — and rename the type to `AccountRow` with `export`.

Run: `npx vitest run components/accounts/account-list.test.tsx` → PASS (4 tests).

- [ ] **Step 4: Label every field in `AccountForm` and `AccountEditForm`**

`components/accounts/account-form.tsx` — per-field change list, replacing `:77-124`:

| Field | Today | Becomes |
|---|---|---|
| name | `<Input placeholder="Account name" {...register('name')} />` | `<FormField id="account-name" label={t('accounts.name')} error={errors.name?.message}>{(aria) => <Input {...aria} {...register('name')} />}</FormField>` |
| accountTypeId | `<select aria-label="Account type">` | `<FormField id="account-type" label={t('accounts.type')} error={errors.accountTypeId?.message}>{(aria) => <select {...aria} {...register('accountTypeId')} className={SELECT_CLASS}>…</select>}</FormField>` |
| initialBalance | `<Input placeholder="Initial balance" …>` | `<FormField id="account-initial-balance" label={t('accounts.initialBalance')} error={errors.initialBalance?.message}>{(aria) => <Input {...aria} type="number" step="0.01" {...register('initialBalance', { valueAsNumber: true })} />}</FormField>` |
| currency | `<select aria-label="Currency">` | `<FormField id="account-currency" label={t('accounts.currency')} error={errors.currency?.message}>{(aria) => <select {...aria} {...register('currency')} className={SELECT_CLASS}><option value="VND">VND</option><option value="USD">USD</option></select>}</FormField>` |
| description | `<Input placeholder="Description (optional)" …>` | `<FormField id="account-description" label={t('accounts.description')} error={errors.description?.message}>{(aria) => <Input {...aria} {...register('description')} />}</FormField>` |
| submit | `Add`/`Create account` literal | `{submit.pending ? t('accounts.createPending') : t('accounts.createAction')}` with `className="self-start"` |
| error | `<p className="text-sm text-negative">` | `<InlineAlert tone="negative">` |

`SELECT_CLASS` is exported from `components/common/form-field.tsx` (Tasks 1a–1c) — the one class string every styled native `<select>` in the app uses, so "a select looks like an input" is one decision and not nine. Each select is wrapped in a `relative` div with a `<ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />` sibling.

Also add the `useSubmitState` wiring: `const submit = useSubmitState()`, `disabled={!hydrated || submit.locked}`, `aria-busy={submit.busy}`, and `await submit.run(async () => { … })` around the existing `onSubmit` body (`:43-57`), keeping its `reset()` and `router.refresh()` and adding `onCreated?.()` after them.

`components/accounts/account-edit-form.tsx` — the same table applied to its five fields (`:97,101-108,118-124,130-138,147`), with ids prefixed `account-edit-`, `useSubmitState` added, and the locked notice rendered as `<InlineAlert tone="neutral">{t('accounts.lockedNotice')}</InlineAlert>` where the current copy sits. Read `:34-96` first and leave the `locked`-driven field omission logic and its comments **exactly** as they are: which fields are editable is a service invariant (`accountsWithActivity` → the lock), not styling.

- [ ] **Step 5: Rewrite `app/(app)/accounts/page.tsx`'s render and add the header total**

Everything at `app/(app)/accounts/page.tsx:1-88` — `countFutureDatedEntries`, the single `now`, the batched `getCurrentAccountBalances`/`accountsWithActivity` calls and every comment explaining them — stays exactly as it is. Add two things and replace the render (`:90-127`):

1. The header total. Add to the existing `Promise.all` (`:51-68`) a fourth entry:
   ```ts
   // The base-currency total for the header (spec §6.4), from the same
   // position read the dashboard uses — so the two pages cannot disagree. It
   // may consult the CURRENT-rate policy, so it degrades to `null` on an FX
   // outage exactly as the dashboard's does, and the header then shows "—"
   // rather than a number nobody can stand behind.
   orNullIfFxUnavailable(getCurrentPosition(user.id, displayCurrency, { now })),
   ```
   with `orNullIfFxUnavailable` copied into this page from `app/(app)/dashboard/page.tsx:51-58` — **or**, better, extracted to `lib/ui/or-null-if-fx-unavailable.ts` and imported by both, since a second copy of a financial-degradation rule is exactly the drift the codebase avoids elsewhere. Extract it, keep its whole doc comment, and update the dashboard's import. Also read `displayCurrency` from `resolveProfileDefaults(user)` (the page currently reads no profile at all).

2. The render:
```tsx
  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('accounts.title')}
        description={
          position === null
            ? t('accounts.totalUnavailable')
            : t('accounts.total', {
                amount: formatMoney(position.totalBalance, displayCurrency, locale),
                currency: displayCurrency,
              })
        }
        meta={futureDatedCount > 0 ? t('accounts.asOfNow') : undefined}
        actions={<AccountCreateButton accountTypes={accountTypes} />}
      />

      <AccountList accounts={accountsWithBalance} accountTypes={accountTypes} locale={locale} />

      {archivedAccounts.length > 0 && (
        <details className="rounded-lg border border-border bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-[0.8125rem]/[1.125rem] font-medium text-muted-foreground">
            {t('accounts.archivedSection', { count: archivedAccounts.length })}
          </summary>
          {/* Read-only, like every other archived section in this app: an
              archived account refuses every write, so no actions are offered. */}
          <ul className="divide-y divide-border border-t border-border opacity-70">
            {archivedAccounts.map((account) => (
              <FinancialListRow
                key={account.id}
                title={account.name}
                meta={`${account.accountType.name} · ${account.currency}`}
                amount={<StatusBadge label={t('labels.recordStatus.ARCHIVED')} tone="muted" />}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
```
`AccountCreateButton` is a small client component in `components/accounts/account-create-button.tsx` (add it to this task's Create list): a `Button` that opens a `Sheet` titled `t('accounts.createTitle')` containing `AccountForm` with `onCreated={() => setOpen(false)}`. It is the same shape as `TransactionCreatePanel`'s sheet half, minus the sticky panel — write it out rather than reusing that component, whose desktop behaviour is deliberately different.

- [ ] **Step 6: Write `CategoryChipList` and its test, replacing `NamedListManager`**

`components/categories/category-chip-list.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { CategoryChipList } from './category-chip-list'

const PROPS = {
  title: 'Danh mục chi',
  addLabel: 'Thêm Danh mục chi',
  addPlaceholder: 'Tên mới',
  archiveLabel: 'Lưu trữ',
  confirmTitle: 'Lưu trữ?',
  confirmBody: 'Vẫn giữ bản ghi cũ.',
  onCreate: async () => {},
  onArchive: async () => {},
}

describe('CategoryChipList', () => {
  it('renders default items as quiet chips with no border and no menu', () => {
    const html = renderToStaticMarkup(
      <CategoryChipList
        {...PROPS}
        items={[{ id: 'c1', name: 'Ăn uống', isDefault: true }]}
      />,
    )
    const chip = html.slice(html.indexOf('Ăn uống') - 300, html.indexOf('Ăn uống'))
    expect(chip).toContain('bg-muted')
    expect(chip).not.toContain('border-border')
    expect(html).not.toContain('common.rowActions')
  })

  it('gives a custom item a border and an actions menu', () => {
    const html = renderToStaticMarkup(
      <CategoryChipList {...PROPS} items={[{ id: 'c2', name: 'Cà phê', isDefault: false }]} />,
    )
    expect(html).toContain('border-border')
    expect(html).toContain('common.rowActions')
  })

  it('gives the inline add input its own visible label naming the section', () => {
    const html = renderToStaticMarkup(<CategoryChipList {...PROPS} items={[]} />)
    expect(html).toContain('<label')
    expect(html).toContain('Thêm Danh mục chi')
    expect(html).toContain('for="')
  })

  it('says a section is empty rather than showing a bare add box', () => {
    const html = renderToStaticMarkup(<CategoryChipList {...PROPS} items={[]} />)
    expect(html).toContain('categories.emptyTitle')
  })
})
```

`components/categories/category-chip-list.tsx` — replacing `components/categories/named-list-manager.tsx` entirely:

1. Keep the `Item` type (`named-list-manager.tsx:7`) and both server-action props (`:19-20`) — the page's `'use server'` closures are unchanged, so the whole categories data path is untouched.
2. Delete the module-level `GENERIC_ERROR` literal (`:9`) — use `t(GENERIC_ERROR_KEY)`.
3. Replace the `<h2>` (`:53`) with `<SectionHeader title={title} />`.
4. Replace the `<ul>` of bordered `<li>`s (`:54-65`) with a wrapping chip row:
   ```tsx
   <ul className="flex flex-wrap gap-2">
     {items.map((item) => (
       <li
         key={item.id}
         className={cn(
           'inline-flex items-center gap-1 rounded-full py-1 pl-3 text-sm',
           item.isDefault
             ? 'bg-muted pr-3 text-muted-foreground'
             : 'border border-border pr-1 text-foreground',
         )}
       >
         <span>{item.name}</span>
         {!item.isDefault && (
           <RowActionsMenu
             label={t('common.rowActions', { name: item.name })}
             actions={[
               {
                 id: 'archive',
                 label: archiveLabel,
                 tone: 'negative',
                 onSelect: () => setPendingArchive(item),
               },
             ]}
           />
         )}
       </li>
     ))}
   </ul>
   ```
   A default item is quiet and menu-less because it cannot be archived — the server action refuses it, and offering the option would be a promise the service breaks (the current code already hides its button for the same reason, `:58`).
5. Replace the empty case with `<p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{t('categories.emptyTitle')}</p>`.
6. Replace the add row (`:66-76`) with a `FormField`-labelled input:
   ```tsx
   <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
     <FormField id={`${sectionId}-new`} label={addLabel} className="flex-1">
       {(aria) => (
         <Input
           {...aria}
           value={name}
           onChange={(event) => setName(event.target.value)}
           placeholder={addPlaceholder}
         />
       )}
     </FormField>
     <Button type="button" onClick={handleAdd} disabled={submit.locked || name.trim() === ''}>
       {submit.pending ? t('categories.addPending') : t('categories.addAction')}
     </Button>
   </div>
   ```
   `sectionId` is `useId()`; the input stays **controlled** as it is today (`:68-69`) — it always was, it has no `defaultValues` entry and therefore no reversion risk, and `useHydrated` was never applied here for exactly that reason (`lib/ui/use-hydrated.ts` documents the "field with NO default reads the DOM instead of writing over it" branch). Say so in a comment so a later reader does not "fix" it by adding a gate.
7. Replace `pending` (`:23`) with `useSubmitState()`; wrap `handleAdd`'s body (`:26-39`) in `submit.run`.
8. Add the archive `ConfirmDialog`, `title={confirmTitle}` / `description={confirmBody}`.
9. Errors become `<InlineAlert tone="negative">`.

Run: `npx vitest run components/categories/category-chip-list.test.tsx` → PASS (4 tests).

- [ ] **Step 7: Rewrite `app/(app)/categories/page.tsx`'s render**

Keep `:11-19` — the redirect, the `Promise.all`, and the three server-action closures at `:26-57` — **exactly** as they are; only the layout and the props change:

```tsx
  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader title={t('categories.title')} description={t('categories.description')} />

      {/* One column, not the two-column grid this page had: the three sections
          have wildly different lengths (three account types beside twenty
          expense categories), and a grid put a short list next to a long one
          with a ragged gap between them. */}
      <div className="flex flex-col gap-8">
        <CategoryChipList
          title={t('categories.accountTypes')}
          items={accountTypes}
          addLabel={t('categories.addLabel', { section: t('categories.accountTypes') })}
          addPlaceholder={t('categories.addPlaceholder')}
          archiveLabel={t('categories.archiveAction')}
          onCreate={async (name) => {
            'use server'
            await createAccountTypeAction({ name })
          }}
          onArchive={async (id) => {
            'use server'
            await archiveAccountTypeAction(id)
          }}
        />
        <CategoryChipList
          title={t('categories.expenseCategories')}
          items={expenseCategories}
          addLabel={t('categories.addLabel', { section: t('categories.expenseCategories') })}
          addPlaceholder={t('categories.addPlaceholder')}
          archiveLabel={t('categories.archiveAction')}
          onCreate={async (name) => {
            'use server'
            await createCategoryAction({ name, type: 'EXPENSE' })
          }}
          onArchive={async (id) => {
            'use server'
            await archiveCategoryAction(id)
          }}
        />
        <CategoryChipList
          title={t('categories.incomeCategories')}
          items={incomeCategories}
          addLabel={t('categories.addLabel', { section: t('categories.incomeCategories') })}
          addPlaceholder={t('categories.addPlaceholder')}
          archiveLabel={t('categories.archiveAction')}
          onCreate={async (name) => {
            'use server'
            await createCategoryAction({ name, type: 'INCOME' })
          }}
          onArchive={async (id) => {
            'use server'
            await archiveCategoryAction(id)
          }}
        />
      </div>
    </div>
  )
```

**Careful — `confirmTitle` needs the item's name**, which only the chip list knows. Change `CategoryChipList`'s prop to `confirmTitleFor: (name: string) => string`? No — a function prop cannot cross from a server page to a client component. Instead pass `confirmTitleTemplate: string` (the raw ICU string, `t.raw('categories.archiveConfirmTitle')` is not interpolatable client-side either) — so the honest fix is to have `CategoryChipList` call `useTranslations()` itself for that one message: it is already a client component, so `const t = useTranslations()` and `t('categories.archiveConfirmTitle', { name: pendingArchive.name })` inside it. Drop `confirmTitle`/`confirmBody` from the props entirely and let the component translate those two. Update the **Interfaces** block above and the test's `PROPS` accordingly. The section title, add label, placeholder and archive label stay as props, because those differ per section and the page is where the section is known.

- [ ] **Step 8: Update the affected e2e specs**

`e2e/helpers.ts:43-56` — `createAccountViaUi`:
```ts
export async function createAccountViaUi(
  page: Page,
  opts: { name: string; currency: 'VND' | 'USD'; initialBalance: number },
): Promise<void> {
  await page.goto('/accounts')
  // The create form lives in a Sheet behind the header's button (spec §6.4).
  await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm tài khoản|Add account/ })
  const nameInput = sheet.getByLabel(/Tên tài khoản|Account name/)
  await nameInput.fill(opts.name)
  if (opts.currency !== 'VND') {
    await sheet.getByLabel(/^Tiền tệ$|^Currency$/).selectOption(opts.currency)
  }
  await sheet.getByLabel(/Số dư ban đầu|Initial balance/).fill(String(opts.initialBalance))
  await sheet.getByRole('button', { name: /Tạo tài khoản|Create account/ }).click()
  // A successful submit resets the form, which clears the name field — and the
  // sheet closes itself, so wait for that instead: it is the app's own
  // confirmation that the account was created.
  await expect(sheet).toBeHidden()
}
```
Keep the helper's doc comment and update its last sentence to say the sheet closing is now the proof of success.

`e2e/transactions-empty-state.spec.ts`:
- `:60,90,104` — `NOTICE` is `accounts.asOfNow`; change the constant to the English string above and match with a regex alternation.
- `:84` — `getByRole('button', { name: 'Archive' })`: archive is now a `RowActionsMenu` item plus a `ConfirmDialog`. Replace with:
  ```ts
  await page.getByRole('button', { name: /Tác vụ cho Old|Actions for Old/ }).click()
  await page.getByRole('menuitem', { name: /Lưu trữ|^Archive$/ }).click()
  const confirm = page.getByRole('dialog')
  await confirm.getByRole('button', { name: /Lưu trữ|^Archive$/ }).click()
  await expect(confirm).toBeHidden()
  ```
  and **delete the `page.once('dialog', …)` handler** that answered `window.confirm` — there is no native dialog any more. Grep the file for `page.once('dialog'` and remove every one that answered an archive/delete confirm.
- `:87` — `getByText('Archived accounts (1)')` → `/Tài khoản đã lưu trữ \(1\)|Archived accounts \(1\)/`.

`e2e/phase4.spec.ts:196-200` — the Accounts tab assertion is a nav label (already handled in Task 3); no change here.

`e2e/phase6.spec.ts` — calls `createAccountViaUi` only; Step 8's helper rewrite covers it. Confirm with a run.

Run: `npx playwright test` → green. Every spec that previously answered a `window.confirm` for an account archive must now be answering a `ConfirmDialog`; grep for stragglers: `grep -rn "page.once('dialog'" e2e` and check each remaining one belongs to a module a later task owns (budgets → Task 7, goals/debts/loans → Tasks 7–8, transfers/transactions → already gone in Task 5).

- [ ] **Step 9: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

- [ ] **Step 10: Browser visual check — Accounts and Categories**

Seed a user with 4 accounts (one negative, one USD, one archived) and the default categories plus two custom ones per section.

Screenshot, light and dark: `/accounts` at 1440, 768, 375 (6); `/accounts` at 1440 with the create sheet open (2); `/accounts` at 1440 with the edit dialog open (2); `/accounts` at 1440 with the archive `ConfirmDialog` open (2); `/accounts` at 1440 for an FX-unavailable user — simulate by stubbing the FX provider route, or by asserting the "—" path with a user whose accounts are all in the base currency and reading the `not-needed` branch instead, and say which was used (1); `/categories` at 1440, 768, 375 (6). Nineteen screenshots.

Look for: the header total present and right; the balance column aligned across rows; the negative balance red; the `…` menu keyboard-operable (Tab to it, Enter, arrow down, Enter); the edit dialog centred at 1440 and bottom-anchored at 375; the archive dialog's copy naming the zero-balance rule; the archived `<details>` muted and action-free; default chips visibly quieter than custom ones; the inline add input labelled per section; nothing overflowing at 375.

- [ ] **Step 11: 🛑 VISUAL CHECKPOINT 3 — Transactions / Transfers / Accounts / Categories (spec §11)**

**The controller STOPS here and does not start Task 7 until the product owner approves.**

Hand over: `/transactions` 1440 light, `/transactions` 375 light (full page), `/transactions` 375 light with the create sheet, `/transactions` 1440 dark, `/transfers` 1440 light showing a cross-currency row, `/transfers` 375 light, `/accounts` 1440 light, `/accounts` 1440 light with the archive ConfirmDialog, `/accounts` 375 light, `/categories` 1440 light, `/categories` 375 light. Eleven images.

Report alongside them: the measured x-position of the amount column across three transaction rows at 375; confirmation that no `window.confirm` remains in `components/transactions`, `components/transfers` or `components/accounts` (`grep -rn "window.confirm" components` output); and the list of e2e `page.once('dialog')` handlers still remaining, with the task that owns each.

**Tests required:**
- Vitest: `components/accounts/account-list.test.tsx` (4 new); `components/categories/category-chip-list.test.tsx` (4 new); `components/accounts/account-form` — add a static-markup test asserting the SSR HTML carries `<fieldset disabled`, five `<label for=`, and `accountTypeId`'s first-option default.
- Playwright: `e2e/helpers.ts`'s `createAccountViaUi` rewritten; `e2e/transactions-empty-state.spec.ts` fully green with the native-dialog handlers removed.

**Browser visual checks required:** the nineteen screenshots in Step 10 and the eleven-image checkpoint package in Step 11.

**Explicit things NOT to change:** `countFutureDatedEntries` and the "not a balance input" comment; the single `now`; `getCurrentAccountBalances` vs `getAccountBalances` and the comment explaining the choice (`app/(app)/accounts/page.tsx:44-50`); `accountsWithActivity` and the `locked` semantics; `AccountEditForm`'s locked-field omission logic; `createFinancialAccountSchema`/`updateFinancialAccountSchema`; the three category server actions and the page's `'use server'` closures; `listAccountTypes`/`listCategories`; the fact that default items cannot be archived.

**Completion gate:** all four commands green; nineteen screenshots inspected; `grep -rn "window.confirm" components/accounts components/categories` returns nothing; every field on both pages has a visible label (verify with a driver script that lists every `input`/`select` on `/accounts` with the sheet and dialog open and asserts each has an associated `<label>`); checkpoint package delivered and **approved**.

**Proposed commit boundary:**
1. `feat(accounts): one-card list with a row actions menu, the header total, a sheet create form and ConfirmDialog for archive`
2. `feat(categories): three labelled chip sections with per-item archive confirmation`

---
## Task 7: Budgets and Savings Goals

**Objective:** Rebuild `/budgets` and `/goals` on the shared `PlanningRow` (spec §6.5): title + `StatusBadge`, a one-line figure "3.720.000 / 20.000.000 VND · còn 16.280.000 · 19 %", a 6 px `Progress`, a meta line, and actions — with the month navigation as a `SegmentedControl`, budget status tones mapped Healthy→positive / Approaching→warning / Exceeded→negative, savings meta "Còn 114 ngày (31/12/2026)" or "Đạt mục tiêu", "Cập nhật tiến độ" as the one inline action opening a small `Dialog`, and Edit/Delete/Archive in `…` with `ConfirmDialog` for the two destructive ones.

**Major files touched:** `app/(app)/budgets/page.tsx`, `app/(app)/goals/page.tsx`, `components/budgets/budget-progress-list.tsx`, `components/budgets/budget-row-actions.tsx`, `components/budgets/budget-form.tsx`, `components/budgets/month-nav.tsx`, `components/goals/goal-list.tsx`, `components/goals/goal-row-actions.tsx`, `components/goals/goal-form.tsx`, `lib/ui/budget-view-model.ts`, `lib/ui/savings-goal-view-model.ts`, `messages/{vi,en}/budgets.json`, `messages/{vi,en}/goals.json`, `e2e/helpers.ts`, `e2e/phase5.spec.ts`, `e2e/phase6.spec.ts`.

**Reusable primitives involved:** `PageHeader`, `SectionHeader`, `PlanningRow`, `Progress`, `StatusBadge`, `MoneyText`, `EmptyState`, `InlineAlert`, `FormField`, `Dialog`, `ConfirmDialog`, `Sheet`, `RowActionsMenu`, `SegmentedControl`, `useSubmitState`.

**User-facing behaviour:** Budgets shows the month as a segmented control (‹ Tháng trước · Tháng này · Tháng sau ›), one card of rows, and "Thêm ngân sách" in the header opening a sheet. Each row states spent/limit, what is left, the percentage and a toned badge. Savings shows rows with progress and a deadline meta; "Cập nhật tiến độ" is one inline button per row opening a small dialog with a single amount field; Sửa and Lưu trữ live in `…`, and archiving asks first. Archived goals sit in a read-only `<details>`.

**Desktop expectation:** both pages `max-w-[60rem]`, `p-8`; one bordered card per list with `divide-y` rows; the header's segmented control sits in `PageHeader`'s `actions` slot beside the create button at ≥ 640; figures right-aligned inside the figure line, progress full width beneath.

**Mobile expectation:** the segmented control scrolls horizontally inside its own track (it is a *secondary* filter, which spec §7 permits) while nothing else on the page does; the figure line wraps after the "/ limit" part rather than mid-number; the inline "Cập nhật tiến độ" button is full width above the `…` trigger at < 480, side by side above it.

**Dark-theme expectation:** the three budget tones read as tints (`bg-positive/18`, `bg-warning/18`, `bg-negative/18`) on `--surface`; the progress track is `bg-muted`; a savings bar stays `bg-brand` at every status (a nearly-met goal must not look like a warning — the current `GoalList` doc explains exactly this and the reasoning carries over); the passed-deadline meta is `--warning` at dark L≈0.74.

**Vietnamese/English expectation:** every string from `budgets.json`/`goals.json` and every status from `labels.json` via `budgetStatusLabelKey`/`goalStatusLabelKey`. The figure lines are ICU messages, not concatenation: `budgets.figureLine` = `"{spent} / {limit} {currency} · còn {remaining} · {percent}"` and its over-budget sibling `budgets.figureLineOver` = `"{spent} / {limit} {currency} · vượt {over} · {percent}"`. Deadlines come from `formatDate(deadline, { style: 'date' })` and the days-left count from `goals.deadlineMeta` with an ICU plural.

**Accessibility acceptance criteria:** one `h1` per page; the archived `<details>` summary states its count; `Progress` keeps its exact ARIA contract (clamped `aria-valuenow`, true `aria-valuetext`) — the four hand-rolled bars in `BudgetProgressList`, `GoalList`, `DebtList` and `LoanList` are replaced by it and must not lose it; every form field gets a visible label (today `budget-form.tsx` has four `aria-label`-only controls, `goal-form.tsx` six, `goal-row-actions.tsx` six); the inline progress button's `aria-label` names its goal; the archive/delete confirmations are `ConfirmDialog`s; the month control is a `<nav>` with `aria-label` and `aria-current="page"` on the selected month.

**Hydration/form-submission constraints:** `BudgetForm` keeps its `useHydrated()` gate (`components/budgets/budget-form.tsx:68,113-117`) **and** its `defaultScope(overallExists)` `defaultValue` on the scope select (`:22-31,124-131`) — that default flips per month, so the server-rendered `selected` must match it or the form submits a scope the user never chose. `GoalForm` keeps its gate (`components/goals/goal-form.tsx:36,67-72`) and its currency select's `defaultValue`. The two row-action forms mount inside a `Dialog` on open, so they need no gate — `components/goals/goal-row-actions.tsx:39-43` already says exactly that ("no `useHydrated` here — a click cannot happen before hydration"); keep that comment. All five forms get `useSubmitState`.

**Files:**
- Create: `components/budgets/budget-create-button.tsx`, `components/goals/goal-create-button.tsx`
- Modify (the phase's third named boundary exception — an additive **move**, see Global Constraints): `lib/datetime/calendar-date.ts` (gains `calendarDaysBetween`, moved down from `lib/ui/reminder-view-model.ts:89-104` with its doc comment intact), `lib/datetime/calendar-date.test.ts` (gains three cases for it)
- Modify: `app/(app)/budgets/page.tsx:94-146`, `app/(app)/goals/page.tsx:55-89`, `components/budgets/budget-progress-list.tsx:1-101` (whole file), `components/budgets/budget-row-actions.tsx:1-127` (whole file), `components/budgets/budget-form.tsx:113-186`, `components/budgets/month-nav.tsx:1-77` (whole file), `components/goals/goal-list.tsx:1-96` (whole file), `components/goals/goal-row-actions.tsx:44-277`, `components/goals/goal-form.tsx:67-154`, `lib/ui/budget-view-model.ts:22-81`, `lib/ui/savings-goal-view-model.ts:29-122`, `messages/{vi,en}/budgets.json`, `messages/{vi,en}/goals.json`
- Test: `components/budgets/budget-progress-list.test.tsx` (new), `components/goals/goal-list.test.tsx` (new), `lib/datetime/calendar-date.test.ts` (+3 for the extracted `calendarDaysBetween`), `lib/ui/budget-view-model.test.ts`, `lib/ui/savings-goal-view-model.test.ts`, `e2e/helpers.ts:121-144`, `e2e/phase5.spec.ts`, `e2e/phase6.spec.ts:196-215,440-497`

**Interfaces:**

- Consumes: every Task 1a–1c primitive; `formatDate`, `formatMoney`; `budgetStatusLabelKey`, `goalStatusLabelKey`; `BUDGET_ERROR_KEYS`, `SAVINGS_GOAL_ERROR_KEYS`, `GENERIC_ERROR_KEY`; `useSubmitState`; `useHydrated`.
- Produces:

```ts
// lib/datetime/calendar-date.ts — MOVED here from lib/ui/reminder-view-model.ts
/**
 * How many calendar days there are from `from` to `to`, both `yyyy-MM-dd`.
 * Carrier arithmetic in UTC, never instant arithmetic — the moved doc comment
 * explains why (a DST change makes a real three-day gap measure 71 hours).
 */
export function calendarDaysBetween(from: string, to: string): number

// lib/ui/budget-view-model.ts — CHANGED
export interface BudgetProgressDto {
  id: string
  /** The category name, or `null` for an OVERALL budget — the component then
   *  renders `labels.budgetScope.OVERALL`. Was the literal 'Overall'. */
  categoryName: string | null
  scope: 'OVERALL' | 'CATEGORY'
  categoryArchived: boolean
  currency: Currency
  amount: string
  spent: string
  remaining: string
  over: boolean
  percent: number
  percentLabel: string
  status: BudgetStatus
  /** REMOVED: `statusLabel`. The component calls `budgetStatusLabelKey`. */
  editable: { amount: string; currency: Currency }
}

// lib/ui/savings-goal-view-model.ts — CHANGED
export interface SavingsGoalDto {
  id: string
  name: string
  currency: Currency
  status: SavingsGoalStatus
  /** REMOVED: `statusLabel`. The component calls `goalStatusLabelKey`. */
  target: string
  progress: string
  remaining: string
  percent: number
  percentLabel: string
  /** `yyyy-MM-dd` carrier or `null` — the component formats it. */
  deadline: string | null
  deadlinePassed: boolean
  /** NEW: whole days from `today` to `deadline`, or `null`. Negative when
   *  passed. Computed on the `Decimal`-free carrier arithmetic already in this
   *  module, so the component does no date maths. */
  daysToDeadline: number | null
  editable: { name: string; targetAmount: string; currency: Currency; deadline: string; note: string; currentProgress: string }
}

// components/budgets/budget-progress-list.tsx  (server component)
export function BudgetProgressList(props: {
  budgets: BudgetProgressDto[]
  locale: Locale
  compact?: boolean
  renderActions?: (budget: BudgetProgressDto) => ReactNode
}): React.ReactElement

// components/goals/goal-list.tsx  (server component)
export function GoalList(props: {
  goals: SavingsGoalDto[]
  locale: Locale
  timeZone: string
  compact?: boolean
  renderActions?: (goal: SavingsGoalDto) => ReactNode
}): React.ReactElement
```

- [ ] **Step 1: Add the message keys**

`messages/vi/budgets.json`:
```json
{
  "title": "Ngân sách",
  "monthLabel": "{month}",
  "monthNav": "Tháng của ngân sách",
  "monthPrevious": "‹ Tháng trước",
  "monthCurrent": "Tháng này",
  "monthNext": "Tháng sau ›",
  "pastMonthNote": "Tháng đã qua — chi tiêu được cộng theo tỷ giá đã ghi của từng giao dịch; nhập một khoản chi lùi ngày vẫn tính vào tháng này.",
  "spendingNote": "Chỉ tính giao dịch chi, quy đổi theo tỷ giá đã ghi của từng giao dịch.",
  "figureLine": "{spent} / {limit} {currency} · còn {remaining} · {percent}",
  "figureLineOver": "{spent} / {limit} {currency} · vượt {over} · {percent}",
  "categoryArchived": "(đã lưu trữ)",
  "createTitle": "Thêm ngân sách",
  "createAction": "Thêm ngân sách",
  "createPending": "Đang thêm…",
  "openCreate": "Thêm ngân sách",
  "scope": "Phạm vi",
  "category": "Danh mục",
  "categoryPlaceholder": "Chọn danh mục",
  "amount": "Hạn mức",
  "currency": "Tiền tệ",
  "editTitle": "Sửa ngân sách {name}",
  "editAction": "Sửa",
  "deleteAction": "Xóa",
  "deleteConfirmTitle": "Xóa ngân sách {name}?",
  "deleteConfirmBody": "Lịch sử chi tiêu không bị ảnh hưởng.",
  "deletePending": "Đang xóa…",
  "emptyTitle": "Chưa có ngân sách cho {month}",
  "emptyBody": "Đặt hạn mức cho tháng này để theo dõi chi tiêu."
}
```
`messages/en/budgets.json`: the same keys; keep `"createAction": "Add budget"`, `"scope": "Budget scope"`, `"category": "Budget category"`, `"amount": "Budget amount"`, `"currency": "Budget currency"` — those five are the accessible names `e2e/helpers.ts:132-142` selects by, and keeping the English wording identical means only the vi alternation has to be added there. `"monthPrevious": "‹ Previous"`, `"monthCurrent": "This month"`, `"monthNext": "Next ›"`, `"pastMonthNote"` and `"spendingNote"` verbatim from `app/(app)/budgets/page.tsx:106-109,122-125`, `"figureLine": "{spent} / {limit} {currency} · {remaining} left · {percent}"`, `"figureLineOver": "{spent} / {limit} {currency} · {over} over · {percent}"`, `"emptyTitle": "No budgets for {month}"`.

`messages/vi/goals.json`:
```json
{
  "title": "Mục tiêu tiết kiệm",
  "description": "Mục tiêu tự nhập — không có gì ở đây làm dịch chuyển tiền",
  "figureLine": "{progress} / {target} {currency} · {percent}",
  "deadlineMeta": "Còn {count, plural, other {# ngày}} ({date})",
  "deadlinePassed": "Đã qua hạn {date}",
  "achieved": "Đạt mục tiêu",
  "remaining": "Còn thiếu {amount} {currency}",
  "createTitle": "Thêm mục tiêu",
  "createAction": "Thêm mục tiêu",
  "createPending": "Đang thêm…",
  "openCreate": "Thêm mục tiêu",
  "name": "Tên mục tiêu",
  "namePlaceholder": "Ví dụ: MacBook",
  "target": "Số tiền mục tiêu",
  "current": "Đã tiết kiệm (tùy chọn)",
  "currency": "Tiền tệ",
  "deadline": "Hạn hoàn thành",
  "note": "Ghi chú (tùy chọn)",
  "progressAction": "Cập nhật tiến độ",
  "progressTitle": "Cập nhật tiến độ · {name}",
  "progressField": "Số tiền hiện có",
  "progressPending": "Đang lưu…",
  "editTitle": "Sửa {name}",
  "editAction": "Sửa",
  "archiveAction": "Lưu trữ",
  "archiveConfirmTitle": "Lưu trữ {name}?",
  "archiveConfirmBody": "Mục tiêu vẫn xem được trong phần Đã lưu trữ, nhưng không thể thay đổi.",
  "archivePending": "Đang lưu trữ…",
  "archivedSection": "Mục tiêu đã lưu trữ ({count})",
  "emptyTitle": "Chưa có mục tiêu tiết kiệm",
  "emptyBody": "Đặt mục tiêu đầu tiên để theo dõi tiến độ."
}
```
`messages/en/goals.json`: keep `"name": "Goal name"`, `"target": "Target amount"`, `"current": "Current amount"`, `"currency": "Goal currency"`, `"deadline": "Deadline"`, `"note": "Goal note"`, `"createAction": "Add goal"`, `"progressAction": "Update progress"`, `"archiveAction": "Archive"`, `"editAction": "Edit"`, `"archivedSection": "Archived goals ({count})"`, `"description": "Manual targets — nothing here moves money"`, `"deadlineMeta": "{count, plural, one {# day} other {# days}} left ({date})"`, `"deadlinePassed": "Deadline passed {date}"`, `"achieved": "Achieved"`, `"remaining": "{amount} {currency} to go"`, `"emptyTitle": "No savings goals yet"` — the last one loses the "— add one below." tail because the create form is no longer below (it is in a sheet), and `e2e/phase6.spec.ts:434,489` assert that exact string; Step 8 updates them.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS.

- [ ] **Step 2: Change the two view models to emit keys and a day count**

`lib/ui/budget-view-model.ts`:
1. `:24-25` — replace `/** 'Overall' for OVERALL scope, else the category name. */ label: string` with `categoryName: string | null` and the comment "The category name, or `null` for an OVERALL budget: 'Overall' is a WORD in one language, and the component that renders the row has a translator (`labels.budgetScope.OVERALL`) while this pure function does not."
2. `:40` — delete `statusLabel: string`.
3. `:46-56` — delete `BUDGET_STATUS_LABELS` and its doc comment entirely; `budgetStatusLabelKey` (Task 2a) replaces it, and `messages/en/labels.json` already carries its five values verbatim.
4. `:66,78` — `label: budget.scope === 'OVERALL' ? 'Overall' : (budget.category?.name ?? '')` becomes `categoryName: budget.category?.name ?? null`, and `statusLabel: BUDGET_STATUS_LABELS[status]` is deleted.
5. `formatMoney` calls gain a `locale` parameter: add `locale: Locale = DEFAULT_LOCALE` as `toBudgetProgressDto`'s second parameter and thread it into all four `formatMoney` calls (`:71-74`). Defaulting to `vi` means `lib/ui/budget-view-model.test.ts`'s existing expectations and `buildDashboardViewModel`'s call (`dashboard-view-model.ts:400`) keep working untouched.

`lib/ui/savings-goal-view-model.ts`:
1. `:34` — delete `statusLabel: string`.
2. `:68-77` — delete `SAVINGS_GOAL_STATUS_LABELS` and its doc comment; `goalStatusLabelKey` replaces it.
3. Add `daysToDeadline: number | null` to the DTO with the comment "Whole calendar days from the user's today to the deadline; negative when it has passed, `null` when the goal has none. Computed here, on the same UTC-midnight carrier arithmetic the rest of this module uses, so the component does no date maths and the ICU plural in `goals.deadlineMeta` gets a plain number."
4. Compute it with the existing `compareCalendarDates`/carrier helpers — import `calendarDateToUtcCarrier` and divide by `MS_PER_DAY` exactly as `lib/ui/reminder-view-model.ts:100-103`'s `calendarDaysBetween` does; **extract that function** to `lib/datetime/calendar-date.ts` as `calendarDaysBetween(from, to)` with its whole doc comment (it explains why carrier arithmetic and not instant arithmetic, which is the same reason here) and import it in both modules rather than writing a second copy.
5. `:100` — delete `statusLabel: SAVINGS_GOAL_STATUS_LABELS[goal.status]`.
6. Add `locale: Locale = DEFAULT_LOCALE` as `toSavingsGoalDto`'s third parameter and thread it into the four `formatMoney` calls (`:103-105`).

Add to `lib/datetime/calendar-date.test.ts` two cases for the extracted `calendarDaysBetween`: `('2026-09-08','2026-09-11') === 3` and `('2026-09-11','2026-09-08') === -3`, plus one across a DST boundary in a zone that has one (`('2026-03-28','2026-03-30') === 2`), since the whole point of carrier arithmetic is that a DST shift cannot shorten a day.

Update `lib/ui/budget-view-model.test.ts` and `lib/ui/savings-goal-view-model.test.ts`: every `statusLabel` assertion becomes a `status` assertion (`expect(dto.status).toBe('warning_80')` instead of `expect(dto.statusLabel).toBe('Approaching limit')`), every `label: 'Overall'` becomes `categoryName: null`, and add one `daysToDeadline` case per sign.

- [ ] **Step 3: Write the failing tests for the two lists**

`components/budgets/budget-progress-list.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}|${JSON.stringify(args)}` : key,
}))

import { BudgetProgressList } from './budget-progress-list'
import type { BudgetProgressDto } from '@/lib/ui/budget-view-model'

function dto(overrides: Partial<BudgetProgressDto> = {}): BudgetProgressDto {
  return {
    id: 'b1',
    categoryName: 'Ăn uống',
    scope: 'CATEGORY',
    categoryArchived: false,
    currency: 'VND',
    amount: '20.000.000',
    spent: '3.720.000',
    remaining: '16.280.000',
    over: false,
    percent: 19,
    percentLabel: '19 %',
    status: 'ok',
    editable: { amount: '20000000.00', currency: 'VND' },
    ...overrides,
  }
}

describe('BudgetProgressList', () => {
  it('renders the spec’s figure line with spent, limit, remaining and percent', async () => {
    const html = renderToStaticMarkup(await BudgetProgressList({ budgets: [dto()], locale: 'vi' }))
    expect(html).toContain('budgets.figureLine')
    expect(html).toContain('3.720.000')
    expect(html).toContain('20.000.000')
    expect(html).toContain('16.280.000')
    expect(html).toContain('19 %')
  })

  it('switches to the over-budget wording rather than a negative "remaining"', async () => {
    const html = renderToStaticMarkup(
      await BudgetProgressList({
        budgets: [dto({ over: true, remaining: '2.000.000', status: 'exceeded', percentLabel: '110 %' })],
        locale: 'vi',
      }),
    )
    expect(html).toContain('budgets.figureLineOver')
    expect(html).not.toContain('budgets.figureLine|')
  })

  it('maps the five status bands onto the spec’s three tones', async () => {
    const tones: Record<BudgetProgressDto['status'], string> = {
      ok: 'text-positive',
      warning_50: 'text-positive',
      warning_80: 'text-warning',
      at_100: 'text-negative',
      exceeded: 'text-negative',
    }
    for (const [status, tone] of Object.entries(tones)) {
      const html = renderToStaticMarkup(
        await BudgetProgressList({
          budgets: [dto({ status: status as BudgetProgressDto['status'] })],
          locale: 'vi',
        }),
      )
      expect(html, status).toContain(tone)
    }
  })

  it('announces the true percentage even when the bar is clamped', async () => {
    const html = renderToStaticMarkup(
      await BudgetProgressList({
        budgets: [dto({ percent: 100, percentLabel: '120 %', status: 'exceeded', over: true })],
        locale: 'vi',
      }),
    )
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuetext="120 %"')
  })

  it('labels an OVERALL budget from the enum key, never the word "Overall"', async () => {
    const html = renderToStaticMarkup(
      await BudgetProgressList({
        budgets: [dto({ scope: 'OVERALL', categoryName: null })],
        locale: 'vi',
      }),
    )
    expect(html).toContain('labels.budgetScope.OVERALL')
    expect(html).not.toContain('>Overall<')
  })
})
```

`components/goals/goal-list.test.tsx`: the same shape, asserting (1) the figure line uses `goals.figureLine` with progress/target/percent; (2) the bar is `bg-brand` at every status — including `ACHIEVED` — because a nearly-met goal must not look like a warning; (3) `daysToDeadline: 114` renders `goals.deadlineMeta` with `{count: 114}`; (4) `deadlinePassed: true` renders `goals.deadlinePassed` and `text-warning`; (5) `status: 'ACHIEVED'` renders `labels.goalStatus.ACHIEVED` and **not** the deadline meta ("saved after the date is still saved" — the current DTO already encodes that in `deadlinePassed`); (6) the true percentage is announced when the bar is clamped.

Run both → FAIL.

- [ ] **Step 4: Rewrite `BudgetProgressList` and `GoalList` on `PlanningRow`**

`components/budgets/budget-progress-list.tsx` — per-change list:
1. Becomes an `async` server component using `getTranslations` (it is rendered from two server pages and never from a client component — verify with `grep -rn "BudgetProgressList" app components`; the dashboard and the budgets page are the only callers, both server).
2. Delete `STATUS_TEXT_COLOR`/`STATUS_FILL_COLOR` (`:20-34`) and replace with one map to a `StatusTone` plus a `Progress` tone:
   ```ts
   /**
    * The spec's three tones (§6.5): Healthy → positive, Approaching → warning,
    * Exceeded → negative. Five bands map onto three because "over half used"
    * is still healthy and "at limit" is already exceeded in every way that
    * matters to the reader. The LABEL differs at every band regardless
    * (`labels.budgetStatus.*`), so nothing depends on seeing the colour.
    */
   const STATUS_TONE: Record<BudgetProgressDto['status'], StatusTone> = {
     ok: 'positive',
     warning_50: 'positive',
     warning_80: 'warning',
     at_100: 'negative',
     exceeded: 'negative',
   }
   ```
3. Replace the `<ul className="flex flex-col gap-2">` of bordered `<li>`s with `<ul className="divide-y divide-border">` inside the caller's card, and each `<li>` with a `PlanningRow`:
   - `title` = `budget.categoryName ?? t('labels.budgetScope.OVERALL')`, plus, when `categoryArchived`, a trailing `<span className="font-normal text-muted-foreground">{t('budgets.categoryArchived')}</span>`;
   - `badge` = `<StatusBadge label={t(budgetStatusLabelKey(budget.status))} tone={STATUS_TONE[budget.status]} />`;
   - `figureLine` = `t(budget.over ? 'budgets.figureLineOver' : 'budgets.figureLine', { spent: budget.spent, limit: budget.amount, currency: budget.currency, remaining: budget.remaining, over: budget.remaining, percent: budget.percentLabel })`;
   - `progress` = `<Progress percent={budget.percent} valueText={budget.percentLabel} label={budget.categoryName ?? t('labels.budgetScope.OVERALL')} tone={STATUS_TONE[budget.status] === 'positive' ? 'positive' : STATUS_TONE[budget.status] === 'warning' ? 'warning' : 'negative'} />`;
   - `actions` = `renderActions?.(budget)`;
   - `compact` drops `progress`'s label duplication and the `meta` line, exactly as today's `compact` drops the remaining line.
4. Delete the `role="progressbar"` block (`:72-88`) — `Progress` owns it now, with the identical attributes.
5. Keep the module doc's "used by both the Budgets page and the Dashboard's widget" and "never touches a `Prisma.Decimal`" paragraphs; replace the paragraph about the three-colour mapping with the new comment above.

`components/goals/goal-list.tsx` — the same treatment:
1. `async` server component with `getTranslations`; add `locale` and `timeZone` props (it needs `formatDate` for the deadline).
2. Delete `STATUS_TEXT_COLOR` (`:25-29`); the badge tone map is `{ ACTIVE: 'neutral', ACHIEVED: 'positive', ARCHIVED: 'muted' }`.
3. `PlanningRow` with `title={goal.name}`, `badge={<StatusBadge label={t(goalStatusLabelKey(goal.status))} tone={…} />}`, `figureLine={t('goals.figureLine', { progress: goal.progress, target: goal.target, currency: goal.currency, percent: goal.percentLabel })}`, `progress={<Progress percent={goal.percent} valueText={goal.percentLabel} label={goal.name} tone="brand" />}`.
4. `meta`: `goal.status === 'ACHIEVED' ? t('goals.achieved') : goal.deadline === null ? t('goals.remaining', { amount: goal.remaining, currency: goal.currency }) : goal.deadlinePassed ? t('goals.deadlinePassed', { date: formatDate(goal.deadline, { locale, timeZone, style: 'date' }) }) : t('goals.deadlineMeta', { count: goal.daysToDeadline ?? 0, date: formatDate(goal.deadline, { locale, timeZone, style: 'date' }) })` — wrapped in a `<span className={cn(goal.deadlinePassed && 'text-warning')}>`.
5. Keep the module doc's paragraph explaining why the bar is `bg-brand` at every status — it is exactly why `tone="brand"` is hard-coded above — and its "never touches a `Prisma.Decimal` or a `Date`" note, now qualified: the DTO's `deadline` is a *carrier string*, which is why `formatDate` can read it here.

Run both tests → PASS.

- [ ] **Step 5: Rewrite the month navigation as a `SegmentedControl`**

`components/budgets/month-nav.tsx` — keep the whole module doc (`:11-21`: the URL is the source of truth, and the `MIN_BUDGET_YEAR`/`MAX_BUDGET_YEAR` clamping is what stops the page linking outside the range the create form would reject). Replace `linkClass`/`disabledClass` and the three-link body (`:37-76`) with:

```tsx
  const segments: Segment[] = [
    ...(atMinYear
      ? []
      : [
          {
            id: 'previous',
            label: t('budgets.monthPrevious'),
            href: `/budgets?month=${formatCalendarMonth(previous)}`,
          },
        ]),
    {
      id: 'current',
      label: t('budgets.monthCurrent'),
      href: `/budgets?month=${formatCalendarMonth(current)}`,
    },
    ...(atMaxYear
      ? []
      : [
          {
            id: 'next',
            label: t('budgets.monthNext'),
            href: `/budgets?month=${formatCalendarMonth(next)}`,
          },
        ]),
  ]

  return (
    <SegmentedControl
      label={t('budgets.monthNav')}
      segments={segments}
      // Only "Tháng này" can be the SELECTED segment: previous/next are moves,
      // not states, and marking one of them current would claim the user is
      // "in" a relative month. At the ends of the range the unavailable move is
      // omitted rather than rendered disabled — a segmented control with a dead
      // segment invites a click that does nothing.
      activeId={isCurrent ? 'current' : null}
    />
  )
```
The component becomes `async` with `getTranslations` (its only caller is the server budgets page). Note in a comment that omitting a segment at the range's edge replaces the previous `aria-disabled` span, and why.

- [ ] **Step 6: Label every field in the four forms and add the two dialogs**

`components/budgets/budget-form.tsx` — replace `:118-186` field by field, keeping `:22-52` (the `defaultScope`/`defaultValues` helpers and their comments) and the fieldset's gate:

| Field | Today | Becomes |
|---|---|---|
| scope | `<select aria-label="Budget scope" defaultValue={defaultScope(overallExists)}>` | `<FormField id="budget-scope" label={t('budgets.scope')} error={errors.scope?.message}>{(aria) => <select {...aria} {...register('scope')} defaultValue={defaultScope(overallExists)} className={SELECT_CLASS}><option value="OVERALL">{t('labels.budgetScope.OVERALL')}</option><option value="CATEGORY">{t('labels.budgetScope.CATEGORY')}</option></select>}</FormField>` — **keep the `defaultValue`**, it flips per month |
| categoryId | `<select aria-label="Budget category" defaultValue="">` | `<FormField id="budget-category" label={t('budgets.category')} error={errors.categoryId?.message}>{(aria) => <select {...aria} {...register('categoryId', …)} defaultValue="" className={SELECT_CLASS}><option value="">{t('budgets.categoryPlaceholder')}</option>…</select>}</FormField>` — keep the existing `setValueAs`/register options verbatim |
| amount | `<Input aria-label="Budget amount" placeholder="Amount">` | `<FormField id="budget-amount" label={t('budgets.amount')} error={errors.amount?.message}>{(aria) => <Input {...aria} type="number" step="0.01" {...register('amount', { valueAsNumber: true })} />}</FormField>` |
| currency | `<select aria-label="Budget currency">` | `<FormField id="budget-currency" label={t('budgets.currency')} error={errors.currency?.message}>{(aria) => <select {...aria} {...register('currency')} className={SELECT_CLASS}><option value="VND">VND</option><option value="USD">USD</option></select>}</FormField>` |
| submit | `Add budget` | `{submit.pending ? t('budgets.createPending') : t('budgets.createAction')}` |

Plus `useSubmitState` wiring and `InlineAlert` for the form error. Read `components/budgets/budget-form.test.tsx` (114 lines) and update every `aria-label` assertion to the new `<label>`; keep whatever it asserts about the scope default.

`components/budgets/budget-row-actions.tsx` — restructure:
1. `BudgetRowActions` (`:23-58`) becomes a `RowActionsMenu` with two items — `{ id: 'edit', label: t('budgets.editAction'), onSelect: () => setEditing(true) }` and `{ id: 'delete', label: t('budgets.deleteAction'), tone: 'negative', onSelect: () => setConfirming(true) }` — plus a `Dialog` holding `BudgetEditForm` and a `ConfirmDialog` for delete.
2. Delete `window.confirm` (`:29`); the dialog's copy is `t('budgets.deleteConfirmTitle', { name })` / `t('budgets.deleteConfirmBody')` where `name` is `budget.categoryName ?? t('labels.budgetScope.OVERALL')`.
3. `BudgetEditForm` (`:60-127`): its two `aria-label`-only controls (`:100,108`) become `FormField`s with `t('budgets.amount')` / `t('budgets.currency')`; add `useSubmitState`; the error becomes `InlineAlert`; the Save/Cancel pair moves into the `Dialog`'s `footer`.
4. Keep the module doc's "`year`/`month`/`scope`/`categoryId` are a budget's identity and are never editable here" paragraph (`:14-22`) verbatim.

`components/goals/goal-form.tsx` — its six `aria-label` controls (`:75,85,97,121,134,139`) become `FormField`s with `t('goals.name')` (+ `helper={t('goals.namePlaceholder')}`), `t('goals.target')`, `t('goals.current')`, `t('goals.currency')`, `t('goals.deadline')`, `t('goals.note')`; keep the currency select's `defaultValue` and the fieldset gate; add `useSubmitState`; `InlineAlert` for the error.

`components/goals/goal-row-actions.tsx` — restructure `:44-92`:
1. The two toggle buttons become **one inline primary action** (`Cập nhật tiến độ`) plus a `RowActionsMenu` with Sửa and Lưu trữ. The amended spec §6.5 is explicit that it opens a **`Dialog`** — "one amount field, Save/Cancel — the same overlay primitive every other inline action uses" — not a popover: a popover would be a fifth overlay behaviour in a product that already has three, and it would not trap focus.
2. "Cập nhật tiến độ" opens a `Dialog` titled `t('goals.progressTitle', { name: goal.name })` containing `GoalProgressForm`, whose single field (`:135`) becomes a `FormField` with `t('goals.progressField')`.
3. Lưu trữ opens a `ConfirmDialog` (`t('goals.archiveConfirmTitle', { name })` / `t('goals.archiveConfirmBody')`), replacing `window.confirm` (`:50`).
4. `GoalEditForm`'s six `aria-label`s (`:207,221,235,246,258`) become `FormField`s reusing the `goals.*` keys.
5. Keep `:39-43`'s comment about no `useHydrated` here — it is still exactly right for a dialog-mounted form — and add `useSubmitState` to all three forms in the file.

- [ ] **Step 7: Rewrite the two pages' renders**

`app/(app)/budgets/page.tsx` — keep `:1-93` entirely (the month resolution, `isPastMonth`, `isBudgetableMonth` clamping, the `Promise.all`, `toBudgetProgressDto` mapping, `overallExists`, and every comment). Replace `:94-146`:

```tsx
  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('budgets.title')}
        description={formatDate(
          getCalendarMonthBounds(timezone, selected.year, selected.month).startUtc,
          { locale, timeZone: timezone, style: 'monthYear' },
        )}
        meta={isPastMonth(selected, current) ? t('budgets.pastMonthNote') : undefined}
        actions={
          <>
            <MonthNav selected={selected} current={current} />
            <BudgetCreateButton
              key={`${selected.year}-${selected.month}`}
              year={selected.year}
              month={selected.month}
              categories={categories.map((c) => ({ id: c.id, name: c.name }))}
              overallExists={overallExists}
            />
          </>
        }
      />

      {dtos.length === 0 ? (
        <EmptyState
          icon={Target}
          size="page"
          title={t('budgets.emptyTitle', {
            month: formatDate(
              getCalendarMonthBounds(timezone, selected.year, selected.month).startUtc,
              { locale, timeZone: timezone, style: 'monthYear' },
            ),
          })}
          description={t('budgets.emptyBody')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <BudgetProgressList
              budgets={dtos}
              locale={locale}
              renderActions={(budget) => <BudgetRowActions budget={budget} />}
            />
          </div>
          {/* Only qualifies figures that are actually on screen — the empty
              state above has none for this note to explain. */}
          <p className="text-xs/[1rem] text-muted-foreground">{t('budgets.spendingNote')}</p>
        </div>
      )}
    </div>
  )
```
`BudgetCreateButton` is a new client component (`components/budgets/budget-create-button.tsx`, add to Create) opening a `Sheet` with `BudgetForm`; the `key` stays on it so every per-month default is rebuilt when the month changes — keep the existing comment explaining that (`:132-136`), moved to the button.

`app/(app)/goals/page.tsx` — keep `:1-54` (the `STATUS_RANK` sort and its reasoning, `todayCalendarDateInZone`, `listAllSavingsGoals`, the DTO mapping). Replace `:55-89` with the same shape: `PageHeader` (title, `description={t('goals.description')}`, `actions={<GoalCreateButton />}`), the `EmptyState` (`icon={PiggyBank}`) or the card + `GoalList` with `renderActions`, and the archived `<details>` using `t('goals.archivedSection', { count })` with a read-only `GoalList` at `opacity-70` — keeping the existing comment about why archived rows get no actions (`:80-82`).

Thread `locale` and `timezone` into both of this page's `GoalList` calls (the active list and the archived one) and pass `locale` into `toSavingsGoalDto`.

**And update the dashboard's two call sites**, which Task 4 deliberately left on the old signatures: `app/(app)/dashboard/page.tsx`'s `<BudgetProgressList budgets={…} compact />` becomes `<BudgetProgressList budgets={…} locale={locale} compact />`, and `<GoalList goals={…} compact />` becomes `<GoalList goals={…} locale={locale} timeZone={timezone} compact />`. `npx tsc --noEmit` is what catches it if you forget.

- [ ] **Step 8: Update the affected e2e specs**

`e2e/helpers.ts:121-144` — `createBudgetViaUi`: the form is now in a sheet. Wrap:
```ts
  if (!opts.stayOnPage) await page.goto('/budgets')
  await page.getByRole('button', { name: /Thêm ngân sách|Add budget/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm ngân sách|Add budget/ })
  await sheet.getByLabel(/Phạm vi|Budget scope/).selectOption(opts.scope)
  if (opts.scope === 'CATEGORY') {
    if (!opts.categoryName) {
      throw new Error('createBudgetViaUi: categoryName is required when scope is CATEGORY')
    }
    await sheet
      .getByLabel(/Danh mục|Budget category/)
      .selectOption({ label: opts.categoryName })
  }
  await sheet.getByLabel(/Hạn mức|Budget amount/).fill(String(opts.amount))
  if (opts.currency && opts.currency !== 'VND') {
    await sheet.getByLabel(/Tiền tệ|Budget currency/).selectOption(opts.currency)
  }
  await sheet.getByRole('button', { name: /Thêm ngân sách|Add budget/ }).click()
  // Deliberately NOT asserted here: a duplicate submission is expected to
  // fail with an inline error rather than resetting the form, so the caller —
  // not this helper — asserts whichever outcome its scenario expects.
```
Keep the helper's `stayOnPage` doc paragraph verbatim — the "a client-side month change keeps the mounted form alive" case is still real, and now it means the *sheet's* form. **But** the sheet unmounts its form on close, so the stale-month case it exists to catch may no longer be reachable: run `e2e/phase5.spec.ts`'s that-case test and, if it now passes trivially, keep it (it still asserts the month merge) and add a sentence to the helper saying the sheet remounts the form so the staleness is now prevented structurally as well as by the merge.

`e2e/phase5.spec.ts` — the label changes:
- `:79-81` — the `h1` and the "Add budget" `h2`: `h1` → `/Ngân sách|^Budgets$/`; the `h2` assertion is now the sheet's title, so assert the sheet instead.
- `:80,230,251,285` — `getByText(/No budgets for/)` → `/Chưa có ngân sách cho|No budgets for/`.
- `:89,138,141,152,163,173,180,191,193,210,263,274,299` — the status labels: `'Healthy'` → `/Trong hạn mức|^Healthy$/`, `'Over half used'` → `/Đã dùng hơn nửa|Over half used/`, `'Approaching limit'` → `/Sắp vượt hạn mức|Approaching limit/`, `'At limit'` → `/Đã đến hạn mức|At limit/`, `'Exceeded'` → `/Vượt hạn mức|^Exceeded$/`. (`{ exact: true }` must go where a regex replaces the string.)
- `:174` — `getByText(/Over by/)` → the figure line now says "vượt {over}" / "{over} over": `/vượt |over$/`. Prefer asserting the row's text contains both figures instead: `await expect(row).toContainText('2.000.000')`.
- `:200-202,219` — Edit/Save/Delete: Edit and Delete are `RowActionsMenu` items now; Save lives in the edit `Dialog`'s footer; Delete raises a `ConfirmDialog`. Rewrite each as the menu-then-dialog sequence, and **delete the `page.once('dialog')` handler** for the budget delete.
- `:201` — `getByLabel('Edit Overall budget amount')` → the edit dialog's `getByLabel(/Hạn mức|Budget amount/)`.
- `:227,233` — `getByRole('link', { name: 'Previous' | 'This month' })` → `/‹ Tháng trước|‹ Previous/` and `/Tháng này|This month/`; the `aria-current` assertion still holds on "This month".
- `:231` — `getByText(/^Past month —/)` → `/^Tháng đã qua|^Past month —/`.
- `:292` — the dashboard widget heading (already handled in Task 4).

`e2e/phase6.spec.ts` — the goals half:
- `:196-215` — `createGoalViaUi`: the create form is in a sheet; wrap it the same way and change `getByLabel('Goal name'|'Target amount'|'Current amount')` to the vi/en alternations, and `getByRole('button', { name: 'Add goal' })` to the sheet's submit.
- `:434,489` — `'No savings goals yet — add one below.'` → `/Chưa có mục tiêu tiết kiệm|No savings goals yet/`.
- `:453,467,496` — `'In progress'`/`'Achieved'`/`'Archived'` → `/Đang thực hiện|In progress/`, `/Đạt mục tiêu|^Achieved$/`, `/Đã lưu trữ|^Archived$/`.
- `:460` — `getByText('Remaining 7.500.000')` → the figure/meta line changed: assert `await expect(row).toContainText('7.500.000')`.
- `:463-465` — Update progress and its field: `getByRole('button', { name: /Cập nhật tiến độ|Update progress/ })` then the dialog's `getByLabel(/Số tiền hiện có|Current amount/)` then its Save.
- `:471-472` — Edit is a menu item; the name field is `getByLabel(/Tên mục tiêu|Goal name/)` inside the edit dialog.
- `:486` — Archive is a menu item plus a `ConfirmDialog`; **delete its `page.once('dialog')` handler**.

Run: `npx playwright test` → green. Then `grep -rn "page.once('dialog'" e2e` and confirm the only remaining handlers belong to `/debts` and `/loans` (Task 8).

- [ ] **Step 9: Full verification**

Run: `npm run test` → green (both view-model suites updated, both new list tests, `budget-form.test.tsx` and `goal-form.test.tsx` migrated to `<label>` assertions, `lib/datetime/calendar-date.test.ts` +3).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

- [ ] **Step 10: Browser visual check — Budgets and Savings**

Seed: 4 budgets in the current month (one at 19 %, one at 84 %, one at 100 %, one at 120 %, one of them USD and one on an archived category), 4 goals (one at 42 % with a deadline 114 days out, one achieved, one with a passed deadline, one archived).

Screenshot, light and dark: `/budgets` at 1440, 768, 375 (6); `/budgets` at 1440 with the create sheet, the edit dialog, and the delete `ConfirmDialog` (3 light only); `/budgets?month=` a past month at 1440 light (1); `/goals` at 1440, 768, 375 (6); `/goals` at 1440 with the progress dialog and the archive `ConfirmDialog` (2 light only). Eighteen screenshots.

Look for: all four budget tones distinguishable in both themes and each with a *different word*; the figure line never wrapping mid-number at 375; the 120 % bar full but not overflowing; the segmented control showing "Tháng này" selected only when it is; the archived-category budget carrying "(đã lưu trữ)"; the savings bar brand-coloured even at 100 %; "Còn 114 ngày (31/12/2026)" and "Đạt mục tiêu" both present; the passed-deadline row's meta in warning; the progress dialog holding exactly one field; nothing overflowing at 375.

**Tests required:**
- Vitest: `components/budgets/budget-progress-list.test.tsx` (5 new); `components/goals/goal-list.test.tsx` (6 new); `lib/ui/budget-view-model.test.ts` and `lib/ui/savings-goal-view-model.test.ts` migrated (`statusLabel` → `status`, `label` → `categoryName`) plus 2 new `daysToDeadline` cases; `lib/datetime/calendar-date.test.ts` (+3 for the extracted `calendarDaysBetween`); `budget-form.test.tsx` and `goal-form.test.tsx` migrated to `<label>` assertions.
- Playwright: `e2e/helpers.ts`'s `createBudgetViaUi` rewritten; `e2e/phase5.spec.ts` fully green with its budget-delete native-dialog handler removed; `e2e/phase6.spec.ts`'s goals tests green with its archive handler removed.

**Browser visual checks required:** the eighteen screenshots in Step 10.

**Explicit things NOT to change:** `calendarDaysBetween`'s *behaviour* — the extraction is a move, and its three new test cases must pass against the code exactly as `reminder-view-model.ts` had it; `classifyBudgetStatus` and its five bands; `getBudgetProgressForMonth` and the "each budget in its own currency, never converted" ruling R5-3; `isBudgetableMonth`/`MIN_BUDGET_YEAR`/`MAX_BUDGET_YEAR`; `BudgetForm`'s month merge at submit and the page's `key`; `updateBudgetSchema`'s immutable-identity fields; `listAllSavingsGoals`, `STATUS_RANK`, and the fact that an archived goal refuses every write; `createSavingsGoalSchema`/`updateSavingsGoalSchema`/the progress action; the clamped-bar / unclamped-figure distinction in both DTOs.

**Completion gate:** all four commands green; eighteen screenshots inspected; `grep -rn "window.confirm" components/budgets components/goals` returns nothing; every field in the four forms and the three dialogs has a visible label (driver check as in Task 6).

**Proposed commit boundary:**
1. `feat(budgets): PlanningRow rows with toned status badges, a segmented month control and ConfirmDialog for delete`
2. `feat(goals): PlanningRow rows with deadline meta, an inline progress dialog and ConfirmDialog for archive`

---
## Task 8: Debts and Loans

**Objective:** Rebuild `/debts` and `/loans` to spec §6.6 — Debts split into two `SectionHeader` sections ("Người khác nợ bạn" / "Bạn nợ người khác") each with a per-currency subtotal, rows on `PlanningRow` with "còn 1.500.000 / 2.000.000 VND" and a due meta, "Ghi nhận thanh toán" as the one inline action opening a `Dialog` (not a right-aligned panel); Loans with a dominant "Dư nợ gốc 117.000.000 VND", a "Kỳ tới …" second line and a "Lãi …" third line, and an instalment `Dialog` whose three fields Gốc / Lãi / Tổng are all visible with Tổng read-only and computed live as a **figure, never "—"**. Write-off and Close-loan move into `…` behind `ConfirmDialog`s.

**Major files touched:** `app/(app)/debts/page.tsx`, `app/(app)/loans/page.tsx`, `components/debts/debt-list.tsx`, `components/debts/debt-row-actions.tsx`, `components/debts/debt-form.tsx`, `components/loans/loan-list.tsx`, `components/loans/loan-row-actions.tsx`, `components/loans/loan-form.tsx`, `lib/ui/debt-view-model.ts`, `lib/ui/loan-view-model.ts`, `messages/{vi,en}/debts.json`, `messages/{vi,en}/loans.json`, `e2e/phase6.spec.ts`.

**Reusable primitives involved:** `PageHeader`, `SectionHeader`, `PlanningRow`, `Progress`, `StatusBadge`, `MoneyText`, `EmptyState`, `InlineAlert`, `FormField`, `Dialog`, `ConfirmDialog`, `Sheet`, `RowActionsMenu`, `useSubmitState`.

**User-facing behaviour:** Debts opens with two sections, each showing its per-currency subtotal as a line of `MoneyText`s. Each row states the person, a status badge, what is still owed against what was agreed, the due date, and one "Ghi nhận thanh toán" button; `…` holds Sửa and Xóa nợ, the latter confirmed. Loans opens with the principal-outstanding subtotal per currency, rows stating the lender, badge, dominant outstanding principal, the next instalment and the interest paid, one "Ghi nhận thanh toán" button opening a three-field dialog where Tổng updates as Gốc and Lãi are typed, and `…` with Sửa and Đóng khoản vay behind a confirmation. Written-off debts and closed loans sit in read-only `<details>`.

**Desktop expectation:** both pages `max-w-[60rem]`, `p-8`; two cards on Debts (one per direction) each with `divide-y`; one card on Loans; the payment `Dialog` is 480 px centred; the inline action and the `…` trigger sit right-aligned on the row's first line.

**Mobile expectation:** the subtotal line wraps to one row per currency; the row's figure line wraps after the "/ original" segment; the inline "Ghi nhận thanh toán" is full width above the `…` trigger below 480 px; the payment dialog becomes a bottom sheet (< 640, from `Dialog` itself).

**Dark-theme expectation:** the direction words keep `--positive`/`--negative` at dark lightness; a written-off row's `<details>` content is `opacity-70` and its badge `muted`; the loan's dominant figure is `--foreground`, not red — an outstanding principal is a fact, not an error; only OVERDUE carries `--negative`.

**Vietnamese/English expectation:** every string from `debts.json`/`loans.json`; every status and direction from `labels.json` via `debtStatusLabelKey` / `debtDirectionLabelKey` / `loanStatusLabelKey` / `paymentFrequencyLabelKey`; the glossary's Ghi nhận thanh toán, Xóa nợ, Đóng khoản vay, Gốc, Lãi, Dư nợ gốc, Kỳ tới, Trả góp are used verbatim. Dates go through `formatDate(..., 'date')`; the interest rate keeps `interestRateLabel`'s existing `%` formatting.

**Accessibility acceptance criteria:** one `h1` per page, two `h2`s on Debts, one on Loans plus `h2` on each `<details>`; `Progress` keeps the clamped-`aria-valuenow`/true-`aria-valuetext` contract on both pages; every field in the four forms and the two payment dialogs gets a visible label (today `debt-form.tsx` has seven `aria-label`-only controls, `debt-row-actions.tsx` seven, `loan-form.tsx` ten, `loan-row-actions.tsx` nine); the Tổng field is `readOnly` with `aria-readonly="true"` and is bound to the two inputs via `aria-describedby` pointing at a note that says it is computed; the inline action's `aria-label` names its person/lender; both destructive actions are `ConfirmDialog`s.

**Hydration/form-submission constraints:** `DebtForm` and `LoanForm` keep their `useHydrated()` gates (`components/debts/debt-form.tsx:42,73-78`, `components/loans/loan-form.tsx:53,84-89`) and every `defaultValue` on a non-first-option select — `LoanForm`'s payment-frequency select has one because MONTHLY is not the first option, and `components/loans/loan-form.tsx:32` documents exactly that; keep it. The row-action forms mount inside a `Dialog` on open and keep their existing "no `useHydrated` here" comments (`debt-row-actions.tsx:41-43`, `loan-row-actions.tsx:42-44`). All six forms get `useSubmitState`.

**Files:**
- Modify: `app/(app)/debts/page.tsx:67-131`, `app/(app)/loans/page.tsx:75-140`, `components/debts/debt-list.tsx:1-160` (whole file), `components/debts/debt-row-actions.tsx:46-333`, `components/debts/debt-form.tsx:73-166`, `components/loans/loan-list.tsx:1-174` (whole file), `components/loans/loan-row-actions.tsx:50-517`, `components/loans/loan-form.tsx:84-220`, `lib/ui/debt-view-model.ts:39-160`, `lib/ui/loan-view-model.ts:57-243`, `messages/{vi,en}/debts.json`, `messages/{vi,en}/loans.json`
- Test: `components/debts/debt-list.test.tsx` (new), `components/loans/loan-list.test.tsx` (new), `lib/ui/debt-view-model.test.ts`, `lib/ui/loan-view-model.test.ts`, `components/loans/loan-row-actions.test.ts`, `e2e/phase6.spec.ts:216-260,499-670`

**Interfaces:**

- Consumes: every Task 1a–1c primitive; `formatDate`, `formatMoney`; `debtDirectionLabelKey`, `debtStatusLabelKey`, `loanStatusLabelKey`, `paymentFrequencyLabelKey`; `DEBT_ERROR_KEYS`, `LOAN_ERROR_KEYS`, `GENERIC_ERROR_KEY`; `totalFromParts` (existing, `components/loans/loan-row-actions.tsx:127`).
- Produces:

```ts
// lib/ui/debt-view-model.ts — CHANGED
export interface DebtDto {
  // ... every existing field unchanged EXCEPT:
  /** REMOVED: `directionLabel`, `statusLabel`. The component calls
   *  `debtDirectionLabelKey` / `debtStatusLabelKey`. */
  direction: DebtDirection
  status: DebtDisplayStatus
}
export function toDebtDto(row: DebtWithOutstanding, locale?: Locale): DebtDto
export function debtSubtotalsByCurrency(rows: DebtWithOutstanding[], locale?: Locale): CurrencySubtotalDto[]

// lib/ui/loan-view-model.ts — CHANGED
export interface LoanDto {
  // ... every existing field unchanged EXCEPT:
  /** REMOVED: `frequencyLabel`, `statusLabel`. The component calls
   *  `paymentFrequencyLabelKey` / `loanStatusLabelKey`. */
  paymentFrequency: PaymentFrequency
  status: LoanDisplayStatus
}
export function toLoanDto(row: LoanWithOutstanding, today: string, locale?: Locale): LoanDto
export function loanSubtotalsByCurrency(rows: LoanWithOutstanding[], locale?: Locale): LoanCurrencySubtotalDto[]

// components/debts/debt-list.tsx  (async server component)
export function DebtList(props: {
  debts: DebtDto[]
  locale: Locale
  timeZone: string
  compact?: boolean
  renderActions?: (debt: DebtDto) => ReactNode
}): Promise<React.ReactElement>

// components/loans/loan-list.tsx  (async server component)
export function LoanList(props: {
  loans: LoanDto[]
  locale: Locale
  timeZone: string
  compact?: boolean
  renderActions?: (loan: LoanDto) => ReactNode
}): Promise<React.ReactElement>
```

- [ ] **Step 1: Add the message keys**

`messages/vi/debts.json`:
```json
{
  "title": "Công nợ",
  "description": "Khoản phải thu và phải trả bạn tự theo dõi — ghi nhận thanh toán ở đây không làm dịch chuyển tiền giữa các tài khoản của bạn",
  "sectionReceivable": "Người khác nợ bạn",
  "sectionPayable": "Bạn nợ người khác",
  "subtotalReceivable": "Khoản phải thu",
  "subtotalPayable": "Khoản phải trả",
  "figureLine": "còn {outstanding} / {original} {currency}",
  "dueMeta": "Đến hạn {date}",
  "overdueMeta": "Quá hạn từ {date}",
  "paymentsSection": "Lần thanh toán ({count})",
  "createTitle": "Thêm công nợ",
  "createAction": "Thêm công nợ",
  "createPending": "Đang thêm…",
  "openCreate": "Thêm công nợ",
  "direction": "Chiều",
  "person": "Người",
  "personPlaceholder": "Ví dụ: Minh",
  "originalAmount": "Số tiền ban đầu",
  "currency": "Tiền tệ",
  "dueDate": "Ngày đến hạn",
  "descriptionField": "Nội dung (tùy chọn)",
  "notes": "Ghi chú (tùy chọn)",
  "paymentAction": "Ghi nhận thanh toán",
  "paymentTitle": "Ghi nhận thanh toán · {name}",
  "paymentAmount": "Số tiền",
  "paymentDate": "Ngày thanh toán",
  "paymentNote": "Ghi chú (tùy chọn)",
  "paymentPending": "Đang lưu…",
  "editTitle": "Sửa {name}",
  "editAction": "Sửa",
  "writeOffAction": "Xóa nợ",
  "writeOffConfirmTitle": "Xóa nợ của {name}?",
  "writeOffConfirmBody": "Các lần thanh toán đã ghi vẫn được giữ trong lịch sử. Khoản nợ sẽ không thể thay đổi nữa.",
  "writeOffPending": "Đang xóa nợ…",
  "writtenOffSection": "Công nợ đã xóa ({count})",
  "emptyTitle": "Chưa có công nợ",
  "emptyBody": "Thêm khoản phải thu hoặc phải trả đầu tiên."
}
```
`messages/en/debts.json`: keep today's exact accessible names so only the vi alternation is added to the specs — `"direction": "Direction"`, `"person": "Person"`, `"originalAmount": "Original amount"`, `"currency": "Debt currency"`, `"dueDate": "Due date"`, `"descriptionField": "Description"`, `"notes": "Notes"`, `"createAction": "Add debt"`, `"paymentAction": "Record payment"`, `"writeOffAction": "Write off"`, `"editAction": "Edit"`, `"writtenOffSection": "Written-off debts ({count})"`, `"paymentsSection": "Payments ({count})"`, `"subtotalReceivable": "Owed to you"`, `"subtotalPayable": "You owe"`, `"description"` verbatim from `app/(app)/debts/page.tsx:72-75`, `"figureLine": "{outstanding} of {original} {currency}"`, `"dueMeta": "Due {date}"`, `"overdueMeta": "Overdue since {date}"`, `"emptyTitle": "No debts yet"`.

`messages/vi/loans.json`:
```json
{
  "title": "Khoản vay",
  "description": "Khoản vay bạn tự theo dõi — ghi nhận một kỳ trả ở đây không làm dịch chuyển tiền giữa các tài khoản của bạn",
  "subtotalPrincipal": "Dư nợ gốc",
  "outstandingLine": "Dư nợ gốc {outstanding} {currency}",
  "principalOfLine": "trên tổng {principal} {currency}",
  "nextDueLine": "Kỳ tới {date} · {amount} · {frequency}",
  "overdueLine": "Quá hạn từ {date} · {amount} · {frequency}",
  "dueSoonLine": "Sắp đến hạn {date} · {amount} · {frequency}",
  "interestLine": "Lãi {rate} · đã trả lãi {paid} {currency}",
  "termLine": "{months} tháng từ {date}",
  "paymentsSection": "Lần trả ({count})",
  "paymentRowLine": "{total} · gốc {principal} · lãi {interest}",
  "createTitle": "Thêm khoản vay",
  "createAction": "Thêm khoản vay",
  "createPending": "Đang thêm…",
  "openCreate": "Thêm khoản vay",
  "lender": "Bên cho vay",
  "lenderPlaceholder": "Ví dụ: Vietcombank",
  "principal": "Số tiền vay",
  "currency": "Tiền tệ",
  "interestRate": "Lãi suất (%/năm)",
  "startDate": "Ngày bắt đầu",
  "termMonths": "Kỳ hạn (tháng)",
  "paymentFrequency": "Tần suất trả",
  "scheduledPayment": "Số tiền mỗi kỳ",
  "nextDueDate": "Kỳ tới",
  "notes": "Ghi chú (tùy chọn)",
  "paymentAction": "Ghi nhận thanh toán",
  "paymentTitle": "Ghi nhận thanh toán · {name}",
  "paymentPrincipal": "Gốc",
  "paymentInterest": "Lãi",
  "paymentTotal": "Tổng",
  "paymentTotalNote": "Tổng được tính từ Gốc và Lãi.",
  "paymentDate": "Ngày trả",
  "paymentNote": "Ghi chú (tùy chọn)",
  "paymentPending": "Đang lưu…",
  "editTitle": "Sửa {name}",
  "editAction": "Sửa",
  "closeAction": "Đóng khoản vay",
  "closeConfirmTitle": "Đóng khoản vay với {name}?",
  "closeConfirmBody": "Lịch sử các kỳ đã trả vẫn được giữ lại. Khoản vay sẽ không thể thay đổi nữa.",
  "closePending": "Đang đóng…",
  "closedSection": "Khoản vay đã đóng ({count})",
  "emptyTitle": "Chưa có khoản vay",
  "emptyBody": "Thêm khoản vay đầu tiên để theo dõi dư nợ gốc."
}
```
`messages/en/loans.json`: keep `"lender": "Lender"`, `"principal": "Principal"`, `"currency": "Loan currency"`, `"interestRate": "Interest rate (%)"`, `"startDate": "Start date"`, `"termMonths": "Term (months)"`, `"paymentFrequency": "Payment frequency"`, `"scheduledPayment": "Scheduled payment"`, `"nextDueDate": "Next due date"`, `"notes": "Notes"`, `"createAction": "Add loan"`, `"paymentAction": "Record payment"`, `"closeAction": "Close loan"`, `"editAction": "Edit"`, `"closedSection": "Closed loans ({count})"`, `"paymentsSection": "Payments ({count})"`, `"subtotalPrincipal": "Principal outstanding"` — the last three and the field names are the accessible names `e2e/phase6.spec.ts` selects by. For the payment dialog: `"paymentPrincipal": "Principal"`, `"paymentInterest": "Interest"`, `"paymentTotal": "Total"`. Note that the current form labels are `Principal for {lender}` / `Interest for {lender}` / `Total payment for {lender}` (`components/loans/loan-row-actions.tsx:317,336,354`) — inside a dialog titled with the lender's name the suffix is redundant, so the labels lose it and Step 7 updates the spec selectors to scope by the dialog instead.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS.

- [ ] **Step 2: Drop the four label maps from the two view models**

`lib/ui/debt-view-model.ts`:
1. `:42-43` delete `directionLabel: string`; `:46` delete `statusLabel: string` (keep `direction` and `status`, which the rows key off).
2. `:80-106` delete `DEBT_DIRECTION_LABELS` and `DEBT_STATUS_LABELS` with their doc comments. `messages/en/labels.json` (Task 2a) already carries their exact values, and `debtDirectionLabelKey`/`debtStatusLabelKey` replace them.
3. `:129,142` delete the two assignments.
4. Add `locale: Locale = DEFAULT_LOCALE` as a second parameter and thread it into the five `formatMoney` calls (`:132-146`) and into `debtSubtotalsByCurrency`'s (`:190-217`).

`lib/ui/loan-view-model.ts`:
1. `:60-61,64` delete `frequencyLabel: string` and `statusLabel: string`; add `paymentFrequency: PaymentFrequency` (the row now needs the enum to build its own label) and keep `status`.
2. `:110-135` delete `LOAN_FREQUENCY_LABELS` and `LOAN_STATUS_LABELS` with their doc comments.
3. `:219,226` delete the two assignments; add `paymentFrequency: loan.paymentFrequency`.
4. Add `locale: Locale = DEFAULT_LOCALE` as a third parameter and thread it into every `formatMoney` call and into `loanSubtotalsByCurrency`.
5. Leave `interestRateLabel` (`:222`) exactly as it is — it is a percentage with its own `RATE_FORMATTER`, and the `%` sign is not language-specific here.

Update `lib/ui/debt-view-model.test.ts` and `lib/ui/loan-view-model.test.ts`: every `directionLabel`/`statusLabel`/`frequencyLabel` assertion becomes an assertion on the enum field (`expect(dto.status).toBe('PARTIALLY_PAID')`, `expect(dto.paymentFrequency).toBe('MONTHLY')`).

- [ ] **Step 3: Write the failing tests for the two lists**

`components/debts/debt-list.test.tsx` — five cases, with the translator mocked to echo its key and arguments so an assertion names the key rather than a Vietnamese string:

```tsx
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}|${JSON.stringify(args)}` : key,
}))
```

The five cases:
1. the figure line uses `debts.figureLine` and carries both the outstanding and the original figure;
2. the direction is rendered from `labels.debtDirection.RECEIVABLE` / `.PAYABLE` and never as the words "Owes you"/"You owe" hard-coded;
3. an `OVERDUE` debt's meta uses `debts.overdueMeta` and carries `text-negative`, while an OPEN one uses `debts.dueMeta` and does not;
4. the repayment `Progress` is `bg-positive` in **both** directions (being repaid is good news whichever way the money is going — the current `DebtList` doc says exactly this at `:113-115`) and announces the true percentage when clamped;
5. `compact` renders the person, the direction and the outstanding figure and **no** progress bar, badge, description, notes or payment history.

`components/loans/loan-list.test.tsx` — six cases:
1. the outstanding principal is the **dominant** figure (`MoneyText size="kpi"` or the row's largest class — assert the class present) and `loans.outstandingLine` is used;
2. the second line is `loans.nextDueLine` with the date, the instalment and `labels.paymentFrequency.MONTHLY`;
3. an overdue loan uses `loans.overdueLine` + `text-negative`; a due-soon one uses `loans.dueSoonLine` + `text-warning`; a `PAID_OFF` or `CLOSED` one always lands on the plain `nextDueLine` whatever its stored due date says (the current `scheduleLine` doc asserts this mutual exclusion at `:44-49` — preserve it);
4. the third line is `loans.interestLine` with the rate and the interest paid;
5. the bar measures **principal** repaid and is `bg-positive`, announcing the true percentage when clamped;
6. `compact` renders the lender and the outstanding principal only.

Run both → FAIL.

- [ ] **Step 4: Rewrite `DebtList` and `LoanList` on `PlanningRow`**

`components/debts/debt-list.tsx` — per-change list:
1. `async` server component with `getTranslations`; add `locale`/`timeZone` props.
2. Keep `DIRECTION_TEXT_COLOR` (`:33-36`) and `STATUS_TEXT_COLOR` (`:45-51`) but convert the latter to a `StatusTone` map: `{ OPEN: 'neutral', PARTIALLY_PAID: 'neutral', PAID: 'positive', OVERDUE: 'negative', WRITTEN_OFF: 'muted' }`, keeping the doc comment about only the exceptional states carrying colour.
3. `PlanningRow` with:
   - `title` = `<>{debt.person}<span className={cn('ml-2 text-xs', DIRECTION_TEXT_COLOR[debt.direction])}>{t(debtDirectionLabelKey(debt.direction))}</span></>`;
   - `badge` = `<StatusBadge label={t(debtStatusLabelKey(debt.status))} tone={STATUS_TONE[debt.status]} />` (omitted when `compact`);
   - `figureLine` = `compact ? <MoneyText value={debt.outstanding} currency={debt.currency} /> : t('debts.figureLine', { outstanding: debt.outstanding, original: debt.original, currency: debt.currency })`;
   - `progress` = `!compact && <Progress percent={debt.percentPaid} valueText={debt.percentLabel} label={debt.person} tone="positive" />`;
   - `meta` = `!compact && debt.dueDate && <span className={cn(debt.status === 'OVERDUE' && 'text-negative')}>{t(debt.status === 'OVERDUE' ? 'debts.overdueMeta' : 'debts.dueMeta', { date: formatDate(debt.dueDate, { locale, timeZone, style: 'date' }) })}</span>`;
   - `extra` = `!compact && (<>{debt.description && …}{debt.notes && …}{debt.payments.length > 0 && <details>…}</>)`, keeping the payment `<details>` but with `t('debts.paymentsSection', { count })` and each row's date through `formatDate`;
   - `actions` = `renderActions?.(debt)`.
4. Wrap in `<ul className="divide-y divide-border">`; the card border belongs to the caller (the page renders one card per section).
5. Keep the whole module doc, updating only the sentence about the per-currency subtotals living on the page (still true) and the "colour is never the only signal" paragraph (still true, and now enforced by `StatusBadge`).

`components/loans/loan-list.tsx` — the same treatment:
1. `async`, `getTranslations`, `locale`/`timeZone`.
2. Convert `STATUS_TEXT_COLOR` (`:34-39`) to `{ ACTIVE: 'neutral', OVERDUE: 'negative', PAID_OFF: 'positive', CLOSED: 'muted' }`, keeping its doc comment.
3. Replace `scheduleLine` (`:50-55`) with a key-returning version, preserving its exact precedence and its doc comment about three wordings rather than one coloured sentence:
   ```ts
   function scheduleLineKey(loan: LoanDto): 'loans.overdueLine' | 'loans.dueSoonLine' | 'loans.nextDueLine' {
     if (loan.overdue) return 'loans.overdueLine'
     if (loan.dueSoon) return 'loans.dueSoonLine'
     return 'loans.nextDueLine'
   }
   ```
4. `PlanningRow` with `title={loan.lender}`, the status badge, `figureLine` = a `<div className="flex flex-wrap items-baseline gap-x-2">` holding `t('loans.outstandingLine', …)` rendered through a `MoneyText size="kpi"` for the figure plus a muted `t('loans.principalOfLine', …)` (`compact` collapses to just the outstanding `MoneyText`), `progress` as today's principal-repaid bar via `Progress tone="positive"`, and `meta` as three stacked lines: the schedule line (toned `text-negative` when overdue, `text-warning` when due soon), `t('loans.interestLine', …)`, and `t('loans.termLine', { months: loan.termMonths, date: formatDate(loan.startDate, …) })`.
5. Keep the payment `<details>` with `t('loans.paymentsSection', { count })` and each row as `t('loans.paymentRowLine', { total, principal, interest })` — preserving the comment about why the split is spelled out (`:151-154`).
6. Keep the comment explaining that the bar measures principal only and why interest is on its own line (`:91-95`, `:115-117`).

Run both tests → PASS.

- [ ] **Step 5: Restructure the two row-action components**

`components/debts/debt-row-actions.tsx` — replace `:46-110`:
1. One inline `Button size="sm"` — `t('debts.paymentAction')`, `aria-label={t('debts.paymentAction') + ' · ' + debt.person}` — opening a `Dialog` titled `t('debts.paymentTitle', { name: debt.person })` containing `DebtPaymentForm`.
2. A `RowActionsMenu` with `{ id: 'edit', label: t('debts.editAction'), onSelect: … }` opening a second `Dialog` with `DebtEditForm`, and `{ id: 'writeOff', label: t('debts.writeOffAction'), tone: 'negative', onSelect: … }` opening a `ConfirmDialog` (`t('debts.writeOffConfirmTitle', { name: debt.person })` / `t('debts.writeOffConfirmBody')`), replacing `window.confirm` at `:59`.
3. `DebtPaymentForm` (`:112-228`): its three `aria-label`-only controls (`:165,182,194`) become `FormField`s labelled `t('debts.paymentAmount')`, `t('debts.paymentDate')`, `t('debts.paymentNote')` — the `(${debt.currency})` placeholder moves into the amount field's suffix span exactly as the transaction form's does. Add `useSubmitState`; `InlineAlert` for the error; the submit button moves into the `Dialog`'s `footer`.
4. `DebtEditForm` (`:229-333`): its four `aria-label`-only controls (`:274,286,302,314`) become `FormField`s labelled `t('debts.person')`, `t('debts.descriptionField')`, `t('debts.dueDate')`, `t('debts.notes')`.
5. Keep every comment about which fields are immutable after creation (`lib/ui/debt-view-model.ts:66-70` and the form's own) — `direction`, `originalAmount` and `currency` are not editable, and that is a service invariant.

`components/loans/loan-row-actions.tsx` — replace `:50-125`, with the same inline-action + menu + two dialogs + confirm structure (`t('loans.closeConfirmTitle', { name: loan.lender })` / `t('loans.closeConfirmBody')`, replacing `window.confirm` at `:65`).

`LoanPaymentForm` (`:251-423`) is the delicate one — spec §6.6 requires **three visible fields with Tổng read-only, computed live, and shown as a figure and not "—"**:
1. `t('loans.paymentPrincipal')`, `t('loans.paymentInterest')` and `t('loans.paymentTotal')` as three `FormField`s in that order; Gốc and Lãi are `type="number" step="0.01"`, Tổng is `readOnly aria-readonly="true"` with `helper={t('loans.paymentTotalNote')}`.
2. Tổng's **value** comes from the existing exported `totalFromParts(principal, interest)` (`:127`) — read that function and `components/loans/loan-row-actions.test.ts` (191 lines) first; it already returns `number | null`. The spec's requirement is that a `null` must not render as "—": when either part is blank or unparseable, render `formatMoney(0, currency, locale)` **only if both are blank**, and otherwise render the sum of whichever parts parse — i.e. treat a blank as zero for the *display* of the total while still letting Zod refuse a genuinely missing field. Implement that as a new exported helper beside `totalFromParts`:
   ```ts
   /**
    * What the read-only Tổng field SHOWS while the user is still typing.
    *
    * `totalFromParts` answers `null` when a part is not a finite number, which
    * is right for validation and wrong for a field the user is watching: a
    * dash where a number should be reads as "this is broken" the moment they
    * clear one box to retype it. So a blank part counts as zero for DISPLAY
    * only — the submitted `total` still comes from `totalFromParts`, and
    * `createLoanPaymentSchema`'s split refine is still the authority on whether
    * gốc + lãi = tổng.
    */
   export function displayTotal(principal: number, interest: number): number {
     const safe = (value: number) => (Number.isFinite(value) ? value : 0)
     return safe(principal) + safe(interest)
   }
   ```
   and add two cases to `components/loans/loan-row-actions.test.ts`: `displayTotal(NaN, 500000) === 500000` and `displayTotal(NaN, NaN) === 0`, alongside its existing `totalFromParts` cases, which stay untouched.
3. Keep `dropDuplicateTotalError` (`:228-250`) and its behaviour verbatim — it exists so the split invariant does not print twice, and the three-visible-field layout makes that *more* relevant, not less.
4. Keep the register options and the `total` field's participation in the submitted payload exactly as they are: the schema's refine is one of three layers enforcing gốc + lãi = tổng, and this task changes none of them.
5. `t('loans.paymentDate')`, `t('loans.paymentNote')` for the last two fields; `useSubmitState`; `InlineAlert`; the submit in the `Dialog`'s footer.

`LoanEditForm` (`:424-517`): its three `aria-label` controls (`:469,483,498`) become `FormField`s labelled `t('loans.lender')`, `t('loans.scheduledPayment')`, `t('loans.notes')`.

- [ ] **Step 6: Label the two create forms and rewrite the two pages**

`components/debts/debt-form.tsx` — the seven `aria-label` controls (`:89,100,107,119,132,137,152`) become `FormField`s labelled `t('debts.direction')`, `t('debts.person')` (+ `helper={t('debts.personPlaceholder')}`), `t('debts.originalAmount')`, `t('debts.currency')`, `t('debts.dueDate')`, `t('debts.descriptionField')`, `t('debts.notes')`. The direction select's two options become `t(debtDirectionLabelKey('RECEIVABLE'))` / `t(debtDirectionLabelKey('PAYABLE'))` — **note** they currently read "Someone owes me"/"I owe someone" (`:94-95`) while the *row* reads "Owes you"/"You owe"; unify on the row's wording via `labels.json`, and record that as a deliberate copy change (a form and a row describing the same fact two ways was a pre-flight finding). Keep the fieldset gate; add `useSubmitState`; `InlineAlert`.

`components/loans/loan-form.tsx` — the ten `aria-label` controls (`:91,98,112,127,140,147,162,177,193,203`) become `FormField`s labelled `t('loans.lender')` (+ helper), `t('loans.principal')`, `t('loans.currency')`, `t('loans.interestRate')`, `t('loans.startDate')`, `t('loans.termMonths')`, `t('loans.paymentFrequency')`, `t('loans.scheduledPayment')`, `t('loans.nextDueDate')`, `t('loans.notes')`. The frequency select's three options become `t(paymentFrequencyLabelKey('WEEKLY'|'MONTHLY'|'YEARLY'))`, and its `defaultValue` **stays** with the comment at `:32` intact. Keep the gate; add `useSubmitState`; `InlineAlert`.

`app/(app)/debts/page.tsx` — keep `:1-66` (the `displayRank` sort and its reasoning, `todayCalendarDateInZone`, `getDebtsWithOutstanding`, `debtSubtotalsByCurrency` taken from the service rows before formatting, the DTO mapping). Replace `:67-131`:
- `PageHeader` with `t('debts.title')`, `description={t('debts.description')}`, `actions={<DebtCreateButton />}`;
- **two sections**, split by `direction`: for each, a `SectionHeader` with the section title and a `right` slot holding the per-currency subtotal lines (`subtotals.map` → `<span>{currency} · {t('debts.subtotalReceivable')} <MoneyText …tone="positive" /> · {t('debts.subtotalPayable')} <MoneyText …tone="negative" /></span>`), then one card with `DebtList` filtered to that direction. Keep the page's existing comment about why there is one row per currency and never a single total (`:78-80`) verbatim, moved to the subtotal block.
- the `EmptyState` (`icon={HandCoins}`) when both sections are empty;
- the written-off `<details>` with `t('debts.writtenOffSection', { count })` and a read-only `DebtList` at `opacity-70`, keeping the existing comment (`:121-124`).

**Careful:** `debtSubtotalsByCurrency` returns receivable *and* payable per currency for the whole page (`lib/ui/debt-view-model.ts:190`). Rendering the same subtotal row under both section headers would state each figure twice. Either (a) show only the relevant half under each section — `subtotalReceivable` under the receivable section, `subtotalPayable` under the payable one — or (b) keep the combined strip once, above both sections. Choose **(a)**: spec §6.6 says "each with a subtotal per currency". Filter the DTO's fields at the call site; do not change `debtSubtotalsByCurrency`.

`app/(app)/loans/page.tsx` — keep `:1-74` (`DISPLAY_RANK`, `todayCalendarDateInZone`, `getLoansWithOutstanding`, `loanSubtotalsByCurrency`, the mapping). Replace `:75-140` with the same shape: `PageHeader` + `LoanCreateButton`; the per-currency `subtotalPrincipal` lines in the header's `meta` slot (one card, so no per-section split), keeping the "principal only — interest already paid is a settled cost" comment (`:86-90`); one card with `LoanList`; the `EmptyState` (`icon={Landmark}`); the closed `<details>` with `t('loans.closedSection', { count })`, keeping its comment (`:130-133`).

`DebtCreateButton` and `LoanCreateButton` are new client components (`components/debts/debt-create-button.tsx`, `components/loans/loan-create-button.tsx` — add to Create) opening a `Sheet` around the respective form, `onCreated` closing it.

- [ ] **Step 7: Update `e2e/phase6.spec.ts`'s debts and loans halves**

- `:216-235` (`createDebtViaUi`) — wrap in the create sheet; `getByLabel('Direction')` → `/^Chiều$|^Direction$/`, `'Person'` → `/^Người$|^Person$/`, `'Original amount'` → `/Số tiền ban đầu|Original amount/`; the submit → `/Thêm công nợ|Add debt/`; the direction option label changes to the row's wording, so `selectOption({ label })` calls must use `/Họ nợ bạn|Owes you/` and `/Bạn nợ họ|You owe/` — prefer `selectOption('RECEIVABLE')` / `selectOption('PAYABLE')` by **value**, which is stable across both locales and both wordings.
- `:236-260` (`createLoanViaUi`) — the same, with the ten label alternations from Step 6 and `selectOption('MONTHLY')` by value.
- `:499-547` — the debt payment flow: `getByRole('button', { name: 'Record payment' })` → `/Ghi nhận thanh toán|Record payment/`, then scope to the dialog: `const dialog = page.getByRole('dialog', { name: /Ghi nhận thanh toán/ })`, and `getByLabel('Payment amount for Minh')` → `dialog.getByLabel(/^Số tiền$|^Amount$/)`, `'Payment date for Minh'` → `dialog.getByLabel(/Ngày thanh toán|Payment date/)`.
- `:509-510,526,545,555-556,577` — status/direction words: `'Owes you'` → `/Họ nợ bạn|Owes you/`, `'You owe'` → `/Bạn nợ họ|You owe/`, `'Open'` → `/Đang mở|^Open$/`, `'Partly paid'` → `/Trả một phần|Partly paid/`, `'Paid'` → `/Đã thanh toán|^Paid$/`, `'Written off'` → `/Đã xóa nợ|Written off/`.
- `:529,539,547,633,647,668` — `getByText('Payments (1)')` → `/Lần thanh toán \(1\)|Lần trả \(1\)|Payments \(1\)/` per page.
- `:570` — Write off: menu item + `ConfirmDialog`; **delete its `page.once('dialog')` handler**.
- `:585` — `getByText('Owed to you')` → `/Khoản phải thu|Owed to you/`.
- `:601,666` — `'Active'`/`'Closed'` → `/Đang trả|^Active$/`, `/Đã đóng|^Closed$/`.
- `:617-647` — the loan instalment flow: the three field labels lose their lender suffix and are scoped to the dialog: `dialog.getByLabel(/^Gốc$|^Principal$/)`, `dialog.getByLabel(/^Lãi$|^Interest$/)`, `dialog.getByLabel(/^Tổng$|^Total$/)`. **Add an assertion the spec does not have and the spec text requires**: after typing Gốc and Lãi, the Tổng field's value is their sum and is never `'—'`:
  ```ts
  await dialog.getByLabel(/^Gốc$|^Principal$/).fill('3000000')
  await dialog.getByLabel(/^Lãi$|^Interest$/).fill('800000')
  await expect(dialog.getByLabel(/^Tổng$|^Total$/)).toHaveValue(/3\D?800\D?000/)
  await expect(dialog.getByLabel(/^Tổng$|^Total$/)).not.toHaveValue('—')
  ```
  and one for the blank case: clear Gốc and assert Tổng shows the interest alone rather than a dash.
- `:657` — Close loan: menu item + `ConfirmDialog`; **delete its `page.once('dialog')` handler**.
- `:659` — `'No loans yet — add one below.'` → `/Chưa có khoản vay|No loans yet/`.
- `:433-434` — the two `destination.empty` strings for `/debts` and `/loans` → `/Chưa có công nợ|No debts yet/` and `/Chưa có khoản vay|No loans yet/`.

Run: `npx playwright test e2e/phase6.spec.ts` → green. Then `grep -rn "page.once('dialog'" e2e` → **no hits at all**. Every one of the seven `window.confirm` sites is now a `ConfirmDialog`; record that in the task report.

- [ ] **Step 8: Full verification**

Run: `npm run test` → green (both view-model suites migrated, both new list tests, `loan-row-actions.test.ts` +2, all four form tests migrated to `<label>` assertions).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

- [ ] **Step 9: Browser visual check — Debts and Loans**

Seed: 5 debts (a VND receivable at 25 %, a USD receivable, an overdue VND payable, a fully paid one, a written-off one) and 4 loans (an active MONTHLY VND loan with 3 recorded instalments, an overdue one, a due-soon one, a closed one).

Screenshot, light and dark: `/debts` at 1440, 768, 375 (6); `/debts` at 1440 with the payment dialog, the edit dialog and the write-off `ConfirmDialog` (3 light); `/loans` at 1440, 768, 375 (6); `/loans` at 1440 with the instalment dialog **showing a computed Tổng** and with the close `ConfirmDialog` (2 light); `/loans` at 375 with the instalment dialog as a bottom sheet (1 light). Eighteen screenshots.

Look for: two clearly separated Debts sections each with its own subtotal, and no figure stated twice; the overdue row's meta in negative and the due-soon loan's in warning; the loan's outstanding principal visibly the dominant figure on its row; the three-line loan row not wrapping into an unreadable block at 375; the instalment dialog showing Gốc, Lãi and a **filled** Tổng; the payment dialog bottom-anchored at 375; the written-off/closed `<details>` muted and action-free; every dialog's focus trapped (Tab around it) and returned.

**Tests required:**
- Vitest: `components/debts/debt-list.test.tsx` (5 new); `components/loans/loan-list.test.tsx` (6 new); `lib/ui/debt-view-model.test.ts` and `lib/ui/loan-view-model.test.ts` migrated; `components/loans/loan-row-actions.test.ts` (+2 for `displayTotal`); `debt-form.test.tsx` and `loan-form.test.tsx` migrated to `<label>` assertions.
- Playwright: `e2e/phase6.spec.ts`'s debts and loans tests green, with both native-dialog handlers removed and the two new computed-Tổng assertions added.

**Browser visual checks required:** the eighteen screenshots in Step 9.

**Explicit things NOT to change:** `deriveDebtOutstanding`/`deriveDebtDisplayStatus`, `deriveLoanOutstandingPrincipal` and every service in `lib/server/services/debt.ts`/`loan.ts`; the overpayment checks and their error codes; `createDebtSchema`/`updateDebtSchema`/`createDebtPaymentSchema`/`createLoanSchema`/`updateLoanSchema`/`createLoanPaymentSchema` and the split refine; `totalFromParts` and `dropDuplicateTotalError`; `advanceByFrequency`; `DUE_SOON_DAYS` and the `overdue`/`dueSoon` mutual exclusion; `debtSubtotalsByCurrency`/`loanSubtotalsByCurrency`'s `Decimal` sums (taken from service rows before formatting — never from strings); the immutability of `direction`/`originalAmount`/`currency` on a debt and of `interestRate`/`startDate`/`termMonths`/`paymentFrequency`/`nextDueDate` on a loan; the fact that nothing on either page writes a Transaction.

**Completion gate:** all four commands green; eighteen screenshots inspected; `grep -rn "window.confirm" components` returns **nothing at all**; `grep -rn "page.once('dialog'" e2e` returns **nothing at all**; every field in the six forms and the four dialogs has a visible label (driver check); the Tổng field shows a figure in every state the driver can reach.

**Proposed commit boundary:**
1. `feat(debts): two directional sections with per-currency subtotals, PlanningRow rows and a payment dialog`
2. `feat(loans): dominant outstanding principal, a three-field instalment dialog with a live total, and ConfirmDialog for close`

---
## Task 9: Reminders

**Objective:** Rebuild `/reminders` to spec §6.7 — two top-level segmented tabs ("Sắp đến hạn" for occurrences, "Lịch nhắc" for definitions), the Bills/Income filter demoted to secondary chips inside the first tab, **repeated occurrences of one reminder collapsed to a single row** with "+n kỳ" and an expander, an Overdue group with its count, and definition rows carrying a type badge, an Active/Paused badge and a Pause/Resume ghost button. Acknowledge, Dismiss, Pause and Resume get **no** dialog — nothing is destroyed.

**Major files touched:** `app/(app)/reminders/page.tsx`, `components/reminders/occurrence-list.tsx`, `components/reminders/occurrence-group.tsx` (new), `components/reminders/occurrence-actions.tsx`, `components/reminders/reminder-list.tsx`, `components/reminders/reminder-toggle.tsx`, `components/reminders/reminder-form.tsx`, `lib/ui/reminder-view-model.ts`, `messages/{vi,en}/reminders.json`, `e2e/phase6.spec.ts`.

**Reusable primitives involved:** `PageHeader`, `SectionHeader`, `SegmentedControl`, `PlanningRow`, `StatusBadge`, `MoneyText`, `EmptyState`, `InlineAlert`, `FormField`, `Sheet`, `useSubmitState`.

**User-facing behaviour:** the page opens on "Sắp đến hạn" with an Overdue group (headed by its count) above an Upcoming group. A weekly gym membership with four occurrences in the window is **one** row — "Gym membership · hàng tuần · tiếp theo 11/09 · +3 kỳ" — whose Acknowledge/Dismiss act on the *next* occurrence, and whose disclosure reveals the remaining three as their own rows. Switching to "Lịch nhắc" shows the definitions with Pause/Resume. Bills/Income chips filter the first tab only. "Thêm nhắc nhở" in the header opens a sheet.

**Desktop expectation:** `max-w-[60rem]`, `p-8`; the tab `SegmentedControl` sits under the header, the chip row under it inside the first tab; one card per group with `divide-y` rows; the collapsed row's "+3 kỳ" is a `StatusBadge tone="neutral"` and the expander is a `<details>` inside the row's `extra` slot.

**Mobile expectation:** the tabs stay a full-width segmented control (two segments fit at 375); the chip row scrolls horizontally inside its own track (a secondary filter — spec §7 permits exactly this and forbids it for core metrics); the row's Acknowledge/Dismiss pair sits full width below the figure line.

**Dark-theme expectation:** the overdue count and any overdue due line are `--negative` at dark L≈0.68; a paused definition's row is `opacity-70` **and** carries the Paused badge, so dimming is never the only signal; the "+n kỳ" badge is `bg-muted`.

**Vietnamese/English expectation:** every string from `reminders.json`; type from `labels.reminderType.*` (Thu nhập / Hóa đơn); recurrence from `labels.recurrence.*` via `recurrenceLabelKey(frequency, interval)` with `{ count: interval }`; the due label from `reminders.dueToday`/`dueTomorrow`/`dueInDays` (ICU plural)/`overdue`; the collapse badge from `reminders.morePeriods` with an ICU plural.

**Accessibility acceptance criteria:** one `h1`; the two tabs are links with `aria-current="page"` (the `SegmentedControl` primitive); each group is an `h2`, the Overdue sub-group an `h3`; the collapse disclosure is a `<summary>` whose text names the reminder and the count; Acknowledge/Dismiss keep their existing disambiguating `aria-label`s (title + due date — `components/reminders/occurrence-actions.tsx:75-82` explains exactly why the title alone is not unique, and collapsing makes that *more* true, so keep it); Pause/Resume keeps its action-word `aria-label`; every one of the twelve `aria-label`-only controls in `reminder-form.tsx` gains a visible `<label>`.

**Hydration/form-submission constraints:** `ReminderForm` keeps its `useHydrated()` gate (`components/reminders/reminder-form.tsx:136,176-181`) and every `defaultValue` on a non-first-option select — the type select defaults to `EXPENSE` (`:206-212`, where EXPENSE *is* first, so no `defaultValue` is needed and none must be added), the frequency select defaults to `MONTHLY` which is **not** first (`:265-271`), and the month select's `defaultValue=""` (`:325-333`). Read `:96-119` before touching any of them — the comments there explain which fields the schema refuses per frequency and why a field left on screen would be a trap. Add `useSubmitState` to the form; the four row actions already guard with their own `pending` state (`occurrence-actions.tsx:42`, `reminder-toggle.tsx:28`) — replace both with `useSubmitState` for one mechanism, keeping their comments about why a double click is harmless but a row told two things at once is not.

**Files:**
- Create: `components/reminders/occurrence-group.tsx`, `components/reminders/occurrence-group.test.ts`, `components/reminders/reminder-create-button.tsx`
- Modify: `app/(app)/reminders/page.tsx:46-277`, `components/reminders/occurrence-list.tsx:1-115` (whole file), `components/reminders/occurrence-actions.tsx:39-115`, `components/reminders/reminder-list.tsx:22-70`, `components/reminders/reminder-toggle.tsx:25-72`, `components/reminders/reminder-form.tsx:176-432`, `lib/ui/reminder-view-model.ts:47-231`, `messages/{vi,en}/reminders.json`
- Test: `components/reminders/occurrence-group.test.ts`, `components/reminders/occurrence-list.test.tsx` (new), `lib/ui/reminder-view-model.test.ts`, `components/reminders/reminder-form.test.tsx`, `e2e/phase6.spec.ts:261-300,672-760`

**Interfaces:**

- Consumes: every Task 1a–1c primitive; `formatDate`; `reminderTypeLabelKey`, `recurrenceLabelKey`; `REMINDER_ERROR_KEYS`, `GENERIC_ERROR_KEY`; `OCCURRENCE_LOOKAHEAD_DAYS`.
- Produces:

```ts
// lib/ui/reminder-view-model.ts — CHANGED
export interface OccurrenceDto {
  id: string
  reminderId: string
  title: string
  type: ReminderType
  /** REMOVED: `typeLabel`, `recurrenceLabel`, `dueLabel`. The component calls
   *  `reminderTypeLabelKey` / `recurrenceLabelKey` and picks a due key from
   *  `daysToDue`. */
  frequency: RecurrenceFrequency
  interval: number
  amount: string
  currency: Currency
  dueDate: string
  /** NEW: whole calendar days from the user's today to `dueDate`; negative
   *  when overdue. Replaces the pre-baked English `dueLabel`. */
  daysToDue: number
  overdue: boolean
  categoryName: string | null
  accountName: string | null
  status: OccurrenceStatus
}
export interface ReminderDto {
  id: string
  title: string
  type: ReminderType
  /** REMOVED: `typeLabel`, `recurrenceLabel`. */
  frequency: RecurrenceFrequency
  interval: number
  amount: string
  currency: Currency
  startDate: string
  active: boolean
  note: string | null
  categoryName: string | null
  accountName: string | null
}
export function toOccurrenceDto(row: OccurrenceRow, timezone: string, today: string, locale?: Locale): OccurrenceDto
export function toReminderDto(row: ReminderRow, timezone: string, locale?: Locale): ReminderDto

// components/reminders/occurrence-group.tsx
export interface OccurrenceCluster {
  /** The next (soonest) occurrence — the one the row's actions act on. */
  next: OccurrenceDto
  /** The remaining occurrences of the SAME reminder, in `dueAt asc` order. */
  rest: OccurrenceDto[]
}
export function clusterByReminder(occurrences: OccurrenceDto[]): OccurrenceCluster[]

// components/reminders/occurrence-list.tsx  (async server component)
export function OccurrenceList(props: {
  occurrences: OccurrenceDto[]
  locale: Locale
  timeZone: string
  /** Collapse repeated occurrences of one reminder into one row (spec §6.7).
   *  The dashboard widget passes `false` — it shows at most five rows total and
   *  a "+n" badge there would explain a list the user cannot expand. */
  collapse?: boolean
  compact?: boolean
  renderActions?: (occurrence: OccurrenceDto) => ReactNode
}): Promise<React.ReactElement>
```

- [ ] **Step 1: Add the message keys**

`messages/vi/reminders.json`:
```json
{
  "title": "Nhắc nhở",
  "description": "Hóa đơn và thu nhập dự kiến — một nhắc nhở không tự ghi giao dịch cho bạn",
  "tabs": "Chế độ xem",
  "tabDue": "Sắp đến hạn",
  "tabDefinitions": "Lịch nhắc",
  "filter": "Loại nhắc nhở",
  "filterAll": "Tất cả",
  "filterBills": "Hóa đơn",
  "filterIncome": "Thu nhập",
  "groupOverdue": "Quá hạn",
  "groupUpcoming": "Sắp tới",
  "overdueCount": "{count, plural, other {# quá hạn}}",
  "overdue": "Quá hạn",
  "dueToday": "Hôm nay",
  "dueTomorrow": "Ngày mai",
  "dueInDays": "Còn {count, plural, other {# ngày}}",
  "dueLine": "{due} · {date}",
  "morePeriods": "+{count, plural, other {# kỳ}}",
  "expandPeriods": "Xem {count, plural, other {# kỳ}} còn lại của {name}",
  "contextLine": "{parts}",
  "acknowledgeAction": "Ghi nhận",
  "dismissAction": "Bỏ qua",
  "pauseAction": "Tạm dừng",
  "resumeAction": "Tiếp tục",
  "activeBadge": "Đang hoạt động",
  "pausedBadge": "Tạm dừng",
  "definitionMeta": "{recurrence} · từ {date}",
  "createTitle": "Thêm nhắc nhở",
  "createAction": "Thêm nhắc nhở",
  "createPending": "Đang thêm…",
  "openCreate": "Thêm nhắc nhở",
  "titleField": "Tiêu đề",
  "titlePlaceholder": "Ví dụ: Tiền internet",
  "type": "Loại",
  "expectedAmount": "Số tiền dự kiến",
  "currency": "Tiền tệ",
  "frequency": "Tần suất",
  "interval": "Mỗi",
  "intervalUnitWeeks": "tuần",
  "intervalUnitMonths": "tháng",
  "intervalUnitYears": "năm",
  "dayOfMonth": "Ngày trong tháng",
  "dayOfMonthHelper": "Bỏ trống để dùng ngày của ngày bắt đầu.",
  "month": "Tháng",
  "monthPlaceholder": "Tháng của ngày bắt đầu",
  "startDate": "Ngày bắt đầu",
  "categoryOptional": "Danh mục (tùy chọn)",
  "accountOptional": "Tài khoản (tùy chọn)",
  "none": "Không chọn",
  "note": "Ghi chú (tùy chọn)",
  "emptyDueTitle": "Không có gì đến hạn trong {days} ngày tới",
  "emptyDueBills": "Không có hóa đơn nào đến hạn trong {days} ngày tới",
  "emptyDueIncome": "Không có thu nhập nào đến hạn trong {days} ngày tới",
  "emptyDefinitionsTitle": "Chưa có nhắc nhở",
  "emptyDefinitionsBody": "Thêm nhắc nhở đầu tiên cho một hóa đơn hoặc một khoản thu.",
  "emptyDefinitionsBills": "Chưa có hóa đơn nào",
  "emptyDefinitionsIncome": "Chưa có nhắc nhở thu nhập nào"
}
```
`messages/en/reminders.json`: keep today's accessible names — `"titleField": "Title"`, `"type": "Type"`, `"expectedAmount": "Expected amount"`, `"currency": "Reminder currency"`, `"frequency": "Frequency"`, `"interval": "Every"`, `"dayOfMonth": "Day of month"`, `"month": "Month"`, `"startDate": "Start date"`, `"categoryOptional": "Category (optional)"`, `"accountOptional": "Account (optional)"`, `"note": "Note"`, `"createAction": "Add reminder"`, `"acknowledgeAction": "Acknowledge"`, `"dismissAction": "Dismiss"`, `"pauseAction": "Pause"`, `"resumeAction": "Resume"`, `"activeBadge": "Active"`, `"pausedBadge": "Paused"`, `"filterAll": "All"`, `"filterBills": "Bills"`, `"filterIncome": "Income"`, `"groupOverdue": "Overdue"`, `"groupUpcoming": "Upcoming"`, `"overdue": "Overdue"`, `"dueToday": "Today"`, `"dueTomorrow": "Tomorrow"`, `"dueInDays": "In {count, plural, one {# day} other {# days}}"`, `"morePeriods": "+{count, plural, one {# period} other {# periods}}"`, `"emptyDueTitle": "Nothing due in the next {days} days"`, `"emptyDefinitionsTitle": "No reminders yet"`, `"description"` verbatim from `app/(app)/reminders/page.tsx:172-174`. Note the two labels the spec fixes: the two optional selects are labelled "Danh mục (tùy chọn)" / "Tài khoản (tùy chọn)" (spec §6.7), not the bare "Category"/"Account" they carry today.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS.

- [ ] **Step 2: Change the view model to emit enums and a day count**

`lib/ui/reminder-view-model.ts`:
1. `:47-59` — delete `REMINDER_TYPE_LABELS` and its doc comment. The "Bill rather than Expense" reasoning it carries is preserved in `messages/*/labels.json`'s `reminderType.EXPENSE` value ("Hóa đơn" / "Bill") — copy that sentence into a comment above the key in the vi file so the reasoning is not lost.
2. `:61-87` — delete `recurrenceLabel`. Its interval-1-vs-N idiom distinction is preserved by `recurrenceLabelKey`'s two-key mapping (Task 2a), whose doc comment already cites this function; **check nothing else imports `recurrenceLabel`** (`grep -rn "recurrenceLabel" app components lib e2e`) and update each hit.
3. `:89-104` — delete `calendarDaysBetween` from this module and import it from `lib/datetime/calendar-date.ts`, where Task 7 moved it (with its doc comment). Task 7 precedes this task, so the function is already there; `npx tsc --noEmit` is what catches it if the import is missed.
4. `:106-125` — delete `dueLabel`. Its four cases become the component's choice between `reminders.overdue`, `reminders.dueToday`, `reminders.dueTomorrow` and `reminders.dueInDays`. **Keep its doc comment's reasoning** by moving the two load-bearing sentences into `OccurrenceDto.daysToDue`'s comment: that "Overdue" carries no count of how late it is on purpose (the list is unbounded and "Overdue by 97 days" shouts at someone who already knows), and that "Today"/"Tomorrow" are named rather than counted because that is how a person reads a due date.
5. `OccurrenceDto` (`:127-152`): delete `typeLabel`, `dueLabel`, `recurrenceLabel`; add `frequency: RecurrenceFrequency`, `interval: number`, `daysToDue: number`.
6. `toOccurrenceDto` (`:154-192`): set the three new fields from `reminder.frequency`, `reminder.interval` and `calendarDaysBetween(today, dueDate)`; keep `overdue` derived from `compareCalendarDates(dueDate, today) < 0` **exactly as it is** — it must stay the single definition of "late" and must not be re-derived from `daysToDue < 0` in a second place (they agree by construction, and the comment at `:186-188` says why one definition matters).
7. `ReminderDto` (`:194-212`) and `toReminderDto` (`:214-231`): delete `typeLabel`/`recurrenceLabel`; add `frequency`, `interval`.
8. Add `locale: Locale = DEFAULT_LOCALE` to both mappers and thread it into their `formatMoney` calls.

Update `lib/ui/reminder-view-model.test.ts`: every `typeLabel`/`dueLabel`/`recurrenceLabel` assertion becomes an assertion on the enum/count fields — `expect(dto.daysToDue).toBe(0)` where it asserted `'Today'`, `-1` where `'Overdue'`, `3` where `'In 3 days'`; `expect(dto.frequency).toBe('WEEKLY')` and `expect(dto.interval).toBe(2)` where it asserted `'Every 2 weeks'`. The `recurrenceLabel` unit tests move to a new `lib/ui/labels.test.ts` case asserting `recurrenceLabelKey('WEEKLY', 1) === 'labels.recurrence.WEEKLY'` and `recurrenceLabelKey('WEEKLY', 2) === 'labels.recurrence.WEEKLY_N'` (Task 2's test already covers key existence; this adds the *choice*).

- [ ] **Step 3: Write the failing test for `clusterByReminder`**

`components/reminders/occurrence-group.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clusterByReminder } from './occurrence-group'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'

function occ(id: string, reminderId: string, dueDate: string, daysToDue: number): OccurrenceDto {
  return {
    id,
    reminderId,
    title: 'Gym membership',
    type: 'EXPENSE',
    frequency: 'WEEKLY',
    interval: 1,
    amount: '500.000',
    currency: 'VND',
    dueDate,
    daysToDue,
    overdue: daysToDue < 0,
    categoryName: null,
    accountName: null,
    status: 'PENDING',
  }
}

describe('clusterByReminder', () => {
  it('collapses repeated occurrences of one reminder into a single cluster', () => {
    const clusters = clusterByReminder([
      occ('o1', 'r1', '2026-09-11', 3),
      occ('o2', 'r1', '2026-09-18', 10),
      occ('o3', 'r1', '2026-09-25', 17),
      occ('o4', 'r1', '2026-10-02', 24),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0].next.id).toBe('o1')
    expect(clusters[0].rest.map((o) => o.id)).toEqual(['o2', 'o3', 'o4'])
  })

  it('keeps different reminders apart and preserves the input order of the firsts', () => {
    const clusters = clusterByReminder([
      occ('a1', 'r1', '2026-09-09', 1),
      occ('b1', 'r2', '2026-09-10', 2),
      occ('a2', 'r1', '2026-09-16', 8),
    ])
    expect(clusters.map((c) => c.next.id)).toEqual(['a1', 'b1'])
    expect(clusters[0].rest.map((o) => o.id)).toEqual(['a2'])
    expect(clusters[1].rest).toEqual([])
  })

  it('takes the SOONEST occurrence as the cluster’s next, whatever the input order', () => {
    // The service returns `dueAt asc`, so the first is the soonest — but a
    // caller that ever sorted differently must not end up offering
    // Acknowledge on next month's instance.
    const clusters = clusterByReminder([occ('o2', 'r1', '2026-09-18', 10), occ('o1', 'r1', '2026-09-11', 3)])
    expect(clusters[0].next.id).toBe('o1')
    expect(clusters[0].rest.map((o) => o.id)).toEqual(['o2'])
  })

  it('returns nothing for an empty list', () => {
    expect(clusterByReminder([])).toEqual([])
  })
})
```

Run → FAIL.

- [ ] **Step 4: Write `clusterByReminder`**

`components/reminders/occurrence-group.tsx`:

```tsx
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'

/**
 * One row per REMINDER, not per occurrence (spec §6.7).
 *
 * A weekly gym membership inside a 30-day window materializes four
 * occurrences, and listing all four gave a page of identical rows in which the
 * one the user could act on was indistinguishable from the three they could
 * not usefully act on yet. So the soonest becomes the row — with Acknowledge
 * and Dismiss acting on IT — and the rest sit behind "+3 kỳ".
 *
 * Nothing is hidden: the disclosure lists every remaining occurrence with its
 * own actions. The list this operates on is deliberately unbounded (a PENDING
 * occurrence from three months ago is a bill the user never answered, and
 * dropping it because it is old would be the app forgetting it on their
 * behalf), and collapsing is the only way that stays readable.
 *
 * `next` is the soonest by `dueDate`, not the first in the input: the service
 * returns `dueAt asc` so the two agree today, but offering "Acknowledge" on
 * next month's instance because a caller sorted differently would record the
 * wrong answer against the wrong period.
 */
export interface OccurrenceCluster {
  next: OccurrenceDto
  rest: OccurrenceDto[]
}

export function clusterByReminder(occurrences: OccurrenceDto[]): OccurrenceCluster[] {
  const byReminder = new Map<string, OccurrenceDto[]>()
  // Insertion order of the FIRST sighting decides the cluster order, so the
  // page's `dueAt asc` grouping survives: `Map` iterates in insertion order.
  for (const occurrence of occurrences) {
    const existing = byReminder.get(occurrence.reminderId)
    if (existing) existing.push(occurrence)
    else byReminder.set(occurrence.reminderId, [occurrence])
  }
  return [...byReminder.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    const [next, ...rest] = sorted
    return { next, rest }
  })
}
```

Run → PASS (4 tests).

- [ ] **Step 5: Rewrite `OccurrenceList` on `PlanningRow` with the collapse**

`components/reminders/occurrence-list.tsx` — per-change list:
1. `async` server component with `getTranslations`; props gain `locale`, `timeZone`, `collapse?`.
2. Keep `TYPE_TEXT_COLOR` (`:37-40`) but convert to a `StatusTone` map `{ INCOME: 'positive', EXPENSE: 'neutral' }`, keeping the comment about why only income is coloured (a bill that is simply due is not a problem).
3. Delete `dueLine` (`:44-46`) and `contextLine` (`:50-54`); replace with:
   ```ts
   /** Which due-label key this occurrence's day count calls for. */
   function dueKey(occurrence: OccurrenceDto): string {
     if (occurrence.daysToDue < 0) return 'reminders.overdue'
     if (occurrence.daysToDue === 0) return 'reminders.dueToday'
     if (occurrence.daysToDue === 1) return 'reminders.dueTomorrow'
     return 'reminders.dueInDays'
   }
   ```
   and build the context line from the already-translated parts:
   ```ts
   const contextParts = [
     t(recurrenceLabelKey(occurrence.frequency, occurrence.interval), { count: occurrence.interval }),
     occurrence.categoryName,
     occurrence.accountName,
   ].filter((part): part is string => Boolean(part))
   ```
   joined with `' · '` — the same "joined only when they exist, an empty separator reads as a missing value" rule the deleted helper had; keep that sentence as a comment.
4. Render `collapse ? clusterByReminder(occurrences) : occurrences.map((o) => ({ next: o, rest: [] }))` so one code path draws both modes.
5. Each cluster is a `PlanningRow`:
   - `title` = `cluster.next.title`;
   - `badge` = `<>{!compact && <StatusBadge label={t(reminderTypeLabelKey(next.type))} tone={TYPE_TONE[next.type]} />}{cluster.rest.length > 0 && <StatusBadge label={t('reminders.morePeriods', { count: cluster.rest.length })} tone="neutral" />}</>`;
   - `figureLine` = `<MoneyText value={next.amount} currency={next.currency} />`;
   - `meta` = `<span className={cn(next.overdue && 'text-negative')}>{t('reminders.dueLine', { due: t(dueKey(next), { count: next.daysToDue }), date: formatDate(next.dueDate, { locale, timeZone, style: 'date' }) })}</span>` plus, when not `compact`, the context line;
   - `extra` = the disclosure, when `cluster.rest.length > 0`:
     ```tsx
     <details className="mt-1">
       <summary className="cursor-pointer text-xs/[1rem] text-muted-foreground">
         {t('reminders.expandPeriods', { count: cluster.rest.length, name: next.title })}
       </summary>
       <ul className="mt-2 flex flex-col gap-2 border-l border-border pl-3">
         {cluster.rest.map((occurrence) => (
           <li key={occurrence.id} className="flex flex-wrap items-center justify-between gap-2">
             <span className="text-xs/[1rem] text-muted-foreground tabular-nums">
               {formatDate(occurrence.dueDate, { locale, timeZone, style: 'date' })}
             </span>
             {renderActions?.(occurrence)}
           </li>
         ))}
       </ul>
     </details>
     ```
   - `actions` = `renderActions?.(cluster.next)`.
6. Wrap in `<ul className="divide-y divide-border">`; the card belongs to the caller.
7. Keep the module doc's "no total anywhere in this list, and that is deliberate" paragraph (`:17-22`) verbatim — an expected amount is money the user *thinks* will move, and summing them would state a figure that has not happened.

`components/reminders/occurrence-list.test.tsx` (new) — four cases: (1) with `collapse` and four occurrences of one reminder, exactly one `PlanningRow` renders and it carries `reminders.morePeriods` with `{count:3}`; (2) without `collapse`, four rows render and no `morePeriods` badge appears; (3) an overdue occurrence's meta uses `reminders.overdue` and `text-negative`; (4) `daysToDue: 1` uses `reminders.dueTomorrow` and `daysToDue: 5` uses `reminders.dueInDays` with `{count:5}`.

- [ ] **Step 6: Rewrite the definitions list and the two action components**

`components/reminders/reminder-list.tsx` — per-change list:
1. `async` server component with `getTranslations`; props gain `locale`, `timeZone`.
2. `PlanningRow` per definition: `title={reminder.title}`, `badge={<><StatusBadge label={t(reminderTypeLabelKey(reminder.type))} tone={reminder.type === 'INCOME' ? 'positive' : 'neutral'} /><StatusBadge label={t(reminder.active ? 'reminders.activeBadge' : 'reminders.pausedBadge')} tone={reminder.active ? 'neutral' : 'muted'} /></>}`, `figureLine={<MoneyText value={reminder.amount} currency={reminder.currency} />}`, `meta={t('reminders.definitionMeta', { recurrence: t(recurrenceLabelKey(reminder.frequency, reminder.interval), { count: reminder.interval }), date: formatDate(reminder.startDate, { locale, timeZone, style: 'date' }) })}`, `extra` = the optional category/account line and the note, `dim={!reminder.active}`, `actions={renderActions?.(reminder)}`.
3. Keep the module doc's paragraphs about why a paused definition still appears (a reminder the user cannot see is one they cannot resume) and why there is no subtotal strip — both still exactly true.
4. Keep the "state as a *word*, so a dimmed row is never the only signal" comment (`:44-45`), now satisfied by the Paused `StatusBadge`.

`components/reminders/occurrence-actions.tsx` — replace `:84-114`:
1. Two `Button size="sm"`s — `variant="outline"` for Acknowledge, `variant="ghost"` for Dismiss — with `t('reminders.acknowledgeAction')` / `t('reminders.dismissAction')` and their existing `aria-label`s rebuilt as `` `${t('reminders.acknowledgeAction')} ${occurrence.title} · ${formatDate(occurrence.dueDate, …)}` `` — keep the `rowName` construction and its whole doc comment (`:75-82`), which is the reason the due date is in the label.
2. Replace `pending` (`:42`) with `useSubmitState()`; wrap `answer`'s body in `submit.run`; `disabled={submit.locked}` on both buttons.
3. Errors become `<InlineAlert tone="negative">` with `t(REMINDER_ERROR_KEYS[result.error])` / `t(GENERIC_ERROR_KEY)`.
4. Keep the module doc's "neither answer records a Transaction" and "that is also why there is no confirmation dialog on either" paragraphs verbatim — they are the spec's own rule (§10: harmless actions get no dialog).

`components/reminders/reminder-toggle.tsx` — replace `:49-71`: one `Button variant="ghost" size="sm"` with `t(reminder.active ? 'reminders.pauseAction' : 'reminders.resumeAction')` and the same word in its `aria-label` alongside the title; `useSubmitState`; `InlineAlert`. Keep the module doc's "the button's word states the ACTION, not the state" and "why there is no confirmation dialog here" paragraphs.

- [ ] **Step 7: Label all twelve fields in `ReminderForm`**

`components/reminders/reminder-form.tsx` — replace `:182-432` field by field. Read `:20-119` first (the defaults, `INTERVAL_UNITS`, `DAY_OF_MONTH_FREQUENCIES`, `MONTH_LABELS` and the comments about which fields the schema refuses per frequency) and change **none** of that logic:

| Field | Today (`aria-label`) | Becomes (`FormField` label) |
|---|---|---|
| title | `"Title"` | `t('reminders.titleField')`, `helper={t('reminders.titlePlaceholder')}` |
| type | `"Type"` | `t('reminders.type')`; options become `t(reminderTypeLabelKey('EXPENSE'))` / `t(reminderTypeLabelKey('INCOME'))` — EXPENSE stays first so no `defaultValue` is added |
| expectedAmount | `"Expected amount"` | `t('reminders.expectedAmount')`, currency code as an in-field suffix |
| currency | `"Reminder currency"` | `t('reminders.currency')` |
| frequency | `"Frequency"` | `t('reminders.frequency')`; options from `t(recurrenceLabelKey(f, 1))`; **keep the `defaultValue={DEFAULT_FREQUENCY}`** |
| interval | `"Every"` | `t('reminders.interval')`, with the unit rendered beside the input from `t('reminders.intervalUnitWeeks'|'…Months'|'…Years')` chosen by `INTERVAL_UNITS`'s existing mapping — replace that map's English values with the three keys |
| dayOfMonth | `"Day of month"` | `t('reminders.dayOfMonth')`, `helper={t('reminders.dayOfMonthHelper')}` |
| month | `"Month"` | `t('reminders.month')`; the placeholder option becomes `t('reminders.monthPlaceholder')`; **keep `defaultValue=""`**. `MONTH_LABELS` (`:62`) is a hardcoded English month list — replace it with `Array.from({ length: 12 }, (_, index) => formatDate(`2026-${String(index + 1).padStart(2, '0')}-01`, { locale, timeZone, style: 'monthYear' }))`? No — a month *name* without a year is what is wanted, so use `new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, index, 1)))`. Add `locale` to the form's props and note that the year 2026 is arbitrary and never displayed |
| startDate | `"Start date"` | `t('reminders.startDate')` |
| categoryId | `"Category"` | `t('reminders.categoryOptional')` (spec §6.7 names this exactly); the empty option becomes `t('reminders.none')` |
| accountId | `"Account"` | `t('reminders.accountOptional')`; empty option `t('reminders.none')` |
| note | `"Note"` | `t('reminders.note')` |

Plus `useSubmitState`, `InlineAlert`, and `SELECT_CLASS` on all five selects. Update `components/reminders/reminder-form.test.tsx` (264 lines): its eleven `aria-label` assertions become `<label>` assertions, and its assertions about which fields appear per frequency stay exactly as they are.

- [ ] **Step 8: Rewrite `app/(app)/reminders/page.tsx`**

Keep `:1-45` (the module doc, which explains the no-cron materialization and the unbounded list) and the `searchParams` handling. Replace the tab/filter model at `:46-114` and the render at `:167-277`:

1. **Two dimensions in the URL**, not one: `?view=due|schedule` (the spec's two top-level tabs) and `?type=all|bills|income` (the secondary chips, which apply to the `due` view only). Replace `TABS`/`TAB_TYPE`/`resolveTab` with:
   ```ts
   /**
    * Two independent URL parameters, because they are two independent choices
    * (spec §6.7): `view` picks the tab — what is due, or what is scheduled —
    * and `type` is a secondary filter INSIDE the due tab. Folding them into one
    * `?tab=` (as this page did) made "Bills" a peer of "Due", which is why the
    * filter appeared to apply to the definitions list too.
    *
    * Both live in the URL rather than client state for the same reason as
    * before: a filtered Reminders page is then bookmarkable, shareable and
    * reloadable, and it works before (and without) JavaScript.
    */
   const VIEWS = ['due', 'schedule'] as const
   type View = (typeof VIEWS)[number]
   const TYPE_FILTERS = ['all', 'bills', 'income'] as const
   type TypeFilter = (typeof TYPE_FILTERS)[number]
   const FILTER_TYPE: Record<TypeFilter, ReminderType | null> = {
     all: null,
     bills: 'EXPENSE',
     income: 'INCOME',
   }
   ```
   with `resolveView`/`resolveTypeFilter` falling back to `'due'`/`'all'` for anything unrecognised — a malformed value, a stale link, a repeated key arriving as `string[]` — keeping the existing fallback comment (`:71-77`).
2. The two `dueEmptyMessage`/`remindersEmptyMessage` helpers (`:82-114`) become key-choosing functions, preserving their whole reasoning (an empty list *under a filter* means "nothing of this kind", and the unfiltered sentence would then be a claim the user disproves by clicking All):
   ```ts
   function dueEmptyKey(filter: TypeFilter, anyPending: boolean): string {
     if (!anyPending) return 'reminders.emptyDueTitle'
     return filter === 'income' ? 'reminders.emptyDueIncome' : 'reminders.emptyDueBills'
   }
   function scheduleEmptyKey(filter: TypeFilter, anyReminders: boolean): string {
     if (!anyReminders) return 'reminders.emptyDefinitionsTitle'
     return filter === 'income' ? 'reminders.emptyDefinitionsIncome' : 'reminders.emptyDefinitionsBills'
   }
   ```
3. The render:
```tsx
  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-6 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('reminders.title')}
        description={t('reminders.description')}
        actions={
          <ReminderCreateButton
            today={today}
            locale={locale}
            timeZone={timezone}
            // Projected to the two fields the selects render. A whole
            // `FinancialAccount` row would ship its `initialBalance` — a
            // `Prisma.Decimal` — into a client component, and a whole
            // `Category` its `userId` and `status`.
            expenseCategories={expenseCategories.map((c) => ({ id: c.id, name: c.name }))}
            incomeCategories={incomeCategories.map((c) => ({ id: c.id, name: c.name }))}
            accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          />
        }
      />

      <SegmentedControl
        label={t('reminders.tabs')}
        activeId={view}
        segments={[
          { id: 'due', label: t('reminders.tabDue'), href: `/reminders?view=due&type=${filter}` },
          { id: 'schedule', label: t('reminders.tabDefinitions'), href: `/reminders?view=schedule&type=${filter}` },
        ]}
      />

      {/* The type filter is SECONDARY (spec §6.7), so it is a scrollable chip
          row rather than a second segmented control competing with the tabs
          above — and spec §7 permits horizontal scrolling for exactly this and
          forbids it for core metrics. */}
      <nav aria-label={t('reminders.filter')} className="-mx-1 flex gap-1 overflow-x-auto px-1">
        {TYPE_FILTERS.map((id) => (
          <Link
            key={id}
            href={`/reminders?view=${view}&type=${id}`}
            aria-current={filter === id ? 'page' : undefined}
            className={cn(
              'rounded-full px-3 py-1.5 text-[0.8125rem]/[1.125rem] whitespace-nowrap',
              filter === id
                ? 'bg-muted font-medium text-brand'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t(id === 'all' ? 'reminders.filterAll' : id === 'bills' ? 'reminders.filterBills' : 'reminders.filterIncome')}
          </Link>
        ))}
      </nav>

      {view === 'due' ? (
        overdue.length === 0 && upcoming.length === 0 ? (
          <EmptyState
            icon={BellRing}
            size="page"
            // `occurrenceRows`, not `occurrences`: the UNFILTERED list is what
            // decides whether "nothing is due" is true or is just this filter.
            title={t(dueEmptyKey(filter, occurrenceRows.length > 0), {
              days: OCCURRENCE_LOOKAHEAD_DAYS,
            })}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {overdue.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionHeader
                  as="h3"
                  title={t('reminders.groupOverdue')}
                  right={
                    // A muted count rather than a banner: the list can be long
                    // (nothing prunes an unanswered bill) and the user needs to
                    // know how much of it there is without being shouted at.
                    <span className="text-xs/[1rem] text-negative tabular-nums">
                      {t('reminders.overdueCount', { count: overdue.length })}
                    </span>
                  }
                />
                <div className="overflow-hidden rounded-lg border border-border bg-surface">
                  <OccurrenceList
                    occurrences={overdue}
                    locale={locale}
                    timeZone={timezone}
                    collapse
                    renderActions={(occurrence) => <OccurrenceActions occurrence={occurrence} />}
                  />
                </div>
              </section>
            )}
            {upcoming.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionHeader as="h3" title={t('reminders.groupUpcoming')} />
                <div className="overflow-hidden rounded-lg border border-border bg-surface">
                  <OccurrenceList
                    occurrences={upcoming}
                    locale={locale}
                    timeZone={timezone}
                    collapse
                    renderActions={(occurrence) => <OccurrenceActions occurrence={occurrence} />}
                  />
                </div>
              </section>
            )}
          </div>
        )
      ) : reminders.length === 0 ? (
        <EmptyState
          icon={BellRing}
          size="page"
          // `reminderRows`, not `reminders`: a user with income reminders on
          // the Bills filter HAS reminders and must not be told they have none.
          title={t(scheduleEmptyKey(filter, reminderRows.length > 0))}
          description={reminderRows.length === 0 ? t('reminders.emptyDefinitionsBody') : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <ReminderList
            reminders={reminders}
            locale={locale}
            timeZone={timezone}
            renderActions={(reminder) => <ReminderToggle reminder={reminder} />}
          />
        </div>
      )}
    </div>
  )
```
The `Promise.all` at `:141-149` and the filtering/mapping at `:151-165` stay, with `filterType` now coming from `FILTER_TYPE[filter]`. `ReminderCreateButton` is the new sheet-opening client component.

**And update the dashboard's call site**, which Task 4 deliberately left on the old signature: `app/(app)/dashboard/page.tsx`'s `<OccurrenceList occurrences={vm.upcomingReminders} compact />` becomes `<OccurrenceList occurrences={vm.upcomingReminders} locale={locale} timeZone={timezone} compact />` — and **not** `collapse`, for the reason the prop's own doc gives: the widget shows five rows in total and a "+n" badge there would explain a list the user cannot expand. `npx tsc --noEmit` catches it if you forget.

- [ ] **Step 9: Update `e2e/phase6.spec.ts`'s reminders tests**

- `:261-300` (`createReminderViaUi`) — wrap in the create sheet; the eleven label alternations from Step 7 (`/Tiêu đề|^Title$/`, `/^Loại$|^Type$/`, `/Số tiền dự kiến|Expected amount/`, `/Tần suất|^Frequency$/`, `/Ngày trong tháng|Day of month/`, `/Ngày bắt đầu|Start date/`, …); `selectOption` by **value** for type and frequency; submit → `/Thêm nhắc nhở|Add reminder/`.
- `:434-441` — the `/reminders` empty states: `'No reminders yet — add one below.'` → `/Chưa có nhắc nhở|No reminders yet/` and `'Nothing due in the next 30 days.'` → `/Không có gì đến hạn trong 30 ngày tới|Nothing due in the next 30 days/`. Note the trailing full stop is gone from both.
- `:672-707` — `sectionFor(page, 'Due')` no longer exists: the page has tabs, not a "Due" section. Rewrite as: navigate to `/reminders?view=due&type=all`, then scope to the Upcoming or Overdue section by its `h3` (`page.locator('section').filter({ has: page.getByRole('heading', { name: /Sắp tới|^Upcoming$/ }) })`).
- `:689,703` — `'Bill'`/`'Income'` badges → `/Hóa đơn|^Bill$/`, `/Thu nhập|^Income$/`.
- `:708-720` — the Bills/Income tab links become the chip row: `page.getByRole('link', { name: /Hóa đơn|^Bills$/ })` and `/Thu nhập|^Income$/`, and the URL assertion becomes `?type=bills` / `?type=income` rather than `?tab=`.
- `:727-731` — `Acknowledge`/`Dismiss` `aria-label`s: the name is now `` `${action} ${title} · ${localeDate}` ``, so match with a regex that does not pin the date format: `getByRole('button', { name: new RegExp(`(Ghi nhận|Acknowledge).*Internet`) })`.
- `:745-750` — `Pause Salary`/`Resume Salary` → `new RegExp('(Tạm dừng|Pause).*Salary')` / `new RegExp('(Tiếp tục|Resume).*Salary')`; `'Paused'`/`'Active'` badges → `/Tạm dừng|^Paused$/`, `/Đang hoạt động|^Active$/`.
- **Add one new test** for the collapse, which is the spec's headline change here:
  ```ts
  test('a weekly reminder collapses to one row with a +n badge that expands', async ({ page }) => {
    // A WEEKLY reminder starting today materializes ~5 occurrences in the
    // 30-day window, so the list must show one row and a "+4 kỳ" badge.
    await createReminderViaUi(page, {
      title: 'Gym membership',
      type: 'EXPENSE',
      amount: 500_000,
      frequency: 'WEEKLY',
      startDate: TODAY,
    })
    await page.goto('/reminders?view=due&type=all')
    const rows = page.getByRole('listitem').filter({ hasText: 'Gym membership' })
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(/\+\d+ (kỳ|period)/)
    await rows.first().getByRole('group').click() // the <details>' summary
    // Every remaining period is now listed with its own date.
    await expect(rows.first().getByRole('listitem')).not.toHaveCount(0)
  })
  ```
  `getByRole('group')` matches a `<details>`; if Playwright's mapping differs, locate the `<summary>` by its accessible name from `reminders.expandPeriods` instead — verify which works and keep the one that does.

Run: `npx playwright test e2e/phase6.spec.ts` → green.

- [ ] **Step 10: Full verification**

Run: `npm run test` → green (`occurrence-group.test.ts` +4, `occurrence-list.test.tsx` +4, `reminder-view-model.test.ts` migrated, `labels.test.ts` +1 case for `recurrenceLabelKey`'s choice, `reminder-form.test.tsx` migrated).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

- [ ] **Step 11: Browser visual check — Reminders**

Seed: one WEEKLY bill starting today (→ 5 occurrences), one MONTHLY bill overdue by 40 days, one ONE_TIME income due tomorrow, one paused MONTHLY bill, and one income reminder due in 12 days.

Screenshot, light and dark: `/reminders?view=due&type=all` at 1440, 768, 375 (6); the same with the weekly row's disclosure **expanded** at 1440 (1 light); `?type=bills` and `?type=income` at 1440 light (2); `?view=schedule&type=all` at 1440, 375 (2 light + 2 dark = 4); the create sheet at 1440 light and 375 light (2); `?view=due` for a user with nothing at all, 1440 light (1). Sixteen screenshots.

Look for: the two tabs reading as one selected segment; the chip row visibly secondary and scrolling (not the tabs); the Overdue group above Upcoming with its count in negative; **exactly one row** for the weekly reminder carrying "+4 kỳ"; the disclosure listing four dated rows each with its own Acknowledge/Dismiss; the paused definition dimmed *and* badged; the two optional selects labelled "Danh mục (tùy chọn)" / "Tài khoản (tùy chọn)"; the empty state naming the filter when one is applied and not when none is; nothing overflowing at 375.

- [ ] **Step 12: 🛑 VISUAL CHECKPOINT 4 — the planning modules (spec §11)**

**The controller STOPS here and does not start Task 10 until the product owner approves.**

Hand over: `/budgets` 1440 light, `/budgets` 375 light, `/goals` 1440 light, `/goals` 1440 light with the progress dialog, `/debts` 1440 light, `/debts` 375 light, `/loans` 1440 light, `/loans` 1440 light with the instalment dialog showing a computed Tổng, `/reminders?view=due` 1440 light, `/reminders?view=due` 1440 light with the weekly row expanded, `/reminders?view=schedule` 1440 light, `/reminders?view=due` 375 light, and one dark shot of each of the four pages. Sixteen images.

Report alongside them: confirmation that no `window.confirm` and no `page.once('dialog')` remain anywhere; the list of the eight `ConfirmDialog` sites now live (archive account, archive category/account type, delete budget, archive goal, write off debt, close loan, delete transaction, delete transfer); and the observed occurrence count for the weekly reminder before and after expansion.

**Tests required:**
- Vitest: `components/reminders/occurrence-group.test.ts` (4 new); `components/reminders/occurrence-list.test.tsx` (4 new); `lib/ui/reminder-view-model.test.ts` migrated; `lib/ui/labels.test.ts` (+1 recurrence-choice case); `components/reminders/reminder-form.test.tsx` migrated to `<label>` assertions.
- Playwright: `e2e/phase6.spec.ts`'s reminders tests green, `createReminderViaUi` rewritten, plus the new collapse test.

**Browser visual checks required:** the sixteen screenshots in Step 11 and the sixteen-image checkpoint package in Step 12.

**Explicit things NOT to change:** `listUpcomingOccurrences` and the fact that it is the one WRITE on the page (lazy materialization, no cron); `OCCURRENCE_LOOKAHEAD_DAYS`; the unbounded list — nothing may be truncated or hidden behind a "show more" other than the per-reminder collapse this task adds; `overdue`'s single definition (`compareCalendarDates(dueDate, today) < 0`); `acknowledgeOccurrenceAction`/`dismissOccurrenceAction`/`setReminderActiveAction` and the fact that none writes a Transaction; the absence of a confirmation dialog on all four harmless actions; `createReminderSchema`, `DAY_OF_MONTH_FREQUENCIES`, `MIN_INTERVAL`/`MAX_INTERVAL` and which fields the form shows per frequency; `lib/server/services/recurrence.ts`.

**Completion gate:** all four commands green; sixteen screenshots inspected; the weekly reminder renders as one row with a working expander; the two optional selects carry the spec's exact labels; checkpoint package delivered and **approved**.

**Proposed commit boundary:**
1. `feat(reminders): two segmented views, a secondary type filter, and per-reminder occurrence collapse`
2. `feat(reminders): labelled create form, PlanningRow definitions, and the shared in-flight lock on all four row actions`

---
## Task 10: Reports

**Objective:** Rebuild `/reports` to spec §6.8 — a header with the range text and export as **one** secondary menu button ("Xuất Excel ▾" → this range / all data), the period picker as a **real** `SegmentedControl` including a selectable "Tùy chọn" state that reveals From/To and Apply, a three-figure summary panel, By Category as horizontal bars with figures, and By Account as a table on desktop that becomes stacked rows below 768. Report content dominates; controls are compact. The **Excel export contract does not change**.

**Major files touched:** `app/(app)/reports/page.tsx`, `components/reports/period-filter.tsx`, `components/reports/export-menu.tsx` (new), `components/reports/category-bars.tsx` (new), `components/reports/account-table.tsx` (new), `messages/{vi,en}/reports.json`, `e2e/phase4.spec.ts`. Deleted: `components/dashboard/dashboard-section.tsx`, `components/dashboard/kpi-strip.tsx` (their last caller).

**Reusable primitives involved:** `PageHeader`, `ChartContainer`, `SegmentedControl`, `SummaryPanel` (its `flat` variant), `MoneyText`, `Progress` (the category bars), `EmptyState`, `InlineAlert`, `FormField`. **Not** `RowActionsMenu`: the export control is a bespoke `ExportMenu` over `@base-ui/react/menu`, because its items are `<a href>` downloads rather than the `onSelect` callbacks `RowActionsMenu`'s `RowAction` type takes, and its trigger is a labelled secondary button rather than a 36×36 icon.

**User-facing behaviour:** the period control shows six segments — Ngày · Tuần · Tháng · Quý · Năm · Tùy chọn — with the active one visibly selected; "Tùy chọn" is selected when a custom range is applied and reveals two date inputs and an Apply button. One "Xuất Excel ▾" button offers "Khoảng này" and "Toàn bộ dữ liệu". A malformed range still shows the control and an `InlineAlert` with the resolver's message.

**Desktop expectation:** `max-w-[75rem]`, `p-8`; the segmented control and the export button sit in `PageHeader`'s `actions` slot; the summary panel is one three-cell card; By Category and By Account are two full-width `ChartContainer`s stacked (a breakdown and a table are both wide).

**Mobile expectation:** the segmented control scrolls horizontally inside its own track (it is the page's core control, but six segments cannot fit at 375 — spec §7's rule against horizontal scrolling applies to *metrics*, and this is a filter; note that distinction in a comment); the By Account table becomes stacked `FinancialListRow`s below 768; the custom From/To inputs stack.

**Dark-theme expectation:** the category bars are `--color-accent` (a neutral breakdown, not a good/bad judgement — the same choice `chart-theme.ts`'s `distribution` already makes and for the same stated reason); the table's `divide-border` rules stay visible at 14 % white; the export menu popup is `--surface-2`.

**Vietnamese/English expectation:** the six period labels come from `reports.period*` keys (the current page renders the raw `PERIODS` strings with `capitalize`, which is English-only); the range text from `reports.rangeText` with two `formatDate` values; the three summary labels reuse `dashboard.monthlyIncome`-style keys but named `reports.income`/`reports.expense`/`reports.netIncome`; the two export options and the "converted at entry" caption from `reports.*`.

**Accessibility acceptance criteria:** one `h1`; two `h2`s from `ChartContainer`; the segmented control is a `<nav>` with `aria-label` and `aria-current="page"`; the export control is `ExportMenu` — its trigger is a named secondary button, its popup exposes the menu role, it is arrow-key navigable, Escape closes it and focus returns to the trigger, and each item is a real `<a href>` so it can be opened in a new tab or copied like any link; the two date inputs keep their existing `<label htmlFor>`s (`components/reports/period-filter.tsx:74-82,93-101` — this is the **one** place in the app that already had them, and they stay); the table has `<th scope="col">`/`<th scope="row">` exactly as today; the invalid-range message is an `InlineAlert` with `role="alert"`.

**Hydration/form-submission constraints:** none new. `PeriodFilter` stays a **server** component with no state — the address bar remains the single source of truth, which is what makes a report bookmarkable and makes the export links agree with what is on screen. Keep its whole module doc (`:7-21`). The export menu is a client component only because a menu needs one; its items are plain `<a href>`s, not `next/link`, because the response is a file download and not a route — keep that reasoning from `app/(app)/reports/page.tsx:193-196`.

**Files:**
- Create: `components/reports/export-menu.tsx`, `components/reports/category-bars.tsx`, `components/reports/account-table.tsx`, `components/reports/account-table.test.tsx`
- Modify: `app/(app)/reports/page.tsx:100-244`, `components/reports/period-filter.tsx:33-118`, `messages/{vi,en}/reports.json`
- Delete: `components/dashboard/dashboard-section.tsx`, `components/dashboard/kpi-strip.tsx`
- Test: `components/reports/account-table.test.tsx`, `e2e/phase4.spec.ts:203-270`

**Interfaces:**

- Consumes: `PERIODS`, `ReportRange`, `resolveReportRange`, `describeRange`, `rangeToQueryString`, `InvalidReportRangeError` (all existing, `lib/reports/report-range.ts`); `SummaryPanel`, `KpiDto` (Task 4); every Task 1a–1c primitive.
- Produces:

```ts
// components/reports/export-menu.tsx  ('use client')
export function ExportMenu(props: {
  label: string
  /** `null` when no range resolved — there is nothing to export a filter of. */
  filteredHref: string | null
  filteredLabel: string
  fullHref: string
  fullLabel: string
}): React.ReactElement

// components/reports/category-bars.tsx  (server component)
export function CategoryBars(props: {
  rows: { id: string; name: string; amount: string; percent: number; percentLabel: string }[]
  currency: Currency
}): React.ReactElement

// components/reports/account-table.tsx  (server component)
export function AccountTable(props: {
  rows: { id: string; name: string; income: string; expense: string; netIncome: string; netNegative: boolean }[]
  currency: Currency
  labels: { account: string; income: string; expense: string; netIncome: string }
}): React.ReactElement
```

- [ ] **Step 1: Add the message keys**

`messages/vi/reports.json`:
```json
{
  "title": "Báo cáo",
  "rangeText": "{from} – {to} · {currency}",
  "chooseRange": "Chọn khoảng thời gian · {currency}",
  "conversionNote": "Quy đổi theo tỷ giá của từng giao dịch tại thời điểm ghi nhận",
  "period": "Kỳ báo cáo",
  "periodDay": "Ngày",
  "periodWeek": "Tuần",
  "periodMonth": "Tháng",
  "periodQuarter": "Quý",
  "periodYear": "Năm",
  "periodCustom": "Tùy chọn",
  "from": "Từ ngày",
  "to": "Đến ngày",
  "apply": "Áp dụng",
  "income": "Thu nhập",
  "expense": "Chi tiêu",
  "netIncome": "Thu nhập ròng",
  "byCategory": "Theo danh mục",
  "byCategoryCaption": "Chỉ chi tiêu — một dòng thu nhập không có chỗ trong bảng phân tích chi",
  "byAccount": "Theo tài khoản",
  "account": "Tài khoản",
  "export": "Xuất Excel",
  "exportRange": "Khoảng này",
  "exportAll": "Toàn bộ dữ liệu",
  "emptyCategory": "Không có chi tiêu trong khoảng này",
  "emptyAccount": "Không có phát sinh trong khoảng này"
}
```
`messages/en/reports.json`: keep today's wording where it exists — `"income": "Income"`, `"expense": "Expense"`, `"netIncome": "Net Income"`, `"byCategory": "By Category"`, `"byCategoryCaption": "Expenses only — an income row has no place in a spending breakdown"`, `"byAccount": "By Account"`, `"account": "Account"`, `"from": "From"`, `"to": "To"`, `"apply": "Apply"`, `"conversionNote": "Converted at each transaction's exchange rate at entry"`, `"emptyCategory": "No expenses in this range"`, `"emptyAccount": "No activity in this range"`, `"periodDay": "Day"` … `"periodCustom": "Custom"`, `"export": "Export Excel"`, `"exportRange": "This range"`, `"exportAll": "All data"`.

**Note:** `e2e/phase4.spec.ts:233` asserts `getByRole('link', { name: 'month', exact: true })` has `aria-current="page"` — the raw lowercase period name. The segments are now labelled "Tháng"/"Month", so Step 6 updates that.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS.

- [ ] **Step 2: Rewrite `PeriodFilter` as a real segmented control with a selectable custom state**

`components/reports/period-filter.tsx` — keep the whole module doc (`:7-21`) and the `PeriodFilterProps` shape (`:22-31`). Replace `:33-118`:

```tsx
// `async`, because it now translates its own six segment labels. Still a
// SERVER component with no state: the address bar remains the single source of
// truth for which period is showing.
export async function PeriodFilter({ activeKind, from, to }: PeriodFilterProps) {
  const t = await getTranslations()
  const customActive = activeKind === 'custom'

  /**
   * Six segments, and "Tùy chọn" is one of them (spec §6.8): the pre-flight
   * finding was that a custom range left every segment unselected, so the
   * control claimed no period was active while the page showed one. It is a
   * link like the others — clicking it re-applies whatever `from`/`to` the URL
   * already carries, or, with none, lands on the resolver's error branch, which
   * is exactly where a user who asked for a custom range with no dates should
   * be.
   */
  const segments: Segment[] = [
    ...PERIODS.map((period) => ({
      id: period,
      label: t(`reports.period${period.charAt(0).toUpperCase()}${period.slice(1)}`),
      href: `/reports?period=${period}`,
    })),
    {
      id: 'custom',
      label: t('reports.periodCustom'),
      href: `/reports?period=custom${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`,
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      {/* Six segments do not fit at 375, so the TRACK scrolls (the primitive's
          own `overflow-x-auto`). Spec §7's ban on horizontal scrolling is about
          core METRICS — a number the user must see must not be hidden — and a
          filter is not a metric. */}
      <SegmentedControl
        label={t('reports.period')}
        segments={segments}
        activeId={activeKind}
      />

      {/* The From/To pair appears only when the custom segment is selected
          (spec §6.8: "'Tùy chọn' ... reveals the From/To inputs and Apply"),
          so five of the six periods render a control with nothing under it. */}
      {customActive && (
        <form
          method="get"
          action="/reports"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-end"
        >
          {/* Not a `<button name="period" value="custom">`: only the button that
              was clicked is submitted, so pressing Enter in a date field would
              otherwise send no period at all. */}
          <input type="hidden" name="period" value="custom" />
          <FormField id="report-from" label={t('reports.from')} className="flex-1">
            {(aria) => (
              <Input {...aria} name="from" type="date" required defaultValue={from} />
            )}
          </FormField>
          <FormField id="report-to" label={t('reports.to')} className="flex-1">
            {(aria) => <Input {...aria} name="to" type="date" required defaultValue={to} />}
          </FormField>
          <Button type="submit" variant="secondary" className="sm:mb-0">
            {t('reports.apply')}
          </Button>
        </form>
      )}
    </div>
  )
}
```
The `async` keyword is in the signature above; verify the component is only ever rendered from the server reports page with `grep -rn "PeriodFilter" app components`, since an `async` component cannot be rendered from a client one.

**Careful — the template-literal key.** `` t(`reports.period${…}`) `` defeats next-intl's type checking and any future key-extraction tool. Replace it with an explicit map declared beside `PERIODS`' use:
```ts
/** Explicit, not built from the enum: a template-literal key cannot be
 *  type-checked and cannot be found by a key-usage grep. */
const PERIOD_LABEL_KEYS: Record<(typeof PERIODS)[number], string> = {
  day: 'reports.periodDay',
  week: 'reports.periodWeek',
  month: 'reports.periodMonth',
  quarter: 'reports.periodQuarter',
  year: 'reports.periodYear',
}
```

- [ ] **Step 3: Write `ExportMenu`**

`components/reports/export-menu.tsx`:

```tsx
'use client'

import { Menu } from '@base-ui/react/menu'
import { ChevronDown } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'

/**
 * The two export links as ONE secondary button (spec §6.8).
 *
 * Two side-by-side buttons ("Export this range (.xlsx)" and "Export all data
 * (.xlsx)") were the pre-flight finding: two secondary buttons of similar
 * weight beside a page title, one of which most users never want, competing
 * with the report itself. One menu, two items.
 *
 * The items are plain `<a href>`s, not `next/link`: the response is a file
 * download, not a route, so a client-side navigation is the wrong mechanism —
 * the same reasoning the page's header carried before.
 *
 * The `.xlsx` suffix is gone from the labels: the button says "Xuất Excel", so
 * repeating the extension in both items said the format three times. The export
 * itself — its sheet names, its columns, its cells — is untouched.
 */
export function ExportMenu({
  label,
  filteredHref,
  filteredLabel,
  fullHref,
  fullLabel,
}: {
  label: string
  filteredHref: string | null
  filteredLabel: string
  fullHref: string
  fullLabel: string
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        className={buttonVariants({ variant: 'secondary', size: 'default' })}
      >
        {label}
        <ChevronDown aria-hidden="true" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="z-50 min-w-48 rounded-lg border border-border bg-surface-2 p-1 shadow-[0_8px_24px_rgba(25,33,30,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]">
            {filteredHref !== null && (
              <Menu.Item
                render={<a href={filteredHref} />}
                className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted"
              >
                {filteredLabel}
              </Menu.Item>
            )}
            <Menu.Item
              render={<a href={fullHref} />}
              className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted"
            >
              {fullLabel}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
```
Read `components/ui/menu.tsx` first and use its exports if it already wraps these parts; `render={<a href/>}` is Base UI's render-prop for changing an item's element — confirm the prop name in `node_modules/@base-ui/react` and adjust.

- [ ] **Step 4: Write `CategoryBars` and `AccountTable`**

`components/reports/category-bars.tsx`:

```tsx
import { Progress } from '@/components/common/progress'
import { MoneyText } from '@/components/common/money-text'
import type { Currency } from '@/lib/currency/provider'

/**
 * Where the money went, as horizontal bars with their figures (spec §6.8).
 *
 * A list of names and numbers answers "how much"; a bar answers "compared to
 * what", which is the question a breakdown exists for. The bar is relative to
 * the LARGEST row, not to the total: a chart in which the biggest slice is 30 %
 * wide is a chart of empty space.
 *
 * `--color-accent` via `Progress`'s brand tone is deliberate — a spending
 * breakdown is a neutral fact, not a good/bad judgement, which is the same
 * choice `chart-theme.ts` makes for the account distribution.
 */
export function CategoryBars({
  rows,
  currency,
}: {
  rows: { id: string; name: string; amount: string; percent: number; percentLabel: string }[]
  currency: Currency
}) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm">{row.name}</span>
            <MoneyText value={row.amount} currency={currency} />
          </div>
          <Progress
            percent={row.percent}
            valueText={row.percentLabel}
            label={row.name}
            tone="brand"
          />
        </li>
      ))}
    </ul>
  )
}
```

`components/reports/account-table.tsx` — a table from 768 up and stacked rows below it (spec §7: "Tables become stacked rows below 768"):

```tsx
import { cn } from 'cn'
import type { Currency } from '@/lib/currency/provider'
import { MoneyText } from '@/components/common/money-text'

/**
 * Which account the money moved through (spec §6.8).
 *
 * Two renderings of the same rows, and both are in the DOM: a real `<table>`
 * from 768 up, and a stacked list below it. Not one table with
 * `overflow-x-auto` — a four-column money table on a 375 px phone is a table
 * nobody reads sideways, and spec §7 says tables become stacked rows below 768.
 *
 * The duplication is deliberate and cheap: these are a handful of already
 * formatted strings, and the alternative (a `useMediaQuery`) would make a
 * server-rendered table depend on the client.
 */
export function AccountTable({
  rows,
  currency,
  labels,
}: {
  rows: { id: string; name: string; income: string; expense: string; netIncome: string; netNegative: boolean }[]
  currency: Currency
  labels: { account: string; income: string; expense: string; netIncome: string }
}) {
  return (
    <>
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="border-b border-border text-xs/[1rem] tracking-[0.04em] text-muted-foreground uppercase">
            <th scope="col" className="py-2 text-left font-medium">
              {labels.account}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {labels.income}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {labels.expense}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {labels.netIncome}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="py-2 pr-4 text-left font-normal">
                {row.name}
              </th>
              <td className="py-2 pl-4 text-right tabular-nums">{row.income}</td>
              <td className="py-2 pl-4 text-right tabular-nums">{row.expense}</td>
              <td
                className={cn(
                  'py-2 pl-4 text-right font-medium tabular-nums',
                  row.netNegative && 'text-negative',
                )}
              >
                {row.netIncome}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="flex flex-col divide-y divide-border md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 py-3">
            <p className="text-sm font-medium">{row.name}</p>
            <dl className="grid grid-cols-3 gap-2">
              <div className="flex flex-col">
                <dt className="text-xs/[1rem] text-muted-foreground">{labels.income}</dt>
                <dd>
                  <MoneyText value={row.income} size="meta" />
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs/[1rem] text-muted-foreground">{labels.expense}</dt>
                <dd>
                  <MoneyText value={row.expense} size="meta" />
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs/[1rem] text-muted-foreground">{labels.netIncome}</dt>
                <dd>
                  <MoneyText
                    value={row.netIncome}
                    size="meta"
                    tone={row.netNegative ? 'negative' : 'default'}
                  />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <span className="sr-only">{currency}</span>
    </>
  )
}
```
**Careful:** the `sr-only` currency span above is a placeholder for stating the unit once — put it in the `ChartContainer`'s caption instead and delete the span, so the currency is announced where a reader expects it rather than at the end of a table.

`components/reports/account-table.test.tsx` — three cases: (1) both renderings are present, with the table `hidden md:table` and the list `md:hidden`; (2) a negative net income carries `text-negative` in **both** renderings; (3) the table uses `<th scope="col">` four times and `<th scope="row">` once per row.

- [ ] **Step 5: Rewrite `app/(app)/reports/page.tsx`**

Keep `:1-99` — the module doc (every figure is historical, restated at each row's own snapshot, so no current FX rate is read on this page at all), `echoableDate`, `resolveReportRange`'s exact-error narrowing (`if (!(error instanceof InvalidReportRangeError)) throw error`), and `getActivitySummary`. Replace the KPI construction (`:88-98`) with key-based `KpiDto`s and the render (`:100-244`):

```tsx
  const t = await getTranslations()
  const locale = await resolveLocale()

  // The only place a `Decimal` becomes a string on this page.
  const kpis: KpiDto[] = [
    { labelKey: 'reports.income', value: formatMoney(summary.income, displayCurrency, locale), negative: false },
    // Expense is aggregated as a positive magnitude — red by meaning, not by
    // sign — so it is never marked negative here.
    { labelKey: 'reports.expense', value: formatMoney(summary.expense, displayCurrency, locale), negative: false },
    {
      labelKey: 'reports.netIncome',
      value: formatMoney(summary.netIncome, displayCurrency, locale),
      negative: summary.netIncome.isNegative(),
    },
  ]

  // Bars are relative to the LARGEST category, not the total — see CategoryBars.
  const largest = summary.byCategory[0]?.total
  const categoryRows = summary.byCategory.map((row) => ({
    id: row.categoryId ?? 'uncategorized',
    name: row.name,
    amount: formatMoney(row.total, displayCurrency, locale),
    percent: largest && !largest.isZero() ? row.total.div(largest).mul(100).toNumber() : 0,
    percentLabel: `${row.total.div(summary.expense.isZero() ? row.total : summary.expense).mul(100).toDecimalPlaces(0).toString()} %`,
  }))

  const accountRows = summary.byAccount.map((row) => ({
    id: row.accountId,
    name: row.name,
    income: formatMoney(row.income, displayCurrency, locale),
    expense: formatMoney(row.expense, displayCurrency, locale),
    netIncome: formatMoney(row.netIncome, displayCurrency, locale),
    netNegative: row.netIncome.isNegative(),
  }))

  return (
    <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-6 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('reports.title')}
        description={t('reports.rangeText', {
          from: fromLabel,
          to: toLabelInclusive,
          currency: displayCurrency,
        })}
        // Always shown, though it only bites for a user with accounts in more
        // than one currency: every figure on this page is history, restated at
        // the rate each row snapshotted when it was entered — never at today's
        // rate. Someone comparing a report against a bank statement, or against
        // the same report run last month, needs to know that up front, and a
        // caption that appeared only sometimes would be missed exactly when it
        // mattered.
        meta={t('reports.conversionNote')}
        actions={
          <ExportMenu
            label={t('reports.export')}
            filteredHref={`/api/reports/export?mode=filtered&${rangeToQueryString(range)}`}
            filteredLabel={t('reports.exportRange')}
            fullHref="/api/reports/export?mode=full"
            fullLabel={t('reports.exportAll')}
          />
        }
      />

      <PeriodFilter
        activeKind={range.kind}
        from={range.kind === 'custom' ? range.from : ''}
        to={range.kind === 'custom' ? range.to : ''}
      />

      <SummaryPanel
        variant="flat"
        kpis={kpis}
        currency={displayCurrency}
        labels={{
          'reports.income': t('reports.income'),
          'reports.expense': t('reports.expense'),
          'reports.netIncome': t('reports.netIncome'),
        }}
        hints={{}}
      />

      <ChartContainer title={t('reports.byCategory')} caption={t('reports.byCategoryCaption')}>
        {categoryRows.length === 0 ? (
          <EmptyState icon={PieChart} title={t('reports.emptyCategory')} />
        ) : (
          <CategoryBars rows={categoryRows} currency={displayCurrency} />
        )}
      </ChartContainer>

      <ChartContainer title={t('reports.byAccount')} caption={displayCurrency}>
        {accountRows.length === 0 ? (
          <EmptyState icon={Wallet} title={t('reports.emptyAccount')} />
        ) : (
          <AccountTable
            rows={accountRows}
            currency={displayCurrency}
            labels={{
              account: t('reports.account'),
              income: t('reports.income'),
              expense: t('reports.expense'),
              netIncome: t('reports.netIncome'),
            }}
          />
        )}
      </ChartContainer>
    </div>
  )
```

**Two corrections to make while writing this:**
- `SummaryPanel` takes `variant` (Task 4): pass `variant="flat"` here, which renders every KPI as an equal cell in a `grid-cols-1 md:grid-cols-3` — what Reports wants and what `KpiStrip` did for it. `'dashboard'` keeps the Net-Worth-dominant hierarchy and is wrong for three equal figures.
- `PeriodFilter`'s current `from`/`to` props are passed the *labels* for a non-custom range (`app/(app)/reports/page.tsx:109-110` passes `fromLabel`/`toLabelInclusive`), which are display strings a `<input type="date">` cannot hold. Since the inputs now render only in the custom branch, pass `''` for a non-custom range as above and note in `PeriodFilterProps` that these are `yyyy-MM-dd` carriers or `''`, never display labels. Keep `echoableDate` for the invalid-range branch, which must still echo what the user typed.

The invalid-range branch (`:69-82`) becomes:
```tsx
    return (
      <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-6 p-4 md:p-6 lg:p-8">
        <PageHeader
          title={t('reports.title')}
          description={t('reports.chooseRange', { currency: displayCurrency })}
          meta={t('reports.conversionNote')}
          actions={
            <ExportMenu
              label={t('reports.export')}
              filteredHref={null}
              filteredLabel={t('reports.exportRange')}
              fullHref="/api/reports/export?mode=full"
              fullLabel={t('reports.exportAll')}
            />
          }
        />
        <PeriodFilter activeKind="custom" from={echoableDate(params.from)} to={echoableDate(params.to)} />
        <InlineAlert tone="negative">{error.message}</InlineAlert>
      </div>
    )
```
`activeKind="custom"` rather than `null`, so the From/To pair the user needs to correct is actually on screen — which is the whole point of echoing the values.

**Note:** `error.message` comes from `InvalidReportRangeError` and is English (`lib/reports/report-range.ts:192`). Leave it: it is a resolver message about a hand-typed URL, not product copy, and translating it means touching `lib/reports/`, which this phase does not. Record it in the Task 13 audit as a **known, accepted** English string with that reasoning.

- [ ] **Step 6: Delete the two superseded dashboard components**

```bash
grep -rn "DashboardSection\|DashboardEmpty\|KpiStrip" app components lib e2e
```
Expected: no hits. Then:
```bash
git rm components/dashboard/dashboard-section.tsx components/dashboard/kpi-strip.tsx
```
If any hit remains, it is a caller this plan missed — fix that caller in this task rather than keeping the file.

- [ ] **Step 7: Update `e2e/phase4.spec.ts`'s reports tests**

- `:205` — the `h1`: `/Báo cáo|^Reports$/`.
- `:233-236` — `getByRole('link', { name: 'month', exact: true })` → `getByRole('link', { name: /^Tháng$|^Month$/ })`; the `aria-current="page"` assertion stands.
- `:239,264` — the `kpiValue(label)` helper's `getByText(label, { exact: true })`: pass regexes and drop `exact`. The three labels become `/Thu nhập$|^Income$/`, `/Chi tiêu|^Expense$/`, `/Thu nhập ròng|Net Income/`. **Careful:** "Thu nhập" is a prefix of "Thu nhập ròng", so the income regex must be anchored — use `/^Thu nhập$|^Income$/` and `/^Thu nhập ròng$|^Net Income$/`.
- `:253-255` — the custom-range form: it now appears only after the custom segment is selected, so add a click first: `await page.getByRole('link', { name: /Tùy chọn|^Custom$/ }).click()`, then `getByLabel(/Từ ngày|^From$/)` / `getByLabel(/Đến ngày|^To$/)` and Apply → `/Áp dụng|^Apply$/`.
- **Add two assertions** the spec text requires: after applying a custom range, the "Tùy chọn" segment carries `aria-current="page"` (the pre-flight finding); and the export control is **one** button whose menu holds two items:
  ```ts
  await expect(page.getByRole('link', { name: /Tùy chọn|^Custom$/ })).toHaveAttribute('aria-current', 'page')
  const exportButton = page.getByRole('button', { name: /Xuất Excel|Export Excel/ })
  await expect(exportButton).toBeVisible()
  await exportButton.click()
  await expect(page.getByRole('menuitem')).toHaveCount(2)
  ```
- The export **download** itself: `e2e/phase5.spec.ts` and `e2e/phase6.spec.ts` download the file and read it with ExcelJS. Those tests click the old links by name. Update their click target to the menu (`click the button, then the "Khoảng này"/"Toàn bộ dữ liệu" item`) and change **nothing** about the ExcelJS assertions — the export contract does not change, and those assertions are the proof.

Run: `npx playwright test` → green, including every export-sheet assertion in `phase5.spec.ts` and `phase6.spec.ts`.

- [ ] **Step 8: Full verification**

Run: `npm run test` → green, and specifically `npx vitest run lib/server/export app/api/reports` → green **untouched**, which is the export contract's guard.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

- [ ] **Step 9: Browser visual check — Reports**

Seed the Phase-4 fixture (one VND account, one income of 500.000 and one expense of 200.000 today) plus a second month of history and a USD account, so By Account has two rows and one net is negative.

Screenshot, light and dark: `/reports` (default month) at 1440, 768, 375 (6); `/reports?period=custom&from=…&to=…` at 1440 (1 light); `/reports?period=weekly` (an invalid period) at 1440 (1 light); `/reports` at 1440 with the export menu open (1 light); `/reports` at 375 showing the stacked account rows (1 light, included above — take an extra clipped shot of just that block). Ten screenshots.

Look for: the active period segment visibly *selected*, and "Tùy chọn" selected on a custom range; the From/To pair absent for the five named periods and present for custom; one export button, two menu items; the category bars scaled to the largest row with their figures right-aligned; the account table at 768+ and stacked rows at 375 with no horizontal scroll; the invalid-range page showing the control, the echoed dates and one `InlineAlert`; the report content occupying more visual weight than the controls.

**Tests required:**
- Vitest: `components/reports/account-table.test.tsx` (3 new); `components/dashboard/summary-panel.test.tsx` (+2 for the `flat` variant); the export suites re-run untouched as the contract guard.
- Playwright: `e2e/phase4.spec.ts`'s reports tests updated plus the two new assertions; `phase5.spec.ts`/`phase6.spec.ts`'s export clicks routed through the menu with their ExcelJS assertions unchanged.

**Browser visual checks required:** the ten screenshots in Step 9.

**Explicit things NOT to change:** `lib/reports/report-range.ts` in any way — `PERIODS`, `resolveReportRange`, `describeRange`, `rangeToQueryString`, `InvalidReportRangeError` and its message; `getActivitySummary`; `app/api/reports/export/route.ts` and everything under `lib/server/export/`; the fact that the export links are plain anchors; the fact that the filtered link is built from the *resolved* range so the file matches the screen; the `<th scope>` structure of the account table.

**Completion gate:** all four commands green; the export tests green and untouched; ten screenshots inspected; the custom segment selectable and selected; `grep -rn "DashboardSection\|KpiStrip" app components lib e2e` returns nothing.

**Proposed commit boundary:**
1. `feat(reports): a real segmented period control with a selectable custom state and one export menu`
2. `refactor(reports): category bars, a responsive account table, and the removal of DashboardSection/KpiStrip`

---
## Task 11: Settings

**Objective:** Rebuild `/settings` to the amended spec §6.9 — three visual cards but **two** forms: "Hồ sơ" and "Tùy chọn" are two labelled `<fieldset>` groups of **one** `ProfileForm` with a **single Save** (all five fields belong to the one `updateProfile` action, and two Saves each posting the whole `ProfileInput` would race and overwrite each other), and "Bảo mật" is the separate change-password form with its own Save. Every control gets a visible label, the timezone becomes a native select of IANA zones grouped by region with the current value first, feedback is an inline `InlineAlert`, and a successful save toggles the `dark` class optimistically.

**Major files touched:** `app/(app)/settings/page.tsx`, `components/settings/settings-card.tsx` (new), `components/settings/profile-form.tsx`, `components/settings/change-password-form.tsx`, `lib/ui/timezones.ts` (new), `messages/{vi,en}/settings.json`, `e2e/settings-form-hydration.spec.ts`, `e2e/phase7-theme-locale.spec.ts` (new).

**Reusable primitives involved:** `PageHeader`, `SectionHeader`, `FormField`/`Label`/`FieldError`/`SELECT_CLASS`, `InlineAlert`, `useSubmitState`, `useHydrated`.

**User-facing behaviour:** three cards. The first two — Hồ sơ (name) and Tùy chọn (Tiền tệ hiển thị, Ngôn ngữ, Giao diện, Múi giờ) — are one form with one Save at the bottom; saving writes all five fields in a single `updateProfile` call, shows one success alert, and applies a theme change immediately (the `dark` class is toggled on `<html>`) while the rest of the shell picks it up on the next navigation. The third card, Bảo mật, changes the password and has its own Save. Neither form navigates.

**Desktop expectation:** `max-w-[30rem]` (spec §2: single-column forms are 480), `p-8`, three stacked cards with 32 px between them; each card `rounded-lg border border-border bg-surface p-6`; the profile form's single Save sits `self-start` **below** the second card, so it visibly belongs to both groups rather than to the group above it.

**Mobile expectation:** the same single column at `p-4`; inputs 44 px; the timezone select is a native `<select>`, so the phone's own picker handles a 400-entry list instead of a custom popup.

**Dark-theme expectation:** saving `dark` toggles the class immediately, so the page the user is looking at changes without a reload; saving `light` removes it. The cards are `bg-surface`; inputs use `--input-bg` (Task 1a) rather than a translucent wash; the success alert is the positive tint at 18 %.

**Vietnamese/English expectation:** every label and option from `settings.json`; the currency options are the codes; the locale options are "Tiếng Việt" / "English", each named in **its own** language — a language picker that names languages in the current language is the one place that is wrong; the theme options are "Sáng" / "Tối" (vi) and "Light" / "Dark" (en); the timezone `<optgroup>` labels are the region segment of the IANA id itself, and the leading group's label is `settings.timezoneCurrent`.

**Accessibility acceptance criteria:**
- One `h1`; three `h2`s from `SectionHeader` (Hồ sơ, Tùy chọn, Bảo mật).
- Each of the profile form's two groups is a `<fieldset>` with a `<legend>` naming it, so a screen reader announces which group a control belongs to; the `<legend>` is `sr-only` because the card's visible `h2` already says it, and duplicating it would announce the name twice.
- Every one of the eight controls has a visible `<label htmlFor>` (today the profile form has five placeholder- or label-less controls and the password form two).
- Success is an `InlineAlert` (positive tone, **no** `role="alert"` — a confirmation the user just asked for is not an interruption); failure is an `InlineAlert` (negative, `role="alert"`).
- Both fieldsets are `disabled` + `aria-busy` while saving, so a second Save is impossible and the whole group reads as busy.
- The single Save is `disabled` until the form is dirty — a Save that does nothing is a Save that lies.

**Hydration/form-submission constraints:** the `useHydrated()` gate stays on the profile form, and it is the worst case of the reversion defect in the whole app because **every** field carries a `defaultValues` entry — `components/settings/profile-form.tsx:46-65` documents exactly that, and a live pre-fix probe reverted a name typed early 5/5. Both fieldsets therefore carry `disabled={!hydrated || submit.locked}`, and every control keeps its `defaultValue` (never `value`, which would make it controlled) so the server renders the stored profile rather than an empty box and RHF's one destructive ref write agrees with the markup it lands on. The password form has **no** `defaultValues` and therefore needs no gate — `lib/ui/use-hydrated.ts`'s documented "a field with NO default has RHF read the DOM instead of writing over it" branch is why; say so in a comment rather than adding a gate for symmetry. Both forms get `useSubmitState`.

**Files:**
- Create: `components/settings/settings-card.tsx`, `lib/ui/timezones.ts`, `lib/ui/timezones.test.ts`
- Modify: `app/(app)/settings/page.tsx:14-25`, `components/settings/profile-form.tsx:1-127` (whole file), `components/settings/change-password-form.tsx:45-75`, `messages/{vi,en}/settings.json`
- Create: `e2e/phase7-theme-locale.spec.ts`
- Test: `lib/ui/timezones.test.ts`, `components/settings/profile-form.test.tsx`, `e2e/settings-form-hydration.spec.ts`, `e2e/phase7-theme-locale.spec.ts`

**Interfaces:**

- Consumes: `PageHeader`, `SectionHeader`, `FormField`, `SELECT_CLASS`, `InlineAlert` (Tasks 1a–1c); `useSubmitState` (Task 1c); `useHydrated` (existing); `profileSchema`, `ProfileInput`, `resolveProfileDefaults` (existing); `updateProfile` (existing, with Task 2a's cookie writes); `THEME_COOKIE` is **not** consumed here — the class toggle is local and the cookie was written by the action.
- Produces:

```ts
// lib/ui/timezones.ts
export interface TimezoneGroup {
  /** The region prefix of the IANA id, e.g. `'Asia'`; `'current'` for the
   *  single-entry group hoisted to the front. */
  region: string
  /** Ids in that region, alphabetical. */
  zones: string[]
}
export function timezoneGroups(current: string): TimezoneGroup[]

// components/settings/settings-card.tsx
export function SettingsCard(props: {
  title: string
  description?: string
  children: React.ReactNode
}): React.ReactElement

// components/settings/profile-form.tsx  ('use client') — ALL FIVE FIELDS, ONE SAVE
export function ProfileForm(props: {
  defaultValues: ProfileInput
  /** Already-translated card copy, so the form can render the two groups'
   *  headings itself and keep the single Save below both of them. */
  labels: {
    profileTitle: string
    profileDescription: string
    preferencesTitle: string
    preferencesDescription: string
  }
}): React.ReactElement
```

There is **no** `PreferencesForm`. An earlier draft split the four preference fields into a second form with its own Save; the amended spec rejects that, and so does the arithmetic: both forms would post the whole `ProfileInput`, so whichever saved second would write back the other's pre-change values.

- [ ] **Step 1: Add the message keys**

`messages/vi/settings.json`:
```json
{
  "title": "Cài đặt",
  "profileTitle": "Hồ sơ",
  "profileDescription": "Tên hiển thị trong ứng dụng.",
  "name": "Tên",
  "preferencesTitle": "Tùy chọn",
  "preferencesDescription": "Cách CashFlow hiển thị số liệu cho bạn.",
  "baseCurrency": "Tiền tệ hiển thị",
  "baseCurrencyHelper": "Chỉ dùng để hiển thị các số tổng đã quy đổi.",
  "locale": "Ngôn ngữ",
  "theme": "Giao diện",
  "themeLight": "Sáng",
  "themeDark": "Tối",
  "timezone": "Múi giờ",
  "timezoneHelper": "Quyết định ngày và kỳ báo cáo của bạn.",
  "timezoneCurrent": "Đang dùng",
  "profileGroup": "Hồ sơ",
  "preferencesGroup": "Tùy chọn hiển thị",
  "saveProfile": "Lưu",
  "savingProfile": "Đang lưu…",
  "profileSaved": "Đã lưu hồ sơ",
  "securityTitle": "Bảo mật",
  "securityDescription": "Đổi mật khẩu đăng nhập.",
  "currentPassword": "Mật khẩu hiện tại",
  "newPassword": "Mật khẩu mới",
  "changePasswordAction": "Đổi mật khẩu",
  "changePasswordPending": "Đang đổi…",
  "passwordChanged": "Đã đổi mật khẩu",
  "passwordError": "Mật khẩu hiện tại không đúng hoặc mật khẩu mới không hợp lệ"
}
```
`messages/en/settings.json`: the same keys — keep `"name": "Name"`, `"currentPassword": "Current password"`, `"newPassword": "New password"`, `"changePasswordAction": "Change password"`, `"passwordChanged": "Password updated"`, `"passwordError": "Current password is incorrect or the new password is invalid"` and `"profileSaved": "Profile saved"` verbatim (the last is asserted at `e2e/settings-form-hydration.spec.ts:214,251`), plus `"profileTitle": "Profile"`, `"preferencesTitle": "Preferences"`, `"securityTitle": "Security"`, `"baseCurrency": "Display currency"`, `"locale": "Language"`, `"theme": "Theme"`, `"themeLight": "Light"`, `"themeDark": "Dark"`, `"timezone": "Time zone"`, `"timezoneCurrent": "Current"`, `"profileGroup": "Profile"`, `"preferencesGroup": "Display preferences"`, `"saveProfile": "Save"`, `"savingProfile": "Saving…"`, and English for the two helpers and the three descriptions.

**Note:** there is no `preferencesSaved` key. One form, one Save, one success message — `profileSaved` covers all five fields, and its English wording is the one two existing e2e assertions already match.

Run: `npx vitest run lib/i18n/messages.test.ts` → PASS (key parity).

- [ ] **Step 2: Write the failing test for `timezoneGroups`**

`lib/ui/timezones.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { timezoneGroups } from './timezones'

describe('timezoneGroups', () => {
  it('puts the current zone first, in its own group', () => {
    const groups = timezoneGroups('Asia/Ho_Chi_Minh')
    expect(groups[0].zones).toEqual(['Asia/Ho_Chi_Minh'])
    expect(groups[0].region).toBe('current')
  })

  it('groups the rest by region, alphabetically within each', () => {
    const groups = timezoneGroups('Asia/Ho_Chi_Minh')
    const asia = groups.find((group) => group.region === 'Asia')
    expect(asia).toBeDefined()
    expect(asia!.zones).toEqual([...asia!.zones].sort())
    expect(asia!.zones).toContain('Asia/Tokyo')
    // The current zone appears once, not twice.
    expect(asia!.zones).not.toContain('Asia/Ho_Chi_Minh')
  })

  it('lists every zone exactly once across all groups', () => {
    const groups = timezoneGroups('UTC')
    const all = groups.flatMap((group) => group.zones)
    expect(new Set(all).size).toBe(all.length)
  })

  it('includes a zone the runtime does not enumerate, when it is the current one', () => {
    // `Intl.supportedValuesOf('timeZone')` omits some legacy aliases. A user
    // whose stored zone is one of them must still see it selected rather than
    // silently switched to something else on the next save.
    const groups = timezoneGroups('US/Pacific')
    expect(groups[0].zones).toEqual(['US/Pacific'])
  })
})
```

Run: `npx vitest run lib/ui/timezones.test.ts` → FAIL (`Failed to resolve import "./timezones"`).

- [ ] **Step 3: Write `lib/ui/timezones.ts`**

```ts
/**
 * The IANA zone list for the Settings picker (spec §6.9: "timezone as a native
 * select of IANA zones grouped by region, with the current value first").
 *
 * `Intl.supportedValuesOf('timeZone')` is the runtime's own list, so it needs no
 * bundled data file and cannot drift from what `Intl.DateTimeFormat` accepts —
 * which matters, because `isValidIanaTimezone` in `lib/validation/profile.ts`
 * validates against exactly that.
 *
 * The current zone is hoisted into its own leading group for two reasons: a
 * user opening the picker is looking for what they have, and the list omits some
 * legacy aliases (`US/Pacific`), so a stored value that is not in it must still
 * be selectable or the form would silently change it on the next save.
 */
export interface TimezoneGroup {
  region: string
  zones: string[]
}

export function timezoneGroups(current: string): TimezoneGroup[] {
  const all = Intl.supportedValuesOf('timeZone')
  const byRegion = new Map<string, string[]>()
  for (const zone of all) {
    if (zone === current) continue
    const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other'
    const existing = byRegion.get(region)
    if (existing) existing.push(zone)
    else byRegion.set(region, [zone])
  }
  return [
    { region: 'current', zones: [current] },
    ...[...byRegion.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([region, zones]) => ({ region, zones: zones.sort((a, b) => a.localeCompare(b)) })),
  ]
}
```

Run: `npx vitest run lib/ui/timezones.test.ts` → PASS (4 tests).

- [ ] **Step 4: Write `SettingsCard`**

`components/settings/settings-card.tsx`:

```tsx
import { SectionHeader } from '@/components/common/section-header'

/**
 * One settings card (spec §6.9): a titled bordered surface holding a group of
 * fields.
 *
 * It is deliberately NOT "a card plus its own Save": the amended spec has three
 * visual cards but two forms, because Hồ sơ and Tùy chọn are five fields of one
 * `updateProfile` call and two Saves posting the whole `ProfileInput` would race
 * — whichever landed second would write back the other's pre-change values. So
 * this component draws the surface and the heading; the FORM decides where its
 * one Save goes.
 */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6">
      <SectionHeader title={title} caption={description} />
      {children}
    </section>
  )
}
```

- [ ] **Step 5: Rewrite `components/settings/profile-form.tsx` — one form, two groups, one Save**

```tsx
'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'
import { updateProfile } from '@/lib/server/actions/update-profile'
import { timezoneGroups } from '@/lib/ui/timezones'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { SettingsCard } from '@/components/settings/settings-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The profile: all five fields of `updateProfile`, in two labelled groups, with
 * ONE Save (amended spec §6.9).
 *
 * Two Saves were tried and rejected. Both would have posted the whole
 * `ProfileInput` — the action's Zod schema requires every field — so a user who
 * changed the name in one card and the theme in the other, saving each, would
 * have had the second save write back the first's pre-change value. One form
 * cannot have that bug.
 *
 * The two `<fieldset>`s are the groups. They exist for three reasons at once:
 * they name each group to a screen reader through their `<legend>`, they are
 * the native mechanism the hydration gate and the in-flight lock use, and they
 * let the two visual cards sit inside one `<form>` with the Save below both.
 */
export function ProfileForm({
  defaultValues,
  labels,
}: {
  defaultValues: ProfileInput
  labels: {
    profileTitle: string
    profileDescription: string
    preferencesTitle: string
    preferencesDescription: string
  }
}) {
  const router = useRouter()
  const t = useTranslations()
  const [notice, setNotice] = useState<string | null>(null)
  /** See the fieldsets below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const submit = useSubmitState()
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isDirty },
  } = useForm<ProfileInput>({ resolver: zodResolver(profileSchema), defaultValues })

  /** The zone list, with the stored value hoisted to its own leading group. */
  const groups = timezoneGroups(defaultValues.timezone)

  async function onSubmit(values: ProfileInput) {
    setNotice(null)
    await submit.run(async () => {
      try {
        const result = await updateProfile(values)
        if (!result.ok) {
          setError('root', { message: t('errors.generic') })
          return
        }
      } catch {
        console.error('Profile update request failed')
        setError('root', { message: t('errors.generic') })
        return
      }
      reset(values)
      setNotice(t('settings.profileSaved'))

      // Spec §3: "the profile form applies the `dark` class immediately after a
      // successful save".
      //
      // Only after the action resolved `ok`, and only the class — the cookie and
      // the row were written by `updateProfile`, and the next server render
      // produces the same class from `resolveTheme()`. So this is not a second
      // source of truth; it is the same truth applied one navigation earlier.
      // `classList.toggle` with an explicit second argument rather than a bare
      // toggle, so a second save cannot invert it.
      document.documentElement.classList.toggle('dark', values.theme === 'dark')
      document.documentElement.style.colorScheme = values.theme

      // And the shell — the rail's labels, every figure's grouping — re-renders
      // from the database on the next server pass.
      router.refresh()
    })
  }

  /**
   * Both groups share it: `!hydrated` is the pre-hydration gate (this form is
   * the worst case — EVERY field has a `defaultValues` entry, so every field
   * was revertible), and `submit.locked` is spec §9's in-flight lock. A
   * `<fieldset disabled>` is the one native mechanism that disables everything
   * inside it, and `:disabled` matches those descendants, so the existing
   * `disabled:` styles apply with no new CSS. `min-w-0` neutralises a
   * fieldset's default `min-inline-size: min-content`, and Tailwind's preflight
   * already zeroes its margin/padding/border — so nothing shifts when the gate
   * lifts.
   */
  const fieldsetProps = {
    disabled: !hydrated || submit.locked,
    'aria-busy': submit.busy,
    className: 'flex min-w-0 flex-col gap-4',
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-8">
      <SettingsCard title={labels.profileTitle} description={labels.profileDescription}>
        <fieldset {...fieldsetProps}>
          {/* `sr-only`: the card's visible `h2` already names the group, and a
              visible legend would say it twice. */}
          <legend className="sr-only">{t('settings.profileGroup')}</legend>
          <FormField id="settings-name" label={t('settings.name')} error={errors.name?.message}>
            {(aria) => (
              // `defaultValue` (never `value` — that would make it controlled)
              // so the SERVER renders the stored name instead of an empty box,
              // and RHF's one destructive ref write agrees with the markup it
              // lands on.
              <Input {...aria} {...register('name')} defaultValue={defaultValues.name} />
            )}
          </FormField>
        </fieldset>
      </SettingsCard>

      <SettingsCard title={labels.preferencesTitle} description={labels.preferencesDescription}>
        <fieldset {...fieldsetProps}>
          <legend className="sr-only">{t('settings.preferencesGroup')}</legend>

          <FormField
            id="settings-base-currency"
            label={t('settings.baseCurrency')}
            helper={t('settings.baseCurrencyHelper')}
            error={errors.baseCurrency?.message}
          >
            {(aria) => (
              <select
                {...aria}
                {...register('baseCurrency')}
                defaultValue={defaultValues.baseCurrency}
                className={SELECT_CLASS}
              >
                <option value="VND">VND</option>
                <option value="USD">USD</option>
              </select>
            )}
          </FormField>

          <FormField id="settings-locale" label={t('settings.locale')} error={errors.locale?.message}>
            {(aria) => (
              <select
                {...aria}
                {...register('locale')}
                defaultValue={defaultValues.locale}
                className={SELECT_CLASS}
              >
                {/* Each language named in ITS OWN language, deliberately: a
                    language picker that renders "Vietnamese" to someone who
                    cannot read English is the one label that must not be
                    translated. */}
                <option value="vi">Tiếng Việt</option>
                <option value="en">English</option>
              </select>
            )}
          </FormField>

          <FormField id="settings-theme" label={t('settings.theme')} error={errors.theme?.message}>
            {(aria) => (
              <select
                {...aria}
                {...register('theme')}
                defaultValue={defaultValues.theme}
                className={SELECT_CLASS}
              >
                <option value="light">{t('settings.themeLight')}</option>
                <option value="dark">{t('settings.themeDark')}</option>
              </select>
            )}
          </FormField>

          <FormField
            id="settings-timezone"
            label={t('settings.timezone')}
            helper={t('settings.timezoneHelper')}
            error={errors.timezone?.message}
          >
            {(aria) => (
              // A native `<select>` with `<optgroup>`s, not a custom combobox:
              // four hundred entries is exactly the case a phone's own picker
              // handles better than anything this app could build, and it
              // replaces the free-text input a user could type an invalid zone
              // into. `isValidIanaTimezone` still validates it server-side.
              <select
                {...aria}
                {...register('timezone')}
                defaultValue={defaultValues.timezone}
                className={SELECT_CLASS}
              >
                {groups.map((group) => (
                  <optgroup
                    key={group.region}
                    label={group.region === 'current' ? t('settings.timezoneCurrent') : group.region}
                  >
                    {group.zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </FormField>
        </fieldset>
      </SettingsCard>

      {/* ONE Save, below both cards, so it visibly belongs to both groups
          rather than to the one above it. `!isDirty` because a Save that does
          nothing is a Save that lies. */}
      <div className="flex flex-col gap-3">
        {errors.root && <InlineAlert tone="negative">{errors.root.message}</InlineAlert>}
        {notice && <InlineAlert tone="positive">{notice}</InlineAlert>}
        <Button
          type="submit"
          className="self-start"
          disabled={!hydrated || submit.locked || !isDirty}
        >
          {submit.pending ? t('settings.savingProfile') : t('settings.saveProfile')}
        </Button>
      </div>
    </form>
  )
}
```

**Note on the Save's `disabled`:** it is outside both fieldsets, so it does not inherit their `disabled` — which is why `!hydrated || submit.locked` is repeated on it explicitly. Do not move it inside a fieldset to save the repetition: it belongs to neither group.

- [ ] **Step 6: Label the password form and rewrite the page**

`components/settings/change-password-form.tsx` — replace `:46-75`:
- current password → `<FormField id="settings-current-password" label={t('settings.currentPassword')} error={errors.currentPassword?.message}>{(aria) => <Input {...aria} type="password" autoComplete="current-password" {...register('currentPassword')} />}</FormField>`;
- new password → the same with `id="settings-new-password"`, `label={t('settings.newPassword')}`, `autoComplete="new-password"`;
- wrap both in `<fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex min-w-0 flex-col gap-4">` with an `sr-only` `<legend>{t('settings.securityTitle')}</legend>`;
- the notice becomes `<InlineAlert tone="positive">{t('settings.passwordChanged')}</InlineAlert>`, the root error `<InlineAlert tone="negative">` carrying `t('settings.passwordError')` or `t('errors.generic')`;
- the submit becomes `{submit.pending ? t('settings.changePasswordPending') : t('settings.changePasswordAction')}` with `className="self-start"`;
- keep the "Never echo Better Auth's own message back to the user" comment (`:30`) verbatim, and keep `revokeOtherSessions: true`;
- add a comment stating that this form has **no** `defaultValues` and therefore needs no `useHydrated` gate, citing `lib/ui/use-hydrated.ts`'s reasoning — so nobody adds one for symmetry.

`app/(app)/settings/page.tsx` — replace `:14-25`, keeping the `requireUserOrRedirect()` call and its whole "a layout is not an auth boundary" comment at `:7-11` (which every other page's comment points at):

```tsx
  const defaults = resolveProfileDefaults(user)
  const t = await getTranslations()

  return (
    <div className="mx-auto flex w-full max-w-[30rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader title={t('settings.title')} />

      {/* ONE form spanning the first two cards, with its Save below them
          (amended spec §6.9) — the card copy is passed in because the form owns
          the `<form>` element the two cards sit inside. */}
      <ProfileForm
        defaultValues={defaults}
        labels={{
          profileTitle: t('settings.profileTitle'),
          profileDescription: t('settings.profileDescription'),
          preferencesTitle: t('settings.preferencesTitle'),
          preferencesDescription: t('settings.preferencesDescription'),
        }}
      />

      <SettingsCard
        title={t('settings.securityTitle')}
        description={t('settings.securityDescription')}
      >
        <ChangePasswordForm />
      </SettingsCard>
    </div>
  )
```

- [ ] **Step 7: Update `e2e/settings-form-hydration.spec.ts`**

This spec (253 lines) is the profile form's reversion guard and must keep its meaning. Read it whole, then change only selectors:

- `NAME_PLACEHOLDER` / `TIMEZONE_PLACEHOLDER` (`:156-157,201-202`) → `page.getByLabel(/^Tên$|^Name$/)` and `page.getByLabel(/Múi giờ|Time zone/)`. The timezone control is a `<select>` now, so wherever the spec *typed* into it, replace with `selectOption('Asia/Bangkok')` — a zone that is not the default — and assert `toHaveValue('Asia/Bangkok')`.
- `:206` — `getByRole('button', { name: 'Save changes' })` → **one** Save: `page.getByRole('button', { name: /^Lưu$|^Save$/ })`. There is no per-card scoping to do, because there is one Save for all five fields; if a previous draft of this spec scoped by card, unscope it.
- `:214,251` — `getByText('Profile saved')` → `getByText(/Đã lưu hồ sơ|Profile saved/)`.
- Keep every early-interaction mechanism exactly as the file has it; only the selectors change.
- **Add one test:** the *preference* fields are reverted-proof too — drive the theme `<select>` to `dark` before hydration completes and assert it is still `dark` afterwards, mirroring whatever technique the file already uses for the name field. That case exists because the four preference fields moved into a second `<fieldset>`, and a gate applied to only one of them would be invisible until a user hit it.

- [ ] **Step 8: Write `e2e/phase7-theme-locale.spec.ts`**

The permanent version of Task 2a's driver checks — theme and locale end to end (spec §12):

```ts
import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { registerNewUser } from './helpers'

/**
 * Theme and locale, end to end.
 *
 * The first-paint assertions read the RAW response body rather than the live
 * DOM, which is what makes them deterministic and what makes them prove the
 * claim: the `dark` class is server-rendered, so there is no flash by
 * construction and no client script to catch mid-flip. No `waitForTimeout`, no
 * retry helper.
 */
const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-theme-${process.pid}.json`)

/**
 * The registered account, kept for the one test that signs back in through the
 * UI — the same module-level pattern `phase4.spec.ts` uses for its user.
 */
let account: { email: string; password: string }

/** The Tùy chọn group, which is where all four preference controls live. */
function preferences(page: import('@playwright/test').Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /Tùy chọn|Preferences/ }) })
}

test.describe.serial('Phase 7 — theme and locale', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    account = await registerNewUser(page, { emailPrefix: 'e2e-phase7-theme' })
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('a new account starts in Vietnamese and light', async ({ page }) => {
    const html = await (await page.request.get('/dashboard')).text()
    expect(html).toContain('lang="vi"')
    expect(html).not.toMatch(/<html[^>]*class="[^"]*\bdark\b/)
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { level: 1, name: 'Tổng quan' })).toBeVisible()
  })

  test('saving dark paints dark on the very first byte of the next render', async ({ page }) => {
    await page.goto('/settings')
    await preferences(page).getByLabel(/Giao diện|^Theme$/).selectOption('dark')
    // ONE Save for all five fields (amended spec §6.9), so it is not scoped to
    // a card.
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    // Optimistic, in the page the user is already looking at (spec §3).
    await expect(page.locator('html')).toHaveClass(/dark/)

    // And server-rendered on the next request — the flash-free guarantee.
    const html = await (await page.request.get('/dashboard')).text()
    expect(html).toMatch(/<html[^>]*class="[^"]*\bdark\b/)
    expect(html).toContain('color-scheme:dark')
  })

  test('the theme survives sign-out, from the cookie alone', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /Đăng xuất|Log out/ }).click()
    await expect(page).toHaveURL(/\/login/)
    const html = await (await page.request.get('/login')).text()
    expect(html).toMatch(/<html[^>]*class="[^"]*\bdark\b/)
  })

  test('switching to English changes lang and every nav label', async ({ page }) => {
    // Signed back in through the UI, not through storageState, so
    // `syncPreferenceCookies` runs and the cookies match the account.
    await page.goto('/login')
    await page.getByLabel(/^Email$/).fill(account.email)
    await page.getByLabel(/Mật khẩu|^Password$/).fill(account.password)
    await page.getByRole('button', { name: /Đăng nhập|Sign in/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)

    await page.goto('/settings')
    await preferences(page).getByLabel(/Ngôn ngữ|Language/).selectOption('en')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    await page.goto('/dashboard')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const rail = page.getByRole('navigation', { name: /^Primary$/ })
    await expect(rail.getByRole('link', { name: 'Transactions' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()

    // And back, so the suite leaves the account as it found it.
    await page.goto('/settings')
    await preferences(page).getByLabel(/Language/).selectOption('vi')
    await page.getByRole('button', { name: /^Save$/ }).click()
    await expect(page.getByText(/Profile saved/)).toBeVisible()
  })
})
```

The login selectors here are the ones Task 12 introduces. **If Task 11 runs before Task 12**, write them as `getByPlaceholder(/Email/)` / `getByPlaceholder(/Password/)` for now — Task 12 Step 5 already lists this file among the specs it updates.

- [ ] **Step 9: Split and extend `components/settings/profile-form.test.tsx`**

The existing file (167 lines) asserts each of the five controls' `defaultValue` and the SSR gate. Keep all of that — the form still owns all five fields — and add:

```tsx
it('renders the server-stored profile in ONE form with two gated fieldsets', () => {
  const html = render()
  expect(html.match(/<form/g)).toHaveLength(1)
  expect(html.match(/<fieldset/g)).toHaveLength(2)
  // Both gated before hydration, both marked busy-capable.
  expect(html.match(/<fieldset disabled/g)).toHaveLength(2)
  expect(html.match(/<legend class="sr-only"/g)).toHaveLength(2)
})

it('has exactly one submit button, outside both fieldsets', () => {
  const html = render()
  expect(html.match(/type="submit"/g)).toHaveLength(1)
  // The button follows the second `</fieldset>`, so it inherits neither
  // group's `disabled` — which is why it carries its own.
  expect(html.lastIndexOf('</fieldset>')).toBeLessThan(html.indexOf('type="submit"'))
})

it('gives all five controls a visible label bound to their id', () => {
  const html = render()
  for (const id of [
    'settings-name',
    'settings-base-currency',
    'settings-locale',
    'settings-theme',
    'settings-timezone',
  ]) {
    expect(html).toContain(`for="${id}"`)
    expect(html).toContain(`id="${id}"`)
  }
})

it('hoists the stored timezone into the leading optgroup', () => {
  const html = render()
  const firstGroup = html.slice(html.indexOf('<optgroup'), html.indexOf('</optgroup>'))
  expect(firstGroup).toContain('Asia/Ho_Chi_Minh')
})
```

There is **no** `preferences-form.test.tsx` — the component it would have tested does not exist.

- [ ] **Step 10: Full verification**

Run: `npm run test` → green (`timezones.test.ts` +4, `profile-form.test.tsx` extended).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green, including `settings-form-hydration.spec.ts` with every original test intact plus the new preference-reversion case, and the new theme/locale spec.
Run: `npm run build` → succeeds.

- [ ] **Step 11: Browser visual check — Settings**

Screenshot, light and dark: `/settings` at 1440, 768, 375 (6); `/settings` at 1440 with the profile success alert and with the password success alert (2 light); `/settings` at 1440 with the timezone select open, showing the current zone first (1 light); `/settings` in English at 1440 (1 light); and a **video** of saving `dark` and the page turning dark without a reload (1). Eleven artefacts.

Look for: three visual cards at 480 px with the single Save below the second one and the password card's own Save inside it; every field labelled; the helper text under Tiền tệ hiển thị and Múi giờ; the current timezone at the top of its own group; the Save disabled until something changes; the success alert below both groups rather than inside one; the optimistic dark switch happening in place.

**Tests required:**
- Vitest: `lib/ui/timezones.test.ts` (4 new); `components/settings/profile-form.test.tsx` (the existing five `defaultValue` assertions kept, plus 4 new: one form with two gated fieldsets, one submit outside both, five bound labels, the hoisted timezone group).
- Playwright: `e2e/settings-form-hydration.spec.ts` updated with one new preference-reversion test; `e2e/phase7-theme-locale.spec.ts` new (4 tests).

**Browser visual checks required:** the eleven artefacts in Step 11.

**Explicit things NOT to change:** `profileSchema`, `changePasswordSchema`, `isValidIanaTimezone`, `resolveProfileDefaults`; `updateProfile`'s field-by-field `data` construction and its refusal of `isDemo`; `authClient.changePassword`'s `revokeOtherSessions: true`; the fact that no Better Auth message is echoed to the user; `useHydrated`; and — explicitly — do **not** split the five profile fields across two forms, whatever a later reading of "three cards" suggests: the amended spec §6.9 names the race that split causes.

**Completion gate:** all four commands green; eleven artefacts inspected; every control labelled and bound; exactly one `<form>` and one submit for the five profile fields (asserted, not eyeballed); the optimistic toggle visible in the video; the raw-HTML dark assertion passing.

**Proposed commit boundary:**
1. `feat(settings): one profile form with two labelled groups, a grouped IANA timezone select and a single Save`
2. `feat(settings): optimistic dark-class toggle after a save, plus the theme/locale e2e spec`

---
## Task 12: Authentication screens

**Objective:** Rebuild the four auth screens to spec §6.10 — a centred 400 px card on the app background carrying the wordmark and a one-line tagline, an `h1`, labelled fields, inline errors, one primary button and secondary links; Register, Forgot and Reset share the layout; Reset shows a clear invalid-token state with a link to request a new one. No illustrations, no marketing panel. The theme comes from the cookie.

**Major files touched:** `app/(auth)/layout.tsx` (new), `app/(auth)/login/page.tsx`, `app/(auth)/register/page.tsx`, `app/(auth)/forgot-password/page.tsx`, `app/(auth)/reset-password/page.tsx`, `components/auth/login-form.tsx`, `components/auth/register-form.tsx`, `components/auth/forgot-password-form.tsx`, `components/auth/reset-password-form.tsx`, `messages/{vi,en}/auth.json`, `e2e/auth.spec.ts`, `e2e/helpers.ts`.

**Reusable primitives involved:** `FormField`/`Label`/`FieldError`, `InlineAlert`, `useSubmitState`.

**User-facing behaviour:** all four screens are one card, vertically centred, with "CashFlow" and "Quản lý tài chính cá nhân" above the heading. Fields are labelled. A failed sign-in shows one inline alert with a fixed message that never reveals whether the email exists. Forgot Password's success state stays a uniform sentence. Reset with a missing or invalid token shows its own heading, an explanation and a link to `/forgot-password`.

**Desktop expectation:** the card is `max-w-[25rem]` (400 px) centred with `min-h-screen`; `rounded-lg border border-border bg-surface p-8`; the page background is `bg-background`.

**Mobile expectation:** the card is full width minus `p-4` with the same internals; inputs 44 px; the primary button is full width **below** 640 only (spec §2 forbids full-width primaries at ≥ 768, and an auth card at 400 px is below that threshold anyway — so `w-full` is correct here and is the one place it is).

**Dark-theme expectation:** the card is `bg-surface` on `bg-background`, both from the `cashflow-theme` cookie via `resolveTheme()` (Task 2a) — these pages have no session, so the cookie is the only source. No shadow.

**Vietnamese/English expectation:** every string from `auth.json`; the tagline from `common.tagline`; error copy from `auth.*` and `errors.generic`. The register form's two fixed error strings (`components/auth/register-form.tsx:12-13`) become keys, and its whole comment about *why* the duplicate-email case is told plainly while sign-in stays uniform is preserved.

**Accessibility acceptance criteria:** one `h1` per screen; every field a visible `<label htmlFor>` (today all eight inputs across the four forms are placeholder-only); the form-level error is an `InlineAlert` with `role="alert"`; the fieldsets are `disabled` + `aria-busy` while submitting; the secondary links are real links with descriptive text (never "click here"); the reset-invalid state's link says what it does.

**Hydration/form-submission constraints:** none of the four auth forms has `defaultValues`, so none needs a `useHydrated` gate — `lib/ui/use-hydrated.ts`'s documented branch (a field with no default has RHF read the DOM rather than write over it) is exactly why, and `e2e/helpers.ts:26-31` already relies on it. State that in a comment in each form so nobody adds a gate for symmetry. All four get `useSubmitState`, and the fieldset carries `disabled={submit.locked}` + `aria-busy={submit.busy}` — which is also what makes the double-submit guard uniform across the app.

**Interfaces:**

- Consumes: `FormField`, `Label`, `FieldError`, `InlineAlert` (Tasks 1a–1c); `useSubmitState` (Tasks 1a–1c); `syncPreferenceCookies` (Task 2a); `authClient` and the four auth Zod schemas (existing).
- Produces:

```tsx
// app/(auth)/layout.tsx — the shared 400 px card
export default async function AuthLayout(props: { children: React.ReactNode }): Promise<React.ReactElement>

// components/auth/register-form.tsx — renamed, now returning a KEY
function registerErrorKey(code: string | undefined): 'auth.emailTaken' | 'errors.generic'
```

The four form components keep their current signatures exactly: `LoginForm()`, `RegisterForm()`, `ForgotPasswordForm()`, `ResetPasswordForm({ token }: { token: string })`.

**Files:**
- Create: `app/(auth)/layout.tsx`
- Modify: `app/(auth)/login/page.tsx:1-10`, `app/(auth)/register/page.tsx:1-10`, `app/(auth)/forgot-password/page.tsx:1-10`, `app/(auth)/reset-password/page.tsx:11-47`, `components/auth/login-form.tsx:21-66`, `components/auth/register-form.tsx:12-97`, `components/auth/forgot-password-form.tsx:19-72`, `components/auth/reset-password-form.tsx:20-57`, `messages/{vi,en}/auth.json`
- Test: `components/auth/login-form.test.tsx` (new), `e2e/auth.spec.ts:40-99`, `e2e/helpers.ts:18-22`

- [ ] **Step 1: Add the message keys**

`messages/vi/auth.json` (extending Task 2's five keys):
```json
{
  "loginTitle": "Đăng nhập CashFlow",
  "registerTitle": "Tạo tài khoản CashFlow",
  "forgotTitle": "Đặt lại mật khẩu",
  "resetTitle": "Đặt mật khẩu mới",
  "invalidTokenTitle": "Liên kết đặt lại không hợp lệ hoặc đã hết hạn",
  "invalidTokenBody": "Liên kết đặt lại hết hạn sau một giờ và chỉ dùng được một lần. Hãy yêu cầu một liên kết mới để tiếp tục.",
  "requestNewLink": "Yêu cầu liên kết mới",
  "name": "Tên",
  "email": "Email",
  "password": "Mật khẩu",
  "newPassword": "Mật khẩu mới",
  "signIn": "Đăng nhập",
  "signingIn": "Đang đăng nhập…",
  "createAccount": "Tạo tài khoản",
  "creatingAccount": "Đang tạo tài khoản…",
  "sendResetLink": "Gửi liên kết đặt lại",
  "sendingResetLink": "Đang gửi…",
  "setNewPassword": "Đặt mật khẩu mới",
  "settingNewPassword": "Đang lưu…",
  "forgotPassword": "Quên mật khẩu?",
  "noAccount": "Chưa có tài khoản?",
  "createOne": "Tạo tài khoản",
  "haveAccount": "Đã có tài khoản?",
  "backToSignIn": "Về trang đăng nhập",
  "rememberedIt": "Đã nhớ ra?",
  "invalidCredentials": "Email hoặc mật khẩu không đúng",
  "emailTaken": "Đã có tài khoản dùng email đó.",
  "resetSent": "Nếu có tài khoản dùng email đó, một liên kết đặt lại đã được gửi. Liên kết hết hạn sau một giờ và chỉ dùng được một lần.",
  "resetInvalid": "Liên kết đặt lại này không hợp lệ hoặc đã hết hạn. Hãy yêu cầu một liên kết mới."
}
```
`messages/en/auth.json`: keep today's exact strings — `"name": "Name"`, `"email": "Email"`, `"password": "Password"`, `"newPassword": "New password"`, `"signIn": "Sign in"`, `"signingIn": "Signing in…"`, `"createAccount": "Create account"`, `"creatingAccount": "Creating account…"`, `"sendResetLink": "Send reset link"`, `"sendingResetLink": "Sending…"`, `"setNewPassword": "Set new password"`, `"forgotPassword": "Forgot password?"`, `"invalidCredentials": "Invalid email or password"`, `"emailTaken": "An account with that email already exists."`, `"resetSent": "If an account exists for that email, a reset link has been sent. The link expires in one hour and can only be used once."`, `"resetInvalid": "This reset link is invalid or has expired. Request a new one."`, `"invalidTokenBody": "Reset links expire after one hour and can only be used once. Request a new one to continue."`, `"requestNewLink": "Request a new reset link"`, `"loginTitle": "Sign in to CashFlow"`, `"registerTitle": "Create your CashFlow account"`, `"forgotTitle": "Reset your password"`, `"resetTitle": "Set a new password"`, `"invalidTokenTitle": "Reset link is invalid or expired"`, `"noAccount": "Don't have an account?"`, `"createOne": "Create one"`, `"haveAccount": "Already have an account?"`, `"backToSignIn": "Back to sign in"`, `"rememberedIt": "Remembered it?"` — every one of those is a string `e2e/auth.spec.ts` asserts or the current JSX renders.

- [ ] **Step 2: Write `app/(auth)/layout.tsx`**

```tsx
import { getTranslations } from 'next-intl/server'

/**
 * The frame the four auth screens share (spec §6.10): a centred 400 px card on
 * the app background, with the wordmark and a one-line tagline above whatever
 * the page renders.
 *
 * A layout rather than four copies of the same wrapper, which is what the four
 * pages had — and they had drifted: each declared its own
 * `min-h-screen max-w-sm` wrapper with slightly different gaps.
 *
 * No illustration and no marketing panel. This is a finance app's front door;
 * the fastest possible path to the form is the whole design.
 *
 * The THEME comes from the `cashflow-theme` cookie via `resolveTheme()` in the
 * root layout — there is no session here to ask, which is exactly why that
 * cookie exists (spec §3).
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="flex w-full max-w-[25rem] flex-col gap-6 rounded-lg border border-border bg-surface p-6 sm:p-8">
        <div className="flex flex-col gap-1">
          <p className="text-base font-semibold text-brand">{t('common.appName')}</p>
          <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{t('common.tagline')}</p>
        </div>
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Reduce the four pages to a heading plus their form**

`app/(auth)/login/page.tsx`:
```tsx
import { getTranslations } from 'next-intl/server'
import { LoginForm } from '@/components/auth/login-form'

export default async function LoginPage() {
  const t = await getTranslations()
  return (
    <>
      <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.loginTitle')}</h1>
      <LoginForm />
    </>
  )
}
```
`register/page.tsx`, `forgot-password/page.tsx`: identical with `auth.registerTitle` / `auth.forgotTitle`.

`reset-password/page.tsx`: keep the whole module doc (`:4-10` — how Better Auth 1.7.2 delivers the token as a query parameter) and the token/error resolution at `:16-21` verbatim. Replace both returns with the heading-plus-content shape:
```tsx
  if (error !== undefined || token === null) {
    return (
      <>
        <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.invalidTokenTitle')}</h1>
        <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
          {t('auth.invalidTokenBody')}
        </p>
        <Link
          href="/forgot-password"
          className="text-sm text-brand underline-offset-4 hover:underline"
        >
          {t('auth.requestNewLink')}
        </Link>
      </>
    )
  }

  return (
    <>
      <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.resetTitle')}</h1>
      <ResetPasswordForm token={token} />
    </>
  )
```

- [ ] **Step 4: Label and lock the four forms**

Per-form change list. In every one: add `const t = useTranslations()`, add `const submit = useSubmitState()`, wrap the whole `onSubmit` body in `await submit.run(async () => { … })`, wrap the fields in `<fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex min-w-0 flex-col gap-4"><legend className="sr-only">{…the page's title key…}</legend>`, replace each root-error `<p>` with `<InlineAlert tone="negative">`, and add the comment about why there is no `useHydrated` gate here.

`components/auth/login-form.tsx`:
- email → `FormField id="login-email" label={t('auth.email')}` around `<Input {...aria} type="email" autoComplete="email" {...register('email')} />` (add the `autoComplete`, which it lacks);
- password → `FormField id="login-password" label={t('auth.password')}` around `<Input {...aria} type="password" autoComplete="current-password" {...register('password')} />`;
- the root error message becomes `t('auth.invalidCredentials')` — keep the comment at `:28-29` about never revealing whether the email exists;
- the submit label becomes `submit.pending ? t('auth.signingIn') : t('auth.signIn')`, `className="w-full"`;
- the two links become `t('auth.forgotPassword')` and the `t('auth.noAccount')` + `t('auth.createOne')` pair;
- keep the `syncPreferenceCookies()` call Task 2 added, and its comment.

`components/auth/register-form.tsx`:
- keep `registerErrorMessage`'s whole doc comment (`:15-35`) — the Better Auth code archaeology and the deliberate enumeration trade-off — and change only its return values to `'auth.emailTaken'` / `'errors.generic'` keys, renaming it `registerErrorKey`;
- name → `FormField id="register-name" label={t('auth.name')}` with `autoComplete="name"`;
- email → `label={t('auth.email')}`, `autoComplete="email"`;
- password → `label={t('auth.password')}`, `autoComplete="new-password"`;
- submit → `submit.pending ? t('auth.creatingAccount') : t('auth.createAccount')`, `w-full`;
- the footer link pair → `t('auth.haveAccount')` + `t('auth.signIn')`.

`components/auth/forgot-password-form.tsx`:
- email → `FormField id="forgot-email" label={t('auth.email')}` (keeping `autoComplete="email"`);
- submit → `submit.pending ? t('auth.sendingResetLink') : t('auth.sendResetLink')`, `w-full`;
- the success branch (`:41-53`) keeps its `isSubmitSuccessful && !errors.root` condition **and its comment** and renders `<InlineAlert tone="positive">{t('auth.resetSent')}</InlineAlert>` plus the `t('auth.backToSignIn')` link;
- keep the comment at `:21-23` about answering identically whether or not the address is registered.

`components/auth/reset-password-form.tsx`:
- password → `FormField id="reset-password" label={t('auth.newPassword')}` with `autoComplete="new-password"`;
- the root error becomes `t('auth.resetInvalid')`;
- submit → `submit.pending ? t('auth.settingNewPassword') : t('auth.setNewPassword')`, `w-full`.

`components/auth/login-form.test.tsx` (new) — three static-markup cases: (1) both fields have a `<label for>` matching their input's `id`; (2) the SSR markup has **no** `<fieldset disabled` (these forms have no gate, and a disabled first paint would be the bug this asserts against); (3) the submit button is `w-full`. Mock `next-intl`'s `useTranslations` to echo keys and `next/navigation`'s `useRouter`.

- [ ] **Step 5: Update `e2e/auth.spec.ts` and the shared register helper**

`e2e/helpers.ts:18-22` — `registerNewUser`:
```ts
  await page.goto('/register')
  await page.getByLabel(/^Tên$|^Name$/).fill('Phase 4 E2E User')
  await page.getByLabel(/^Email$/).fill(email)
  await page.getByLabel(/Mật khẩu|^Password$/).fill(password)
  await page.getByRole('button', { name: /Tạo tài khoản|Create account/ }).click()
```
Keep the whole comment at `:23-31` about the 30-second bound and about this form having no `defaultValues` — both still exactly true, and the second is now also asserted by `login-form.test.tsx`.

`e2e/auth.spec.ts:40-99`:
- `:42-45` — the three register fields and the submit, as above.
- `:48` — `getByRole('button', { name: 'Log out' })` → `/Đăng xuất|Log out/` (Task 3 already changed the shell; if that task's run left this green because the label was still English, it is because Task 3 updated only `phase4/5/6` — fix it here).
- `:52-53` — `getByPlaceholder('Email')` → `getByLabel(/^Email$/)`; the submit → `/Gửi liên kết đặt lại|Send reset link/`.
- `:55` — `getByText('If an account exists for that email, a reset link has been sent.')` → `getByText(/Nếu có tài khoản dùng email đó|If an account exists for that email/)` (the message now continues past the full stop, so the exact-string match must go).
- `:77-78` — the reset field and submit → `getByLabel(/Mật khẩu mới|New password/)` and `/Đặt mật khẩu mới|Set new password/`.
- `:82-88` — the login fields → `getByLabel(/^Email$/)` / `getByLabel(/Mật khẩu|^Password$/)`; the submit → `/Đăng nhập|Sign in/`; `getByText('Invalid email or password')` → `/Email hoặc mật khẩu không đúng|Invalid email or password/`.
- **Add one test:** the invalid-token state. `page.goto('/reset-password?error=INVALID_TOKEN')`, assert the `h1` matches `/không hợp lệ|invalid or expired/` and that a link to `/forgot-password` is present with the `auth.requestNewLink` name.

`e2e/phase7-theme-locale.spec.ts` (Task 11) — fill in its elided sign-back-in lines with these selectors now.

- [ ] **Step 6: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green — **and note that every spec in the suite depends on `registerNewUser`**, so a failure here fails everything; run the whole suite, not just `auth.spec.ts`.
Run: `npm run build` → succeeds.

- [ ] **Step 7: Browser visual check — the four auth screens**

Screenshot, light and dark: `/login`, `/register`, `/forgot-password`, `/reset-password?token=x` and `/reset-password?error=INVALID_TOKEN` at 1440 (10); the same five at 375 light (5); `/login` at 1440 light with a failed sign-in showing the inline alert (1); `/forgot-password` at 1440 light in its success state (1); `/login` at 1440 light in English (1). Eighteen screenshots.

Look for: one 400 px card, vertically centred, on the app background; wordmark and tagline above every heading; every field labelled; one primary button, full width inside the card; the failed sign-in message revealing nothing; the invalid-token screen explaining the one-hour, one-use rule and offering the link; dark rendering from the cookie with no session; nothing overflowing at 375.

- [ ] **Step 8: 🛑 VISUAL CHECKPOINT 5 — Reports / Settings / Auth (spec §11)**

**The controller STOPS here and does not start Task 13 until the product owner approves.**

Hand over: `/reports` 1440 light, `/reports` 375 light, `/reports` 1440 light with the export menu open, `/reports` 1440 dark, `/settings` 1440 light, `/settings` 375 light, `/settings` 1440 dark, `/login` 1440 light, `/login` 375 light, `/login` 1440 dark, `/register` 1440 light, `/reset-password?error=INVALID_TOKEN` 1440 light. Twelve images, plus the Settings dark-toggle video from Task 11.

Report alongside them: the count of inputs across the whole app that still lack a visible `<label>` (run the driver check over all twelve app pages and both auth pages — the expected answer is **zero**), and the list of English strings still reaching the DOM (the expected answer is `InvalidReportRangeError`'s message alone, with Task 10's accepted-exception note).

**Tests required:**
- Vitest: `components/auth/login-form.test.tsx` (3 new).
- Playwright: `e2e/auth.spec.ts` updated plus the new invalid-token test; `e2e/helpers.ts`'s `registerNewUser` rewritten (which every other spec depends on).

**Browser visual checks required:** the eighteen screenshots in Step 7 and the twelve-image checkpoint package in Step 8.

**Explicit things NOT to change:** `loginSchema`/`registerSchema`/`forgotPasswordSchema`/`resetPasswordSchema`; `authClient`'s calls and their options; the uniform-answer behaviour of sign-in and request-password-reset; `registerErrorMessage`'s two accepted codes and the reasoning for telling a visitor their email is taken; the reset page's token/error resolution; the fact that no Better Auth message is echoed; the absence of a `useHydrated` gate on these four forms.

**Completion gate:** all four commands green; eighteen screenshots inspected; zero unlabelled inputs app-wide; checkpoint package delivered and **approved**.

**Proposed commit boundary:**
1. `feat(auth): one shared 400 px card layout with the wordmark and tagline`
2. `feat(auth): labelled fields, translated copy, submit locks, and a clear invalid-token state`

---
## Task 13: i18n completion audit

**Objective:** Close the loop on internationalisation — thread `locale` through every view model call site so figures and dates are formatted for the reader, delete the temporary English `*_MESSAGES` alias block, prove with a repository-wide sweep that no user-facing literal and no raw enum remains, and add the permanent e2e sweep that keeps it that way.

**Major files touched:** `lib/ui/action-error-messages.ts`, every `app/(app)/*/page.tsx` (the DTO mapping calls), `e2e/phase7-enum-sweep.spec.ts` (new), plus whatever the sweeps find.

**Reusable primitives involved:** none new — this task adds no UI.

**User-facing behaviour:** in English, `25,000,000` instead of `25.000.000` everywhere (not just in the few places Task 2 reached); every date in the reader's format; no English string in a Vietnamese page and none the other way round.

**Desktop expectation:** unchanged layout at 1024/1280/1440; only text and number formatting change.

**Mobile expectation:** unchanged layout at 375/414/768 — but English is *shorter* than Vietnamese, so a label that fitted in Vietnamese cannot start overflowing in English; the paired screenshots in Step 8 are where that is checked.

**Dark-theme expectation:** unchanged.

**Vietnamese/English expectation:** this task *is* the expectation. Acceptance: switching the locale changes every visible string, every thousands separator and every date format, with the documented exceptions below.

**Accessibility acceptance criteria:** every `aria-label` and every `<label>` is translated too — an English `aria-label` on a Vietnamese page is a screen-reader-only regression that a visual sweep cannot see, so the sweep in Step 4 greps for them specifically.

**Hydration/form-submission constraints:** none; no form changes shape. Threading `locale` into a DTO mapper cannot change a `defaultValue`, because a mapper's output feeds a *row*, never a form default — verify that claim per call site while editing (a mapper's `editable` block does feed a form, and its values are `toFixed(2)` strings that must stay unformatted; do **not** localise those).

**Files:**
- Modify: `lib/ui/action-error-messages.ts` (delete the alias block), `app/(app)/dashboard/page.tsx`, `app/(app)/transactions/page.tsx`, `app/(app)/transfers/page.tsx`, `app/(app)/accounts/page.tsx`, `app/(app)/budgets/page.tsx`, `app/(app)/goals/page.tsx`, `app/(app)/debts/page.tsx`, `app/(app)/loans/page.tsx`, `app/(app)/reminders/page.tsx`, `app/(app)/reports/page.tsx`, `lib/ui/dashboard-view-model.ts` (thread `locale` into the nested mapper calls)
- Create: `e2e/phase7-enum-sweep.spec.ts`
- Test: `lib/ui/dashboard-view-model.test.ts` (+1 locale case), `e2e/phase7-enum-sweep.spec.ts`

**Interfaces:**

- Consumes: every `lib/ui/*` mapper's optional trailing `locale` parameter (Tasks 4, 7, 8, 9); `resolveLocale` (Task 2a); the `*_ERROR_KEYS` maps (Task 2a).
- Produces:

```ts
// lib/ui/dashboard-view-model.ts — `DashboardInput` gains one required field
export interface DashboardInput {
  /** The reader's locale, threaded into every `formatMoney` and every nested
   *  DTO mapper this builder calls. Required, not optional: the dashboard is
   *  the one page that formats figures from five different mappers, and a
   *  default here is how four of them stayed Vietnamese in an English page. */
  locale: Locale
  // … every existing field unchanged
}

// e2e/helpers.ts — new exports
export const PAGES: readonly string[]
/** A vi/en alternation for an action-error message, built from both files. */
export function errorText(path: (messages: typeof import('@/messages/en/errors.json')) => string): RegExp
```

- Removes: `GENERIC_ERROR_MESSAGE` and the eight `*_ERROR_MESSAGES` maps from `lib/ui/action-error-messages.ts`.

- [ ] **Step 1: Thread `locale` into every DTO mapper call**

Every mapper gained an optional trailing `locale` in Tasks 4–9. Now pass it. Per file:

| File | Call to change |
|---|---|
| `app/(app)/dashboard/page.tsx` | `buildDashboardViewModel({ …, locale })` — add `locale: Locale` to `DashboardInput` and thread it into `formatMoney`, `toBudgetProgressDto`, `toSavingsGoalDto` and `toOccurrenceDto` inside `buildDashboardViewModel` |
| `app/(app)/budgets/page.tsx` | `progress.map((row) => toBudgetProgressDto(row, locale))` |
| `app/(app)/goals/page.tsx` | `goals.map((goal) => toSavingsGoalDto(goal, today, locale))` |
| `app/(app)/debts/page.tsx` | `rows.map((row) => toDebtDto(row, locale))` and `debtSubtotalsByCurrency(rows, locale)` |
| `app/(app)/loans/page.tsx` | `rows.map((row) => toLoanDto(row, today, locale))` and `loanSubtotalsByCurrency(rows, locale)` |
| `app/(app)/reminders/page.tsx` | `toOccurrenceDto(row, timezone, today, locale)` and `toReminderDto(row, timezone, locale)` |
| `app/(app)/reports/page.tsx` | already passes `locale` (Task 10) |
| `app/(app)/accounts/page.tsx` | already passes `locale` (Task 6) |
| `app/(app)/transactions/page.tsx` | already passes `locale` (Task 5) |
| `app/(app)/transfers/page.tsx` | already passes `locale` (Task 5) |

Each page already resolves `const locale = await resolveLocale()`; where one does not, add it beside its `resolveProfileDefaults(user)` call.

Add to `lib/ui/dashboard-view-model.test.ts`:
```ts
it('formats every figure in the requested locale', () => {
  const vi = buildDashboardViewModel({ ...baseInput(), locale: 'vi' })
  const en = buildDashboardViewModel({ ...baseInput(), locale: 'en' })
  expect(vi.kpis[1].value).toMatch(/\d\.\d{3}/)
  expect(en.kpis[1].value).toMatch(/\d,\d{3}/)
  // And the nested DTOs, not just the top-level KPIs — a budget row formatted
  // by the default locale inside an English dashboard was the bug this catches.
  expect(en.budgets[0]?.amount ?? '1,000').toMatch(/,/)
})
```
(Adjust the fixture so `budgets[0]` exists with a four-digit-plus amount.)

- [ ] **Step 2: Delete the temporary English alias block**

```bash
grep -rn "_ERROR_MESSAGES\|GENERIC_ERROR_MESSAGE" app components lib e2e
```
Every hit must now be either (a) an `e2e` spec importing a map to assert its text, or (b) nothing. For (a), change the spec to import the **key** map and translate it in the test — but a Playwright test has no translator. So instead have those specs import the English JSON directly:
```ts
import enErrors from '@/messages/en/errors.json'
// `enErrors.budget.DUPLICATE_BUDGET`, `enErrors.debt.OVERPAYMENT`,
// `enErrors.loan.OVERPAYMENT` — the three the four assertions need.
```
**But** the app renders Vietnamese by default, so an English assertion would fail. Change each such assertion to a vi/en alternation built from both files:
```ts
import viErrors from '@/messages/vi/errors.json'
import enErrors from '@/messages/en/errors.json'

/** Matches whichever locale the app is rendering — the message text is not
 *  what these tests are about; the fact that the right code surfaced is. */
function errorText(path: (t: typeof enErrors) => string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escape(path(viErrors))}|${escape(path(enErrors))}`)
}
// e2e/phase5.spec.ts:102
await expect(page.getByText(errorText((e) => e.budget.DUPLICATE_BUDGET))).toBeVisible()
```
Put `errorText` in `e2e/helpers.ts` and use it in `phase5.spec.ts:102,125` and `phase6.spec.ts:537,643`. Then delete the whole alias block from `lib/ui/action-error-messages.ts` (the `englishMap` helper, the eight `*_MESSAGES` exports and `GENERIC_ERROR_MESSAGE`), leaving only the `*_KEYS` maps and `GENERIC_ERROR_KEY`.

Run: `npx tsc --noEmit` → clean, which is the proof no importer remains.

- [ ] **Step 3: Sweep for user-facing literals in the source**

Run each of these and triage every hit:

```bash
# 1. JSX text nodes that look like sentences.
grep -rnE '>[A-Z][a-z]+ [a-z]' --include='*.tsx' app components | grep -v "t('" | grep -v '\.test\.'

# 2. String literals in JSX attributes that carry copy.
grep -rnE '(aria-label|placeholder|title)="[A-Z]' --include='*.tsx' app components | grep -v '\.test\.'

# 3. English words that are almost certainly copy.
grep -rniE '"(add|edit|delete|save|cancel|close|archive|confirm|loading|retry)"' --include='*.tsx' app components | grep -v '\.test\.'

# 4. Any remaining hard-coded label map.
grep -rn "_LABELS" app components lib | grep -v '\.test\.'

# 5. Ad-hoc date formatting left in the UI.
grep -rn "formatInTimeZone" app components | grep -v '\.test\.'

# 6. Ad-hoc number formatting outside the money module.
grep -rn "Intl.NumberFormat" app components lib | grep -v 'format-money\|format-date\|timezones\|\.test\.'

# 7. A form rendering an RHF error message directly instead of through
#    `FieldError`, which is what translates a Zod literal (spec §4).
grep -rnE 'errors\.[a-zA-Z]+\?\.message' --include='*.tsx' app components | grep -v 'FormField\|\.test\.'
```

Expected outcomes, and what to do with each:
1. **Zero** hits outside tests. Any hit is a missed literal — move it to its domain's message file in this task.
2. **Zero** hits outside tests. An untranslated `aria-label` is the invisible half of this task.
3. Only `option value="…"` enum values and Tailwind class strings. Anything else is copy.
4. **Zero.** All seven label maps were deleted in Tasks 7–9; a survivor means a task skipped one.
5. Allowed: `components/transactions/transaction-list.tsx`'s day-grouping key (a `yyyy-MM-dd` *key*, not display), `lib/ui/format-date.ts`'s `toDateInputValue`, and any `<input type="date">`/`type="time"` `defaultValue`. Everything else must be `formatDate`.
7. **Zero** hits outside tests: every field error must reach the screen through `FormField`'s `error` prop, which renders `FieldError`, which is the one place a Zod literal is translated. A form passing `errors.x?.message` into its own `<p>` is a field whose error stays English.
6. Allowed: `lib/ui/format-money.ts`, `lib/ui/format-date.ts`, `lib/ui/timezones.ts`. Anything else — `components/transfers/transfer-list.tsx`'s old `amountFormatter`, `components/accounts/account-list.tsx`'s old `formatBalance` — should already be gone; a survivor means a task skipped one.

Record the triage in the task report: the command, the hit count, and what each hit was.

- [ ] **Step 4: Add the shared page list to `e2e/helpers.ts`, then write the sweep spec**

Three specs walk every app page (this task's enum sweep, Task 15's overflow spec and Task 16's a11y spec), so the list lives in one place. Append to `e2e/helpers.ts`:

```ts
/**
 * Every signed-in route, in nav order. Shared by the three specs that walk
 * the whole app — a per-spec copy is how one of them ends up missing a route
 * that a later phase adds.
 */
export const PAGES = [
  '/dashboard',
  '/transactions',
  '/transfers',
  '/accounts',
  '/categories',
  '/budgets',
  '/goals',
  '/debts',
  '/loans',
  '/reminders',
  '/reports',
  '/settings',
] as const
```

`e2e/phase7-enum-sweep.spec.ts`:

```ts
import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { PAGES, registerNewUser, createAccountViaUi, createTransactionViaUi } from './helpers'

/**
 * The guarantee spec §4 asks for, as a test rather than a habit: **no raw enum
 * reaches the DOM**.
 *
 * `CASH_OUT`, `ADJUSTMENT_DECREASE`, `WRITTEN_OFF`, `PARTIALLY_PAID`,
 * `ONE_TIME`, `PAID_OFF` — every one of them was on screen somewhere before
 * Phase 7, because a view model's `?? row.type` fallback or a missing label map
 * let it through. The regex below catches the shape, not a list, so a NEW enum
 * member added in a later phase is caught the first time it renders.
 *
 * Deliberately scoped to `main`'s text content, not the whole document: a
 * `<select>`'s `value` attributes and a `data-*` hook legitimately carry the
 * enum, and only what a person can READ is the subject.
 */
const RAW_ENUM = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/

/** Ids and codes that legitimately look like the pattern. */
const ALLOWED = [
  // A user could name an account "MY_SAVINGS"; that is their text, not ours.
  // Nothing here yet — the list exists so a real exception is recorded rather
  // than the regex being loosened.
]

const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-sweep-${process.pid}.json`)

test.describe.serial('Phase 7 — no raw enum on screen', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-sweep' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    // One transaction of every type, so every `transactionType` label is
    // exercised — including the four that used to render verbatim.
    for (const type of ['EXPENSE', 'INCOME'] as const) {
      await createTransactionViaUi(page, {
        type,
        accountName: 'Cash',
        categoryName: type === 'EXPENSE' ? 'Food & Dining' : 'Salary',
        amount: 100_000,
      })
    }
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  for (const url of PAGES) {
    test(`${url} renders no raw enum in Vietnamese`, async ({ page }) => {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      const text = (await page.locator('main').innerText()).replace(
        new RegExp(ALLOWED.join('|') || '(?!)', 'g'),
        '',
      )
      const match = text.match(RAW_ENUM)
      expect(match, `${url} shows "${match?.[0]}"`).toBeNull()
    })
  }

  test('the four uncommon transaction types render as product labels', async ({ page }) => {
    // Created through the UI so the enum→label path is the real one.
    for (const [type, viLabel] of [
      ['CASH_IN', 'Tiền vào (khác)'],
      ['CASH_OUT', 'Tiền ra (khác)'],
      ['ADJUSTMENT_INCREASE', 'Điều chỉnh tăng'],
      ['ADJUSTMENT_DECREASE', 'Điều chỉnh giảm'],
    ] as const) {
      await page.goto('/transactions')
      await page.getByRole('button', { name: /^Khác$|^Other$/ }).click()
      await page.getByRole('radio', { name: viLabel }).click()
      await page.getByLabel(/Số tiền|^Amount$/).fill('50000')
      await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
      await expect(page.getByLabel(/Số tiền|^Amount$/)).toHaveValue('0')
      await expect(page.locator('main')).toContainText(viLabel)
      await expect(page.locator('main')).not.toContainText(type)
    }
  })
})
```

Run: `npx playwright test e2e/phase7-enum-sweep.spec.ts` → green. Any failure names the page and the token; fix the source, never the regex.

- [ ] **Step 5: Verify the locale switch end to end on every page**

Extend `e2e/phase7-theme-locale.spec.ts` (Task 11) with one data-driven test:
```ts
test('every page renders in the reader’s locale, with locale-formatted numbers', async ({ page }) => {
  // Switch to English once, then walk every page and assert (a) `lang="en"`,
  // (b) no Vietnamese diacritic in `main` — the cheapest possible proof that no
  // vi string leaked — and (c) comma grouping wherever a four-plus-digit figure
  // appears.
  await page.goto('/settings')
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: /Tùy chọn|Preferences/ }) })
  await card.getByLabel(/Ngôn ngữ|Language/).selectOption('en')
  await card.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
  await expect(card.getByText(/Preferences saved/)).toBeVisible()

  for (const url of PAGES) {
    await page.goto(url)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const text = await page.locator('main').innerText()
    // Vietnamese-only characters. A user's own data could contain them, so this
    // account's seed data is deliberately ASCII-only (see `beforeAll`).
    expect(text, url).not.toMatch(/[ăâđêôơưĂÂĐÊÔƠƯ]|ạ|ả|ấ|ầ|ệ|ế|ị|ọ|ố|ồ|ộ|ớ|ợ|ủ|ứ|ự|ỳ|ỹ/)
  }
})
```
Seed that spec's user with **ASCII-only** account, category and reminder names so the diacritic check cannot trip on the user's own text; say so in the `beforeAll` comment.

- [ ] **Step 6: Record the accepted exceptions**

Three classes remain, and Zod messages are **not** among them — spec §4's amended ruling puts those behind `validation.json`, which Task 2c builds and this task's sweep now checks. Write the list as a comment under `MESSAGE_DOMAINS`' doc in `lib/i18n/messages.ts`:

```
 * Accepted untranslated strings, as of Phase 7 (each with its reason):
 *
 *  1. `InvalidReportRangeError`'s message (`lib/reports/report-range.ts:192`) —
 *     it describes a hand-typed URL parameter, not a product state, and
 *     translating it means changing `lib/reports/`, which Phase 7 does not
 *     touch. It reaches the DOM only for a user who edited the query string.
 *  2. Excel sheet names and column headers (`lib/server/export/*`) — an
 *     explicit contract (spec §12), deliberately not localised.
 *  3. Currency codes, IANA time-zone ids and account/category/person names —
 *     data, not copy.
 *
 * NOT an exception: the Zod messages in `lib/validation/**`. The schemas keep
 * their English literals (Phase 2–6 tests assert them, and they are re-produced
 * server-side), and the UI translates them at the render boundary through
 * `messages/{vi,en}/validation.json` — see `lib/ui/validation-messages.ts` and
 * the extraction test that proves every literal has both entries.
```

- [ ] **Step 6a: Prove the validation dictionary is still complete after every earlier task's edits**

Task 2c built `messages/{vi,en}/validation.json` and the extraction test that keeps it exhaustive. Tasks 4–12 changed no schema, so the dictionary should still be complete — but this is the audit task, so verify rather than assume:

```bash
npx vitest run lib/ui/validation-messages.test.ts
grep -rn "message:\|error:\|, '" lib/validation --include='*.ts' | grep -c "'"
```
The test must pass. Then reach three validation errors through the UI and confirm the *rendered* text is Vietnamese, not the English literal:
1. `/transactions` — submit with an empty amount → the amount field's error;
2. `/transactions` — submit an income with no category → the category refine's message;
3. `/accounts` — submit with an empty name → the name field's error.

Record the three rendered strings. Any one that comes back in English is either a missing `validation.json` entry (add it — and ask why the test did not catch it, which means the extraction regex missed that literal's shape) or a `FieldError` that was bypassed (the caller is not using `FormField`).

- [ ] **Step 7: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean; the `tsc` pass is what proves the alias deletion left no importer.
Run: `npx playwright test` → green, including the new sweep.
Run: `npm run build` → succeeds.

- [ ] **Step 8: Browser visual check — the same page in both languages**

Screenshot at 1440 light, in Vietnamese and in English: `/dashboard`, `/transactions`, `/budgets`, `/debts`, `/reminders`, `/reports`, `/settings`. Fourteen screenshots, in pairs.

Look for, pair by pair: no English word in the Vietnamese shot and none the other way; thousands separators `.` vs `,`; date formats `09/09/2026` vs `Sep 9, 2026`; no label wrapping or clipping in either language (Vietnamese is the longer one — check the nav, the badges and the KPI labels specifically); no layout shift between the two beyond text width.

**Tests required:**
- Vitest: `lib/ui/dashboard-view-model.test.ts` (+1 locale case); `lib/ui/validation-messages.test.ts` re-run as the exhaustiveness guard (built in Task 2c, unchanged here).
- Playwright: `e2e/phase7-enum-sweep.spec.ts` (13 new tests — twelve pages plus the four-type case); `e2e/phase7-theme-locale.spec.ts` (+1 all-pages locale test); `e2e/phase5.spec.ts` and `phase6.spec.ts`'s four error-text assertions rewritten through `errorText`.

**Browser visual checks required:** the fourteen paired screenshots in Step 8.

**Explicit things NOT to change:** `lib/validation/**` — not one schema, not one message literal (Phase 2–6 tests assert them, and `validation.json` translates them at the render boundary instead); `lib/reports/report-range.ts`; `lib/server/export/*`; any `editable` block's `toFixed(2)` values (they feed form inputs and must stay machine-formatted); the `yyyy-MM-dd` carrier format anywhere it is a key, an input value or a service argument.

**Completion gate:** all four commands green; every one of Step 3's seven sweeps triaged with its result recorded; the enum sweep green on all twelve pages; the three rendered validation messages in Step 6a confirmed Vietnamese; the fourteen paired screenshots inspected; the three-class accepted-exception list written into `lib/i18n/messages.ts`.

**Proposed commit boundary:**
1. `feat(i18n): thread the reader's locale through every view model and delete the English alias maps`
2. `test(i18n): raw-enum sweep across every page and an all-pages locale assertion`

---
## Task 14: Dark-theme consistency pass

**Objective:** Review every screen and every overlay in dark, fix what reads wrong, and prove the palette's contrast numerically. Nothing is auto-inverted; every fix is a token or a class, never a dark-only component.

**Major files touched:** `app/globals.css` (only if a token measurably fails), `components/dashboard/chart-theme.ts`, and whichever components the review finds — recorded, not guessed, in Step 3.

**Reusable primitives involved:** all of them — this is a review of their dark rendering.

**User-facing behaviour:** unchanged in light; in dark, no unreadable text, no invisible border, no washed-out chart, no glowing element.

**Desktop expectation:** identical structure to light at 1024/1280/1440 — a dark fix that moves an element is a regression, not a fix.

**Mobile expectation:** identical structure to light at 375/414/768; the raised `+` in the bottom bar keeps its `border-surface` ring rather than gaining a glow, and the bottom bar stays distinguishable from the page behind it.

**Hydration/form-submission constraints:** none — this task changes tokens and classes, never a `defaultValue`, a gate or a submit path. If a fix appears to need one, it is not a dark-theme fix.

**Dark-theme expectation:** this task *is* the expectation. Specifically: the three-surface ladder (`#171C1A` → `#202724` → `#29302D`) visibly distinct; borders at 14 % white visible against both surfaces; `--brand` at L≈0.60, `--negative` at L≈0.68, `--warning` at L≈0.74 all ≥ 4.5:1 as text on `--surface`; chart grid lines visible; every tinted badge legible; no `shadow` on a card, only on popovers.

**Vietnamese/English expectation:** unchanged.

**Accessibility acceptance criteria:** every text/background pair in dark measures ≥ 4.5:1; every UI/background pair ≥ 3:1; the focus ring is visible against `--surface` *and* `--surface-2` (a brand ring on a dark surface is the one at risk); disabled controls remain distinguishable from enabled ones without relying on colour alone.

**Files:**
- Modify: `app/globals.css` (only tokens that measurably fail), `components/dashboard/chart-theme.ts` (only if a chart colour fails), plus the components Step 3 records
- Test: `app/globals.css`'s contrast comment block (updated); no new spec — contrast and legibility are measured, not asserted

**Interfaces:**

- Consumes: everything Tasks 1–12 produced; nothing is added.
- Produces: nothing new. This task changes no exported name, no signature and no prop — a change to any of them here would silently redesign a page a checkpoint already approved, and belongs in the module task that owns it.


- [ ] **Step 1: Measure every pair, in dark, and write the table**

Compute the WCAG ratio for each pair below against the **dark** token values and write the results into the contrast comment block in `app/globals.css` (which Task 1a Step 5 started for light):

Text pairs (≥ 4.5:1): `foreground`/`background`, `foreground`/`surface`, `foreground`/`surface-2`, `muted-foreground`/`background`, `muted-foreground`/`surface`, `muted-foreground`/`surface-2`, `brand`/`surface`, `positive`/`surface`, `negative`/`surface`, `warning`/`surface`, `primary-foreground`/`brand`, `negative`/`surface-2` (the ConfirmDialog's text), `warning`/`surface` at the 18 % tint.

UI pairs (≥ 3:1): `border`/`surface`, `border`/`background`, `border-strong`/`surface-2`, `input`/`surface`, `focus`/`surface`, `focus`/`surface-2`, each chart series colour against `surface`, `muted`/`surface` (the progress track).

For any pair that fails, nudge **only that token's lightness** — the same procedure and the same justification the light palette already carries at `app/globals.css:81-90` ("accessibility outranks the exact hex") — and record the old value, the new value, the old ratio and the new ratio. Do not restructure the palette and do not add a dark-only component.

- [ ] **Step 2: Screenshot every screen and every overlay in dark**

With a scratch driver and the fully seeded user from Tasks 5–9, capture in dark at **1440** and **375**:

Pages (12 × 2 = 24): `/dashboard`, `/transactions`, `/transfers`, `/accounts`, `/categories`, `/budgets`, `/goals`, `/debts`, `/loans`, `/reminders`, `/reports`, `/settings`.
Auth (4, 1440 only): `/login`, `/register`, `/forgot-password`, `/reset-password?error=INVALID_TOKEN`.
Overlays (1440 only, 11): the transaction create sheet, the transaction delete ConfirmDialog, a `RowActionsMenu` open, the account create sheet, the account edit dialog, the account archive ConfirmDialog, the goal progress dialog, the loan instalment dialog, the reminder create sheet, the mobile More sheet (at 375), the export menu.
States (1440 only, 4): the empty dashboard, an `InlineAlert` in each of its four tones (use the reports invalid-range page for negative and a settings save for positive), a loading skeleton (Task 17 adds these — if this task runs first, note it and re-check in Task 17), and a focused control (press Tab three times).

Forty-three screenshots. Store them in the scratch directory in a `dark/` subfolder.

- [ ] **Step 3: Triage, and record every finding before fixing any of it**

Go through the forty-three images and write a numbered list of findings, each with: the screenshot, the element, what is wrong (unreadable / invisible / glowing / inverted / shadowed), and the one-line fix. Do not fix anything until the list is complete — fixing as you go is how a token change made for one screen breaks another.

Then apply the fixes, cheapest first:
1. a token nudge in `app/globals.css` (fixes every occurrence at once) — only when the pair measurably fails;
2. a `dark:` utility on the primitive (fixes every user of it) — e.g. a tint that needs 18 % instead of 10 %, which the primitives already do;
3. a `dark:` utility on the one component (last resort, and it must be justified in a comment).

**Never** add a dark-only component, a dark-only layout or an inverted image filter.

Re-screenshot every image a fix touched and confirm the fix in both themes — a dark fix that breaks light is a regression, and this is where it would be introduced.

- [ ] **Step 4: Verify the charts specifically**

Charts are the most likely failure, because their colours come from tokens but their *composition* does not. For each of the five, in dark at 1440, check: the grid lines are visible but not dominant; the axis text is legible; the tooltip is on `--surface-2` with legible text (hover a point and screenshot); a `null` gap in the balance line reads as a gap and not as a zero; the bar cursor's `--color-muted` wash is visible; two adjacent series are distinguishable (income/expense on the trend, and the four-plus bars on the category breakdown).

If a chart colour fails its 3:1 against `--surface`, change the **token** in the `.dark` block, not `chart-theme.ts` — the whole point of `CHART_COLORS` being `var(--color-*)` references is that dark mode is a token change (`components/dashboard/chart-theme.ts:4-9` says exactly this).

- [ ] **Step 5: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

Then re-run the **light** screenshot set from the earlier checkpoints for any screen a fix touched, and confirm nothing moved.

**Tests required:** no new automated test — contrast and legibility are measured, not asserted, and a pixel-comparison test would fail on every font-rendering difference. The measurements in Step 1 and the triage list in Step 3 are the deliverables, and they go into the task report.

**Browser visual checks required:** the forty-three dark screenshots in Step 2, plus a re-shot light image for every screen a fix touched.

**Explicit things NOT to change:** any layout, any copy, any component structure; the light palette (except a token that fails in *light*, which would be a Task 1 miss — record it and fix it, noting the light ratio); `chart-theme.ts`'s `var(--color-*)` indirection; the "never pure black" rule (`--background` stays the warm charcoal `#171C1A`).

**Completion gate:** `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` and `$env:CI="1"; npx playwright test` all green (Step 5); every pair in Step 1 measured and recorded, with every failure fixed and re-measured; every finding in Step 3 either fixed or explicitly deferred with a reason; forty-three dark screenshots inspected; light unchanged on every screen a fix touched.

**Proposed commit boundary:**
1. `fix(theme): dark-mode contrast and legibility fixes with the measured ratios recorded`

---
## Task 15: Responsive, mobile and tablet pass

**Objective:** Prove and enforce the spec's §7 acceptance widths — 375, 414, 768, 1024, 1280, 1440 — with **no horizontal page overflow anywhere**, tables stacked below 768, dialogs as bottom sheets below 640, financial rows never wrapping a figure mid-number, and page headers stacking their actions on mobile. Add the permanent Playwright spec that keeps it true.

**Major files touched:** `e2e/phase7-responsive.spec.ts` (new), plus whichever components the sweep finds — recorded, not guessed.

**Reusable primitives involved:** all of them — this is a review of their responsive behaviour.

**User-facing behaviour:** no sideways scrolling on any page at any of the six widths; every control reachable; no figure clipped.

**Desktop expectation:** 1024/1280/1440 keep the layouts the module tasks built, with the two-column Transactions layout and the dashboard's 12-column grid both appearing at ≥ 1280 (Tailwind `xl`); 1024–1279 gets the two-per-row tablet shape, which is what spec §6.1's tablet row describes.

**Mobile/tablet expectation:** 375 and 414 — bottom bar visible, rail hidden, every table stacked, every dialog bottom-anchored, the amount column intact; 768 — icon rail, no bottom bar, two-per-row charts, and the table *rendered* (768 is the boundary: spec §7 says tables become stacked rows **below** 768, so 767 stacks and 768 tables — assert both sides explicitly rather than assuming one). **1024–1279 is the tablet composition by design**, not an unfinished desktop: the 12-column dashboard grid and the two-column Transactions layout both start at 1280, so these widths get two-per-row charts and a full-width create form, and a screenshot showing that is correct rather than a finding.

**Dark-theme expectation:** the responsive spec runs in light; Task 14 covered dark at 1440 and 375, and this task's manual sweep adds dark at 768.

**Vietnamese/English expectation:** the sweep runs in Vietnamese (the longer language), because an overflow that Vietnamese causes and English hides is the one that ships.

**Accessibility acceptance criteria:** every touch target ≥ 44 px at 375 (measure the bottom-bar tabs, the `…` triggers, the type radios, the inline row actions and every `Button size="sm"` — the last is 36 px, which is below 44, so at < 768 a `size="sm"` button must sit inside a container with enough padding to make its *hit box* 44 px, or use `size="default"`; decide per site and record which); no content hidden behind the fixed bottom bar at the end of a scroll; the skip link reachable first.

**Files:**
- Create: `e2e/phase7-responsive.spec.ts`
- Modify: whichever components the sweep finds
- Test: `e2e/phase7-responsive.spec.ts`

**Interfaces:**

- Consumes: `PAGES`, `registerNewUser`, `createAccountViaUi`, `createTransactionViaUi` from `e2e/helpers.ts` (Task 13).
- Produces: nothing new in the app. Any fix is a Tailwind class on an existing element — never a new prop, a new component or a changed signature, either of which would redesign a page a checkpoint already approved.

**Hydration/form-submission constraints:** none. A `min-w-0` or an `overflow-x-auto` cannot touch a `defaultValue` or a gate; if a fix appears to need to, stop and report it.

- [ ] **Step 1: Write the overflow spec across every page and every width**

`e2e/phase7-responsive.spec.ts`:

```ts
import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { PAGES, registerNewUser, createAccountViaUi, createTransactionViaUi } from './helpers'

/**
 * Spec §7's acceptance widths, as a test.
 *
 * The assertion is `documentElement.scrollWidth <= innerWidth`, which is the
 * same check `phase4.spec.ts` and `phase6.spec.ts` already make on a few pages
 * — generalised to every page at every width, because an overflow introduced on
 * `/loans` at 414 is not caught by a check on `/dashboard` at 375.
 *
 * Seeded with real data on purpose: an empty page cannot overflow, and every
 * overflow this suite has ever caught came from a long row — a VND figure beside
 * a long note, a subtotal strip, a three-line loan row.
 *
 * Vietnamese, deliberately: it is the longer language, and an overflow that
 * English hides is the one that ships.
 */
const WIDTHS = [375, 414, 768, 1024, 1280, 1440] as const

const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-responsive-${process.pid}.json`)

test.describe.serial('Phase 7 — responsive', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-responsive' })
    await createAccountViaUi(page, { name: 'Tiền mặt', currency: 'VND', initialBalance: 25_000_000 })
    await createAccountViaUi(page, { name: 'Đô la Mỹ', currency: 'USD', initialBalance: 2_000 })
    // A long note beside a wide VND figure — the exact row that used to
    // overflow, and the reason `FinancialListRow` has a fixed amount column.
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Tiền mặt',
      categoryName: 'Food & Dining',
      amount: 12_500_000,
      note: 'Bữa trưa với khách hàng tại nhà hàng ở quận 1, đã bao gồm phí dịch vụ và thuế giá trị gia tăng',
    })
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const offenders: string[] = []
      for (const url of PAGES) {
        await page.goto(url)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        const overflowing = await page.evaluate(() => {
          const root = document.documentElement
          if (root.scrollWidth <= window.innerWidth) return null
          // Name the widest offending element, so a failure is actionable.
          const all = [...document.querySelectorAll('main *')]
          const widest = all
            .map((element) => ({
              element,
              right: element.getBoundingClientRect().right,
            }))
            .sort((a, b) => b.right - a.right)[0]
          return {
            scrollWidth: root.scrollWidth,
            innerWidth: window.innerWidth,
            offender: widest?.element.tagName + '.' + (widest?.element.className || '').slice(0, 120),
          }
        })
        if (overflowing) offenders.push(`${url}: ${JSON.stringify(overflowing)}`)
      }
      expect(offenders, offenders.join('\n')).toEqual([])
    })
  }

  test('tables become stacked rows below 768 and a table at 768', async ({ page }) => {
    // Spec §7's boundary, asserted rather than assumed.
    await page.setViewportSize({ width: 767, height: 900 })
    await page.goto('/reports')
    await expect(page.locator('table')).toBeHidden()
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/reports')
    await expect(page.locator('table')).toBeVisible()
  })

  test('a dialog is a bottom sheet below 640 and a centred card above it', async ({ page }) => {
    await page.setViewportSize({ width: 639, height: 900 })
    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản/ }).click()
    const sheet = page.getByRole('dialog')
    const belowBox = await sheet.boundingBox()
    expect(belowBox!.y + belowBox!.height).toBeCloseTo(900, 0)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản/ }).click()
    const aboveBox = await page.getByRole('dialog').boundingBox()
    // A right-hand sheet at ≥ 640: anchored to the right edge, full height.
    expect(aboveBox!.x + aboveBox!.width).toBeCloseTo(1440, 0)
  })

  test('the mobile bar does not cover the end of a page', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/transactions')
    await page.keyboard.press('End')
    const bar = page.getByRole('navigation', { name: /Điều hướng nhanh|Primary \(compact\)/ })
    const barBox = (await bar.boundingBox())!
    // The last row of the list must end above the bar's top edge.
    const lastRow = page.getByRole('listitem').last()
    const rowBox = (await lastRow.boundingBox())!
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(barBox.y)
  })

  test('every bottom-bar tab is at least 44 px tall at 375', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    const bar = page.getByRole('navigation', { name: /Điều hướng nhanh|Primary \(compact\)/ })
    for (const link of await bar.getByRole('link').all()) {
      const box = (await link.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('the amount column never wraps a figure mid-number at 375', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/transactions')
    // A figure that wrapped would be taller than one line of its own text.
    const amounts = page.locator('li >> css=[class*="tabular-nums"]')
    for (const amount of await amounts.all()) {
      const box = (await amount.boundingBox())!
      expect(box.height, await amount.innerText()).toBeLessThan(28)
    }
  })
})
```
Export `PAGES` from `e2e/helpers.ts` (Task 13 already does).

- [ ] **Step 2: Run it, and fix what it names**

Run: `npx playwright test e2e/phase7-responsive.spec.ts`

Every failure names the page, the width, the measured `scrollWidth` and the widest element. Fix each at the source, in this order of preference:
1. `min-w-0` on the flex/grid child that refuses to shrink (the single commonest cause — a `flex` child's default `min-width: auto`);
2. `overflow-x-auto` on the wide element's own wrapper (a table, a chart, a chip row) — never on `body` or `main`;
3. `flex-wrap` or a narrower breakpoint on the row that cannot fit;
4. `truncate` on a text node with `title` carrying the full text.

Never fix an overflow with `overflow-x: hidden` on an ancestor: that hides the content instead of fitting it, and the content is money.

Record every fix: the page, the width, the element, the cause, the fix.

- [ ] **Step 3: The 36 px button audit at mobile widths**

`Button size="sm"` is 36 px (Task 2a), and spec §8 requires ≥ 44 px touch targets on mobile. Enumerate every `size="sm"` in the app:
```bash
grep -rn 'size="sm"' app components | grep -v '\.test\.'
```
For each, decide and record: (a) it is inside a `RowActionsMenu` popup, where the *menu item* is the target and is already ≥ 40 px with padding — leave it; (b) it is an inline row action (Ghi nhận thanh toán, Cập nhật tiến độ, Acknowledge, Dismiss, Pause/Resume) — change to `size="default"` below `md` via `className="h-11 md:h-9"`; (c) it is a desktop-only control — leave it and note why.

Then extend the spec with one test that walks the inline row actions at 375 and asserts each is ≥ 44 px tall.

- [ ] **Step 4: Manual sweep at 768 and 414, in both themes**

The automated spec proves *no overflow*; it cannot prove *usable*. Screenshot at 768 and 414, light and dark, every one of the twelve pages (48 screenshots) and look for:
- 768: the icon rail with no labels but working tooltips (hover one and screenshot); two-per-row charts with equal heights; the reports table present; page headers with their actions still on the same line as the title (640+ per `PageHeader`);
- 414: the same as 375 but with more room — nothing should look *stretched*, and the 2×2 summary grid should still be 2×2 rather than collapsing oddly;
- both: no element touching a viewport edge without page padding; no truncated label that matters; the bottom bar's five slots evenly spaced.

Fix and re-shoot as in Task 14 Step 3, recording each finding.

- [ ] **Step 5: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green, including the new responsive spec.
Run: `npm run build` → succeeds.

**Tests required:** `e2e/phase7-responsive.spec.ts` — six overflow tests (one per width, each walking twelve pages), the 768 table boundary, the 640 dialog boundary, the bottom-bar clearance, the tab height, the amount-column wrap, and the Step 3 inline-action height test. Twelve tests.

**Browser visual checks required:** the forty-eight screenshots in Step 4, plus one re-shot image per fix.

**Explicit things NOT to change:** the breakpoints the module tasks chose (`xl` for the Transactions two-column layout and the dashboard's 12-column grid, `lg` for the 240 px rail, `md` for the icon rail and the reports table) — a breakpoint change here would silently redesign a page a checkpoint already approved; the max widths; `overflow-x: hidden` anywhere.

**Completion gate:** `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` and `$env:CI="1"; npx playwright test` all green (Step 5) — including the new responsive spec at all six widths on all twelve pages; every finding from Step 2 and Step 4 recorded and fixed; the `size="sm"` audit complete with a decision per site; forty-eight screenshots inspected.

**Proposed commit boundary:**
1. `test(responsive): assert no horizontal overflow at every acceptance width on every page`
2. `fix(responsive): shrink-safe rows, stacked tables and 44 px touch targets at mobile widths`

---
## Task 16: Accessibility pass

**Objective:** Verify and fix the whole of spec §8 — one `h1` per page and a logical heading order, a visible label on every input, an `aria-label` on every icon-only control, focus visible everywhere, dialogs and sheets trapping and restoring focus, keyboard-operable menus, status never colour-only, contrast met (Task 14 measured it), touch targets ≥ 44 px (Task 15), validation errors linked and announced, `aria-busy` in flight, and `prefers-reduced-motion` respected. Add the permanent forms/labels spec.

**Major files touched:** `e2e/phase7-a11y-forms.spec.ts` (new), plus whichever components the audit finds.

**Reusable primitives involved:** all of them.

**User-facing behaviour:** every screen operable by keyboard alone; every field announced with its name, its help and its error; every dialog dismissible and escapable.

**Desktop expectation:** the audit runs at 1440 light in Vietnamese, where every control is present and the tab order is longest.

**Mobile expectation:** re-checked at 375 for the controls that exist only there — the bottom tab bar, the More sheet, and the create sheets that replace the desktop panels.

**Dark-theme expectation:** the focus ring is re-checked in dark on `--surface` and inside a dialog on `--surface-2`; Task 14 measured the ratio, and this task confirms the ring is actually *visible* against both.

**Vietnamese/English expectation:** every `aria-label`, every `<label>` and every dialog title is translated — an English accessible name on a Vietnamese page is a screen-reader-only regression a visual sweep cannot see, which is why Step 1's spec runs against the Vietnamese default.

**Hydration/form-submission constraints:** the `useHydrated` gates stay untouched. A `<fieldset disabled>` is correctly skipped by the tab order, so a pre-hydration page having fewer tab stops is the gate working, not an accessibility defect — do not "fix" it.

**Accessibility acceptance criteria:** the whole of spec §8, item by item, each with a recorded result.

**Files:**
- Create: `e2e/phase7-a11y-forms.spec.ts`
- Modify: whichever components the audit finds
- Test: `e2e/phase7-a11y-forms.spec.ts`

**Interfaces:**

- Consumes: `PAGES`, `registerNewUser`, `createAccountViaUi` from `e2e/helpers.ts` (Task 13).
- Produces: nothing new in the app. Every fix is an `aria-*` attribute, a heading level or a `FormField` wrapper on an existing element — a fix that needs a new prop means the primitive is wrong, and the fix belongs in `components/common/` where it fixes every page at once.


- [ ] **Step 1: Write the labels-and-names spec**

`e2e/phase7-a11y-forms.spec.ts`:

```ts
import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import { PAGES, registerNewUser, createAccountViaUi } from './helpers'

/**
 * The accessibility guarantees spec §8 makes, as tests.
 *
 * These are structural assertions read off the live accessibility tree, not a
 * third-party audit library: no new dependency, and every failure names the
 * exact element. They cover the four things that regress silently — an input
 * that loses its label, a page that grows a second `h1`, an icon button with no
 * name, and a dialog that stops trapping focus.
 */
const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-a11y-${process.pid}.json`)

/** Every form control on the page that a person can operate. */
async function unlabelledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        'main input:not([type="hidden"]), main select, main textarea, [role="dialog"] input:not([type="hidden"]), [role="dialog"] select, [role="dialog"] textarea',
      ),
    ]
    return controls
      .filter((control) => {
        const id = control.getAttribute('id')
        const hasLabel = id ? document.querySelector(`label[for="${id}"]`) !== null : false
        const wrapped = control.closest('label') !== null
        const ariaLabel = control.getAttribute('aria-label')
        const ariaLabelledBy = control.getAttribute('aria-labelledby')
        // A visible <label> is what the spec requires; aria-label alone is
        // allowed ONLY where there is genuinely no visible text (there is no
        // such control left in this app, so a hit here is a finding).
        return !hasLabel && !wrapped && !ariaLabel && !ariaLabelledBy
      })
      .map(
        (control) =>
          `${control.tagName.toLowerCase()}#${control.id || '(no id)'}[name=${control.getAttribute('name') ?? '?'}]`,
      )
  })
}

test.describe.serial('Phase 7 — accessibility', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-a11y' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  for (const url of PAGES) {
    test(`${url} has exactly one h1 and no unlabelled control`, async ({ page }) => {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      expect(await unlabelledControls(page)).toEqual([])
    })

    test(`${url} names every icon-only control`, async ({ page }) => {
      await page.goto(url)
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('main button, main a')]
          .filter((element) => {
            const text = (element.textContent ?? '').trim()
            if (text.length > 0) return false
            return !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')
          })
          .map((element) => `${element.tagName.toLowerCase()}.${element.className.slice(0, 80)}`),
      )
      expect(unnamed).toEqual([])
    })

    test(`${url} has no skipped heading level`, async ({ page }) => {
      await page.goto(url)
      const levels = await page.evaluate(() =>
        [...document.querySelectorAll('main h1, main h2, main h3, main h4')].map((h) =>
          Number(h.tagName.slice(1)),
        ),
      )
      let previous = 0
      for (const level of levels) {
        expect(level, `after h${previous}`).toBeLessThanOrEqual(previous + 1)
        previous = Math.max(previous, level)
      }
    })
  }

  test('a dialog traps focus and returns it to the opener', async ({ page }) => {
    await page.goto('/accounts')
    const opener = page.getByRole('button', { name: /Thêm tài khoản/ })
    await opener.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')

    // Tab twenty times: focus must never leave the dialog.
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(() => {
        const active = document.activeElement
        const dialogElement = document.querySelector('[role="dialog"]')
        return active !== null && dialogElement !== null && dialogElement.contains(active)
      })
      expect(inside, `after ${index + 1} tabs`).toBe(true)
    }

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('a dialog closes on an overlay click', async ({ page }) => {
    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Click the top-left corner of the viewport, which is the backdrop.
    await page.mouse.click(5, 5)
    await expect(dialog).toBeHidden()
  })

  test('a row actions menu is keyboard operable', async ({ page }) => {
    await page.goto('/accounts')
    const trigger = page.getByRole('button', { name: /Tác vụ cho Cash|Actions for Cash/ })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('a validation error is linked to its field and announced', async ({ page }) => {
    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản/ }).click()
    const dialog = page.getByRole('dialog')
    // Submit with an empty name — the schema refuses it.
    await dialog.getByRole('button', { name: /Tạo tài khoản|Create account/ }).click()
    const nameInput = dialog.getByLabel(/Tên tài khoản|Account name/)
    await expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    const describedBy = await nameInput.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const error = page.locator(`#${describedBy!.split(' ').find((id) => id.endsWith('-error'))}`)
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute('role', 'alert')
  })

  test('the skip link is the first focusable element and reaches the content', async ({ page }) => {
    await page.goto('/dashboard')
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: /Đến nội dung|Skip to content/ })
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main')).toBeVisible()
  })

  test('an in-flight form sets aria-busy', async ({ page }) => {
    // The transactions create panel, held by a route delay — the same
    // technique `e2e/transaction-form-hydration.spec.ts` uses for its
    // double-submit test.
    await page.goto('/transactions')
    await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
    await page.getByRole('option').first().click()
    await page.getByLabel(/Số tiền|^Amount$/).fill('1000')
    await page.route('**/transactions', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await route.fallback()
    })
    await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
    await expect(page.locator('form fieldset').first()).toHaveAttribute('aria-busy', 'true')
    await page.unroute('**/transactions')
  })
})
```

- [ ] **Step 2: Run it, and fix every finding at the source**

Run: `npx playwright test e2e/phase7-a11y-forms.spec.ts`

Each failure names the element. Fix in the source component:
- an unlabelled control → wrap it in `FormField` (never add a bare `aria-label` to satisfy the test; the spec asks for a *visible* label);
- a second `h1` → demote it to `h2` (only one `PageHeader` per page renders an `h1`);
- a skipped heading level → use `SectionHeader`'s `as` prop;
- an unnamed icon control → add the `aria-label` its purpose deserves, translated;
- a focus escape from a dialog → the `Dialog`/`Sheet` primitive is wrong, not the caller: fix it once in `components/common/`;
- a missing `role="alert"` → `FieldError` owns it; the caller is bypassing `FormField`.

- [ ] **Step 3: Manual keyboard walk of every page**

The spec above proves structure; only a person proves *order*. Walk each of the twelve pages plus the four auth screens with the keyboard alone, at 1440, and record for each: (a) the tab order is the visual order; (b) every interactive element is reachable; (c) the focus ring is visible on every one of them, including on `--surface` and inside a dialog on `--surface-2`; (d) no focus trap outside a dialog; (e) Enter/Space activate what they should; (f) Escape closes what is open; (g) a `<details>` opens with Enter.

For each page write PASS or the finding. Fix the findings.

- [ ] **Step 4: Screen-reader spot check**

With the OS screen reader (Narrator on this Windows machine, or NVDA), read through three screens and record what is announced:
1. `/transactions` — a ledger row (does the amount announce with its currency and its sign? does the note announce?), the type radiogroup (does it announce as a group with six options and the current selection?), and the create form's fields in order.
2. `/budgets` — a progress row (does `aria-valuetext` announce "120 %" rather than "100 %"?) and its status badge.
3. `/settings` — the three cards (does each announce as a region with its heading?) and the timezone select's groups.

Record what was announced verbatim. Fix anything that announces a figure without its label, a percentage that is the clamped one, or a badge that announces only as a colour class.

- [ ] **Step 5: `prefers-reduced-motion`**

With the driver's `reducedMotion: 'reduce'` context option, open a dialog, a sheet and a menu and confirm nothing animates. The rule is in `app/globals.css` (Task 1a Step 4); this verifies the primitives' 150 ms transitions actually go through it and that `Skeleton`'s `animate-pulse` stops.

- [ ] **Step 6: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds.

**Tests required:** `e2e/phase7-a11y-forms.spec.ts` — three tests per page (36) plus eight cross-cutting tests: 44 tests.

**Browser visual checks required:** a focus-ring screenshot per page at 1440 (12), plus one inside a dialog and one inside a sheet (2). Fourteen screenshots.

**Explicit things NOT to change:** any copy; any layout; the `useHydrated` gates (a disabled fieldset is *correctly* skipped by the tab order); the existing disambiguating `aria-label`s on Acknowledge/Dismiss/Pause/Resume and on every `RowActionsMenu` (they name their row on purpose).

**Completion gate:** `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` and `$env:CI="1"; npx playwright test` all green (Step 6) — including the new a11y spec on every page; the keyboard walk recorded PASS for all sixteen screens; the screen-reader spot check recorded verbatim with every finding fixed; reduced motion verified.

**Proposed commit boundary:**
1. `test(a11y): assert one h1, labelled controls, named icon controls and heading order on every page`
2. `fix(a11y): focus, labelling and announcement findings from the keyboard and screen-reader walk`

---
## Task 17: Loading, error, empty and confirmation consistency

**Objective:** Deliver spec §10's four state families uniformly: route-level `loading.tsx` skeletons in the real layout for the dashboard and every list page; every error surfaced through `InlineAlert` with translated copy and the route boundary for the unexpected ones; an `EmptyState` on every list, widget and filtered view; and a `ConfirmDialog` on **exactly** the eight destructive actions and nowhere else. Add the spec that proves the eight.

**Major files touched:** twelve new `app/(app)/*/loading.tsx`, `components/common/skeleton.tsx` (from Task 1), `app/(app)/error.tsx`, `e2e/phase7-confirm-dialogs.spec.ts` (new), plus any empty state the audit finds missing.

**Reusable primitives involved:** `Skeleton`, `EmptyState`, `InlineAlert`, `ConfirmDialog`, `PageHeader`, `ChartContainer`.

**User-facing behaviour:** navigating to a page shows grey bars in the shape of what is coming — never a spinner and never a blank frame. A failed action shows one inline message where it happened. An empty list says what is missing and offers one action. A destructive action asks first, in a dialog, naming what it will do; a harmless one does not ask at all.

**Desktop expectation:** each skeleton mirrors its page's real layout at 1024/1280/1440, so the content does not jump when it arrives — the dashboard's skeleton has the summary panel and the grid, the transactions one has its two columns, the list pages' have a header and a card of rows.

**Mobile expectation:** at 375 the skeleton loses the second column exactly as the page does (`xl:block`), and its rows are the same height as the real ones; the confirmation dialogs are bottom sheets.

**Hydration/form-submission constraints:** a `loading.tsx` renders on the server during a route transition and is replaced by the page — it mounts no form, holds no state and cannot interact with a `useHydrated` gate. `ConfirmDialog`'s own pending lock (Tasks 1a–1c) is the only in-flight state this task touches, and it is already written.

**Dark-theme expectation:** `Skeleton`'s `bg-muted` reads as a placeholder on both surfaces; the `InlineAlert` tints are the 18 % dark values; the `ConfirmDialog`'s solid `negative` confirm button is legible in dark (Task 14 measured `primary-foreground`/`negative`).

**Vietnamese/English expectation:** every empty state, every alert and every confirmation is a key. A skeleton has no text at all — deliberately: a "Đang tải…" line under grey bars says nothing the bars do not, and it would be the one string that flashes on every navigation.

**Accessibility acceptance criteria:** `Skeleton` is `aria-hidden="true"` (it is decoration standing in for content, and announcing "loading" twelve times is worse than silence — the route transition itself is announced by the browser); a negative `InlineAlert` carries `role="alert"`; every `EmptyState`'s action is a real link or button with descriptive text; the `ConfirmDialog`'s confirm button is not the default focus (Base UI focuses the first focusable element, which is Cancel or the close button — verify and, if it lands on Confirm, set `initialFocus` to Cancel: a destructive dialog must not confirm on a stray Enter).

**Files:**
- Create: `app/(app)/dashboard/loading.tsx`, `app/(app)/transactions/loading.tsx`, `app/(app)/transfers/loading.tsx`, `app/(app)/accounts/loading.tsx`, `app/(app)/categories/loading.tsx`, `app/(app)/budgets/loading.tsx`, `app/(app)/goals/loading.tsx`, `app/(app)/debts/loading.tsx`, `app/(app)/loans/loading.tsx`, `app/(app)/reminders/loading.tsx`, `app/(app)/reports/loading.tsx`, `app/(app)/settings/loading.tsx`, `components/common/page-skeleton.tsx`, `e2e/phase7-confirm-dialogs.spec.ts`
- Modify: whichever pages the empty-state audit finds
- Test: `components/common/page-skeleton.test.tsx`, `e2e/phase7-confirm-dialogs.spec.ts`

**Interfaces:**

```ts
// components/common/page-skeleton.tsx
export function PageSkeleton(props: {
  /** How many placeholder rows the list card shows. */
  rows?: number
  /** Add a summary strip above the list — dashboard and reports. */
  summary?: 'panel' | 'strip' | 'none'
  /** Add a second column for the pages that have one. */
  twoColumn?: boolean
  /** The page's max width class, so the skeleton occupies the real geometry. */
  maxWidth?: string
}): React.ReactElement
```

- [ ] **Step 1: Write `PageSkeleton` and its test**

`components/common/page-skeleton.tsx`:

```tsx
import { cn } from 'cn'
import { Skeleton } from './skeleton'

/**
 * A page's shape, in grey (spec §10: "grey bars in the real layout, no
 * spinners").
 *
 * A spinner says "something is happening"; a skeleton says "a header, a summary
 * and eight rows are happening", which is the difference between waiting and
 * knowing. And because it occupies the real geometry — the same max width, the
 * same padding, the same card — the content does not jump when it arrives.
 *
 * No text at all, deliberately: "Đang tải…" under grey bars adds nothing the
 * bars do not already say, and it would be the one string that flashes on every
 * navigation in the app.
 *
 * `aria-hidden` on every bar (from `Skeleton`): this is decoration standing in
 * for content, and announcing it twelve times per session is worse than
 * silence — the route transition itself is what a screen reader announces.
 */
export function PageSkeleton({
  rows = 6,
  summary = 'none',
  twoColumn = false,
  maxWidth = 'max-w-[60rem]',
}: {
  rows?: number
  summary?: 'panel' | 'strip' | 'none'
  twoColumn?: boolean
  maxWidth?: string
}) {
  return (
    <div className={cn('mx-auto flex w-full flex-col gap-8 p-4 md:p-6 lg:p-8', maxWidth)}>
      {/* The header: a title bar and a subtitle bar, at the real sizes. */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      {summary === 'panel' && (
        <div className="grid grid-cols-1 gap-px rounded-lg border border-border bg-surface md:grid-cols-2 xl:grid-cols-12">
          <div className="flex flex-col gap-2 p-4 xl:col-span-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-10 w-40" />
          </div>
          <div className="grid grid-cols-2 gap-px border-t border-border md:grid-cols-3 xl:col-span-8 xl:border-t-0">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-col gap-2 p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-28" />
              </div>
            ))}
          </div>
        </div>
      )}

      {summary === 'strip' && (
        <div className="grid grid-cols-1 gap-px rounded-lg border border-border bg-surface md:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex flex-col gap-2 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-28" />
            </div>
          ))}
        </div>
      )}

      <div className={cn('grid grid-cols-1 gap-8', twoColumn && 'xl:grid-cols-12')}>
        <div className={cn(twoColumn && 'xl:col-span-7')}>
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <ul className="divide-y divide-border">
              {Array.from({ length: rows }, (_, index) => (
                <li key={index} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                  <Skeleton className="h-5 w-24" />
                </li>
              ))}
            </ul>
          </div>
        </div>
        {twoColumn && (
          <div className="hidden xl:col-span-5 xl:block">
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
              <Skeleton className="h-5 w-32" />
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-11 w-full" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

`components/common/page-skeleton.test.tsx` — four cases: (1) every bar is `aria-hidden="true"`; (2) it contains no text node at all (`expect(html.replace(/<[^>]+>/g, '').trim()).toBe('')`); (3) `rows={8}` renders eight `<li>`s; (4) `twoColumn` renders the second column with `xl:block` so it is desktop-only.

- [ ] **Step 2: Write the twelve `loading.tsx` files**

Each is three lines, and each mirrors its page's real geometry. Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md` first and confirm `loading.tsx` is still the Next 16 convention and that a default export with no props is what it takes.

| File | Body |
|---|---|
| `app/(app)/dashboard/loading.tsx` | `<PageSkeleton maxWidth="max-w-[75rem]" summary="panel" rows={8} />` |
| `app/(app)/transactions/loading.tsx` | `<PageSkeleton maxWidth="max-w-[75rem]" rows={8} twoColumn />` |
| `app/(app)/transfers/loading.tsx` | `<PageSkeleton rows={5} />` |
| `app/(app)/accounts/loading.tsx` | `<PageSkeleton rows={4} />` |
| `app/(app)/categories/loading.tsx` | `<PageSkeleton rows={3} />` |
| `app/(app)/budgets/loading.tsx` | `<PageSkeleton rows={4} />` |
| `app/(app)/goals/loading.tsx` | `<PageSkeleton rows={3} />` |
| `app/(app)/debts/loading.tsx` | `<PageSkeleton rows={4} />` |
| `app/(app)/loans/loading.tsx` | `<PageSkeleton rows={3} />` |
| `app/(app)/reminders/loading.tsx` | `<PageSkeleton rows={5} />` |
| `app/(app)/reports/loading.tsx` | `<PageSkeleton maxWidth="max-w-[75rem]" summary="strip" rows={5} />` |
| `app/(app)/settings/loading.tsx` | `<PageSkeleton maxWidth="max-w-[30rem]" rows={3} />` |

Each file is the same three lines with its own props from the table above. `app/(app)/dashboard/loading.tsx` in full, as the pattern:

```tsx
import { PageSkeleton } from '@/components/common/page-skeleton'

export default function Loading() {
  return <PageSkeleton maxWidth="max-w-[75rem]" summary="panel" rows={8} />
}
```

and `app/(app)/goals/loading.tsx`, as the shortest:

```tsx
import { PageSkeleton } from '@/components/common/page-skeleton'

export default function Loading() {
  return <PageSkeleton rows={3} />
}
```

**Careful — the settings skeleton.** Settings is three cards, not a list, so `PageSkeleton`'s single card of rows is the wrong shape. Either add a `variant="cards"` to `PageSkeleton` (three bordered blocks each with a title bar and two field bars) or write `app/(app)/settings/loading.tsx`'s markup inline. Choose the variant — a second skeleton component for one page is not worth it — and add a fifth test case for it.

- [ ] **Step 3: Audit every empty state**

Enumerate every list, widget and filtered view and record whether it has an `EmptyState`, what it says and what it offers:

| Surface | Expected |
|---|---|
| Dashboard × 10 widgets | Task 4 — one per widget, each with one action; the balance-history one shows the empty state, not a flat line |
| `/transactions` list | Task 5 |
| `/transactions` no-account | Task 5 — links to Accounts |
| `/transfers` list | Task 5 |
| `/transfers` < 2 accounts | Task 5 — links to Accounts |
| `/accounts` list | Task 6 |
| `/categories` × 3 sections | Task 6 |
| `/budgets` list (per month) | Task 7 — names the month |
| `/goals` list | Task 7 |
| `/debts` both sections | Task 8 |
| `/loans` list | Task 8 |
| `/reminders` due (× 3 filters) | Task 9 — filter-aware copy |
| `/reminders` schedule (× 3 filters) | Task 9 — filter-aware copy |
| `/reports` by category | Task 10 |
| `/reports` by account | Task 10 |

For each, visit it with an empty (or filtered-to-empty) account and screenshot. Anything missing, or anything whose copy claims "nothing" when a filter is hiding something, is a finding — fix it in this task. The filter-aware distinction is the subtle one and `/reminders` is where it was designed (Task 9's `dueEmptyKey`/`scheduleEmptyKey`); check `/budgets` (a month with none while other months have some — is the copy month-specific? Task 7 says yes) and `/reports` (a range with none — "No expenses in this range", which is already range-aware).

- [ ] **Step 4: Move the four Phase-6 seed helpers into `e2e/helpers.ts`, then write the confirmation spec**

`createGoalViaUi`, `createDebtViaUi`, `createLoanViaUi` and `createReminderViaUi` are local functions inside `e2e/phase6.spec.ts` (Tasks 7–9 rewrote their selectors there). This spec needs all four, so move them — unchanged apart from the move — into `e2e/helpers.ts`, export them, and import them back into `phase6.spec.ts`. Run `npx playwright test e2e/phase6.spec.ts` immediately afterwards to prove the move changed nothing.

`e2e/phase7-confirm-dialogs.spec.ts`:

```ts
import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import {
  createAccountViaUi,
  createBudgetViaUi,
  createDebtViaUi,
  createGoalViaUi,
  createLoanViaUi,
  createReminderViaUi,
  createTransactionViaUi,
  registerNewUser,
} from './helpers'

/**
 * Spec §10's confirmation rule, both halves:
 *
 *  - EXACTLY these eight destructive actions ask first, in a `ConfirmDialog`:
 *    archive account, archive category (and account type), delete budget,
 *    archive goal, write off debt, close loan, delete transaction, delete
 *    transfer.
 *  - The five harmless ones — acknowledge, dismiss, pause, resume, update
 *    progress — ask NOTHING. A dialog in front of an action that is its own
 *    undo trains the user to dismiss dialogs, which is how the eight above
 *    stop working.
 *
 * And there is no `window.confirm` anywhere: this file registers no
 * `page.once('dialog')` handler, so a native dialog would hang the test rather
 * than be silently accepted — which is the point.
 */
const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-confirm-${process.pid}.json`)

/** Opens a row's `…` menu and clicks the named item. */
async function rowAction(page: Page, rowName: RegExp, itemName: RegExp): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`(Tác vụ cho|Actions for).*${rowName.source}`) }).click()
  await page.getByRole('menuitem', { name: itemName }).click()
}

test.describe.serial('Phase 7 — confirmations', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-confirm' })

    // One of everything the eight destructive actions need.
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    await createAccountViaUi(page, { name: 'Bank', currency: 'VND', initialBalance: 5_000_000 })
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 100_000,
    })

    // A transfer, through its own form (there is no helper for one).
    await page.goto('/transfers')
    await page.getByLabel(/^Từ$|^From$/).selectOption({ label: 'Cash' })
    await page.getByLabel(/^Đến$|^To$/).selectOption({ label: 'Bank' })
    await page.getByLabel(/Số tiền|^Amount$/).fill('50000')
    await page.getByRole('button', { name: /Chuyển tiền|^Transfer$/ }).click()

    // A custom expense category, so `/categories` has an archivable chip
    // (a default one cannot be archived and offers no menu).
    await page.goto('/categories')
    const section = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: /Danh mục chi|Expense Categories/ }) })
      .last()
    await section.getByLabel(/Thêm Danh mục chi|Add Expense Categories/).fill('Cà phê')
    await section.getByRole('button', { name: /^Thêm$|^Add$/ }).click()

    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 10_000_000 })
    await createGoalViaUi(page, { name: 'Emergency fund', target: 20_000_000 })
    await createDebtViaUi(page, {
      direction: 'RECEIVABLE',
      person: 'Minh',
      amount: 2_000_000,
    })
    await createLoanViaUi(page, {
      lender: 'Bank',
      principal: 120_000_000,
      interestRate: 8.5,
      termMonths: 60,
      frequency: 'MONTHLY',
      scheduledPayment: 3_800_000,
    })
    await createReminderViaUi(page, {
      title: 'Internet',
      type: 'EXPENSE',
      amount: 300_000,
      frequency: 'MONTHLY',
    })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  const DESTRUCTIVE = [
    { name: 'delete transaction', url: '/transactions', row: /Food/, item: /Xóa giao dịch|Delete transaction/ },
    { name: 'delete transfer', url: '/transfers', row: /→/, item: /Xóa lệnh chuyển|Delete transfer/ },
    { name: 'archive account', url: '/accounts', row: /Cash/, item: /Lưu trữ|^Archive$/ },
    { name: 'archive category', url: '/categories', row: /Cà phê/, item: /Lưu trữ|^Archive$/ },
    { name: 'delete budget', url: '/budgets', row: /Tổng thể|^Overall$/, item: /^Xóa$|^Delete$/ },
    { name: 'archive goal', url: '/goals', row: /Emergency/, item: /Lưu trữ|^Archive$/ },
    { name: 'write off debt', url: '/debts', row: /Minh/, item: /Xóa nợ|Write off/ },
    { name: 'close loan', url: '/loans', row: /Bank/, item: /Đóng khoản vay|Close loan/ },
  ] as const

  for (const action of DESTRUCTIVE) {
    test(`${action.name} asks first, and Cancel changes nothing`, async ({ page }) => {
      await page.goto(action.url)
      const before = await page.locator('main').innerText()
      await rowAction(page, action.row, action.item)

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      // It names what it will do, not just "Are you sure?".
      await expect(dialog.getByRole('heading')).toBeVisible()
      await expect(dialog.getByRole('button', { name: /^Hủy$|^Cancel$/ })).toBeVisible()

      await dialog.getByRole('button', { name: /^Hủy$|^Cancel$/ }).click()
      await expect(dialog).toBeHidden()
      expect(await page.locator('main').innerText()).toBe(before)
    })
  }

  /**
   * Five, not four: `resume` is a distinct code path (`setReminderActive(id,
   * true)`) rendered by the same button as `pause`, and "the action is its own
   * undo" is only true if BOTH directions are dialog-free.
   */
  const HARMLESS = [
    { name: 'acknowledge', url: '/reminders?view=due&type=all', button: /Ghi nhận|Acknowledge/ },
    { name: 'dismiss', url: '/reminders?view=due&type=all', button: /^Bỏ qua|Dismiss/ },
    { name: 'pause', url: '/reminders?view=schedule&type=all', button: /Tạm dừng|^Pause/ },
    { name: 'resume', url: '/reminders?view=schedule&type=all', button: /Tiếp tục|^Resume/ },
    { name: 'update progress', url: '/goals', button: /Cập nhật tiến độ|Update progress/ },
  ] as const

  // `resume` runs after `pause` in this serial file, so the reminder really is
  // paused by the time its button says Tiếp tục.
  for (const action of HARMLESS) {
    test(`${action.name} asks nothing`, async ({ page }) => {
      await page.goto(action.url)
      const button = page.getByRole('button', { name: action.button }).first()
      await button.click()
      // "Update progress" opens a FORM dialog, which is not a confirmation:
      // it has a labelled field. The other three open nothing at all.
      const dialog = page.getByRole('dialog')
      if (action.name === 'update progress') {
        await expect(dialog).toBeVisible()
        await expect(dialog.getByRole('spinbutton')).toBeVisible()
      } else {
        await expect(dialog).toHaveCount(0)
      }
    })
  }

  test('no native window.confirm remains anywhere', async ({ page }) => {
    // A native dialog with no handler blocks the page, so this walks every
    // destructive action's CONFIRM path and asserts each completed. If any site
    // still called `window.confirm`, the click below would hang and the test
    // would time out — which is a louder failure than an assertion.
    await page.goto('/transactions')
    const rows = page.getByRole('listitem')
    const countBefore = await rows.count()
    await rowAction(page, /Food/, /Xóa giao dịch|Delete transaction/)
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Xóa$|^Delete$/ }).click()
    await expect(dialog).toBeHidden()
    await expect(rows).toHaveCount(countBefore - 1)
  })
})
```

Run: `npx playwright test e2e/phase7-confirm-dialogs.spec.ts` → green (14 tests).

- [ ] **Step 5: Verify every error path**

For each error family, reach the state and confirm the copy and the placement:

| Error | How to reach it | Expected |
|---|---|---|
| Action error (each of the ~35 codes) | not all reachable through the UI; reach the ones that are: duplicate budget, debt overpayment, loan overpayment, loan split mismatch, non-zero-balance archive, same-account transfer, missing category | one `InlineAlert tone="negative"` beside the form that raised it, with the translated copy from `errors.json`, and the form re-enabled |
| Generic action failure | temporarily throw inside one action in a scratch branch, or block its POST with a `page.route` abort | `t('errors.generic')` in an `InlineAlert`, form re-enabled |
| Unexpected server error | `page.route` a page request to fulfil with a 500, or temporarily throw in a page's data fetch | `app/(app)/error.tsx`'s boundary with `errors.boundaryTitle`, `errors.boundaryBody` and a working Retry (which calls `retry`, not `reset` — the boundary's comment explains why, and this verifies it actually re-fetches) |
| Invalid report range | `/reports?period=weekly` | the period control, the echoed dates and one `InlineAlert` |
| Invalid reset token | `/reset-password?error=INVALID_TOKEN` | its own heading and the request-a-new-link link |

Record each as PASS or a finding. **Revert every temporary throw before committing** — `git status` must be clean of them.

- [ ] **Step 6: Full verification**

Run: `npm run test` → green (`page-skeleton.test.tsx` +5).
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green.
Run: `npm run build` → succeeds. Confirm the twelve `loading.tsx` files are picked up (a build log lists each route; check the dashboard and one list page).

- [ ] **Step 7: Browser visual check — the four state families**

Screenshot at 1440 light and dark:
- each of the twelve skeletons, captured by throttling the network in the driver (`context.route` with a delay on the page request) — 24 shots;
- the empty state of every surface in the Step 3 table — the twelve pages' worth, ~16 shots at 1440 light;
- one `InlineAlert` per tone — 4 shots;
- each of the eight `ConfirmDialog`s — 8 shots at 1440 light;
- the route error boundary — 1 shot.

Roughly fifty-three screenshots. Look for: the skeleton occupying the same geometry as the content (overlay the two shots and check the header and the first row land in the same place); no text in any skeleton; every empty state with exactly one action; every confirmation naming its consequence; the boundary's Retry actually re-fetching.

**Tests required:**
- Vitest: `components/common/page-skeleton.test.tsx` (5 new).
- Playwright: `e2e/phase7-confirm-dialogs.spec.ts` (14 new: eight destructive, five harmless, one native-dialog sweep).

**Browser visual checks required:** the ~53 screenshots in Step 7.

**Explicit things NOT to change:** `app/(app)/error.tsx`'s `retry`-not-`reset` choice and its refusal to render or log `error` (both documented at `app/(app)/error.tsx:6-29` and both still correct); the set of eight destructive actions — not seven, not nine; the absence of a dialog on the five harmless actions; any action's error codes.

**Completion gate:** all four commands green; twelve skeletons present and geometry-matched; the Step 3 empty-state table complete with every gap fixed; the confirm spec green with exactly eight destructive and five harmless cases; the Step 5 error table complete; every temporary throw reverted.

**Proposed commit boundary:**
1. `feat(states): route-level skeletons in the real layout for every app page`
2. `test(states): assert the eight confirmation dialogs and the harmless actions that ask nothing`

---
## Task 18: Whole-product visual consistency review

**Objective:** Look at the finished product as one thing rather than twelve pages, and remove the inconsistencies that only appear in that view: a heading two pixels off, a card padded differently, a gap of 20 px where the scale says 16 or 24, a fourth radius, a shadow where the system allows none, a second way of saying the same word. Fix them at the primitive.

**Major files touched:** `components/common/*` (where a primitive is the fix), and whichever pages drifted — recorded, not guessed.

**Reusable primitives involved:** all of them; the deliverable is that they are genuinely the only source of these decisions.

**User-facing behaviour:** nothing new; everything slightly more calm.

**Desktop expectation:** the twelve pages read as one product at 1440 — same `h1` metrics, same card padding, same max widths, same alignment of the right-hand figure column.

**Mobile expectation:** the same at 375 — same row heights across the four planning pages, same header stacking, same sheet anchoring.

**Dark-theme expectation:** the dark contact sheet is compared against the light one for *structural* identity; a page that changes shape between themes is a finding.

**Vietnamese/English expectation:** the copy sweep in Step 5 unifies synonyms in both message trees, so one action has one word in each language.

**Hydration/form-submission constraints:** none. Every fix here is a class, a token or a message value — if one appears to need a form change, it is out of scope for this task.

**Accessibility acceptance criteria:** unchanged from Task 16 — but re-run the a11y spec after every fix, because a primitive change is the one thing that can regress every page at once.

**Files:**
- Modify: `components/common/*`, `app/globals.css`, and whichever pages Step 3 records
- Test: the full suite re-run; no new test

**Interfaces:**

- Consumes: everything Tasks 1–12 produced; nothing is added.
- Produces: nothing new. This task changes no exported name, no signature and no prop — a change to any of them here would silently redesign a page a checkpoint already approved, and belongs in the module task that owns it.


- [ ] **Step 1: Build the contact sheet**

With a scratch driver, screenshot all twelve app pages plus the four auth screens at **1440 light**, then compose them into one contact sheet (a single image, four across) with a small script in the scratch directory. Do the same for **1440 dark** and **375 light**. Three contact sheets.

Looking at twelve pages one at a time is how the inconsistencies survived to this point; a contact sheet is the whole point of this task.

- [ ] **Step 2: Measure, do not eyeball, the six things that drift**

For each of the twelve pages, read these off the live DOM with a driver script and put them in a table:

1. `h1` computed `font-size`, `line-height` and `font-weight` — must be identical on all twelve.
2. The page container's computed `max-width` and `padding` — must be one of the three max widths and exactly `16/24/32` per breakpoint.
3. Every card's computed `padding`, `border-radius` and `border-width` — `16` or `24`, `10px`, `1px`, and **no** `box-shadow`.
4. Every gap between sections — must be a member of {4, 8, 12, 16, 24, 32, 48}. Report any other value.
5. Every distinct `border-radius` value in use across the page — must be a subset of {6px, 10px, 999px} (plus `0`).
6. Every distinct `font-weight` in use — must be a subset of {400, 500, 600}.

A script sketch for 4–6:
```js
await page.evaluate(() => {
  const values = { radii: new Set(), weights: new Set(), gaps: new Set(), shadows: new Set() }
  for (const element of document.querySelectorAll('main *')) {
    const style = getComputedStyle(element)
    values.radii.add(style.borderRadius)
    values.weights.add(style.fontWeight)
    if (style.rowGap !== 'normal') values.gaps.add(style.rowGap)
    if (style.columnGap !== 'normal') values.gaps.add(style.columnGap)
    if (style.boxShadow !== 'none') values.shadows.add(`${element.tagName}: ${style.boxShadow}`)
  }
  return Object.fromEntries(Object.entries(values).map(([key, set]) => [key, [...set]]))
})
```
Run it on every page and record the union. **Every off-scale value is a finding**, and the fix is nearly always a primitive: a `gap-5` (20 px) somewhere becomes `gap-4` or `gap-6`; a `rounded-md` on a card becomes `rounded-lg`; a `font-bold` becomes `font-semibold`; a `shadow-sm` is deleted.

- [ ] **Step 3: Triage the contact sheets against the design system**

Go through the three sheets and record findings under these headings, with the page, the element and the fix:

- **Hierarchy** — does every page's most important thing read as the most important thing? Is any secondary widget as loud as a primary one?
- **Density** — do two pages of the same kind (`/debts` and `/loans`; `/budgets` and `/goals`) have the same row height and the same padding?
- **Alignment** — do the twelve `h1`s start at the same x? Do the right-aligned figures on the list pages align to the same right edge?
- **Weight** — is there more than one primary button in any view region? Is any destructive action solid outside a dialog?
- **Colour** — is any colour used for two different meanings? Is red used for an ordinary expense anywhere (spec §2 says expense is `foreground`)?
- **Copy** — is the same action called two things in two places (Sửa/Chỉnh sửa, Xóa/Loại bỏ, Lưu trữ/Ẩn)? Grep the vi message files for near-synonyms and unify.
- **Icons** — is every icon lucide, at 16/20/24, and does any icon appear with two different meanings?
- **Empty states** — do all sixteen have the same structure and the same tone of voice?

- [ ] **Step 4: Fix, at the lowest possible level**

Apply the findings in this order, re-running `npm run test && npx playwright test` after each group:
1. `app/globals.css` (a token, a radius, the base layer);
2. a `components/common/` primitive;
3. the one page that drifted.

For every fix at level 3, ask why the primitive did not cover it and write the answer in a comment — that answer is either a legitimate per-page difference or a missing primitive prop, and knowing which is the value of this task.

Re-shoot the three contact sheets after the fixes and compare them to the originals side by side.

- [ ] **Step 5: Copy consistency sweep**

```bash
# Every distinct Vietnamese action word, to catch two words for one action.
grep -rhoE '"[^"]*(Sửa|Xóa|Lưu|Thêm|Đóng|Hủy|Bỏ)[^"]*"' messages/vi/*.json | sort -u
```
Read the list and unify: one word per action across every domain file, matching the glossary in spec §4. Do the same for English. Where a domain genuinely needs a different word (Xóa nợ is not Xóa), keep it and note why.

Then check the reverse: the same key used for two different meanings. `grep -c` each `common.*` key's use across `app/` and `components/`, and for any used more than five times, read the call sites and confirm the word fits all of them.

- [ ] **Step 6: Full verification**

Run: `npm run test` → green.
Run: `npm run lint && npm run format:check && npx tsc --noEmit` → clean.
Run: `npx playwright test` → green — **all** specs, because a primitive change touches every page.
Run: `npm run build` → succeeds.

**Tests required:** none new. The deliverables are the three contact sheets (before and after), the measurement table from Step 2, and the triage list from Step 3 with a disposition per finding.

**Browser visual checks required:** three contact sheets before, three after, plus a re-shot page image per fix.

**Explicit things NOT to change:** anything a checkpoint already approved, **unless** it is a measured off-scale value or a genuine inconsistency — in which case fix it and say so in the report, so the product owner sees the delta from what they approved; any copy whose wording a checkpoint approved (a *synonym* unification is in scope; a rewrite is not); any layout structure.

**Completion gate:** `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` and `$env:CI="1"; npx playwright test` all green (Step 6) — the whole suite, because a primitive change touches every page; the Step 2 table shows only on-scale values for radii, weights, gaps and shadows on all twelve pages; every Step 3 finding has a disposition; the after-sheets are visibly more consistent than the before-sheets.

**Proposed commit boundary:**
1. `fix(design): unify off-scale spacing, radii, weights and duplicate copy across the product`

---
## Task 19: End-to-end verification and the final visual package

**Objective:** Prove the whole phase: every command green, every suite green, the export contract intact, and the complete visual package from spec §11 produced and handed to the product owner for the final approval.

**Major files touched:** none — this task changes no product code except to fix what verification finds.

**Reusable primitives involved:** all of them, as subjects.

**User-facing behaviour:** unchanged; this is verification.

**Desktop expectation:** the ten desktop-light screens of the final package render as the checkpoints approved them, at 1440×900.

**Mobile expectation:** the six mobile-light screens and the one mobile-dark screen render as the checkpoints approved them, at 375×812.

**Dark-theme expectation:** the three desktop-dark screens and the one mobile-dark screen are in the package, from the `cashflow-theme` cookie and the saved `User.theme`.

**Vietnamese/English expectation:** three paired screens (Dashboard, Transactions, Settings) in both languages are in the package.

**Accessibility acceptance criteria:** every §8 item verified in Task 16 is re-confirmed green here by the suite run in Step 1; no new audit is performed, and no §8 item may be failing at merge.

**Hydration/form-submission constraints:** none — this task writes no product code. It does re-run every hydration spec, and each must be green with every original test present.

**Files:**
- Modify: only what verification finds broken
- Test: the entire suite, run in full

**Interfaces:**

- Consumes: everything Tasks 1–12 produced; nothing is added.
- Produces: nothing new. This task changes no exported name, no signature and no prop — a change to any of them here would silently redesign a page a checkpoint already approved, and belongs in the module task that owns it.


- [ ] **Step 1: The five commands, in order, from a clean tree**

```bash
git status --short          # must be clean before starting
npm run format:check
npm run lint
npx tsc --noEmit
npm run test
npm run build
$env:CI="1"; npx playwright test
```
Every one must pass. Record the output summary of each (test counts, build route table, spec counts) in the task report. If any fails, fix it and re-run **all** of them from the top — a fix for one can break another, and a partial re-run is how that ships.

- [ ] **Step 2: The export contract, explicitly**

```bash
npx vitest run lib/server/export app/api/reports
git diff --stat main -- lib/server/export app/api/reports prisma
```
Expected: every export test green, and the `git diff --stat` **empty** — no file under `lib/server/export/`, `app/api/reports/` or `prisma/` changed in the whole phase. If any did, either revert it or, if it was genuinely necessary, escalate: it is outside the phase's boundary and needs the product owner's decision, not a fix.

Then download both exports through the UI and open them:
- `/reports` → Xuất Excel → Khoảng này
- `/reports` → Xuất Excel → Toàn bộ dữ liệu

For each, confirm with the driver (or by hand with ExcelJS in a scratch script) that the sheet names and the header row of every sheet are byte-identical to what `lib/server/export/sheet-registry.ts` declares. Record the sheet list.

- [ ] **Step 3: The phase acceptance criteria, one by one**

Walk spec §13 and record PASS with its evidence, or the gap:

1. **Every page has one `h1`** — evidence: `e2e/phase7-a11y-forms.spec.ts`'s twelve one-`h1` tests.
2. **Every field has a visible label** — evidence: the same spec's twelve unlabelled-control tests, returning `[]`.
3. **No raw enum in the DOM** — evidence: `e2e/phase7-enum-sweep.spec.ts`'s twelve pages plus the four-type case.
4. **vi default and en fully supported, with locale-formatted numbers and dates** — evidence: `e2e/phase7-theme-locale.spec.ts`'s all-pages locale test and `lib/i18n/messages.test.ts`'s key parity.
5. **Theme persists and the first paint matches** — evidence: the raw-HTML `dark` assertions in `e2e/phase7-theme-locale.spec.ts`.
6. **Dashboard hierarchy per §6.1 at 1440 and 375** — evidence: the Task 4 checkpoint approval plus `phase4.spec.ts`'s 8/12-vs-12/12 width assertion.
7. **Transaction rows never collide at 375** — evidence: `e2e/phase7-responsive.spec.ts`'s amount-column wrap test plus the measured column x-positions from the Task 5 checkpoint.
8. **Eight destructive actions use `ConfirmDialog`** — evidence: `e2e/phase7-confirm-dialogs.spec.ts`'s eight destructive and four harmless tests, and `grep -rn "window.confirm" components` returning nothing.
9. **In-flight forms locked** — evidence: the double-submit test in `e2e/transaction-form-hydration.spec.ts` and the `aria-busy` test in `e2e/phase7-a11y-forms.spec.ts`.
10. **Excel export unchanged, all Phase 6 export tests green** — evidence: Step 2.
11. **All Phase 2–6 Vitest and Playwright suites green** — evidence: Step 1.
12. **`npm run lint`, `format:check`, `tsc`, `build` green** — evidence: Step 1.
13. **Visual package approved** — Step 5.

- [ ] **Step 4: Produce the final visual package (spec §11)**

Seed a **fresh** user through the UI with a full, realistic dataset — three accounts (two VND, one USD), thirty transactions across three months including every type, four transfers (two cross-currency), five budgets across the status bands, four savings goals, four debts in both directions, three loans, six reminders including an overdue one and a weekly one — and record the seeding script in the scratch directory so the package is reproducible.

Then capture exactly what spec §11 lists:

**Desktop light (1440×900), 10 shots:** Dashboard, Transactions, Accounts, Budgets, Debts, Loans, Reminders, Reports, Settings, Login.

**Desktop dark (1440×900), 3 shots:** Dashboard, Transactions, Settings.

**Mobile light (375×812), 6 shots:** Dashboard, Transactions, Budgets, Debts, Loans, More sheet.

**Mobile dark (375×812), 1 shot:** Dashboard.

**Vietnamese and English (1440×900 light), 6 shots:** Dashboard, Transactions, Settings — one pair each.

Twenty-six screenshots, full-page (not just the viewport) except the two "above the fold" reference shots noted below. Store them in the scratch directory in a `final/` folder with the naming `NN-surface-theme-locale-width.png`, plus:
- `27-dashboard-abovefold-1440.png` — the 1440×900 viewport clip, as the hierarchy evidence;
- `28-transactions-375-amountcolumn.png` — a clipped crop showing three rows' amount column aligned.

- [ ] **Step 5: 🛑 VISUAL CHECKPOINT 6 — FINAL (spec §11, §13)**

**The controller STOPS here. Phase 7 is not complete and nothing is merged until the product owner approves this package.**

Hand over:
1. The twenty-eight images from Step 4.
2. The acceptance table from Step 3, with the evidence per row.
3. The five command outputs from Step 1 (counts and summaries).
4. The export verification from Step 2 (the sheet list and the empty `git diff --stat`).
5. The contrast tables from Task 1a Step 5 and Task 14 Step 1.
6. The list of accepted untranslated strings from Task 13 Step 6.
7. A one-page summary of what changed, by module.

- [ ] **Step 6: On approval — finish the branch**

**Only after the product owner has approved:**

```bash
git log --oneline main..HEAD    # review every commit
git status --short              # clean
```
Then follow the project's phase-checkpoint workflow: report, and **merge only on the product owner's explicit approval**. **Never push.** No remote operation of any kind is part of this phase.

If approval is withheld on any item, do not merge: record the item, fix it in a new commit on this branch, re-run Step 1, re-shoot the affected images, and return to Step 5.

**Tests required:** the entire suite, run in full — no new tests.

**Browser visual checks required:** the twenty-eight-image final package.

**Explicit things NOT to change:** anything, except to fix a verification failure. This task is not the place for one more improvement.

**Completion gate:** the five commands green from a clean tree; the export diff empty and its tests green; all thirteen acceptance criteria PASS with evidence; the twenty-eight-image package delivered; the product owner's approval recorded. Then, and only then, the merge — never a push.

**Proposed commit boundary:**
1. `chore(phase7): verification fixes` — only if Step 1 or Step 3 found something; otherwise this task commits nothing.

---
## Phase 7 Acceptance Check

- [ ] Every page renders exactly one `h1`, and no heading level is skipped.
- [ ] Every input, select and textarea in the app has a visible `<label htmlFor>`.
- [ ] No raw enum reaches the DOM on any page, in either locale.
- [ ] Vietnamese is the default and English is fully supported, with locale-formatted numbers and dates everywhere, and identical key sets in both message trees.
- [ ] The theme persists across reloads and sign-out, and the first paint already matches — proved on the raw HTML, not the live DOM.
- [ ] The dashboard matches spec §6.1's grid at 1440 and its stacking order at 375, with no horizontally scrolling metrics.
- [ ] Transaction rows never collide or wrap a figure mid-number at 375; the amount column is a fixed 8.5 rem.
- [ ] Exactly eight destructive actions use `ConfirmDialog`; no `window.confirm` remains; the five harmless actions ask nothing.
- [ ] Every mutating form locks its fieldset with `disabled` + `aria-busy` while in flight, and a second submit is impossible.
- [ ] Every `useHydrated` gate and every `defaultValue` rule from Phases 5–6 is intact, and the hydration specs are green with every original test present.
- [ ] The Excel export is unchanged — no file under `lib/server/export/`, `app/api/reports/` or `prisma/` differs from `main`, and every export test is green.
- [ ] No horizontal page overflow at 375, 414, 768, 1024, 1280 or 1440 on any page.
- [ ] Tables become stacked rows below 768; dialogs become bottom sheets below 640.
- [ ] Every text pair measures ≥ 4.5:1 and every UI pair ≥ 3:1, in both themes, with the numbers recorded in `app/globals.css`.
- [ ] Every touch target is ≥ 44 px at mobile widths.
- [ ] Dialogs and sheets trap and restore focus, close on Escape and on an overlay click, and expose `role="dialog"` with a name.
- [ ] `prefers-reduced-motion` is respected.
- [ ] Every list, widget and filtered view has an `EmptyState` with filter-aware copy where a filter can hide something.
- [ ] Every app route has a `loading.tsx` skeleton in its real layout.
- [ ] All Phase 2–6 Vitest and Playwright suites are green.
- [ ] `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` and `$env:CI="1"; npx playwright test` are all green from a clean tree — and were green at the end of **every** task, not only at the end of the phase.
- [ ] The six visual checkpoints were each stopped at and approved, and the final twenty-eight-image package is approved by the product owner.
- [ ] Nothing was pushed.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-08-cashflow-phase7-frontend-ux-i18n-theme-a11y.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration. This plan is built for it: each task is independently testable, names its own files, and ends at a commit boundary.

**2. Inline Execution** — execute the tasks in this session using `superpowers:executing-plans`, batching between the six visual checkpoints.

**Which approach?**

Whichever is chosen, the six checkpoint steps are hard stops — at the end of **Task 3** (primitives + shell), **Task 4** (dashboard), **Task 6** (the four money modules), **Task 9** (the planning modules), **Task 12** (reports, settings, auth) and **Task 19** (final). The controller produces the named screenshots, hands them to the product owner, and does not start the next task until they are approved.

The plan has **twenty-four** tasks under nineteen numbers: 1a, 1b, 1c, 2a, 2b, 2c, 3, 4, 5a, 5b, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19. Each ends with `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run test`, `npm run build` **and `$env:CI="1"; npx playwright test`** green, and each carries its own commit — no task ends with a known-red suite, and every task that changes a label or a control also migrates the specs that assert it.

The one ordering coupling to respect: Task 2c's `validationMessageKey` and Task 1b's `FieldError` reference each other, so whichever runs second wires them together — both tasks say so, and each is green on its own either way (1b first renders the literal verbatim, which is also its fallback).
