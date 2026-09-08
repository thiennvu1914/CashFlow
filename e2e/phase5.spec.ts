import os from 'os'
import path from 'path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { BUDGET_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import {
  createAccountViaUi,
  createBudgetViaUi,
  createTransactionViaUi,
  digitsOnly,
  registerNewUser,
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
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase5-storage-state-${process.pid}.json`,
)

/**
 * The `<li>` row `BudgetProgressList` renders for one budget, found by its
 * visible label ("Overall", or a category name). `root` is either the whole
 * `page` (the Budgets page has only one such list) or a `Locator` scoping to
 * one section (the Dashboard, whose "Budget Progress" widget is one of many
 * sections on the page) — `page` is passed separately because the `has:`
 * filter locator must be built from the top-level page, the same pattern
 * `phase4.spec.ts` uses for its "Recent Transactions" section.
 */
function budgetRow(page: Page, root: Page | Locator, label: string): Locator {
  return root.locator('li').filter({ has: page.getByText(label, { exact: true }) })
}

test.describe.serial('Phase 5 — budgets', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    // `storageState: undefined` overrides the file-level `test.use` above,
    // which at this point names a file this step is about to create — see the
    // identical reasoning in `phase4.spec.ts`'s `beforeAll`.
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase5' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('navigation & empty state (desktop 1280x800)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    const rail = page.getByRole('navigation', { name: /^(Điều hướng chính|Primary)$/ })
    await expect(rail.getByRole('link', { name: /^(Ngân sách|Budgets)$/ })).toBeVisible()
    await rail.getByRole('link', { name: /^(Ngân sách|Budgets)$/ }).click()

    await expect(page).toHaveURL(/\/budgets/)
    await expect(page.getByRole('heading', { name: 'Budgets', level: 1 })).toBeVisible()
    await expect(page.getByText(/No budgets for/)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Add budget', level: 2 })).toBeVisible()
  })

  test('create overall budget', async ({ page }) => {
    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 1_000_000, currency: 'VND' })

    const row = budgetRow(page, page, 'Overall')
    await expect(row).toBeVisible()
    await expect(row.getByText('Healthy', { exact: true })).toBeVisible()

    const spentText = (await row.locator('span.tabular-nums').first().textContent()) ?? ''
    const digits = digitsOnly(spentText)
    expect(digits).toContain('0')
    expect(digits).toContain('1000000')

    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  test('duplicate overall rejected', async ({ page }) => {
    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 500_000, currency: 'VND' })

    await expect(page.getByText(BUDGET_ERROR_MESSAGES.DUPLICATE_BUDGET)).toBeVisible()
    await expect(budgetRow(page, page, 'Overall')).toHaveCount(1)
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

    await expect(page.getByText(BUDGET_ERROR_MESSAGES.DUPLICATE_BUDGET)).toBeVisible()
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
      budgetRow(page, page, 'Food & Dining').getByText('Over half used', { exact: true }),
    ).toBeVisible()
    await expect(
      budgetRow(page, page, 'Overall').getByText('Healthy', { exact: true }),
    ).toBeVisible()

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 60_000,
    })
    await page.goto('/budgets')
    await expect(
      budgetRow(page, page, 'Food & Dining').getByText('Approaching limit', { exact: true }),
    ).toBeVisible()

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 40_000,
    })
    await page.goto('/budgets')
    const foodRow = budgetRow(page, page, 'Food & Dining')
    await expect(foodRow.getByText('At limit', { exact: true })).toBeVisible()
    await expect(foodRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 1,
    })
    await page.goto('/budgets')
    await expect(foodRow.getByText('Exceeded', { exact: true })).toBeVisible()
    await expect(foodRow.getByText(/Over by/)).toBeVisible()
    await expect(foodRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    // Overall stays Healthy: 200,001 / 1,000,000 ≈ 20 %, still below the 50 %
    // "Over half used" band.
    await expect(
      budgetRow(page, page, 'Overall').getByText('Healthy', { exact: true }),
    ).toBeVisible()

    // Income never counts toward spend — neither budget's figures should move.
    await createTransactionViaUi(page, {
      type: 'INCOME',
      accountName: 'Cash',
      categoryName: 'Salary',
      amount: 999_999,
    })
    await page.goto('/budgets')
    await expect(foodRow.getByText('Exceeded', { exact: true })).toBeVisible()
    await expect(
      budgetRow(page, page, 'Overall').getByText('Healthy', { exact: true }),
    ).toBeVisible()
  })

  test('edit', async ({ page }) => {
    await page.goto('/budgets')
    const overallRow = budgetRow(page, page, 'Overall')
    await overallRow.getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Edit Overall budget amount').fill('300000')
    await page.getByRole('button', { name: 'Save' }).click()

    // The badge only flips from "Healthy" to "Over half used" once the new
    // amount (300,000) has actually round-tripped through `router.refresh()`
    // — waiting on it here (an auto-retrying assertion) is what makes the
    // one-shot `textContent()` read right after it safe: reading the amount
    // first, with no retry of its own, could otherwise catch the row still
    // showing its pre-save figures for the instant before the refresh lands.
    await expect(overallRow.getByText('Over half used', { exact: true })).toBeVisible()

    const spentText = (await overallRow.locator('span.tabular-nums').first().textContent()) ?? ''
    expect(digitsOnly(spentText)).toContain('300000')
  })

  test('delete', async ({ page }) => {
    await page.goto('/budgets')
    page.once('dialog', (dialog) => dialog.accept())
    await budgetRow(page, page, 'Food & Dining').getByRole('button', { name: 'Delete' }).click()

    await expect(budgetRow(page, page, 'Food & Dining')).toHaveCount(0)
    await expect(budgetRow(page, page, 'Overall')).toBeVisible()
  })

  test('month navigation', async ({ page }) => {
    await page.goto('/budgets')
    await page.getByRole('link', { name: 'Previous' }).click()

    await expect(page).toHaveURL(/[?&]month=/)
    await expect(page.getByText(/No budgets for/)).toBeVisible()
    await expect(page.getByText(/^Past month —/)).toBeVisible()

    await page.getByRole('link', { name: 'This month' }).click()
    await expect(budgetRow(page, page, 'Overall')).toBeVisible()

    await page.goto('/budgets?month=garbage')
    await expect(page.getByRole('heading', { name: 'Budgets', level: 1 })).toBeVisible()
    await expect(budgetRow(page, page, 'Overall')).toBeVisible()
  })

  test('create after navigating months lands in the viewed month', async ({ page }) => {
    await page.goto('/budgets')
    // Clicking the link (rather than `goto`-ing the URL) is the whole point:
    // "‹ Previous" changes only `?month=`, and the App Router deliberately
    // preserves client state across a search-param-only navigation — so the
    // create form is not remounted, and a form holding its own year/month
    // would go on submitting the month it mounted on.
    await page.getByRole('link', { name: 'Previous' }).click()
    await expect(page).toHaveURL(/[?&]month=/)
    const previousMonthUrl = page.url()
    await expect(page.getByText(/No budgets for/)).toBeVisible()

    await createBudgetViaUi(page, {
      scope: 'OVERALL',
      amount: 777_000,
      currency: 'VND',
      stayOnPage: true,
    })

    // The budget landed in the month on screen: 777,000 with nothing spent
    // against it (all this user's expenses are in the current month).
    const previousOverall = budgetRow(page, page, 'Overall')
    await expect(previousOverall.getByText('Healthy', { exact: true })).toBeVisible()
    const previousText =
      (await previousOverall.locator('span.tabular-nums').first().textContent()) ?? ''
    expect(digitsOnly(previousText)).toContain('777000')
    await expect(page).toHaveURL(previousMonthUrl)

    // And the current month is untouched — still exactly one Overall budget,
    // the 300,000 target the edit test left, not a second one and not 777,000.
    await page.getByRole('link', { name: 'This month' }).click()
    const currentOverall = budgetRow(page, page, 'Overall')
    await expect(currentOverall).toHaveCount(1)
    await expect(currentOverall.getByText('Over half used', { exact: true })).toBeVisible()
    const currentText =
      (await currentOverall.locator('span.tabular-nums').first().textContent()) ?? ''
    expect(digitsOnly(currentText)).toContain('300000')
    expect(digitsOnly(currentText)).not.toContain('777000')

    // Cleaned up here, so the dashboard and export cases below still see the
    // single current-month budget this serial flow built up.
    await page.goto(previousMonthUrl)
    page.once('dialog', (dialog) => dialog.accept())
    await budgetRow(page, page, 'Overall').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText(/No budgets for/)).toBeVisible()
  })

  test('dashboard widget (desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    await expect(page.getByRole('heading', { name: 'Budget Progress' })).toBeVisible()
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Budget Progress' }) })

    const overallRow = budgetRow(page, section, 'Overall')
    await expect(overallRow).toBeVisible()
    await expect(overallRow.getByText('Over half used', { exact: true })).toBeVisible()
    await expect(budgetRow(page, section, 'Food & Dining')).toHaveCount(0)
  })

  test('mobile (375x812)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')

    await page.getByRole('button', { name: /^(Khác|More)$/ }).click()
    const morePanel = page.getByRole('dialog', { name: /^(Tất cả mục|All sections)$/ })

    await expect(morePanel.getByRole('link', { name: /^(Ngân sách|Budgets)$/ })).toBeVisible()
    await morePanel.getByRole('link', { name: /^(Ngân sách|Budgets)$/ }).click()

    await expect(page).toHaveURL(/\/budgets/)
    await expect(budgetRow(page, page, 'Overall')).toBeVisible()

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
