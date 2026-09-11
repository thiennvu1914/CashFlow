import { test, expect, type Locator, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import enErrors from '@/messages/en/errors.json'
import viErrors from '@/messages/vi/errors.json'
import {
  authenticatedSession,
  createAccountViaUi,
  createBudgetViaUi,
  createTransactionViaUi,
  digitsOnly,
  eitherLocale,
} from './helpers'

/**
 * Phase 5 Task 5: end-to-end coverage for the Budgets page, its progress
 * thresholds, the Dashboard's Budget Progress widget, mobile navigation and
 * the Budgets export sheet.
 *
 * One user is registered via the UI once (in `beforeAll`) and its login
 * session is captured as Playwright `storageState`, reused by every test in
 * this file via `test.use` — the same pattern `phase4.spec.ts` uses. Tests
 * run `serial`: budgets are created, then pushed through every threshold band
 * with real transactions, then edited and deleted, so later tests depend on
 * the exact running totals earlier tests left behind.
 *
 * The user's profile defaults (a fresh registration, `lib/auth/user-defaults.ts`)
 * are `baseCurrency: 'VND'` and `timezone: 'Asia/Ho_Chi_Minh'`, and the
 * transaction form pre-fills "now" in that zone — so every seeded transaction
 * lands in the current local month, the same month `/budgets` and the
 * Dashboard show by default with no `?month=` at all.
 *
 * No `NEXT_LOCALE` cookie is ever set, so every page renders in the app's
 * default locale (vi) — `eitherLocale` is what lets this file's assertions
 * hold in either locale without pinning which one is rendering.
 */

const SESSION = authenticatedSession('phase5')

/** The localised scope label for an OVERALL budget, in both locales — never
 *  the literal word "Overall", which Task 7 replaced everywhere in the UI. */
const OVERALL_VI = 'Tổng thể'
const OVERALL_EN = 'Overall'
const OVERALL = eitherLocale(OVERALL_VI, OVERALL_EN)

/** The DUPLICATE_BUDGET server error, in both locales — the InlineAlert
 *  renders `t(BUDGET_ERROR_KEYS.DUPLICATE_BUDGET)`, and the temporary English
 *  `BUDGET_ERROR_MESSAGES` alias this spec used to import for its English
 *  half is gone (Task 13): `messages/en/errors.json` is the source of that
 *  text now, read directly. */
const DUPLICATE_BUDGET_MESSAGE = eitherLocale(
  viErrors.budget.DUPLICATE_BUDGET,
  enErrors.budget.DUPLICATE_BUDGET,
)

/**
 * The `<li>` row `BudgetProgressList` renders for one budget, found by its
 * visible label ("Overall"/"Tổng thể", or a category name). `root` is either
 * the whole `page` (the Budgets page has only one such list) or a `Locator`
 * scoping to one section (the Dashboard, whose "Budget Progress" widget is one
 * of many sections on the page) — `page` is passed separately because the
 * `has:` filter locator must be built from the top-level page, the same
 * pattern `phase4.spec.ts` uses for its "Recent Transactions" section.
 *
 * `label` may be a `RegExp` (the OVERALL alternation) or an exact string (a
 * category name, unaffected by locale).
 */
function budgetRow(page: Page, root: Page | Locator, label: string | RegExp): Locator {
  const text =
    typeof label === 'string' ? page.getByText(label, { exact: true }) : page.getByText(label)
  return root.locator('li').filter({ has: text })
}

/** The row's figure line — a `<div>` now (`PlanningRow`), not the old
 *  hand-rolled `<span>`, but still the one `.tabular-nums` element on the row. */
function figureLine(row: Locator): Locator {
  return row.locator('.tabular-nums').first()
}

/**
 * Opens a row's `…` menu. `name` is the row's own visible label as it reads
 * in vi (a category name is identical in both locales, so `enName` defaults
 * to the same value; the OVERALL row's label is not, so its two callers pass
 * both explicitly) — `common.rowActions` interpolates whichever the page is
 * actually rendering into the trigger's accessible name.
 */
async function openRowMenu(page: Page, row: Locator, name: string, enName = name): Promise<void> {
  await row
    .getByRole('button', { name: eitherLocale(`Tác vụ cho ${name}`, `Actions for ${enName}`) })
    .click()
}

test.describe.serial('Phase 5 — budgets', () => {
  test.use({ storageState: SESSION.path })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    await SESSION.bootstrap(browser, async (page) => {
      await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    })
  })

  test('navigation & empty state (desktop 1280x800)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    const rail = page.getByRole('navigation', { name: /^(Điều hướng chính|Primary)$/ })
    await expect(rail.getByRole('link', { name: /^(Ngân sách|Budgets)$/ })).toBeVisible()
    await rail.getByRole('link', { name: /^(Ngân sách|Budgets)$/ }).click()

    await expect(page).toHaveURL(/\/budgets/)
    await expect(page.getByRole('heading', { name: /Ngân sách|^Budgets$/, level: 1 })).toBeVisible()
    await expect(page.getByText(/Chưa có ngân sách cho|No budgets for/)).toBeVisible()

    // Creation is behind the header action's sheet, not an inline "Add
    // budget" section any more.
    await page.getByRole('button', { name: /Thêm ngân sách|Add budget/ }).click()
    await expect(page.getByRole('dialog', { name: /Thêm ngân sách|Add budget/ })).toBeVisible()
  })

  test('create overall budget', async ({ page }) => {
    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 1_000_000, currency: 'VND' })

    const row = budgetRow(page, page, OVERALL)
    await expect(row).toBeVisible()
    await expect(row.getByText(/Trong hạn mức|^Healthy$/, { exact: true })).toBeVisible()

    const spentText = (await figureLine(row).textContent()) ?? ''
    const digits = digitsOnly(spentText)
    expect(digits).toContain('0')
    expect(digits).toContain('1000000')

    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  test('duplicate overall rejected', async ({ page }) => {
    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 500_000, currency: 'VND' })

    await expect(page.getByText(DUPLICATE_BUDGET_MESSAGE)).toBeVisible()
    await expect(budgetRow(page, page, OVERALL)).toHaveCount(1)
  })

  test('create category budget', async ({ page }) => {
    await createBudgetViaUi(page, {
      scope: 'CATEGORY',
      categoryName: 'Food & Dining',
      amount: 200_000,
      currency: 'VND',
    })

    await expect(budgetRow(page, page, 'Food & Dining')).toBeVisible()
  })

  test('duplicate category rejected', async ({ page }) => {
    await createBudgetViaUi(page, {
      scope: 'CATEGORY',
      categoryName: 'Food & Dining',
      amount: 300_000,
      currency: 'VND',
    })

    await expect(page.getByText(DUPLICATE_BUDGET_MESSAGE)).toBeVisible()
    await expect(budgetRow(page, page, 'Food & Dining')).toHaveCount(1)
  })

  test('progress after expenses + threshold states', async ({ page }) => {
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 100_000,
    })
    await page.goto('/budgets')
    await expect(
      budgetRow(page, page, 'Food & Dining').getByText(/Đã dùng hơn nửa|Over half used/, {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      budgetRow(page, page, OVERALL).getByText(/Trong hạn mức|^Healthy$/, { exact: true }),
    ).toBeVisible()

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 60_000,
    })
    await page.goto('/budgets')
    await expect(
      budgetRow(page, page, 'Food & Dining').getByText(/Sắp vượt hạn mức|Approaching limit/, {
        exact: true,
      }),
    ).toBeVisible()

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 40_000,
    })
    await page.goto('/budgets')
    const foodRow = budgetRow(page, page, 'Food & Dining')
    await expect(foodRow.getByText(/Đã đến hạn mức|At limit/, { exact: true })).toBeVisible()
    await expect(foodRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 1,
    })
    await page.goto('/budgets')
    await expect(foodRow.getByText(/Vượt hạn mức|^Exceeded$/, { exact: true })).toBeVisible()
    // The figure line now says "vượt {over}" / "{over} over" rather than a
    // separate "Over by" paragraph — asserting the row carries both figures is
    // what the old assertion actually meant.
    await expect(foodRow).toContainText('200.001')
    await expect(foodRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    // Overall stays Healthy: 200,001 / 1,000,000 ≈ 20 %, still below the 50 %
    // "Over half used" band.
    await expect(
      budgetRow(page, page, OVERALL).getByText(/Trong hạn mức|^Healthy$/, { exact: true }),
    ).toBeVisible()

    // Income never counts toward spend — neither budget's figures should move.
    await createTransactionViaUi(page, {
      type: 'INCOME',
      accountName: 'Cash',
      categoryName: 'Salary',
      amount: 999_999,
    })
    await page.goto('/budgets')
    await expect(foodRow.getByText(/Vượt hạn mức|^Exceeded$/, { exact: true })).toBeVisible()
    await expect(
      budgetRow(page, page, OVERALL).getByText(/Trong hạn mức|^Healthy$/, { exact: true }),
    ).toBeVisible()
  })

  test('edit', async ({ page }) => {
    await page.goto('/budgets')
    const overallRow = budgetRow(page, page, OVERALL)
    await openRowMenu(page, overallRow, OVERALL_VI, OVERALL_EN)
    await page.getByRole('menuitem', { name: /^Sửa$|^Edit$/ }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/Hạn mức|Budget amount/).fill('300000')
    await dialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()

    // The badge only flips from "Healthy" to "Over half used" once the new
    // amount (300,000) has actually round-tripped through `router.refresh()`
    // — waiting on it here (an auto-retrying assertion) is what makes the
    // one-shot `textContent()` read right after it safe: reading the amount
    // first, with no retry of its own, could otherwise catch the row still
    // showing its pre-save figures for the instant before the refresh lands.
    await expect(
      overallRow.getByText(/Đã dùng hơn nửa|Over half used/, { exact: true }),
    ).toBeVisible()

    const spentText = (await figureLine(overallRow).textContent()) ?? ''
    expect(digitsOnly(spentText)).toContain('300000')
  })

  test('delete', async ({ page }) => {
    await page.goto('/budgets')
    const row = budgetRow(page, page, 'Food & Dining')
    await openRowMenu(page, row, 'Food & Dining')
    await page.getByRole('menuitem', { name: /^Xóa$|^Delete$/ }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Xóa$|^Delete$/ })
      .click()

    await expect(budgetRow(page, page, 'Food & Dining')).toHaveCount(0)
    await expect(budgetRow(page, page, OVERALL)).toBeVisible()
  })

  test('month navigation', async ({ page }) => {
    await page.goto('/budgets')
    await page.getByRole('link', { name: /‹ Tháng trước|‹ Previous/ }).click()

    await expect(page).toHaveURL(/[?&]month=/)
    await expect(page.getByText(/Chưa có ngân sách cho|No budgets for/)).toBeVisible()
    await expect(page.getByText(/^Tháng đã qua —|^Past month —/)).toBeVisible()

    const thisMonthLink = page.getByRole('link', { name: /Tháng này|This month/ })
    await thisMonthLink.click()
    await expect(page.getByRole('link', { name: /Tháng này|This month/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(budgetRow(page, page, OVERALL)).toBeVisible()

    await page.goto('/budgets?month=garbage')
    await expect(page.getByRole('heading', { name: /Ngân sách|^Budgets$/, level: 1 })).toBeVisible()
    await expect(budgetRow(page, page, OVERALL)).toBeVisible()
  })

  test('create after navigating months lands in the viewed month', async ({ page }) => {
    await page.goto('/budgets')
    // Clicking the link (rather than `goto`-ing the URL) is the whole point:
    // "‹ Tháng trước" changes only `?month=`, and the App Router deliberately
    // preserves client state across a search-param-only navigation — so the
    // create sheet's button is not remounted, and a form holding its own
    // year/month would go on submitting the month it mounted on. (The sheet
    // itself unmounts `BudgetForm` on close, which now also prevents the
    // staleness structurally — this still exercises the client-side month
    // MERGE at submit, which is a real behaviour independent of that.)
    await page.getByRole('link', { name: /‹ Tháng trước|‹ Previous/ }).click()
    await expect(page).toHaveURL(/[?&]month=/)
    const previousMonthUrl = page.url()
    await expect(page.getByText(/Chưa có ngân sách cho|No budgets for/)).toBeVisible()

    await createBudgetViaUi(page, {
      scope: 'OVERALL',
      amount: 777_000,
      currency: 'VND',
      stayOnPage: true,
    })

    // The budget landed in the month on screen: 777,000 with nothing spent
    // against it (all this user's expenses are in the current month).
    const previousOverall = budgetRow(page, page, OVERALL)
    await expect(
      previousOverall.getByText(/Trong hạn mức|^Healthy$/, { exact: true }),
    ).toBeVisible()
    const previousText = (await figureLine(previousOverall).textContent()) ?? ''
    expect(digitsOnly(previousText)).toContain('777000')
    await expect(page).toHaveURL(previousMonthUrl)

    // And the current month is untouched — still exactly one Overall budget,
    // the 300,000 target the edit test left, not a second one and not 777,000.
    await page.getByRole('link', { name: /Tháng này|This month/ }).click()
    const currentOverall = budgetRow(page, page, OVERALL)
    await expect(currentOverall).toHaveCount(1)
    await expect(
      currentOverall.getByText(/Đã dùng hơn nửa|Over half used/, { exact: true }),
    ).toBeVisible()
    const currentText = (await figureLine(currentOverall).textContent()) ?? ''
    expect(digitsOnly(currentText)).toContain('300000')
    expect(digitsOnly(currentText)).not.toContain('777000')

    // Cleaned up here, so the dashboard and export cases below still see the
    // single current-month budget this serial flow built up.
    await page.goto(previousMonthUrl)
    const cleanupRow = budgetRow(page, page, OVERALL)
    await openRowMenu(page, cleanupRow, OVERALL_VI, OVERALL_EN)
    await page.getByRole('menuitem', { name: /^Xóa$|^Delete$/ }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Xóa$|^Delete$/ })
      .click()
    await expect(page.getByText(/Chưa có ngân sách cho|No budgets for/)).toBeVisible()
  })

  test('dashboard widget (desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    await expect(
      page.getByRole('heading', { name: /Tiến độ ngân sách|Budget Progress/ }),
    ).toBeVisible()
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: /Tiến độ ngân sách|Budget Progress/ }) })

    const overallRow = budgetRow(page, section, OVERALL)
    await expect(overallRow).toBeVisible()
    await expect(
      overallRow.getByText(/Đã dùng hơn nửa|Over half used/, { exact: true }),
    ).toBeVisible()
    await expect(budgetRow(page, section, 'Food & Dining')).toHaveCount(0)
  })

  test('mobile (375x812)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')

    await page.getByRole('button', { name: /^(Menu|More)$/ }).click()
    const morePanel = page.getByRole('dialog', { name: /^(Tất cả mục|All sections)$/ })

    await expect(morePanel.getByRole('link', { name: /^(Ngân sách|Budgets)$/ })).toBeVisible()
    await morePanel.getByRole('link', { name: /^(Ngân sách|Budgets)$/ }).click()

    await expect(page).toHaveURL(/\/budgets/)
    await expect(budgetRow(page, page, OVERALL)).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)
  })

  test('export: Budgets sheet in the full workbook, absent from a filtered one', async ({
    page,
  }) => {
    const fullResp = await page.request.get('/api/reports/export?mode=full')
    expect(fullResp.status()).toBe(200)
    const fullBuffer = await fullResp.body()

    const fullWorkbook = new ExcelJS.Workbook()
    // Two different nested `@types/node` copies (Playwright's and exceljs's own)
    // each declare their own incompatible `Buffer` type, so even `Buffer` cast to
    // `Buffer` fails structurally — `any` is the only cast that actually erases
    // that mismatch; the value itself is a real Node `Buffer` either way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fullWorkbook.xlsx.load(fullBuffer as any)

    // The first five sheets, in order, and Budgets among them — deliberately
    // NOT the whole list. This is a Phase 5 spec: what it has to prove is that
    // its own sheet was appended after the Phase 4 four, in that position. A
    // `toEqual` on the entire array would additionally assert the *absence* of
    // every sheet a later phase adds, which is not Phase 5's claim to make —
    // and it broke the moment Phase 6 appended its six planning sheets.
    // `e2e/phase6.spec.ts` owns the exact, complete list.
    const sheetNames = fullWorkbook.worksheets.map((sheet) => sheet.name)
    expect(sheetNames.slice(0, 5)).toEqual([
      'Summary',
      'Accounts',
      'Transactions',
      'Transfers',
      'Budgets',
    ])
    expect(sheetNames).toContain('Budgets')

    const budgetsSheet = fullWorkbook.getWorksheet('Budgets')
    if (!budgetsSheet) throw new Error('Budgets sheet not found in full export')

    const header = budgetsSheet.getRow(1).values as unknown[]
    expect(header.slice(1, 12)).toEqual([
      'Year',
      'Month',
      'Scope',
      'Category',
      'Amount',
      'Currency',
      'Spent',
      'Remaining',
      'Used %',
      'Status',
      'Created',
    ])

    // Exactly one data row: the Food & Dining budget was deleted in an earlier
    // test, and `deleteBudget` is a hard delete — the row does not linger.
    expect(budgetsSheet.actualRowCount).toBe(2)
    const dataRow = budgetsSheet.getRow(2)
    expect(dataRow.getCell(3).value).toBe('OVERALL')
    expect(dataRow.getCell(5).value).toBe(300_000)
    expect(dataRow.getCell(6).value).toBe('VND')
    expect(dataRow.getCell(7).value).toBe(200_001)
    // The export sheet's Status column is English regardless of the reader's
    // locale (spec §12 does not localise a workbook) — `BUDGET_STATUS_LABELS`
    // is kept in `lib/ui/budget-view-model.ts` purely for this.
    expect(dataRow.getCell(10).value).toBe('Over half used')

    for (const name of ['Summary', 'Accounts', 'Transactions', 'Transfers']) {
      expect(fullWorkbook.getWorksheet(name)).toBeTruthy()
    }

    const filteredResp = await page.request.get('/api/reports/export?mode=filtered&period=month')
    expect(filteredResp.status()).toBe(200)
    const filteredBuffer = await filteredResp.body()
    const filteredWorkbook = new ExcelJS.Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filteredWorkbook.xlsx.load(filteredBuffer as any)

    expect(filteredWorkbook.getWorksheet('Budgets')).toBeUndefined()
  })
})
