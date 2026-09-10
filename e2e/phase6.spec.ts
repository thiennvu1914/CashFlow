import os from 'os'
import path from 'path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { addMonthsUtcClamped } from '@/lib/datetime/add-months-clamped'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { formatDate } from '@/lib/ui/format-date'
import enErrors from '@/messages/en/errors.json'
import viErrors from '@/messages/vi/errors.json'
import {
  createAccountViaUi,
  createDebtViaUi,
  createGoalViaUi,
  createLoanViaUi,
  createReminderViaUi,
  digitsOnly,
  eitherLocale,
  registerNewUser,
  todayInZone,
} from './helpers'

/**
 * Phase 6 Group 10: end-to-end coverage for the four planning modules
 * (`/goals`, `/debts`, `/loans`, `/reminders`), the three Dashboard sections
 * they feed, the Net Worth extension, mobile navigation, the create forms'
 * hydration gates and the six new export sheets.
 *
 * One user is registered via the UI once (in `beforeAll`) and its login session
 * is captured as Playwright `storageState`, reused by every test in this file
 * via `test.use` — the same pattern `phase4.spec.ts` and `phase5.spec.ts` use.
 * Tests run `serial`: a goal is created, progressed, edited and archived; a
 * debt is paid down and then over-paid; a loan is instalment-paid and closed —
 * so every later test depends on the exact state its predecessors left behind.
 *
 * The user's profile defaults (a fresh registration,
 * `lib/auth/user-defaults.ts`) are `baseCurrency: 'VND'` and
 * `timezone: 'Asia/Ho_Chi_Minh'`, and all four planning pages seed their date
 * fields from `todayCalendarDateInZone(timezone, …)` — so `TIMEZONE` below must
 * match, and every date this file computes is a calendar date in that zone and
 * never an instant.
 *
 * ## Determinism
 *
 * There is no retry helper, no `waitForTimeout` and no sleep anywhere below,
 * and `playwright.config.ts` runs with `retries: 0`. Two rules keep that
 * honest:
 *
 *  - **Money is asserted through an auto-retrying matcher wherever a value can
 *    still change.** `toHaveText(/^600.000 of 1.000.000 VND$/)` retries until
 *    the `router.refresh()` behind a row action has landed, and the unescaped
 *    `.` deliberately accepts any thousands separator — the separator belongs
 *    to `formatMoney`'s locale and is not what these tests are about. The two
 *    one-shot `textContent()` reads (the Dashboard's KPI and overview figures)
 *    are taken on a freshly `goto`-ed, server-rendered page, where there is no
 *    later mutation to race — the same reasoning `phase4.spec.ts` gives for its
 *    KPI reads — and `digitsOnly` is what compares them.
 *  - **Every `window.confirm` is answered explicitly**, with a `page.once`
 *    registered immediately before the click that raises it, so a stray
 *    handler can never accept a dialog a later test did not ask for.
 *
 * Both the Cash account's balance (5.000.000, never spent in this file) and
 * every debt/loan figure are round VND amounts, so the Net Worth arithmetic in
 * test 7 is exact rather than approximately right.
 *
 * ## Timeout
 *
 * `test.describe.configure({ timeout: … })` rather than the 30 s default: these
 * tests are the first thing in the suite to visit `/goals`, `/debts`, `/loans`
 * and `/reminders`, and `next dev` compiles each route (and each server action)
 * on demand the first time it is asked for. That is the server building code,
 * not the app being slow — and it is the same reason `registerNewUser` widens
 * its own first assertion.
 */

const TIMEZONE = 'Asia/Ho_Chi_Minh'

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase6-storage-state-${process.pid}.json`,
)

/**
 * The user's own calendar day, taken once for the whole file.
 *
 * Every page under test seeds its date inputs with the *server's* reading of
 * that same day, so a run that straddled midnight would compare two different
 * days — an inherent property of a serial suite that seeds "today", and the
 * same one `phase4.spec.ts` lives with.
 */
const TODAY = todayInZone(TIMEZONE)

/** Milliseconds in a day — exact on a UTC-midnight carrier, where no DST shift
 *  can shorten one (`lib/datetime/add-months-clamped.ts` gives the reasoning). */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Tomorrow, for the reminder the Dashboard's Upcoming widget has to list. */
const TOMORROW = formatCalendarDate(
  new Date(calendarDateToUtcCarrier(TODAY).getTime() + MS_PER_DAY),
)

/**
 * Where a MONTHLY loan due today lands after one accepted instalment.
 *
 * Computed with the app's own month arithmetic rather than by adding 30 days or
 * bumping the month number: `recordLoanPayment` advances the schedule with
 * `advanceByFrequency(nextDueDate, 'MONTHLY', dueDayOfMonth)`, which is
 * `addMonthsUtcClamped(carrier, 1, anchorDay)` — and the loan's `dueDayOfMonth`
 * is derived from this very carrier's own UTC day, so the default `anchorDay`
 * is the same one. A test run on 31 January therefore expects 28 February,
 * which is what the user is shown, instead of a "31 February" that rolls over
 * into March.
 */
const NEXT_DUE_AFTER_ONE_PAYMENT = formatCalendarDate(
  addMonthsUtcClamped(calendarDateToUtcCarrier(TODAY), 1),
)

/** The day of the month the MONTHLY income reminder is anchored to. */
const TODAY_DAY_OF_MONTH = Number(TODAY.slice(8, 10))

/** The OVERPAYMENT server error, in both locales — the InlineAlert renders
 *  `t(DEBT_ERROR_KEYS.OVERPAYMENT)`/`t(LOAN_ERROR_KEYS.OVERPAYMENT)`. The
 *  temporary English `DEBT_ERROR_MESSAGES`/`LOAN_ERROR_MESSAGES` aliases this
 *  spec used to import for its English half are gone (Task 13):
 *  `messages/en/errors.json` is the source of that text now, read directly.
 *  No `NEXT_LOCALE` cookie is ever set in this file, so every page renders in
 *  the app's default locale (vi) — `eitherLocale` is what lets these
 *  assertions hold in either locale without pinning which one is rendering. */
const DEBT_OVERPAYMENT_MESSAGE = eitherLocale(viErrors.debt.OVERPAYMENT, enErrors.debt.OVERPAYMENT)
const LOAN_OVERPAYMENT_MESSAGE = eitherLocale(viErrors.loan.OVERPAYMENT, enErrors.loan.OVERPAYMENT)

/**
 * A `yyyy-MM-dd` calendar-date carrier, formatted the way `formatDate(...,
 * 'date')` actually displays it on a row — in either locale, since no
 * `NEXT_LOCALE` cookie is ever set in this file. Never the raw carrier
 * string itself, which is only what an `<input type="date">`'s VALUE holds,
 * not what a row's rendered TEXT reads.
 */
function displayDate(carrier: string): RegExp {
  return eitherLocale(
    formatDate(carrier, { locale: 'vi', timeZone: TIMEZONE, style: 'date' }),
    formatDate(carrier, { locale: 'en', timeZone: TIMEZONE, style: 'date' }),
  )
}

/**
 * Spec §12's full workbook, complete as of Phase 6 — the exact list, in sheet
 * order, and the only place in the suite that asserts it whole. `phase5.spec.ts`
 * deliberately checks only its own sheet's position, so a Phase 7 sheet breaks
 * exactly one assertion and it is this one.
 */
const FULL_EXPORT_SHEETS = [
  'Summary',
  'Accounts',
  'Transactions',
  'Transfers',
  'Budgets',
  'Savings Goals',
  'Debts',
  'Debt Payments',
  'Loans',
  'Loan Payments',
  'Reminders',
]

/** The filtered workbook is historical end to end and stays two sheets. */
const FILTERED_EXPORT_SHEETS = ['Summary', 'Transactions']

/**
 * The `<li>` row a planning list renders for one record, found by the visible
 * name in its header line (a goal's name, a debt's person, a loan's lender, a
 * reminder's title).
 *
 * `root` is either the whole `page` or a `Locator` scoping to one section — the
 * Reminders page shows the same title in both its "Due" and "Your reminders"
 * lists, and the Dashboard shows it in a widget among many. `page` is passed
 * separately because the `has:` filter locator has to be built from the
 * top-level page, the same pattern `phase5.spec.ts` uses.
 *
 * `exact: true` is what keeps "Emergency fund" from matching "Emergency fund 2"
 * after test 2's rename.
 */
function namedRow(page: Page, root: Page | Locator, name: string): Locator {
  return root.locator('li').filter({ has: page.getByText(name, { exact: true }) })
}

/** The `<details>` whose `<summary>` reads exactly `summary` — the archived /
 *  written-off / closed history sections, and a row's own payment log.
 *  `summary` may be a `RegExp` (a vi/en alternation) for a section whose
 *  wording is now localised; `exact` is ignored by Playwright for a `RegExp`
 *  match, same as `sectionFor`'s `heading`. */
function detailsFor(page: Page, summary: string | RegExp): Locator {
  return page.locator('details').filter({ has: page.getByText(summary, { exact: true }) })
}

/** The `<section>` a Dashboard widget (or a Reminders page group) renders under
 *  `heading`. `exact` because "Due" is a substring of "Overdue", and accessible
 *  names match as substrings by default — ignored by Playwright when `heading`
 *  is a `RegExp` (a dashboard widget's translated title), which is why the
 *  three dashboard call sites below pass one instead of a literal string. */
function sectionFor(page: Page, heading: string | RegExp): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
}

/**
 * Opens a `<details>` and returns it. A closed `<details>`' summary is visible
 * but its content is not, so asserting that a row "moved under Archived goals"
 * means opening the section the user would open.
 *
 * `.first()` because these sections NEST: the closed-loans and written-off-debt
 * sections render full rows, and a row with a payment history carries a
 * `<details>` of its own — so `locator('summary')` inside the outer one matches
 * both. A `<summary>` is required to be its `<details>`' first child, so the
 * first match is always the one being opened.
 */
async function openDetails(details: Locator): Promise<Locator> {
  await details.locator('summary').first().click()
  return details
}

/* ------------------------------------------------------------------------- *
 * Create-form helpers.
 *
 * Local to this file rather than in `e2e/helpers.ts`: no other spec creates a
 * goal, a debt, a loan or a reminder, and a helper with one caller belongs
 * beside it. Each is used two or more times *within* this file, which is why
 * they are functions at all.
 *
 * Plain `fill`/`selectOption` with no verify-and-retry wrapper: every one of
 * these forms is inside a `<fieldset disabled>` until hydration finishes
 * (`useHydrated`, `lib/ui/use-hydrated.ts`), and Playwright's actionability
 * check treats a control in a disabled fieldset as disabled — so every action
 * below already waits for the earliest moment the app itself accepts input, and
 * nothing it accepts is ever thrown away afterwards. Each helper finishes on an
 * auto-retrying assertion that the form reset itself, which is the create
 * action's own confirmation that the row landed.
 * ------------------------------------------------------------------------- */

/**
 * Opens a row's `…` menu. `name` is the row's own visible label as it reads in
 * vi (a goal's name is the same in both locales, so `enName` defaults to the
 * same value) — `common.rowActions` interpolates whichever the page is
 * actually rendering into the trigger's accessible name.
 */
async function openRowMenu(page: Page, row: Locator, name: string, enName = name): Promise<void> {
  await row
    .getByRole('button', { name: eitherLocale(`Tác vụ cho ${name}`, `Actions for ${enName}`) })
    .click()
}

/**
 * The debt row's figure line (`debts.figureLine`), in either locale: vi reads
 * "còn {outstanding} / {original} VND", en reads "{outstanding} of {original}
 * VND" — two different templates for the same pair of figures, so a single
 * alternation on the whole line (rather than one word) is what proves the
 * right template rendered with the right numbers together.
 */
function debtFigureLine(outstanding: string, original: string): RegExp {
  return new RegExp(`^(còn )?${outstanding} (/|of) ${original} VND$`)
}

/**
 * The loan row's dominant figure: a muted caption (`loans.outstandingLabel`,
 * "Dư nợ gốc"/"Principal outstanding") above a `MoneyText` figure (fix round
 * 1, finding 6 — split apart specifically so the caption can wrap at narrow
 * widths instead of clipping, which `loans.outstandingLine`'s one
 * `whitespace-nowrap` sentence used to do). The caption and the figure are
 * SEPARATE elements with no text-node space between them in `.textContent()`
 * (same reasoning as `debtFigureLine`'s neighbours), so `\s*` stands in for
 * both "no space" and "a real space", and this still matches regardless of
 * which of `MoneyText`'s two breakpoint copies `.textContent()` picks up.
 */
function loanOutstandingLine(outstanding: string): RegExp {
  return new RegExp(`(Dư nợ gốc|Principal outstanding)\\s*${outstanding}\\s*VND`)
}

/**
 * The occurrence row's due line (`reminders.dueLine`, "{due} · {date}"), in
 * either locale — e.g. "Hôm nay · 09/09/2026" / "Today · Sep 9, 2026".
 * `dueWordVi`/`dueWordEn` are the fixed pair from `messages/{vi,en}/reminders.json`
 * (`dueToday`/`dueTomorrow`/`overdue`) — `dueInDays` is not needed by any case
 * in this file and is left to `e2e/phase7-reminders.spec.ts`.
 */
function occurrenceDueLine(dueWordVi: string, dueWordEn: string, dateCarrier: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const datePattern = displayDate(dateCarrier).source
  return new RegExp(`(${escape(dueWordVi)}|${escape(dueWordEn)}) · (${datePattern})`)
}

/* ------------------------------------------------------------------------- *
 * Raw server-HTML helpers, for the hydration-gate test.
 *
 * The same technique as `e2e/transaction-form-hydration.spec.ts` — a
 * `page.request.get` with the context's session cookies, asserted on the bytes
 * the browser paints first, with no timing involved at all.
 * ------------------------------------------------------------------------- */

/** Every `<fieldset …>` opening tag in the document — so "no operable form
 *  leaked into the initial HTML" can be asserted as a count (zero) rather than
 *  as a substring search. */
function fieldsetOpeningTags(html: string): string[] {
  return [...html.matchAll(/<fieldset[^>]*>/g)].map((match) => match[0])
}

/* ------------------------------------------------------------------------- *
 * Workbook helpers.
 * ------------------------------------------------------------------------- */

function sheetOf(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name)
  if (!sheet) throw new Error(`${name} sheet not found in the export`)
  return sheet
}

/**
 * A sheet's data rows as 0-indexed column arrays (`row.values` is 1-indexed
 * with a hole at 0, which every caller would otherwise have to remember).
 */
function dataRows(sheet: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = []
  sheet.eachRow((row, number) => {
    if (number === 1) return
    rows.push((row.values as unknown[]).slice(1))
  })
  return rows
}

/** The one data row whose `column` reads `value` — rows are matched by content,
 *  never by position, so a sheet's row ORDER is not silently under test here. */
function rowWhere(rows: unknown[][], column: number, value: string): unknown[] {
  const matches = rows.filter((row) => row[column] === value)
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one row with column ${column} = "${value}", got ${matches.length}`,
    )
  }
  return matches[0]
}

test.describe.serial('Phase 6 — planning modules', () => {
  test.use({ storageState: STORAGE_STATE_PATH })
  // See the module comment: `next dev` compiles four brand-new routes, and
  // every server action behind them, on first request.
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(async ({ browser }) => {
    // `storageState: undefined` overrides the file-level `test.use` above,
    // which at this point names a file this step is about to create — see the
    // identical reasoning in `phase4.spec.ts`'s `beforeAll`.
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase6' })
    // The only account, and it never receives a transaction in this file: its
    // balance stays exactly 5.000.000, which is what makes test 7's Net Worth
    // an exact figure rather than an approximation.
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('1. rail navigation to the four planning pages (desktop 1280x800)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    const rail = page.getByRole('navigation', { name: /^(Điều hướng chính|Primary)$/ })
    await expect(rail).toBeVisible()

    // The rail's own DOM order, so "after Budgets, in this order" is asserted
    // as a fact about the navigation rather than as four independent
    // visibility checks that would pass in any order. Note: the rail's links
    // now include the "Thêm giao dịch" action and the wordmark link, which are
    // outside the `<nav>` — so scoping `allTextContents()` to the `nav` (as
    // `rail` already does) still yields exactly the twelve destination labels,
    // and the icon-rail's `sr-only` span still carries the label text at 1280.
    const labels = await rail.getByRole('link').allTextContents()
    const budgetsIndex = labels.findIndex((label) => /^(Ngân sách|Budgets)$/.test(label))
    expect(budgetsIndex).toBeGreaterThanOrEqual(0)
    const nextFour = labels.slice(budgetsIndex + 1, budgetsIndex + 5)
    // Position, not just membership: each of the four must be the SPECIFIC
    // label at that index, not merely one of the four somewhere in the slice
    // — a `toEqual(slice.filter(...))` comparison would let a duplicate
    // through (e.g. two "Công nợ" and no "Tiết kiệm" would still pass a
    // membership check).
    expect(nextFour[0]).toMatch(/^(Tiết kiệm|Savings)$/)
    expect(nextFour[1]).toMatch(/^(Công nợ|Debts)$/)
    expect(nextFour[2]).toMatch(/^(Khoản vay|Loans)$/)
    expect(nextFour[3]).toMatch(/^(Nhắc nhở|Reminders)$/)

    // Each link lands on its own page, and each page states what it has:
    // Savings is `/goals`' h1 (the route and the label differ on purpose).
    const destinations: {
      label: RegExp
      url: RegExp
      heading: string | RegExp
      empty: string | RegExp
    }[] = [
      {
        label: /^(Tiết kiệm|Savings)$/,
        url: /\/goals/,
        heading: /Mục tiêu tiết kiệm|^Savings$/,
        empty: /Chưa có mục tiêu tiết kiệm|No savings goals yet/,
      },
      {
        label: /^(Công nợ|Debts)$/,
        url: /\/debts/,
        heading: /Công nợ|^Debts$/,
        empty: /Chưa có công nợ|No debts yet/,
      },
      {
        label: /^(Khoản vay|Loans)$/,
        url: /\/loans/,
        heading: /Khoản vay|^Loans$/,
        empty: /Chưa có khoản vay|No loans yet/,
      },
      {
        label: /^(Nhắc nhở|Reminders)$/,
        url: /\/reminders/,
        heading: /Nhắc nhở|^Reminders$/,
        // The page opens on "Sắp đến hạn"/"Due" (spec §6.7's default tab), so
        // this is the DUE empty message — the "Lịch nhắc"/"Schedule" tab's own
        // ("Chưa có nhắc nhở"/"No reminders yet") is no longer visible
        // simultaneously the way the old single-page layout showed both at
        // once, so there is no longer a second empty state to check here.
        empty: /Không có gì đến hạn trong 30 ngày tới|Nothing due in the next 30 days/,
      },
    ]

    for (const destination of destinations) {
      await rail.getByRole('link', { name: destination.label }).click()
      await expect(page).toHaveURL(destination.url)
      await expect(page.getByRole('heading', { name: destination.heading, level: 1 })).toBeVisible()
      await expect(page.getByText(destination.empty, { exact: true })).toBeVisible()
    }
  })

  test('2. savings goal: create, progress to achieved, rename, archive', async ({ page }) => {
    await createGoalViaUi(page, {
      name: 'Emergency fund',
      target: 10_000_000,
      current: 2_500_000,
    })

    const row = namedRow(page, page, 'Emergency fund')
    await expect(row).toBeVisible()
    await expect(row.getByText(/Đang thực hiện|In progress/, { exact: true })).toBeVisible()
    // The pair, in the goal's own currency and never converted, now with the
    // percent folded into the same figure line. The unescaped `.`s accept
    // whatever thousands separator `formatMoney`'s locale uses.
    await expect(row.locator('.tabular-nums').first()).toHaveText(
      /^2.500.000 \/ 10.000.000 VND · 25 %$/,
    )
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    // No deadline was set, so the meta line is the "still to go" figure.
    await expect(row).toContainText('7.500.000')

    // Update progress → the whole target, which is what flips the status.
    await row.getByRole('button', { name: /Cập nhật tiến độ|Update progress/ }).click()
    const progressDialog = page.getByRole('dialog')
    await progressDialog.getByLabel(/Số tiền hiện có|Current amount/).fill('10000000')
    await progressDialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()

    // "Đạt mục tiêu"/"Achieved" appears once — the status badge only; the meta
    // line is omitted entirely for an achieved goal (fix round 1, finding 10),
    // so this is a single-element match.
    await expect(row.getByText(/Đạt mục tiêu|^Achieved$/, { exact: true })).toBeVisible()
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    // Edit → the definition, not the progress: two panes, two intents.
    await openRowMenu(page, row, 'Emergency fund')
    await page.getByRole('menuitem', { name: /^Sửa$|^Edit$/ }).click()
    const editDialog = page.getByRole('dialog')
    await editDialog.getByLabel(/Tên mục tiêu|Goal name/).fill('Emergency fund 2')
    await editDialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()

    const renamed = namedRow(page, page, 'Emergency fund 2')
    await expect(renamed).toBeVisible()
    await expect(namedRow(page, page, 'Emergency fund')).toHaveCount(0)

    // Archive → confirmed through a ConfirmDialog, then the row moves into
    // the read-only history.
    await openRowMenu(page, renamed, 'Emergency fund 2')
    await page.getByRole('menuitem', { name: /^Lưu trữ$|^Archive$/ }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Lưu trữ$|^Archive$/ })
      .click()

    // The live list is empty again, so the page shows its own empty state.
    await expect(page.getByText(/Chưa có mục tiêu tiết kiệm|No savings goals yet/)).toBeVisible()

    const archived = detailsFor(page, /Mục tiêu đã lưu trữ \(1\)|Archived goals \(1\)/)
    await expect(archived).toBeVisible()
    await openDetails(archived)
    const archivedRow = namedRow(page, archived, 'Emergency fund 2')
    await expect(archivedRow).toBeVisible()
    await expect(archivedRow.getByText(/Đã lưu trữ|^Archived$/, { exact: true })).toBeVisible()
    // An archived goal refuses every write, so it is offered no actions at all
    // — showing them would be a promise the service breaks: no inline
    // "Cập nhật tiến độ" button and no `…` menu trigger.
    await expect(archivedRow.getByRole('button')).toHaveCount(0)
  })

  test('3. receivable: partial payment, refused overpayment, settled', async ({ page }) => {
    await createDebtViaUi(page, { direction: 'RECEIVABLE', person: 'Minh', amount: 1_000_000 })

    const row = namedRow(page, page, 'Minh')
    await expect(row).toBeVisible()
    await expect(
      row.getByText(eitherLocale('Họ nợ bạn', 'Owes you'), { exact: true }),
    ).toBeVisible()
    await expect(row.getByText(eitherLocale('Đang mở', 'Open'), { exact: true })).toBeVisible()
    await expect(row.locator('div.tabular-nums').first()).toHaveText(
      debtFigureLine('1.000.000', '1.000.000'),
    )

    // The per-currency subtotal strip — one row per currency, never a total,
    // now split across the two directional sections (spec §6.6): only the
    // relevant half is shown under each direction's SectionHeader.
    const receivableSubtotal = page
      .locator('li')
      .filter({ hasText: eitherLocale('Khoản phải thu', 'Owed to you') })
    await expect(receivableSubtotal).toContainText('1.000.000')

    // 400.000 back → partly paid, in the payment Dialog scoped by its title.
    const paymentAction = eitherLocale('Ghi nhận thanh toán', 'Record payment')
    await row.getByRole('button', { name: paymentAction }).click()
    const dialog = page.getByRole('dialog', { name: paymentAction })
    await dialog.getByLabel(/^Số tiền$|^Amount$/).fill('400000')
    await expect(dialog.getByLabel(/Ngày thanh toán|Payment date/)).toHaveValue(TODAY)
    await dialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(dialog).toBeHidden()

    await expect(
      row.getByText(eitherLocale('Trả một phần', 'Partly paid'), { exact: true }),
    ).toBeVisible()
    await expect(row.locator('div.tabular-nums').first()).toHaveText(
      debtFigureLine('600.000', '1.000.000'),
    )
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    await expect(
      row.getByText(eitherLocale('Lần thanh toán (1)', 'Payments (1)'), { exact: true }),
    ).toBeVisible()

    // 700.000 against 600.000 outstanding → the friendly OVERPAYMENT message,
    // not a raw server error, and nothing recorded.
    await row.getByRole('button', { name: paymentAction }).click()
    const amount = dialog.getByLabel(/^Số tiền$|^Amount$/)
    await amount.fill('700000')
    await dialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()

    await expect(dialog.getByText(DEBT_OVERPAYMENT_MESSAGE)).toBeVisible()
    await expect(row.locator('div.tabular-nums').first()).toHaveText(
      debtFigureLine('600.000', '1.000.000'),
    )
    await expect(
      row.getByText(eitherLocale('Lần thanh toán (1)', 'Payments (1)'), { exact: true }),
    ).toBeVisible()

    // Exactly what is left, in the dialog the refusal left open → settled.
    await amount.fill('600000')
    await dialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(dialog).toBeHidden()

    await expect(
      row.getByText(eitherLocale('Đã thanh toán', 'Paid'), { exact: true }),
    ).toBeVisible()
    await expect(row.locator('div.tabular-nums').first()).toHaveText(
      debtFigureLine('0', '1.000.000'),
    )
    // The payment history, inspectable through the row's own disclosure
    // without permanently expanding it.
    const historyToggle = row.getByText(eitherLocale('Lần thanh toán (2)', 'Payments (2)'), {
      exact: true,
    })
    await expect(historyToggle).toBeVisible()
    await historyToggle.click()
    await expect(row.getByText('400.000')).toBeVisible()
    await expect(row.getByText('600.000')).toBeVisible()
  })

  test('4. payable: written off via ConfirmDialog, out of the subtotals, history kept', async ({
    page,
  }) => {
    await createDebtViaUi(page, { direction: 'PAYABLE', person: 'Landlord', amount: 2_000_000 })

    const row = namedRow(page, page, 'Landlord')
    await expect(row).toBeVisible()
    await expect(row.getByText(eitherLocale('Bạn nợ họ', 'You owe'), { exact: true })).toBeVisible()
    await expect(row.getByText(eitherLocale('Đang mở', 'Open'), { exact: true })).toBeVisible()

    // Minh is settled, so its currency contributes nothing to the receivable
    // side any more — no subtotal row is shown there at all, never a zero.
    await expect(
      page.locator('li').filter({ hasText: eitherLocale('Khoản phải thu', 'Owed to you') }),
    ).toHaveCount(0)
    const payableSubtotal = page
      .locator('li')
      .filter({ hasText: eitherLocale('Khoản phải trả', 'You owe') })
    await expect(payableSubtotal).toContainText('2.000.000')

    // Write off: `…` menu item behind a `ConfirmDialog`, never a native
    // `window.confirm`. Cancel first, to prove it keeps the debt untouched.
    await openRowMenu(page, row, 'Landlord')
    await page.getByRole('menuitem', { name: eitherLocale('Xóa nợ', 'Write off') }).click()
    const confirmDialog = page.getByRole('dialog')
    await confirmDialog.getByRole('button', { name: eitherLocale('Hủy', 'Cancel') }).click()
    await expect(row.getByText(eitherLocale('Đang mở', 'Open'), { exact: true })).toBeVisible()

    await openRowMenu(page, row, 'Landlord')
    await page.getByRole('menuitem', { name: eitherLocale('Xóa nợ', 'Write off') }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: eitherLocale('Xóa nợ', 'Write off') })
      .click()

    const writtenOff = detailsFor(page, eitherLocale('Công nợ đã xóa (1)', 'Written-off debts (1)'))
    await expect(writtenOff).toBeVisible()
    await openDetails(writtenOff)
    const writtenOffRow = namedRow(page, writtenOff, 'Landlord')
    await expect(writtenOffRow).toBeVisible()
    await expect(
      writtenOffRow.getByText(eitherLocale('Đã xóa nợ', 'Written off'), { exact: true }),
    ).toBeVisible()
    // A written-off debt refuses every write, so it carries no actions at all.
    await expect(writtenOffRow.getByRole('button')).toHaveCount(0)

    // Nothing is outstanding in any currency any more, so both subtotal strips
    // are gone entirely rather than left behind as rows of zeroes.
    await expect(
      page.locator('li').filter({ hasText: eitherLocale('Khoản phải trả', 'You owe') }),
    ).toHaveCount(0)
  })

  test('5. loan: instalment dialog with a live Tổng, advanced schedule, refused overpayment, closed via ConfirmDialog', async ({
    page,
  }) => {
    await createLoanViaUi(page, {
      lender: 'Bank',
      principal: 12_000_000,
      interestRate: 8.5,
      termMonths: 12,
      scheduledPayment: 1_100_000,
    })

    const row = namedRow(page, page, 'Bank')
    await expect(row).toBeVisible()
    await expect(row.getByText(eitherLocale('Đang trả', 'Active'), { exact: true })).toBeVisible()
    await expect(row).toContainText(loanOutstandingLine('12.000.000'))
    // Due today, so the schedule line is the "due soon" wording; the instalment
    // and cadence are on the same line.
    await expect(row).toContainText(eitherLocale('Sắp đến hạn', 'Due soon'))
    await expect(row).toContainText(displayDate(TODAY))
    await expect(row).toContainText(eitherLocale('Hàng tháng', 'Monthly'))
    await expect(row).toContainText(/12 (tháng từ|months from)/)
    await expect(
      row.getByRole('button', {
        name: eitherLocale('Ghi nhận thanh toán', 'Record payment'),
        exact: true,
      }),
    ).toBeVisible()
    await openRowMenu(page, row, 'Bank')
    await expect(page.getByRole('menuitem', { name: eitherLocale('Sửa', 'Edit') })).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: eitherLocale('Đóng khoản vay', 'Close loan') }),
    ).toBeVisible()
    await page.keyboard.press('Escape')

    // The split: the user types the two parts and Tổng is derived — the
    // read-only field has to show it BEFORE the instalment is saved, because
    // that figure is the one the resolver then submits, and it must be a
    // FIGURE, never an em dash, at every point along the way.
    const paymentAction = eitherLocale('Ghi nhận thanh toán', 'Record payment')
    await row.getByRole('button', { name: paymentAction, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: paymentAction })
    const principal = dialog.getByLabel(/^Gốc$|^Principal$/)
    const interest = dialog.getByLabel(/^Lãi$|^Interest$/)
    const total = dialog.getByLabel(/^Tổng$|^Total$/)

    // Both parts blank: Tổng reads a computed zero, never "—".
    await expect(total).toHaveValue(/^0(,00)?\s?VND$/)
    await expect(total).not.toHaveValue('—')

    await principal.fill('1000000')
    await interest.fill('85000')
    await expect(total).toHaveValue(/1.085.000/)
    await expect(total).not.toHaveValue('—')

    // Clearing Gốc shows the interest alone rather than a dash — a blank part
    // counts as zero for DISPLAY only (`displayTotal`); the schema still
    // requires the real field before submitting.
    await principal.fill('')
    await expect(total).toHaveValue(/85.000/)
    await expect(total).not.toHaveValue('—')
    await principal.fill('1000000')

    await expect(dialog.getByLabel(/Ngày trả|Payment date/)).toHaveValue(TODAY)
    await dialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(dialog).toBeHidden()

    // Principal came off the loan; interest is reported beside it and pays
    // nothing down; the schedule advanced exactly one calendar month.
    await expect(row).toContainText(loanOutstandingLine('11.000.000'))
    await expect(row).toContainText(eitherLocale('đã trả lãi 85.000', '85.000 VND paid so far'))
    await expect(row).toContainText(displayDate(NEXT_DUE_AFTER_ONE_PAYMENT))
    await expect(
      row.getByText(eitherLocale('Lần trả (1)', 'Payments (1)'), { exact: true }),
    ).toBeVisible()

    // One dong more principal than is outstanding → the friendly OVERPAYMENT
    // message, not a raw server error. Interest 0 is legitimate (a final
    // sweep of the principal carries none), so the only thing wrong with this
    // instalment is the part the service checks.
    await row.getByRole('button', { name: paymentAction, exact: true }).click()
    await principal.fill('11000001')
    await interest.fill('0')
    await dialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()

    await expect(dialog.getByText(LOAN_OVERPAYMENT_MESSAGE)).toBeVisible()
    await expect(row).toContainText(loanOutstandingLine('11.000.000'))
    await expect(
      row.getByText(eitherLocale('Lần trả (1)', 'Payments (1)'), { exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: /^Hủy$|^Cancel$/ }).click()
    await expect(dialog).toBeHidden()

    // Close: `…` menu item behind a `ConfirmDialog`, never a native
    // `window.confirm`.
    await openRowMenu(page, row, 'Bank')
    await page.getByRole('menuitem', { name: eitherLocale('Đóng khoản vay', 'Close loan') }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: eitherLocale('Đóng khoản vay', 'Close loan') })
      .click()

    await expect(page.getByText(eitherLocale('Chưa có khoản vay', 'No loans yet'))).toBeVisible()

    const closed = detailsFor(page, eitherLocale('Khoản vay đã đóng (1)', 'Closed loans (1)'))
    await expect(closed).toBeVisible()
    await openDetails(closed)
    const closedRow = namedRow(page, closed, 'Bank')
    await expect(closedRow).toBeVisible()
    await expect(
      closedRow.getByText(eitherLocale('Đã đóng', 'Closed'), { exact: true }),
    ).toBeVisible()
    // The instalment really was paid, so closing the loan does not undo it.
    await expect(
      closedRow.getByText(eitherLocale('Lần trả (1)', 'Payments (1)'), { exact: true }),
    ).toBeVisible()
    await expect(closedRow.getByRole('button')).toHaveCount(0)
  })

  test('6. reminders: due list, tabs, acknowledge, dismiss, pause', async ({ page }) => {
    await createReminderViaUi(page, {
      title: 'Internet',
      type: 'EXPENSE',
      amount: 300_000,
      frequency: 'ONE_TIME',
      startDate: TODAY,
    })

    // Neither reminder created in this test is overdue, so both land in the
    // Upcoming group (spec §6.7's Overdue/Upcoming split) — `sectionFor(page,
    // 'Due')` no longer exists: the page has two TABS now (Sắp đến hạn / Lịch
    // nhắc), not a single "Due" section, so this is scoped to the Upcoming
    // group's own heading instead. The "Lịch nhắc" tab is a separate view with
    // no wrapping `<section>` of its own, so its rows are found directly on
    // `page`.
    const upcoming = sectionFor(page, eitherLocale('Sắp tới', 'Upcoming'))

    const internetDue = namedRow(page, upcoming, 'Internet')
    await expect(internetDue).toBeVisible()
    await expect(internetDue).toContainText(occurrenceDueLine('Hôm nay', 'Today', TODAY))
    await expect(
      internetDue.getByText(eitherLocale('Hóa đơn', 'Bill'), { exact: true }),
    ).toBeVisible()

    await createReminderViaUi(page, {
      title: 'Salary',
      type: 'INCOME',
      amount: 20_000_000,
      frequency: 'MONTHLY',
      dayOfMonth: TODAY_DAY_OF_MONTH,
      startDate: TODAY,
    })

    // Collapsed to ONE row (spec §6.7): a monthly reminder anchored to today
    // can already have next month's instance materialized inside the 30-day
    // lookahead, and `clusterByReminder` is what keeps that a single row
    // rather than two — `.first()` is defensive, not load-bearing here.
    const salaryDue = namedRow(page, upcoming, 'Salary').first()
    await expect(salaryDue).toBeVisible()
    await expect(salaryDue).toContainText(eitherLocale('Hàng tháng', 'Monthly'))
    await expect(
      salaryDue.getByText(eitherLocale('Thu nhập', 'Income'), { exact: true }),
    ).toBeVisible()

    // The tabs and the chip row both live in the URL, so a filtered page is
    // bookmarkable — and the chip is SECONDARY, filtering the due list only
    // (spec §6.7, fix round 1 finding 3): "Lịch nhắc" always lists every
    // definition and does not even render the chip row, so a `?type=` left
    // over from the due tab has no effect there.
    await page.goto('/reminders?view=due&type=bills')
    await expect(
      page.getByRole('link', { name: eitherLocale('Hóa đơn', 'Bills') }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(namedRow(page, upcoming, 'Internet')).toBeVisible()
    await expect(namedRow(page, upcoming, 'Salary')).toHaveCount(0)
    await page.goto('/reminders?view=schedule&type=bills')
    await expect(page.getByRole('link', { name: eitherLocale('Hóa đơn', 'Bills') })).toHaveCount(0)
    await expect(namedRow(page, page, 'Internet')).toBeVisible()
    await expect(namedRow(page, page, 'Salary')).toBeVisible()

    await page.goto('/reminders?view=due&type=income')
    await expect(
      page.getByRole('link', { name: eitherLocale('Thu nhập', 'Income') }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(namedRow(page, upcoming, 'Salary').first()).toBeVisible()
    await expect(namedRow(page, upcoming, 'Internet')).toHaveCount(0)
    await page.goto('/reminders?view=schedule&type=income')
    await expect(namedRow(page, page, 'Salary')).toBeVisible()
    await expect(namedRow(page, page, 'Internet')).toBeVisible()

    // Back to the unfiltered due tab to answer both occurrences. Each button
    // names its row by title AND due date, because a monthly reminder can have
    // more than one unanswered occurrence — but collapsing groups those under
    // one row, and the visible Acknowledge/Dismiss always act on the NEXT
    // (soonest) one, which is today's.
    await page.goto('/reminders?view=due&type=all')
    // The accessible name reads the row's own VISIBLE date (fix round 1,
    // finding 5 — `formatDate`, not the bare `yyyy-MM-dd` carrier), so the
    // regex matches the same locale-formatted pattern `displayDate` builds.
    const todayPattern = displayDate(TODAY).source
    const acknowledgeInternet = new RegExp(`(Ghi nhận|Acknowledge).*Internet.*${todayPattern}`)
    await page.getByRole('button', { name: acknowledgeInternet }).click()
    await expect(namedRow(page, upcoming, 'Internet')).toHaveCount(0)

    const dismissSalary = new RegExp(`(Bỏ qua|Dismiss).*Salary.*${todayPattern}`)
    await page.getByRole('button', { name: dismissSalary }).click()
    await expect(page.getByRole('button', { name: dismissSalary })).toHaveCount(0)

    // Materialization is idempotent and only ever inserts, so an answered
    // occurrence never comes back — an `upsert` there would silently reset it.
    await page.reload()
    await expect(namedRow(page, upcoming, 'Internet')).toHaveCount(0)
    await expect(page.getByRole('button', { name: dismissSalary })).toHaveCount(0)

    // Both definitions are still there: answering an occurrence is not a
    // delete. The "Lịch nhắc" tab is a separate view now, so it is visited
    // rather than found on the same page as the due list.
    await page.goto('/reminders?view=schedule&type=all')
    await expect(namedRow(page, page, 'Internet')).toBeVisible()
    await expect(namedRow(page, page, 'Salary')).toBeVisible()

    // Pausing stops NEW occurrences and nothing else — the definition stays
    // listed, dimmed and labelled, because one the user cannot see is one they
    // cannot resume.
    await page.getByRole('button', { name: new RegExp(`(Tạm dừng|Pause).*Salary`) }).click()
    const salaryDefinition = namedRow(page, page, 'Salary')
    await expect(
      salaryDefinition.getByText(eitherLocale('Tạm dừng', 'Paused'), { exact: true }),
    ).toBeVisible()
    await expect(
      salaryDefinition.getByRole('button', { name: new RegExp(`(Tiếp tục|Resume).*Salary`) }),
    ).toBeVisible()
    await expect(
      namedRow(page, page, 'Internet').getByText(eitherLocale('Đang hoạt động', 'Active'), {
        exact: true,
      }),
    ).toBeVisible()
  })

  test('a weekly reminder collapses to one row with a +n badge that expands', async ({ page }) => {
    // A WEEKLY reminder starting today materializes ~5 occurrences in the
    // 30-day window, so the list must show one row and a "+4 kỳ"/"+4 periods"
    // badge (spec §6.7's headline change).
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
    await expect(rows.first()).toContainText(/\+\d+ (kỳ|periods?)/)

    // The disclosure — a `<summary>` naming the reminder and the count — opens
    // to reveal every remaining occurrence, each with its own dated row.
    const summary = rows.first().locator('summary')
    await expect(summary).toContainText('Gym membership')
    const firstRestRow = rows.first().locator('details ul li').first()
    // Closed by default: present in the DOM but not visible, the same
    // "nothing hidden, just collapsed" contract every other `<details>` on
    // this page (goals/debts history) already keeps.
    await expect(firstRestRow).not.toBeVisible()
    await summary.click()
    await expect(firstRestRow).toBeVisible()
    await expect(rows.first().locator('details ul li')).not.toHaveCount(0)
  })

  test('7. dashboard: the three planning sections and Net Worth (desktop)', async ({ page }) => {
    // Test 2 archived the only goal, so the widget would legitimately be empty
    // — a second, live goal is what makes "the archived one is excluded" an
    // assertion about filtering rather than about emptiness.
    await createGoalViaUi(page, { name: 'Laptop', target: 30_000_000, current: 6_000_000 })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    // Widget order, read out of the DOM: the three planning sections sit after
    // Budget Progress and before Recent Transactions, which is last by design
    // (the ledger is what the user scrolls to in order to check the widgets
    // above it). `section h2` (a descendant selector), not `section > h2`:
    // `ChartContainer`'s `h2` now sits inside a nested `<div>`, not directly
    // under the `<section>`.
    const headings = await page.locator('section h2').allTextContents()
    const lastFive = headings.slice(-5)
    ;[
      /Tiến độ ngân sách|Budget Progress/,
      /Mục tiêu tiết kiệm|Savings Goals/,
      /Công nợ và khoản vay|Debt \/ Loan Overview/,
      /Nhắc nhở sắp tới|Upcoming Reminders/,
      /Giao dịch gần đây|Recent Transactions/,
    ].forEach((pattern, index) => expect(lastFive[index]).toMatch(pattern))

    const goalsWidget = sectionFor(page, /Mục tiêu tiết kiệm|Savings Goals/)
    await expect(namedRow(page, goalsWidget, 'Laptop')).toBeVisible()
    await expect(namedRow(page, goalsWidget, 'Emergency fund 2')).toHaveCount(0)

    const overview = sectionFor(page, /Công nợ và khoản vay|Debt \/ Loan Overview/)
    await expect(
      overview.getByText(/Đã tính trong tài sản ròng|Included in Net Worth/),
    ).toBeVisible()

    /**
     * One row of the overview's three-row `<dl>`, as digits.
     *
     * A one-shot read is safe here and below: the Dashboard is server-rendered
     * on a fresh `goto` and nothing on it mutates afterwards, so there is no
     * refresh to race — the same reasoning `phase4.spec.ts` gives for its own
     * KPI reads.
     */
    async function overviewValue(label: string | RegExp): Promise<string> {
      const pair = overview.locator('dl > div').filter({ has: page.getByText(label) })
      return digitsOnly((await pair.locator('dd span.tabular-nums').first().textContent()) ?? '')
    }

    /** One cell of the summary panel's `<dl>`, as digits. */
    async function kpiValue(label: string | RegExp): Promise<string> {
      const cell = page.locator('dl > div').filter({ has: page.getByText(label) })
      return digitsOnly((await cell.locator('dd span.tabular-nums').first().textContent()) ?? '')
    }

    // Everything the earlier tests created has left the position: Minh is
    // repaid in full, Landlord is written off, and the Bank loan is closed —
    // so all three aggregates are a real zero rather than a missing figure.
    expect(await overviewValue(/Khoản phải thu|Receivables/)).toBe('0')
    expect(await overviewValue(/Khoản phải trả|Payables/)).toBe('0')
    expect(await overviewValue(/Dư nợ gốc|Outstanding loans/)).toBe('0')
    // Accounts only, and nothing else moving it: Net Worth equals the balance.
    // "Total Balance", not "Total Account Balance" (spec §6.1): the KPI moved
    // from a flat five-card strip to the summary panel, where it sits directly
    // under Net Worth rather than beside it, and the shorter label is the
    // deliberate wording change Task 4's brief calls out.
    expect(await kpiValue(/Tổng số dư|Total Balance/)).toBe('5000000')
    expect(await kpiValue(/Tài sản ròng|Net Worth/)).toBe('5000000')

    // A fresh receivable and a fresh loan, created AFTER the settlements above
    // so the expected figures cannot depend on which of them the services
    // happen to still count.
    await createDebtViaUi(page, { direction: 'RECEIVABLE', person: 'Chi', amount: 500_000 })
    await createLoanViaUi(page, {
      lender: 'Credit union',
      principal: 3_000_000,
      interestRate: 0,
      termMonths: 6,
      scheduledPayment: 500_000,
    })
    // And a bill due tomorrow, for the Upcoming Reminders widget.
    await createReminderViaUi(page, {
      title: 'Rent',
      type: 'EXPENSE',
      amount: 4_000_000,
      frequency: 'ONE_TIME',
      startDate: TOMORROW,
    })

    await page.goto('/dashboard')

    expect(await overviewValue(/Khoản phải thu|Receivables/)).toBe('500000')
    expect(await overviewValue(/Khoản phải trả|Payables/)).toBe('0')
    expect(await overviewValue(/Dư nợ gốc|Outstanding loans/)).toBe('3000000')
    // 5.000.000 accounts + 500.000 receivable − 0 payable − 3.000.000 loan
    // principal. Interest is not part of it: it repays nothing.
    expect(await kpiValue(/Tổng số dư|Total Balance/)).toBe('5000000')
    expect(await kpiValue(/Tài sản ròng|Net Worth/)).toBe('2500000')

    const remindersWidget = sectionFor(page, /Nhắc nhở sắp tới|Upcoming Reminders/)
    const rentRow = namedRow(page, remindersWidget, 'Rent')
    await expect(rentRow).toBeVisible()
    await expect(rentRow).toContainText(occurrenceDueLine('Ngày mai', 'Tomorrow', TOMORROW))
  })

  test('8. mobile (375x812): tab bar unchanged, More menu, no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')

    // The four routes the bar shows are deliberately unchanged by Phase 6: a
    // phone bar with nine targets is a bar with no targets. Checked per-tab by
    // accessible name, rather than reading every `<a span>`'s text, because the
    // bar's fifth target, "Thêm giao dịch"/"Add transaction", is an icon with
    // an `aria-label` and no text at all.
    const bar = page.getByRole('navigation', { name: /^(Điều hướng nhanh|Primary \(compact\))$/ })
    await expect(bar).toBeVisible()
    for (const label of [
      /^(Tổng quan|Dashboard)$/,
      /^(Giao dịch|Transactions)$/,
      /^(Tài khoản|Accounts)$/,
      /^(Báo cáo|Reports)$/,
    ]) {
      await expect(bar.getByRole('link', { name: label })).toBeVisible()
    }
    await expect(
      bar.getByRole('link', { name: /^(Thêm giao dịch|Add transaction)$/ }),
    ).toBeVisible()

    await page.getByRole('button', { name: /^(Menu|More)$/ }).click()
    const morePanel = page.getByRole('dialog', { name: /^(Tất cả mục|All sections)$/ })

    for (const label of [
      /^(Tiết kiệm|Savings)$/,
      /^(Công nợ|Debts)$/,
      /^(Khoản vay|Loans)$/,
      /^(Nhắc nhở|Reminders)$/,
    ]) {
      await expect(morePanel.getByRole('link', { name: label })).toBeVisible()
    }

    // The two densest planning pages — a subtotal strip, a status badge, a
    // progress bar and a row of actions on one 375 px line — must not push the
    // document wider than the viewport.
    for (const url of ['/debts', '/loans']) {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(scrollWidth, url).toBeLessThanOrEqual(375)
    }
  })

  test('9. hydration gates and SSR defaults in the raw server HTML', async ({ page }) => {
    // Deterministic by construction: raw response bodies, no timing at all —
    // the same technique as `e2e/transaction-form-hydration.spec.ts`.
    //
    // `/goals`, `/debts` and `/loans` were dropped from this test in Task 7/8,
    // and `/reminders` joins them now (this task): all four create forms live
    // inside a `Sheet` opened from the header action, and a closed `Sheet`
    // renders no popup content at all in the initial HTML — so there is no
    // longer a gated `<fieldset>` (or a labelled `<select>` with a
    // server-rendered selection) to probe on any of the four raw pages.
    // `components/goals/goal-form.test.tsx`, `components/debts/debt-form.test.tsx`,
    // `components/loans/loan-form.test.tsx` and (this task)
    // `components/reminders/reminder-form.test.tsx` are what pin each form's
    // own server markup now, mounted directly via `renderToStaticMarkup`
    // rather than through a closed dialog — the same way `AccountForm`'s
    // equivalent Wave 2 form, also Sheet-gated, has never had a raw-HTML
    // check in this suite either.
    //
    // What is still worth asserting HERE, on the real rendered page rather
    // than a mounted component, is the other half of that same claim: that a
    // CLOSED `Sheet` truly emits nothing operable into the initial HTML at
    // all — not a `<fieldset>` a CSS class merely hides visually, which a
    // component-level test that only ever mounts an OPEN form would never
    // catch.
    const pages = ['/goals', '/debts', '/loans', '/reminders'] as const
    for (const url of pages) {
      const response = await page.request.get(url)
      expect(response.status(), url).toBe(200)
      const html = await response.text()
      expect(fieldsetOpeningTags(html), url).toHaveLength(0)
    }
  })

  test('10. full export: eleven sheets, planning history included; filtered unchanged', async ({
    page,
  }) => {
    const fullResp = await page.request.get('/api/reports/export?mode=full')
    expect(fullResp.status()).toBe(200)
    const fullBuffer = await fullResp.body()

    const fullWorkbook = new ExcelJS.Workbook()
    // Two different nested `@types/node` copies (Playwright's and exceljs's own)
    // each declare their own incompatible `Buffer` type, so even `Buffer` cast
    // to `Buffer` fails structurally — `any` is the only cast that actually
    // erases that mismatch; the value itself is a real Node `Buffer` either way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fullWorkbook.xlsx.load(fullBuffer as any)

    // The exact list, in order — this is the one assertion in the suite that
    // owns spec §12's workbook shape.
    expect(fullWorkbook.worksheets.map((sheet) => sheet.name)).toEqual(FULL_EXPORT_SHEETS)

    // Savings Goals — the archived goal is on the sheet with its status saying
    // so, beside the live one. History is never omitted.
    const goals = dataRows(sheetOf(fullWorkbook, 'Savings Goals'))
    expect(goals).toHaveLength(2)
    expect(rowWhere(goals, 0, 'Emergency fund 2')[7]).toBe('Archived')
    expect(rowWhere(goals, 0, 'Laptop')[7]).toBe('In progress')

    // Debts — the written-off row keeps its outstanding figure rather than
    // being zeroed: writing a debt off records a decision, it does not make the
    // money never have been owed.
    const debts = dataRows(sheetOf(fullWorkbook, 'Debts'))
    expect(debts).toHaveLength(3)
    const landlord = rowWhere(debts, 1, 'Landlord')
    expect(landlord[0]).toBe('Payable')
    expect(landlord[4]).toBe(2_000_000)
    expect(landlord[7]).toBe('Written off')
    expect(rowWhere(debts, 1, 'Minh')[7]).toBe('Paid')
    expect(rowWhere(debts, 1, 'Chi')[7]).toBe('Open')

    // Debt Payments — both of Minh's repayments, and nothing else (the refused
    // 700.000 was never written).
    const debtPayments = dataRows(sheetOf(fullWorkbook, 'Debt Payments'))
    expect(debtPayments).toHaveLength(2)
    expect(debtPayments.filter((row) => row[1] === 'Minh')).toHaveLength(2)
    expect(debtPayments.map((row) => row[3]).sort((a, b) => Number(a) - Number(b))).toEqual([
      400_000, 600_000,
    ])

    // Loans — the closed loan, with the principal it still shows outstanding.
    const loans = dataRows(sheetOf(fullWorkbook, 'Loans'))
    expect(loans).toHaveLength(2)
    const bank = rowWhere(loans, 0, 'Bank')
    expect(bank[12]).toBe('Closed')
    expect(bank[2]).toBe(1_000_000)
    expect(bank[3]).toBe(85_000)
    expect(bank[4]).toBe(11_000_000)
    expect(rowWhere(loans, 0, 'Credit union')[12]).toBe('Active')

    // Loan Payments — the one accepted instalment, split three ways.
    const loanPayments = dataRows(sheetOf(fullWorkbook, 'Loan Payments'))
    expect(loanPayments).toHaveLength(1)
    expect(loanPayments[0][1]).toBe('Bank')
    expect(loanPayments[0][2]).toBe(1_085_000)
    expect(loanPayments[0][3]).toBe(1_000_000)
    expect(loanPayments[0][4]).toBe(85_000)

    // Reminders — the paused definition is listed with Active "No" (words, not
    // TRUE/FALSE: "paused" is a state the user set), and its answered
    // occurrences are tallied rather than dropped. Four rows, not three: the
    // collapse test added earlier in this file (spec §6.7's headline change)
    // creates a fourth, "Gym membership".
    const remindersRows = dataRows(sheetOf(fullWorkbook, 'Reminders'))
    expect(remindersRows).toHaveLength(4)
    const salary = rowWhere(remindersRows, 0, 'Salary')
    expect(salary[1]).toBe('Income')
    expect(salary[4]).toBe('Monthly')
    expect(salary[6]).toBe('No')
    expect(salary[9]).toBe(1)
    const internet = rowWhere(remindersRows, 0, 'Internet')
    expect(internet[1]).toBe('Bill')
    expect(internet[6]).toBe('Yes')
    expect(internet[8]).toBe(1)
    expect(rowWhere(remindersRows, 0, 'Rent')[6]).toBe('Yes')
    // The collapsed weekly reminder is still one DEFINITION on this sheet
    // (the export has no notion of "collapse" at all — that is a UI-only
    // concept — it tallies every occurrence WEEKLY materialized, five of
    // them, none yet answered).
    const gym = rowWhere(remindersRows, 0, 'Gym membership')
    expect(gym[1]).toBe('Bill')
    expect(gym[4]).toBe('Every week')
    expect(gym[6]).toBe('Yes')
    expect(gym[7]).toBe(5) // Pending — none of its five occurrences answered

    // The filtered workbook is historical end to end and gains none of the six:
    // every one of them is denominated in its record's own currency, so there is
    // nothing in a date range to filter them by.
    const filteredResp = await page.request.get('/api/reports/export?mode=filtered&period=month')
    expect(filteredResp.status()).toBe(200)
    const filteredBuffer = await filteredResp.body()
    const filteredWorkbook = new ExcelJS.Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkbook.xlsx.load(filteredBuffer as any)

    expect(filteredWorkbook.worksheets.map((sheet) => sheet.name)).toEqual(FILTERED_EXPORT_SHEETS)
  })
})
