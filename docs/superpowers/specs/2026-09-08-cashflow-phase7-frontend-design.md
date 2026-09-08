# CashFlow Phase 7 — Frontend UX/UI, i18n, Theme & Accessibility Design

Status: approved direction (pre-flight 2026-09-08, amendments applied). Supersedes the frontend scope of the four-task Phase 7 plan (`docs/superpowers/plans/2026-09-04-cashflow-phase7-i18n-theme-a11y.md`), which stays as historical context only. Parent spec: `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§3 i18n/theme, §9 routes, §11 design system, §16 acceptance). Financial semantics, services, actions, validation rules, Prisma models, the Excel export contract and every Phase 2–6 invariant are out of scope and must not change.

## 1. Goals and non-goals

Goals: make CashFlow read as a Calm Premium Fintech product — trustworthy, calm, mature, precise, highly usable — on desktop and mobile, in Vietnamese (default) and English, in light and dark, and accessible. Fix the pre-flight P0/P1 findings. Preserve every hydration and financial guarantee.

Non-goals: new financial features; changing service/action/validation semantics; renaming Excel sheets or columns; custom date-picker; custom swipe gestures; animation systems; a generic component framework; Phase 8 demo/security work.

## 2. Design-system rules

Baseline tokens already exist in `app/globals.css` (oklch, spec §11). Phase 7 adds only: `--surface-2` (raised popover/sheet surface), `--border-strong` (18 %), `--focus` (ring), radius scale trimmed to `6 / 10 / 999`, and dark values for the same. No stock shadcn zinc values.

Typography (Manrope, weights 400/500/600 only):

| Role | Size/line | Weight | Use |
|---|---|---|---|
| Page title (`h1`) | 28/34 (mobile 24/30) | 600 | one per page |
| Section (`h2`) | 18/26 | 600 | page sections |
| Card title | 13/18 uppercase, tracking 0.04em | 600 | dashboard/report sections, muted |
| Body | 14/20 | 400 | default |
| Secondary/meta | 13/18 and 12/16 | 400 | muted-foreground |
| Money in rows | 15/20 | 600 | tabular |
| KPI value | 30/36 (mobile 26/32) | 600 | tabular |
| Dominant KPI (Net Worth) | 36/40 (mobile 30/36) | 600 | tabular |

Money: `tabular-nums` everywhere; VND no decimals, USD two; currency code 12/500 muted after the figure with 4 px gap; sign only in transaction/transfer rows (`+`/`−`); colour rule: income `positive`, expense and neutral figures `foreground`, negative totals `negative`; long KPI figures never wrap mid-digit; KPI panel may show full digits with the currency code on its own baseline, never truncate.

Spacing 4-pt scale: 4/8/12/16/24/32/48. Page padding 16 (mobile) / 24 (tablet) / 32 (desktop). Section gap 32, sibling gap 16, gap before a creation area 48. Max widths, centred in `main`: dashboard and reports 1200; list pages 960; single-column forms (settings, auth) 480.

Surfaces: background `--background` → surface `--surface` for cards (1 px `--border`, radius 10, no shadow) → `--surface-2` for popovers, sheets, dialogs (shadow `0 8px 24px rgba(25,33,30,.10)` light / `rgba(0,0,0,.40)` dark). Never a card inside a card: list rows inside a card use 1 px dividers.

Buttons: primary brand/white 40 px (compact 36), radius 6, one primary per view region, never full-width on ≥ 768; secondary outline; ghost for row actions; destructive is ghost `negative` in rows and solid `negative` only inside a confirmation dialog; icon buttons 36×36 with `aria-label`. Focus ring 2 px `--focus` (brand) with 2 px offset on every interactive element.

Inputs: height 40 (44 on mobile), border `--input`, radius 6; a visible `<label>` above every field (13/500); helper 12 muted; error 12 `negative` bound with `aria-describedby`; placeholder only as example text. Native `<select>` styled to match inputs is the default; a custom Select (shadcn/base-ui) only where option richness or hierarchy needs it (category picker with two groups, account picker with balance and currency). Native `<input type="date">`/`datetime-local` stay; their browser chrome is not restyled and its visual format is not claimed; displayed dates outside native controls are locale-formatted.

Status system: one `StatusBadge` with tones `neutral | positive | warning | negative | brand | muted`, 12/500, tint background 10 % (18 % dark), always text, never colour alone. Progress bars 6 px, track `muted`, fill by tone, label with percent when shown.

Icons: lucide only, 16 px in rows and nav, 20 px in headers, 24 px in empty states. Motion: none beyond 150 ms opacity/transform for sheets and dialogs; respect `prefers-reduced-motion`.

## 3. Theme

`User.theme` (`light | dark`) is the source of truth. A cookie `cashflow-theme` mirrors it and is written by `updateProfile` and on login; pre-auth pages read the cookie, falling back to `light`. The root layout renders `<html class="dark">` server-side from `resolveTheme()`, sets `color-scheme` accordingly and the `theme-color` meta, so the first paint is already the right theme and no client script flips it (no flash by construction). Changing the theme in Settings takes effect on the next server render; the profile form also toggles the `dark` class optimistically after a successful save so the change is immediate. Dark palette: background `#171C1A`, surface `#202724`, surface-2 `#29302D`, text 92 % warm white, muted 60 %, borders 14 % white, inputs on `#1C221F`; brand lifted to L≈0.60, negative L≈0.68, warning L≈0.74; charts use the dark chart tokens from `components/dashboard/chart-theme.ts`. Every screen is reviewed in dark; nothing is auto-inverted.

## 4. Internationalisation

Locale: `User.locale` (`vi | en`, default `vi`), mirrored to the existing `NEXT_LOCALE` cookie by `updateProfile`; `resolveLocale()` prefers the session user, then cookie, then `vi`. `next-intl` is already wired (`i18n/request.ts`); Phase 7 completes it:

- Messages split by domain: `messages/{vi,en}/common.json, nav.json, auth.json, dashboard.json, transactions.json, transfers.json, accounts.json, categories.json, budgets.json, goals.json, debts.json, loans.json, reminders.json, reports.json, settings.json, errors.json, labels.json`; `i18n/request.ts` merges them into one namespace tree. Keys are `module.element.variant`; no sentence concatenation; ICU plurals for counts.
- Server components use `getTranslations`, client components `useTranslations`. Copy that today lives in `lib/ui/action-error-messages.ts`, view-model label maps (`*_LABELS`, `recurrenceLabel`, `dueLabel`) and the `DashboardSection` captions moves behind translation keys. View models keep returning stable label *keys* or enum values; rendering components translate. Server-rendered pages pass already-translated strings to client components where the component cannot call `useTranslations` cheaply.
- Product labels: `lib/ui/labels.ts` exports one function per enum family (`transactionTypeLabelKey`, `debtStatusLabelKey`, `loanStatusLabelKey`, `goalStatusLabelKey`, `budgetStatusLabelKey`, `occurrenceStatusLabelKey`, `reminderTypeLabelKey`, `frequencyLabelKey`, `directionLabelKey`) that map every enum value to a key in `labels.json`; a unit test asserts every Prisma enum member has a key in both locales. No raw enum (`CASH_OUT`, `ADJUSTMENT_DECREASE`, `WRITTEN_OFF`, `PARTIALLY_PAID`, …) may reach the DOM; an e2e sweep greps rendered pages for `[A-Z]+_[A-Z]+` tokens.
- Locale-aware presentation: `formatMoney(value, currency, locale)` uses `Intl.NumberFormat` grouping for the active locale (vi `25.000.000`, en `25,000,000`); `formatDate(instantOrCarrier, { locale, timeZone, style: 'date' | 'dateTime' | 'monthYear' | 'weekday' })` in `lib/ui/format-date.ts` replaces ad-hoc `formatInTimeZone(…, 'yyyy-MM-dd')` in the UI (not in services or export); relative labels ("Hôm nay", "Còn 3 ngày") come from message keys with ICU arguments. Excel sheet names and column headers keep their existing English contract (spec §12) — not localised in Phase 7.
- Vietnamese glossary (binding): Tổng quan, Giao dịch, Chuyển tiền, Tài khoản, Danh mục, Ngân sách, Mục tiêu tiết kiệm, Công nợ, Khoản vay, Nhắc nhở, Báo cáo, Cài đặt, Tài sản ròng, Tổng số dư, Thu nhập tháng, Chi tiêu tháng, Thu nhập ròng, Khoản phải thu, Khoản phải trả, Dư nợ gốc, Kỳ tới, Trả góp, Gốc, Lãi, Đã thanh toán, Trả một phần, Quá hạn, Đã xóa nợ, Đã đóng, Đang thực hiện, Đạt mục tiêu, Đã lưu trữ, Sắp đến hạn, Hôm nay, Ngày mai, Chi tiêu, Thu nhập, Tiền vào (khác), Tiền ra (khác), Điều chỉnh tăng, Điều chỉnh giảm, Ghi nhận thanh toán, Xóa nợ, Đóng khoản vay, Tạm dừng, Tiếp tục, Xác nhận, Bỏ qua, Lưu trữ, Xóa, Hủy.
- Layout risk from longer Vietnamese: nav labels ≤ 12 characters; bottom tab labels 11 px with `text-ellipsis` forbidden — choose labels that fit ("Tổng quan", "Giao dịch", "Tài khoản", "Báo cáo", "Thêm"); badges wrap to a second line rather than truncate; KPI labels may take two lines at 768.

## 5. App shell and navigation

Desktop (≥ 1024): rail 240 px, surface, wordmark 16/600 brand, groups with 12/500 muted headers — Tổng quan (Dashboard), Tiền (Transactions, Transfers, Accounts, Categories), Kế hoạch (Budgets, Savings, Debts, Loans, Reminders), Báo cáo (Reports), Cài đặt (Settings); items 14, height 36, active `bg-muted text-brand` with a 2 px brand bar on the left; "Thêm giao dịch" primary button under the wordmark; Log out becomes a ghost item at the bottom of the rail with the user's name above it. Tablet (768–1023): rail collapses to 64 px icon rail with tooltips (`aria-label`s) — no bottom bar. Mobile (< 768): top bar with wordmark and page title; bottom tab bar of 5 slots (Tổng quan, Giao dịch, raised brand `+`, Tài khoản, Báo cáo), height 60 plus safe-area inset; "More" opens an accessible `Sheet` (bottom sheet) listing the remaining routes in a 2-column icon grid plus Settings and Log out; closes by button, Escape, overlay click or navigation; focus is trapped and returned. No swipe infrastructure.

Every page renders a `PageHeader` (`h1` + optional description + optional right-side actions) — including Transactions, Transfers, Accounts, Categories and Settings, which have none today.

## 6. Page hierarchy and module designs

Common list-page pattern: `PageHeader` → summary strip when the module has totals → primary list (rows with dividers inside one bordered surface) → inactive/archived items in a `<details>` with a muted summary → creation form. Creation form placement: desktop shows it in the page header as a primary button opening a `Sheet` (right side, 480 px) except Transactions, which keeps an always-visible form (see below); mobile always uses the sheet via the `+` or header action. Row actions live in a `…` menu (`RowActionsMenu`, accessible menu with keyboard support) except one primary inline action per row where frequency justifies it (Record payment, Update progress, Acknowledge).

### 6.1 Dashboard (highest priority)

Desktop (≥ 1280) 12-column grid, 24 px gutters, max 1200:

1. Header row: `h1` "Tổng quan", month + display currency; FX status line demoted to a 12 px muted line under the header ("1 USD = 25.969 VND · cập nhật 09:12"), tooltip for details.
2. Summary panel (one bordered surface, not five cards): left 4/12 "Tài sản ròng" dominant 36/600 with a 12 px note "gồm phải thu, phải trả và dư nợ gốc"; below it "Tổng số dư" 22/600. Right 8/12: three equal columns Thu nhập tháng / Chi tiêu tháng / Thu nhập ròng, 13 label + 24/600 value, separated by 1 px dividers. FX-unavailable state shows "—" and a hint in the affected cells only.
3. Row: Cash Flow Trend 8/12 (height 300) + Expense by Category 4/12 (height 300, horizontal bars, ≤ 8 categories, "Khác" bucket).
4. Row: Account Balance Over Time 8/12 (height 260, gaps rendered as gaps) + Income vs Expense 4/12 (height 260).
5. Row: Account Balance Distribution 4/12 + Budget Progress 4/12 + Savings Goals 4/12 (each ≤ 3 rows and a "Xem tất cả" link; height ≤ 240).
6. Row: Debt / Loan Overview 4/12 + Upcoming Reminders 8/12 (≤ 5 rows, overdue count line).
7. Row: Recent Transactions 12/12 as a compact scannable list (8 rows: date · category/type · account · amount right-aligned) with a link to Transactions.

Above the fold at 1440×900: header, summary panel and the top of Cash Flow Trend. Planning widgets are visually secondary (muted titles, smaller numbers). No chart forest: exactly the ten spec widgets, one visual language (`ChartContainer`), no nested cards.

Tablet (768–1023): summary panel keeps Net Worth 6/12 + Total Balance 6/12 on the first line and the three monthly metrics on the second line; charts 2 per row; planning 2 per row; Recent Transactions full width.

Mobile (< 768), no horizontal scrolling of metrics: summary panel = Net Worth full width, then a 2×2 grid Tổng số dư / Thu nhập ròng / Thu nhập tháng / Chi tiêu tháng, all visible. Stacking order: header → summary → Cash Flow Trend (height 220) → Recent Transactions (5 rows) → Budget Progress → Upcoming Reminders → Expense by Category → Savings Goals → Debt / Loan Overview → Income vs Expense → Account Balance Over Time → Account Balance Distribution. Every chart shrinks with its container; labels abbreviate ("25 Tr").

Empty dashboard: one `EmptyState` per widget with an icon and a single call to action; the balance-history widget shows the empty state, not a flat zero line.

### 6.2 Transactions

Page header with month total. Desktop ≥ 1280: two columns — list 7/12 and the create form 5/12 in a sticky bordered panel titled "Thêm giao dịch" (always visible: highest-frequency workflow); at 1024–1279 the form goes below the list; mobile opens it as a bottom sheet from the `+` tab or header button. Form composition in order: type as a segmented control with product labels (Chi tiêu · Thu nhập · Khác ▾ where "Khác" reveals Tiền vào / Tiền ra / Điều chỉnh tăng / Điều chỉnh giảm as radio options), Amount dominant (28/600 tabular input with the account's currency code inside the field), Account select (custom Select showing balance and currency), Category (custom Select grouped, hidden for the four non-categorised types, cleared deterministically on type change — existing behaviour kept), Date and Time (native inputs, separate, defaulting to now in the user's timezone), Note, primary button. Submit-in-flight: the whole fieldset is `disabled` + `aria-busy` while the action runs; on success the form resets and the list refreshes. History: rows grouped by day headers (Hôm nay, Hôm qua, then a locale date), each row = category or type label 14/500 · account 12 muted · note 12 muted (single line, ellipsis, full text in `title`) · amount 15/600 right-aligned in a fixed `min-w-[8.5rem]` column so it never collides or wraps · `…` menu with Delete (dialog). Mobile rows: two lines, amount on the first line right-aligned, note on the second.

### 6.3 Transfers

Form: "Từ" account and "Đến" account side by side with a `→` icon between (stacked on mobile with the arrow rotated); same currency → one amount field; cross-currency → "Số tiền gửi" with source currency, "Số tiền nhận" with destination currency, and a computed line "1 USD = 25.000 VND" (destination per source unit, formatted by `formatRate` in the more readable direction). History rows: "Cash → Bank" 14/500, amount(s) right-aligned, date meta, rate line on cross-currency rows in the same readable direction. Fewer than two active accounts: the form is replaced by an `EmptyState` "Cần ít nhất hai tài khoản đang hoạt động" with a button to Accounts.

### 6.4 Accounts and Categories

Accounts: header shows total in base currency (from position, "—" when FX unavailable). Rows: name 15/500, type · currency meta, balance 15/600 right; `…` menu: Edit, Archive (dialog). Archived accounts in `<details>` with muted rows. Creation via header button → Sheet. Categories: three sections Loại tài khoản / Danh mục chi / Danh mục thu with `SectionHeader`; default items as quiet chips (no border weight, muted); custom items as chips with a `…` menu (Rename, Archive with dialog); an inline "Thêm" input at the end of each section.

### 6.5 Budgets and Savings Goals

Shared planning row (`PlanningRow`): title + `StatusBadge`, one figure line "đã dùng / hạn mức" (or "hiện có / mục tiêu"), 6 px progress, meta line, actions. Budgets: figure line "3.720.000 / 20.000.000 VND · còn 16.280.000 · 19 %"; status tones Healthy → positive, Approaching → warning, Exceeded → negative; month navigation as a segmented control. Savings: "12.500.000 / 30.000.000 VND · 42 %", meta "Còn 114 ngày (31/12/2026)" or "Đạt mục tiêu"; no gamification; primary inline action "Cập nhật tiến độ" opens a small popover form; Edit/Archive in `…`.

### 6.6 Debts and Loans

Debts: two sections "Người khác nợ bạn" and "Bạn nợ người khác", each with a subtotal per currency; rows show person, status badge, "còn 1.500.000 / 2.000.000 VND", due meta; primary inline action "Ghi nhận thanh toán" opens a Dialog (amount, date, note) — not a right-aligned panel; Edit / Write off in `…` (write off → confirmation dialog). Loans: row shows lender + badge, dominant "Dư nợ gốc 117.000.000 VND", second line "Kỳ tới 08/10/2026 · 3.800.000 · Hàng tháng", third "Lãi 8,5 % · đã trả lãi 850.000"; instalment Dialog with three visible fields Gốc / Lãi / Tổng (Tổng read-only, computed live, shown as a figure not "—"); Edit / Close loan in `…` (dialog).

### 6.7 Reminders

Two top-level tabs (segmented): "Sắp đến hạn" (occurrences: Quá hạn group with count, then Sắp tới) and "Lịch nhắc" (definitions with Pause/Resume). Bills/Income filter as secondary chips inside the first tab. Repeated occurrences of one reminder inside the window collapse to one row "Gym membership · hàng tuần · tiếp theo 11/09 · +3 kỳ" with the next occurrence's Acknowledge/Dismiss; expanding shows the rest. Definition rows: title, type badge, amount, recurrence, "từ 08/09/2026", Active/Paused badge, Pause/Resume ghost button. Creation Sheet with labelled fields; the two optional selects are labelled "Danh mục (tùy chọn)" and "Tài khoản (tùy chọn)".

### 6.8 Reports

Header: title + range text; export as one secondary button "Xuất Excel ▾" (this range / all data). Period is a real segmented control (Ngày · Tuần · Tháng · Quý · Năm · Tùy chọn) with the active option visibly selected — "Tùy chọn" is selected when a custom range is applied and reveals the From/To inputs and Apply. Summary strip (3 KPI in one panel), By Category as horizontal bars with figures, By Account as a table (desktop) or stacked rows (mobile). Report content dominates; controls are compact.

### 6.9 Settings

Three cards: Hồ sơ (name), Tùy chọn (Tiền tệ hiển thị, Ngôn ngữ, Giao diện, Múi giờ — every control labelled; timezone as a native select of IANA zones grouped by region, with the current value first), Bảo mật (change password). Each card has its own Save; fields are `disabled` + `aria-busy` while saving; `useHydrated` gate preserved; success feedback inline (`InlineAlert` positive); locale/theme change re-renders the shell on the next navigation and applies the `dark` class immediately.

### 6.10 Authentication

Centered 400 px card on the app background: wordmark "CashFlow" + one-line tagline, `h1`, labelled fields, inline errors, primary button, secondary links; Register, Forgot and Reset share the layout; Reset shows a clear invalid-token state with a link to request a new one. No illustrations, no marketing panel. Theme from cookie.

## 7. Responsive behaviour

Acceptance widths 375, 414, 768, 1024, 1280, 1440. No horizontal page overflow anywhere. Financial rows use a fixed-width amount column; VND figures never wrap mid-number. Tables become stacked rows below 768. Dialogs become bottom sheets below 640. Charts shrink with their container and abbreviate axis labels. Page headers stack actions below the title on mobile. Filter controls become horizontally scrollable chip rows only for secondary filters (never for core metrics).

## 8. Accessibility

Every input has a visible `<label htmlFor>`; every icon-only control has `aria-label`; one `h1` per page and a logical heading order; focus visible on all interactive elements; Dialog and Sheet trap and restore focus, close on Escape and overlay click, expose `role="dialog"` and `aria-labelledby`; menus are keyboard operable; status never colour-only; contrast ≥ 4.5:1 for text and ≥ 3:1 for UI in both themes (checked with the tokens, documented in the plan); touch targets ≥ 44 px on mobile; validation errors linked via `aria-describedby` and announced with `role="alert"` on the form summary; in-flight forms set `aria-busy`; `prefers-reduced-motion` respected.

## 9. Forms, hydration and submit-in-flight

`useHydrated()` gate stays on every server-rendered form with defaults (Phases 5–6 invariant): the `<fieldset disabled>` until hydration, `defaultValue` on non-first-option selects, no controlled state introduced merely to silence the Base UI warning. New rule: while a mutation is pending, the same fieldset is `disabled` and `aria-busy="true"` and the submit button shows a pending label; the form re-enables on success or failure. A `useSubmitState` helper standardises this. Edit/instalment/payment forms open in Dialog or Sheet and mount on open (no SSR defaults problem). Existing Playwright hydration specs must stay green; new specs assert the in-flight lock prevents a second submission and that early input is never reverted.

## 10. Loading, error, empty and confirmation states

Loading: route-level `loading.tsx` skeletons for dashboard and list pages (grey bars in the real layout, no spinners); buttons show pending text. Errors: `InlineAlert` (tone negative) with product copy from `errors.json`; the existing error-code mapping stays, now translated; unexpected errors show the route error boundary with a retry button. Empty: `EmptyState` (icon, title, one sentence, one action) on every list, widget and filtered view; filter-aware copy as on Reminders. Confirmations: `ConfirmDialog` replaces `window.confirm` for archive account, archive category, delete budget, archive goal, write off debt, close loan, delete transaction, delete transfer; harmless actions (acknowledge, dismiss, pause, resume, update progress) get no dialog.

## 11. Visual QA

Intermediate visual checkpoints (screenshots reviewed by a human) after: primitives + shell; Dashboard; Transactions/Transfers/Accounts/Categories; planning modules; Reports/Settings/Auth; final dark/mobile/i18n pass. Final package: desktop light (Dashboard, Transactions, Accounts, Budgets, Debts, Loans, Reminders, Reports, Settings, Login), desktop dark (Dashboard, Transactions, Settings), mobile light 375 (Dashboard, Transactions, Budgets, Debts, Loans, More sheet), mobile dark (Dashboard), Vietnamese and English (Dashboard, Transactions, Settings). Screenshots are produced by a scratch Playwright driver against a seeded user and stored outside the repo.

## 12. Testing strategy

Vitest: `formatMoney`/`formatDate`/`formatRate` per locale; `labels.ts` exhaustiveness for every enum in both message files; message-file key parity vi/en; view-model changes; `StatusBadge`/`MoneyText`/`EmptyState` static render; `useSubmitState`. Playwright: locale switch vi↔en (nav labels, dashboard, settings), theme persistence (cookie + `html.dark` on first paint, no flash), hydration gates on the redesigned forms, submit-in-flight double-submit prevention, transaction type/category behaviour with product labels, mobile navigation (tabs, More sheet, focus), no horizontal overflow at 375/414/768/1024/1280/1440, confirmation dialogs for the eight destructive actions, labels/accessible names on forms, dark-mode representative screens, raw-enum sweep. No retry helpers.

## 13. Acceptance criteria (phase)

Every page has one `h1`; every field has a visible label; no raw enum in the DOM; vi default and en fully supported with locale-formatted numbers and dates; theme persists and first paint matches; dashboard hierarchy per §6.1 at 1440 and 375; transaction rows never collide at 375; eight destructive actions use `ConfirmDialog`; in-flight forms locked; Excel export unchanged (all Phase 6 export tests green); all Phase 2–6 Vitest and Playwright suites green; `npm run lint`, `format:check`, `tsc`, `build` green; visual package approved by the product owner.

## 14. Open decisions (defaults chosen; owner may override)

1. English number grouping follows the `en` locale (`25,000,000`) rather than keeping Vietnamese grouping — default: follow locale.
2. Desktop Transactions keeps an always-visible create form (5/12 sticky column) instead of a sheet — default: always visible.
3. KPI figures show full digits, not compact "95,6 Tr" — default: full digits (compact only on chart axes).
4. Log out moves to the bottom of the rail as a ghost item with the user's name — default: yes.
