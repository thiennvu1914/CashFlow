import os from 'os'
import path from 'path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { addMonthsUtcClamped } from '@/lib/datetime/add-months-clamped'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { DEBT_ERROR_MESSAGES, LOAN_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import { createAccountViaUi, digitsOnly, registerNewUser, todayInZone } from './helpers'

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
 *  written-off / closed history sections, and a row's own payment log. */
function detailsFor(page: Page, summary: string): Locator {
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

async function createGoalViaUi(
  page: Page,
  opts: { name: string; target: number; current?: number },
): Promise<void> {
  await page.goto('/goals')
  const nameInput = page.getByLabel('Goal name')
  await nameInput.fill(opts.name)
  await page.getByLabel('Target amount').fill(String(opts.target))
  if (opts.current !== undefined) {
    await page.getByLabel('Current amount').fill(String(opts.current))
  }
  await page.getByRole('button', { name: 'Add goal' }).click()
  await expect(nameInput).toHaveValue('')
}

async function createDebtViaUi(
  page: Page,
  opts: { direction: 'RECEIVABLE' | 'PAYABLE'; person: string; amount: number },
): Promise<void> {
  await page.goto('/debts')
  // Selected explicitly even for RECEIVABLE, which is already the form's
  // default: the two options are the only place the user states which way the
  // money goes (`direction` is absent from `updateDebtSchema` and can never be
  // corrected), so the wording is worth exercising in both directions.
  await page.getByLabel('Direction').selectOption(opts.direction)
  const personInput = page.getByLabel('Person', { exact: true })
  await personInput.fill(opts.person)
  await page.getByLabel('Original amount').fill(String(opts.amount))
  await page.getByRole('button', { name: 'Add debt' }).click()
  await expect(personInput).toHaveValue('')
}

async function createLoanViaUi(
  page: Page,
  opts: {
    lender: string
    principal: number
    interestRate: number
    termMonths: number
    scheduledPayment: number
  },
): Promise<void> {
  await page.goto('/loans')
  const lenderInput = page.getByLabel('Lender', { exact: true })
  await lenderInput.fill(opts.lender)
  await page.getByLabel('Principal', { exact: true }).fill(String(opts.principal))
  await page.getByLabel('Interest rate (%)').fill(String(opts.interestRate))
  await page.getByLabel('Start date').fill(TODAY)
  await page.getByLabel('Term (months)').fill(String(opts.termMonths))
  // MONTHLY is the *second* option, so the form carries an explicit
  // `defaultValue` for it; selecting it here exercises the same value the
  // server HTML claims (test 9 asserts that claim in the bytes).
  await page.getByLabel('Payment frequency').selectOption('MONTHLY')
  await page.getByLabel('Scheduled payment').fill(String(opts.scheduledPayment))
  // Left at its pre-filled default rather than typed: the loan's whole schedule
  // anchor comes from this field, and "today" is what the page seeded it with.
  await expect(page.getByLabel('Next due date')).toHaveValue(TODAY)
  await page.getByRole('button', { name: 'Add loan' }).click()
  await expect(lenderInput).toHaveValue('')
}

async function createReminderViaUi(
  page: Page,
  opts: {
    title: string
    type: 'EXPENSE' | 'INCOME'
    amount: number
    frequency: 'ONE_TIME' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
    dayOfMonth?: number
    startDate: string
  },
): Promise<void> {
  await page.goto('/reminders')
  const titleInput = page.getByLabel('Title')
  await titleInput.fill(opts.title)
  // `exact` on both selects: an accessible name matches as a substring by
  // default, and this page's tab strip is a `<nav aria-label="Reminder type">`
  // — which "Type" would otherwise also match.
  await page.getByLabel('Type', { exact: true }).selectOption(opts.type)
  await page.getByLabel('Expected amount').fill(String(opts.amount))
  // Before `dayOfMonth`, never after: the frequency's `onChange` clears both
  // recurrence anchors on every change (react-hook-form keeps the value of an
  // unmounted field), so a day typed first would be wiped by the switch.
  await page.getByLabel('Frequency', { exact: true }).selectOption(opts.frequency)
  if (opts.dayOfMonth !== undefined) {
    await page.getByLabel('Day of month').fill(String(opts.dayOfMonth))
  }
  await page.getByLabel('Start date').fill(opts.startDate)
  await page.getByRole('button', { name: 'Add reminder' }).click()
  await expect(titleInput).toHaveValue('')
}

/* ------------------------------------------------------------------------- *
 * Raw server-HTML helpers, for the hydration-gate test.
 *
 * The same technique as `e2e/transaction-form-hydration.spec.ts` — a
 * `page.request.get` with the context's session cookies, asserted on the bytes
 * the browser paints first, with no timing involved at all. Kept local (a
 * near-copy of that file's `selectMarkup`) rather than hoisted into
 * `e2e/helpers.ts`, because hoisting would mean editing an existing spec, which
 * this task does not do.
 * ------------------------------------------------------------------------- */

/**
 * The markup of one `<select>`, found by its `aria-label` — `<select>`s cannot
 * nest, so the first `</select>` after the opening tag closes it. Scoping is
 * what makes a `selected=""` assertion mean anything on a page with several
 * selects.
 */
function selectMarkup(html: string, ariaLabel: string): string {
  const labelIndex = html.indexOf(`aria-label="${ariaLabel}"`)
  if (labelIndex === -1) throw new Error(`No element labelled "${ariaLabel}" in the markup`)
  const start = html.lastIndexOf('<select', labelIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> labelled "${ariaLabel}"`)
  return html.slice(start, end + '</select>'.length)
}

/** The opening tag of one `<input>`, found by its `aria-label`. `<input>` is a
 *  void element, so the tag is all there is. */
function inputMarkup(html: string, ariaLabel: string): string {
  const labelIndex = html.indexOf(`aria-label="${ariaLabel}"`)
  if (labelIndex === -1) throw new Error(`No element labelled "${ariaLabel}" in the markup`)
  const start = html.lastIndexOf('<input', labelIndex)
  const end = html.indexOf('>', labelIndex)
  if (start === -1 || end === -1) throw new Error(`No <input> labelled "${ariaLabel}"`)
  return html.slice(start, end + 1)
}

/** Every `<fieldset …>` opening tag in the document, so "exactly one gated
 *  form" can be asserted as a count rather than as a substring. */
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
    const destinations = [
      {
        label: /^(Tiết kiệm|Savings)$/,
        url: /\/goals/,
        heading: 'Savings',
        empty: 'No savings goals yet — add one below.',
      },
      {
        label: /^(Công nợ|Debts)$/,
        url: /\/debts/,
        heading: 'Debts',
        empty: 'No debts yet — add one below.',
      },
      {
        label: /^(Khoản vay|Loans)$/,
        url: /\/loans/,
        heading: 'Loans',
        empty: 'No loans yet — add one below.',
      },
      {
        label: /^(Nhắc nhở|Reminders)$/,
        url: /\/reminders/,
        heading: 'Reminders',
        empty: 'No reminders yet — add one below.',
      },
    ]

    for (const destination of destinations) {
      await rail.getByRole('link', { name: destination.label }).click()
      await expect(page).toHaveURL(destination.url)
      await expect(page.getByRole('heading', { name: destination.heading, level: 1 })).toBeVisible()
      await expect(page.getByText(destination.empty, { exact: true })).toBeVisible()
    }

    // `/reminders` has a second empty state — the Due list's — whose wording
    // comes from the service's own lookahead constant.
    await expect(
      sectionFor(page, 'Due').getByText('Nothing due in the next 30 days.', { exact: true }),
    ).toBeVisible()
  })

  test('2. savings goal: create, progress to achieved, rename, archive', async ({ page }) => {
    await createGoalViaUi(page, {
      name: 'Emergency fund',
      target: 10_000_000,
      current: 2_500_000,
    })

    const row = namedRow(page, page, 'Emergency fund')
    await expect(row).toBeVisible()
    await expect(row.getByText('In progress', { exact: true })).toBeVisible()
    // The pair, in the goal's own currency and never converted. The unescaped
    // `.`s accept whatever thousands separator `formatMoney`'s locale uses.
    await expect(row.locator('span.tabular-nums').first()).toHaveText(
      /^2.500.000 \/ 10.000.000 VND$/,
    )
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    await expect(row.getByText('Remaining 7.500.000')).toBeVisible()

    // Update progress → the whole target, which is what flips the status.
    await row.getByRole('button', { name: 'Update progress' }).click()
    await page.getByLabel('New amount for Emergency fund').fill('10000000')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(row.getByText('Achieved', { exact: true })).toBeVisible()
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    // Edit → the definition, not the progress: two panes, two intents.
    await row.getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Edit name for Emergency fund').fill('Emergency fund 2')
    await page.getByRole('button', { name: 'Save' }).click()

    const renamed = namedRow(page, page, 'Emergency fund 2')
    await expect(renamed).toBeVisible()
    await expect(namedRow(page, page, 'Emergency fund')).toHaveCount(0)

    // Archive → confirmed, then the row moves into the read-only history.
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe(
        'Archive this goal? Its history stays visible under Archived goals.',
      )
      return dialog.accept()
    })
    await renamed.getByRole('button', { name: 'Archive' }).click()

    // The live list is empty again, so the page shows its own empty state.
    await expect(page.getByText('No savings goals yet — add one below.')).toBeVisible()

    const archived = detailsFor(page, 'Archived goals (1)')
    await expect(archived).toBeVisible()
    await openDetails(archived)
    const archivedRow = namedRow(page, archived, 'Emergency fund 2')
    await expect(archivedRow).toBeVisible()
    await expect(archivedRow.getByText('Archived', { exact: true })).toBeVisible()
    // An archived goal refuses every write, so it is offered no actions at all
    // — showing them would be a promise the service breaks.
    for (const action of ['Update progress', 'Edit', 'Archive']) {
      await expect(archivedRow.getByRole('button', { name: action, exact: true })).toHaveCount(0)
    }
  })

  test('3. receivable: partial payment, refused overpayment, settled', async ({ page }) => {
    await createDebtViaUi(page, { direction: 'RECEIVABLE', person: 'Minh', amount: 1_000_000 })

    const row = namedRow(page, page, 'Minh')
    await expect(row).toBeVisible()
    await expect(row.getByText('Owes you', { exact: true })).toBeVisible()
    await expect(row.getByText('Open', { exact: true })).toBeVisible()
    await expect(row.locator('span.tabular-nums').first()).toHaveText(
      /^1.000.000 of 1.000.000 VND$/,
    )

    // The per-currency subtotal strip — one row per currency, never a total.
    const subtotal = page.locator('li').filter({ hasText: 'Owed to you' })
    await expect(subtotal.locator('span.text-positive')).toHaveText(/^1.000.000$/)
    await expect(subtotal.locator('span.text-negative')).toHaveText(/^0$/)

    // 400.000 back → partly paid, and the history opens under the row.
    await row.getByRole('button', { name: 'Record payment' }).click()
    await page.getByLabel('Payment amount for Minh').fill('400000')
    await expect(page.getByLabel('Payment date for Minh')).toHaveValue(TODAY)
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(row.getByText('Partly paid', { exact: true })).toBeVisible()
    await expect(row.locator('span.tabular-nums').first()).toHaveText(/^600.000 of 1.000.000 VND$/)
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    await expect(row.getByText('Payments (1)', { exact: true })).toBeVisible()

    // 700.000 against 600.000 outstanding → refused inline, nothing recorded.
    await row.getByRole('button', { name: 'Record payment' }).click()
    const amount = page.getByLabel('Payment amount for Minh')
    await amount.fill('700000')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(row.getByText(DEBT_ERROR_MESSAGES.OVERPAYMENT)).toBeVisible()
    await expect(row.locator('span.tabular-nums').first()).toHaveText(/^600.000 of 1.000.000 VND$/)
    await expect(row.getByText('Payments (1)', { exact: true })).toBeVisible()

    // Exactly what is left, in the pane the refusal left open → settled.
    await amount.fill('600000')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(row.getByText('Paid', { exact: true })).toBeVisible()
    await expect(row.locator('span.tabular-nums').first()).toHaveText(/^0 of 1.000.000 VND$/)
    await expect(row.getByText('Payments (2)', { exact: true })).toBeVisible()
  })

  test('4. payable: written off, out of the subtotals, history kept', async ({ page }) => {
    await createDebtViaUi(page, { direction: 'PAYABLE', person: 'Landlord', amount: 2_000_000 })

    const row = namedRow(page, page, 'Landlord')
    await expect(row).toBeVisible()
    await expect(row.getByText('You owe', { exact: true })).toBeVisible()
    await expect(row.getByText('Open', { exact: true })).toBeVisible()

    const subtotal = page.locator('li').filter({ hasText: 'Owed to you' })
    // Minh is settled, so it contributes nothing: the strip's receivable side
    // is 0 and the payable side is the new debt.
    await expect(subtotal.locator('span.text-positive')).toHaveText(/^0$/)
    await expect(subtotal.locator('span.text-negative')).toHaveText(/^2.000.000$/)

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe(
        'Write off this debt? Payments already recorded stay in the history.',
      )
      return dialog.accept()
    })
    await row.getByRole('button', { name: 'Write off' }).click()

    const writtenOff = detailsFor(page, 'Written-off debts (1)')
    await expect(writtenOff).toBeVisible()
    await openDetails(writtenOff)
    const writtenOffRow = namedRow(page, writtenOff, 'Landlord')
    await expect(writtenOffRow).toBeVisible()
    await expect(writtenOffRow.getByText('Written off', { exact: true })).toBeVisible()
    // A written-off debt refuses every write, so it carries no actions.
    for (const action of ['Record payment', 'Edit', 'Write off']) {
      await expect(writtenOffRow.getByRole('button', { name: action, exact: true })).toHaveCount(0)
    }

    // Nothing is outstanding in any currency any more, so the strip is gone
    // entirely rather than left behind as a row of zeroes.
    await expect(page.getByText('Owed to you')).toHaveCount(0)
  })

  test('5. loan: instalment split, advanced schedule, refused overpayment, closed', async ({
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
    await expect(row.getByText('Active', { exact: true })).toBeVisible()
    await expect(row.locator('span.tabular-nums').first()).toHaveText(
      /^12.000.000 of 12.000.000 VND$/,
    )
    // Due today, so the schedule line is the "due soon" wording; the instalment
    // and cadence are on the same line.
    await expect(row).toContainText(`Due soon — ${TODAY}`)
    await expect(row).toContainText('Monthly')
    await expect(row).toContainText('12 months from ' + TODAY)
    for (const action of ['Record payment', 'Edit', 'Close loan']) {
      await expect(row.getByRole('button', { name: action, exact: true })).toBeVisible()
    }

    // The split: the user types the two parts and the total is derived — the
    // read-only field has to show it BEFORE the instalment is saved, because
    // that figure is the one the resolver then submits.
    await row.getByRole('button', { name: 'Record payment', exact: true }).click()
    const total = page.getByLabel('Total payment for Bank')
    await expect(total).toHaveValue('—')
    await page.getByLabel('Principal for Bank').fill('1000000')
    await page.getByLabel('Interest for Bank').fill('85000')
    await expect(total).toHaveValue(/^1.085.000 VND$/)
    await expect(page.getByLabel('Payment date for Bank')).toHaveValue(TODAY)
    await page.getByRole('button', { name: 'Save' }).click()

    // Principal came off the loan; interest is reported beside it and pays
    // nothing down; the schedule advanced exactly one calendar month.
    await expect(row.locator('span.tabular-nums').first()).toHaveText(
      /^11.000.000 of 12.000.000 VND$/,
    )
    await expect(row).toContainText(/85.000 VND paid so far/)
    await expect(row).toContainText(`Next due ${NEXT_DUE_AFTER_ONE_PAYMENT}`)
    await expect(row.getByText('Payments (1)', { exact: true })).toBeVisible()

    // One dong more principal than is outstanding → refused inline. Interest 0
    // is legitimate (a final sweep of the principal carries none), so the only
    // thing wrong with this instalment is the part the service checks.
    await row.getByRole('button', { name: 'Record payment', exact: true }).click()
    await page.getByLabel('Principal for Bank').fill('11000001')
    await page.getByLabel('Interest for Bank').fill('0')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(row.getByText(LOAN_ERROR_MESSAGES.OVERPAYMENT)).toBeVisible()
    await expect(row.locator('span.tabular-nums').first()).toHaveText(
      /^11.000.000 of 12.000.000 VND$/,
    )
    await expect(row.getByText('Payments (1)', { exact: true })).toBeVisible()

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe(
        'Close this loan? Its payment history stays visible under Closed loans.',
      )
      return dialog.accept()
    })
    // `exact` because the open payment pane's toggle now reads "Close", and an
    // accessible name matches as a substring by default.
    await row.getByRole('button', { name: 'Close loan', exact: true }).click()

    await expect(page.getByText('No loans yet — add one below.')).toBeVisible()

    const closed = detailsFor(page, 'Closed loans (1)')
    await expect(closed).toBeVisible()
    await openDetails(closed)
    const closedRow = namedRow(page, closed, 'Bank')
    await expect(closedRow).toBeVisible()
    await expect(closedRow.getByText('Closed', { exact: true })).toBeVisible()
    // The instalment really was paid, so closing the loan does not undo it.
    await expect(closedRow.getByText('Payments (1)', { exact: true })).toBeVisible()
    for (const action of ['Record payment', 'Edit', 'Close loan']) {
      await expect(closedRow.getByRole('button', { name: action, exact: true })).toHaveCount(0)
    }
  })

  test('6. reminders: due list, tabs, acknowledge, dismiss, pause', async ({ page }) => {
    await createReminderViaUi(page, {
      title: 'Internet',
      type: 'EXPENSE',
      amount: 300_000,
      frequency: 'ONE_TIME',
      startDate: TODAY,
    })

    const due = sectionFor(page, 'Due')
    const definitions = sectionFor(page, 'Your reminders')

    const internetDue = namedRow(page, due, 'Internet')
    await expect(internetDue).toBeVisible()
    await expect(internetDue).toContainText(`Today · ${TODAY}`)
    await expect(internetDue.getByText('Bill', { exact: true })).toBeVisible()

    await createReminderViaUi(page, {
      title: 'Salary',
      type: 'INCOME',
      amount: 20_000_000,
      frequency: 'MONTHLY',
      dayOfMonth: TODAY_DAY_OF_MONTH,
      startDate: TODAY,
    })

    const salaryDue = namedRow(page, due, 'Salary').first()
    await expect(salaryDue).toBeVisible()
    await expect(salaryDue).toContainText('Monthly')
    await expect(salaryDue.getByText('Income', { exact: true })).toBeVisible()

    // The tabs live in the URL, so a filtered page is bookmarkable — and they
    // filter the WHOLE page, both the due list and the definitions below it.
    await page.goto('/reminders?tab=bills')
    await expect(page.getByRole('link', { name: 'Bills' })).toHaveAttribute('aria-current', 'page')
    await expect(namedRow(page, due, 'Internet')).toBeVisible()
    await expect(namedRow(page, due, 'Salary')).toHaveCount(0)
    await expect(namedRow(page, definitions, 'Internet')).toBeVisible()
    await expect(namedRow(page, definitions, 'Salary')).toHaveCount(0)

    await page.goto('/reminders?tab=income')
    await expect(page.getByRole('link', { name: 'Income' })).toHaveAttribute('aria-current', 'page')
    await expect(namedRow(page, due, 'Salary').first()).toBeVisible()
    await expect(namedRow(page, due, 'Internet')).toHaveCount(0)
    await expect(namedRow(page, definitions, 'Salary')).toBeVisible()
    await expect(namedRow(page, definitions, 'Internet')).toHaveCount(0)

    // Back to the unfiltered page to answer both occurrences. Each button
    // names its row by title AND due date, because a monthly reminder can have
    // more than one unanswered occurrence on this page at once — which is
    // exactly the case here: `Salary` is anchored to today and the 30-day
    // lookahead can already have materialized next month's instance too.
    await page.goto('/reminders')
    await page.getByRole('button', { name: `Acknowledge Internet due ${TODAY}` }).click()
    await expect(namedRow(page, due, 'Internet')).toHaveCount(0)

    await page.getByRole('button', { name: `Dismiss Salary due ${TODAY}` }).click()
    await expect(page.getByRole('button', { name: `Dismiss Salary due ${TODAY}` })).toHaveCount(0)

    // Materialization is idempotent and only ever inserts, so an answered
    // occurrence never comes back — an `upsert` there would silently reset it.
    await page.reload()
    await expect(namedRow(page, due, 'Internet')).toHaveCount(0)
    await expect(page.getByRole('button', { name: `Dismiss Salary due ${TODAY}` })).toHaveCount(0)
    // Both definitions are still there: answering an occurrence is not a delete.
    await expect(namedRow(page, definitions, 'Internet')).toBeVisible()
    await expect(namedRow(page, definitions, 'Salary')).toBeVisible()

    // Pausing stops NEW occurrences and nothing else — the definition stays
    // listed, dimmed and labelled, because one the user cannot see is one they
    // cannot resume.
    await page.getByRole('button', { name: 'Pause Salary' }).click()
    const salaryDefinition = namedRow(page, definitions, 'Salary')
    await expect(salaryDefinition.getByText('Paused', { exact: true })).toBeVisible()
    await expect(salaryDefinition.getByRole('button', { name: 'Resume Salary' })).toBeVisible()
    await expect(
      namedRow(page, definitions, 'Internet').getByText('Active', { exact: true }),
    ).toBeVisible()
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
    await expect(rentRow).toContainText(`Tomorrow · ${TOMORROW}`)
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
    const pages = ['/goals', '/debts', '/loans', '/reminders'] as const
    const bodies = new Map<string, string>()
    for (const url of pages) {
      const response = await page.request.get(url)
      expect(response.status(), url).toBe(200)
      bodies.set(url, await response.text())
    }

    // 1. The gate itself, in the bytes the browser paints first: each page has
    //    exactly one form, nothing in it is operable, and assistive tech is
    //    told the group is busy. Asserted as a count rather than a substring so
    //    a second, ungated form could not hide behind a passing `toContain`.
    for (const url of pages) {
      const html = bodies.get(url)!
      const tags = fieldsetOpeningTags(html)
      expect(tags, url).toHaveLength(1)
      expect(tags[0], url).toMatch(/\sdisabled=""/)
      expect(tags[0], url).toMatch(/\saria-busy="true"/)
    }

    // 2. `/loans` — MONTHLY is the frequency select's SECOND option, so without
    //    the explicit `defaultValue` the server HTML would select WEEKLY (a
    //    `<select>`'s browser fallback) while `useForm` held MONTHLY, and a
    //    submission before hydration would file a monthly loan as weekly.
    const loans = bodies.get('/loans')!
    expect(selectMarkup(loans, 'Payment frequency')).toMatch(
      /<option[^>]*\svalue="MONTHLY"[^>]*\sselected=""/,
    )
    // The next due date is the schedule's anchor, so the server states it.
    expect(inputMarkup(loans, 'Next due date')).toContain(`value="${TODAY}"`)
    // And the start date is deliberately NOT pre-filled — asserted rather than
    // skipped, so a `defaultValue` added to the wrong input would be caught.
    expect(inputMarkup(loans, 'Start date')).not.toContain(`value="${TODAY}"`)

    // 3. `/reminders` — same second-vs-third-option hazard on frequency
    //    (MONTHLY is third here), and the start date IS pre-filled.
    const reminders = bodies.get('/reminders')!
    expect(selectMarkup(reminders, 'Frequency')).toMatch(
      /<option[^>]*\svalue="MONTHLY"[^>]*\sselected=""/,
    )
    expect(inputMarkup(reminders, 'Start date')).toContain(`value="${TODAY}"`)

    // 4. `/goals` and `/debts` have no date default at all (a target has no
    //    start day, and a debt's due date is optional), and their selects
    //    default to their own first option — so the marker must be on the value
    //    the form actually holds and on nothing else.
    expect(selectMarkup(bodies.get('/goals')!, 'Goal currency')).toMatch(
      /<option[^>]*\svalue="VND"[^>]*\sselected=""/,
    )
    expect(selectMarkup(bodies.get('/debts')!, 'Direction')).toMatch(
      /<option[^>]*\svalue="RECEIVABLE"[^>]*\sselected=""/,
    )
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
    // occurrences are tallied rather than dropped.
    const remindersRows = dataRows(sheetOf(fullWorkbook, 'Reminders'))
    expect(remindersRows).toHaveLength(3)
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
