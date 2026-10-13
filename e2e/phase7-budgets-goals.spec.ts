import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  authenticatedSession,
  createAccountViaUi,
  createBudgetViaUi,
  createTransactionViaUi,
  eitherLocale,
} from './helpers'

/**
 * Phase 7 Task 7: owner requirement S — coverage the Budgets/Savings rebuild
 * adds on top of `phase5.spec.ts` (budgets) and `phase6.spec.ts` (goals),
 * which this task already migrated to the new PlanningRow/Dialog/ConfirmDialog
 * UI. This file is the NEW, additional coverage: real localisation of status
 * text (vi by default, English through Settings — `resolveLocale()` reads the
 * signed-in session's stored `locale` before the `NEXT_LOCALE` cookie, so a
 * cookie set on an authenticated visit has no effect; `phase7-dashboard.spec.ts`
 * gives the same reasoning), the `Progress` component's exact ARIA contract,
 * the full create/edit/delete and create/progress/archive flows through the
 * header action, the row `…` menu and a `ConfirmDialog`, and that the
 * Vietnamese dashboard widgets carry no English budget/goal status word.
 */

const SESSION = authenticatedSession('phase7-budgets-goals')

/** Creates one savings goal through the `/goals` page's header action and its
 *  create `Sheet` — the same flow `e2e/phase6.spec.ts`'s local helper uses. */
async function createGoalViaUi(
  page: Page,
  opts: { name: string; target: number; current?: number },
): Promise<void> {
  await page.goto('/goals')
  await page.getByRole('button', { name: /Thêm mục tiêu|Add goal/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm mục tiêu|Add goal/ })
  await sheet.getByLabel(/Tên mục tiêu|Goal name/).fill(opts.name)
  await sheet.getByLabel(/Số tiền mục tiêu|Target amount/).fill(String(opts.target))
  if (opts.current !== undefined) {
    await sheet.getByLabel(/Đã tiết kiệm|Current amount/).fill(String(opts.current))
  }
  await sheet.getByRole('button', { name: /Thêm mục tiêu|Add goal/ }).click()
  await expect(sheet).toBeHidden()
}

/** Opens a row's `…` menu — `name` is the row's own visible label. */
async function openRowMenu(page: Page, row: Locator, name: string): Promise<void> {
  await row
    .getByRole('button', { name: eitherLocale(`Tác vụ cho ${name}`, `Actions for ${name}`) })
    .click()
}

function budgetRow(page: Page, label: string): Locator {
  return page.locator('li').filter({ has: page.getByText(label, { exact: true }) })
}

function goalRow(page: Page, name: string): Locator {
  return page.locator('li').filter({ has: page.getByText(name, { exact: true }) })
}

test.describe.serial('Phase 7 Task 7 — budgets, savings goals', () => {
  test.use({ storageState: SESSION.path })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    await SESSION.bootstrap(browser, async (page) => {
      await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    })
  })

  test('vi: budget status badge is Vietnamese, and the progress bar announces the true percentage', async ({
    page,
  }) => {
    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 1_000_000, currency: 'VND' })
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Ăn uống',
      amount: 850_000,
    })

    await page.goto('/budgets')
    const row = budgetRow(page, 'Tổng thể')
    await expect(row.getByText('Sắp vượt hạn mức', { exact: true })).toBeVisible()

    const bar = row.getByRole('progressbar')
    await expect(bar).toHaveAttribute('aria-valuenow', '85')
    await expect(bar).toHaveAttribute('aria-valuetext', '85 %')
  })

  test('create / edit / delete a budget through the header action, the … menu and a ConfirmDialog (Cancel keeps, Confirm removes)', async ({
    page,
  }) => {
    await createBudgetViaUi(page, {
      scope: 'CATEGORY',
      categoryName: 'Hóa đơn & tiện ích',
      amount: 200_000,
      currency: 'VND',
    })
    const row = budgetRow(page, 'Hóa đơn & tiện ích')
    await expect(row).toBeVisible()

    // Edit through the row's … menu and the edit Dialog.
    await openRowMenu(page, row, 'Hóa đơn & tiện ích')
    await page.getByRole('menuitem', { name: 'Sửa' }).click()
    const editDialog = page.getByRole('dialog', { name: 'Sửa ngân sách Hóa đơn & tiện ích' })
    await editDialog.getByLabel('Hạn mức').fill('250000')
    await editDialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(editDialog).toBeHidden()
    await expect(row).toContainText('250.000')

    // Delete: Cancel keeps the row.
    await openRowMenu(page, row, 'Hóa đơn & tiện ích')
    await page.getByRole('menuitem', { name: 'Xóa' }).click()
    const confirmDialog = page.getByRole('dialog', {
      name: 'Xóa ngân sách Hóa đơn & tiện ích?',
    })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Hủy' }).click()
    await expect(confirmDialog).toBeHidden()
    await expect(row).toBeVisible()

    // Delete: Confirm removes it.
    await openRowMenu(page, row, 'Hóa đơn & tiện ích')
    await page.getByRole('menuitem', { name: 'Xóa' }).click()
    await page
      .getByRole('dialog', { name: 'Xóa ngân sách Hóa đơn & tiện ích?' })
      .getByRole('button', { name: 'Xóa' })
      .click()
    await expect(budgetRow(page, 'Hóa đơn & tiện ích')).toHaveCount(0)
  })

  test('vi: savings goal status, contributing reaches Achieved, and archive via a ConfirmDialog (Cancel keeps, Confirm removes)', async ({
    page,
  }) => {
    await createGoalViaUi(page, { name: 'Máy ảnh', target: 8_000_000, current: 2_000_000 })

    const row = goalRow(page, 'Máy ảnh')
    await expect(row).toBeVisible()
    await expect(row.getByText('Đang thực hiện', { exact: true })).toBeVisible()
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')

    // "Góp" opens a Dialog with one amount field (plus a date and a note).
    await row.getByRole('button', { name: 'Góp vào Máy ảnh' }).click()
    const progressDialog = page.getByRole('dialog', { name: 'Góp vào Máy ảnh' })
    await expect(progressDialog.getByRole('spinbutton')).toHaveCount(1)
    await progressDialog.getByLabel('Số tiền', { exact: true }).fill('6000000')
    await progressDialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(progressDialog).toBeHidden()

    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    // "Đạt mục tiêu" appears once — the status badge only; an achieved goal's
    // meta line is omitted entirely (fix round 1, finding 10).
    await expect(row.getByText('Đạt mục tiêu', { exact: true })).toBeVisible()

    // Archive: Cancel keeps the row visible.
    await openRowMenu(page, row, 'Máy ảnh')
    await page.getByRole('menuitem', { name: 'Lưu trữ' }).click()
    const archiveConfirm = page.getByRole('dialog', { name: 'Lưu trữ Máy ảnh?' })
    await expect(archiveConfirm).toBeVisible()
    await archiveConfirm.getByRole('button', { name: 'Hủy' }).click()
    await expect(archiveConfirm).toBeHidden()
    await expect(goalRow(page, 'Máy ảnh')).toBeVisible()

    // Archive: Confirm moves it into the read-only Archived section.
    await openRowMenu(page, row, 'Máy ảnh')
    await page.getByRole('menuitem', { name: 'Lưu trữ' }).click()
    await page
      .getByRole('dialog', { name: 'Lưu trữ Máy ảnh?' })
      .getByRole('button', { name: 'Lưu trữ' })
      .click()

    const archivedSection = page.getByText(/Mục tiêu đã lưu trữ \(\d+\)/)
    await expect(archivedSection).toBeVisible()
    await archivedSection.click()
    const archivedRow = goalRow(page, 'Máy ảnh')
    await expect(archivedRow).toBeVisible()
    await expect(archivedRow.getByText('Đã lưu trữ', { exact: true })).toBeVisible()
  })

  test('vi: a goal linked to an account follows a transfer into it, and offers no entry buttons', async ({
    page,
  }) => {
    await createAccountViaUi(page, { name: 'Savings', currency: 'VND', initialBalance: 1_000_000 })

    await page.goto('/goals')
    await page.getByRole('button', { name: 'Thêm mục tiêu' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm mục tiêu' })
    await sheet.getByLabel('Tên mục tiêu').fill('Quỹ nhà')
    await sheet.getByLabel('Số tiền mục tiêu').fill('10000000')
    await sheet.getByLabel('Gắn với tài khoản').selectOption({ label: 'Savings · VND' })
    // The opening amount and currency give way to the account's.
    await expect(sheet.getByLabel(/Đã tiết kiệm/)).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Thêm mục tiêu' }).click()
    await expect(sheet).toBeHidden()

    const row = goalRow(page, 'Quỹ nhà')
    await expect(row.locator('.tabular-nums').first()).toHaveText(
      /^1.000.000 \/ 10.000.000 VND · 10\s%$/,
    )
    await expect(row.getByText('Tự động theo số dư Savings')).toBeVisible()
    await expect(row.getByRole('button', { name: /Góp vào|Rút từ/ })).toHaveCount(0)

    // 2.000.000 from Cash into Savings: the goal is never touched, yet it rises.
    await page.goto('/transfers')
    await page.getByLabel(/^Từ$/).selectOption({ label: 'Cash (VND)' })
    await page.getByLabel(/^Đến$/).selectOption({ label: 'Savings (VND)' })
    await page.getByLabel(/^Số tiền$/).fill('2000000')
    await page.getByRole('button', { name: /^Chuyển tiền$/ }).click()
    await expect(page.getByText('Savings', { exact: false }).first()).toBeVisible()

    await page.goto('/goals')
    await expect(goalRow(page, 'Quỹ nhà').locator('.tabular-nums').first()).toHaveText(
      /^3.000.000 \/ 10.000.000 VND · 30\s%$/,
    )
  })

  test('vi: an unlinked goal records a contribution then a withdrawal, with history', async ({
    page,
  }) => {
    await createGoalViaUi(page, { name: 'Du lịch', target: 10_000_000 })
    const row = goalRow(page, 'Du lịch')

    await row.getByRole('button', { name: 'Góp vào Du lịch' }).click()
    const contribute = page.getByRole('dialog', { name: 'Góp vào Du lịch' })
    await contribute.getByLabel('Số tiền', { exact: true }).fill('3000000')
    await contribute.getByLabel('Ghi chú (tùy chọn)').fill('Lương')
    await contribute.getByRole('button', { name: 'Lưu' }).click()
    await expect(contribute).toBeHidden()
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30')

    await row.getByRole('button', { name: 'Rút từ Du lịch' }).click()
    const withdraw = page.getByRole('dialog', { name: 'Rút từ Du lịch' })
    await withdraw.getByLabel('Số tiền', { exact: true }).fill('1000000')
    await withdraw.getByRole('button', { name: 'Lưu' }).click()
    await expect(withdraw).toBeHidden()
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')

    // More than is saved is refused with the friendly message, nothing recorded.
    await row.getByRole('button', { name: 'Rút từ Du lịch' }).click()
    const tooMuch = page.getByRole('dialog', { name: 'Rút từ Du lịch' })
    await tooMuch.getByLabel('Số tiền', { exact: true }).fill('5000000')
    await tooMuch.getByRole('button', { name: 'Lưu' }).click()
    await expect(tooMuch.getByRole('alert')).toBeVisible()
    await tooMuch.getByRole('button', { name: 'Hủy' }).click()
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')

    // The history lists both, newest first.
    await row.getByText('Lịch sử (2)').click()
    await expect(row.getByText(/Góp\s*\+3\.000\.000/)).toBeVisible()
    await expect(row.getByText(/Rút\s*−1\.000\.000/)).toBeVisible()
    await expect(row.getByText(/· Lương/)).toBeVisible()

    // Deleting the withdrawal puts the money back.
    await row.getByRole('button', { name: /^Xóa khoản Rút/ }).click()
    await page
      .getByRole('dialog', { name: 'Xóa khoản này?' })
      .getByRole('button', { name: 'Xóa' })
      .click()
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30')
  })

  test('vi: the dashboard widgets show Vietnamese budget/goal statuses and no English', async ({
    page,
  }) => {
    await page.goto('/dashboard')

    const budgetsWidget = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Tiến độ ngân sách' }) })
    await expect(budgetsWidget.getByText('Sắp vượt hạn mức', { exact: true })).toBeVisible()

    const goalsWidget = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Mục tiêu tiết kiệm' }) })
    await expect(goalsWidget).toBeVisible()

    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(
      /\bApproaching limit\b|\bExceeded\b|\bIn progress\b|\bAchieved\b|\bHealthy\b/,
    )
  })

  test('375: no horizontal overflow on /budgets or /goals', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })

    for (const url of ['/budgets', '/goals']) {
      await page.goto(url)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      )
      expect(overflow, url).toBe(true)
    }
  })

  test('switching to English in Settings renders the budget and goal status badges in English', async ({
    page,
  }) => {
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('en')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    await page.goto('/budgets')
    await expect(
      budgetRow(page, 'Overall').getByText('Approaching limit', { exact: true }),
    ).toBeVisible()

    await page.goto('/goals')
    const archivedSection = page.getByText(/Archived goals \(\d+\)/)
    await expect(archivedSection).toBeVisible()
    await archivedSection.click()
    await expect(goalRow(page, 'Máy ảnh').getByText('Archived', { exact: true })).toBeVisible()
  })
})
