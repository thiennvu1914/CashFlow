import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { createAccountViaUi, createTransactionViaUi, registerNewUser } from './helpers'

/**
 * Phase 7 Task 5a: owner requirement R — coverage the Transactions rebuild
 * adds beyond `transaction-form-hydration.spec.ts`'s reversion guard and
 * `transactions-empty-state.spec.ts`'s no-account coverage.
 *
 * The hydration gate itself (interact before load → no silent revert) is
 * `transaction-form-hydration.spec.ts`'s job — extended there for the new
 * radiogroup/split-date-time shape rather than duplicated here. This file
 * only proves the PRODUCT behaviour once the page is hydrated: every field
 * has a visible label, choosing a type re-filters and deterministically
 * clears Category, a duplicate submit cannot create two rows, no raw enum
 * ever reaches the page, 375 has no horizontal overflow and the amount
 * column never intersects a row's meta/note, and the row `…` menu's
 * keyboard-driven delete flow goes through `ConfirmDialog`.
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase7-transactions-storage-state-${process.pid}.json`,
)

/** A raw enum value: two-plus upper-case words joined by underscores — never
 *  a translated label, which is prose in Vietnamese or English. */
const RAW_ENUM_PATTERN = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/

test.describe.serial('Phase 7 Task 5a — transactions form, a11y and row actions', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase7-transactions' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 1_000_000 })
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 120_000,
    })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('every field in the create form has a visible label', async ({ page }) => {
    await page.goto('/transactions')

    // Scoped to `form`: the shell's own nav rail also carries an "Tài khoản"
    // (Accounts) link with an `aria-label`, which `getByLabel` matches too —
    // `getByLabel` only resolves when a `<label>` (not merely an
    // `aria-label`) is bound to the control, which is the exact gap this task
    // closes, so scoping to the create form is what keeps this assertion
    // about THIS form's fields rather than about the whole page.
    const form = page.locator('form')
    for (const label of [
      /Số tiền|^Amount$/,
      /Tài khoản|^Account$/,
      /Danh mục|^Category$/,
      /^Ngày$|^Date$/,
      /^Giờ$|^Time$/,
      /Ghi chú|^Note/,
    ]) {
      await expect(form.getByLabel(label)).toBeVisible()
    }
  })

  test('choosing Income then Expense re-filters Category and clears the chosen value', async ({
    page,
  }) => {
    await page.goto('/transactions')

    const income = page.getByRole('radio', { name: /Thu nhập|^Income$/ })
    const expense = page.getByRole('radio', { name: /Chi tiêu|^Expense$/ })
    const category = page.getByRole('combobox', { name: /Danh mục|^Category$/ })
    const options = page.getByRole('option')
    const placeholder = /Chọn danh mục|Select a category/

    await income.click()
    await category.click()
    // `expect(...).toHaveText([...])` (not a one-shot `allTextContents()`)
    // auto-retries until the portal-rendered popup's options actually match —
    // reading the list the instant `click()` resolves can race the re-render
    // the type change triggers.
    await expect(options.first()).toBeVisible()
    const incomeOptions = await options.allTextContents()
    expect(incomeOptions.length).toBeGreaterThan(0)
    await options.first().click()
    // A category is now chosen — the trigger no longer shows the placeholder.
    await expect(category).not.toHaveText(placeholder)

    await expense.click()
    // INCOME → EXPENSE clears the chosen category deterministically, even
    // though both types require one (`transaction-form.tsx`'s type Controller
    // clears on EVERY change, not only when `needsCategory` flips).
    await expect(category).toHaveText(placeholder)

    await category.click()
    await expect(options.first()).toBeVisible()
    const expenseOptions = await options.allTextContents()
    await page.keyboard.press('Escape')
    expect(expenseOptions).not.toEqual(incomeOptions)
  })

  test('duplicate-submit prevention: two rapid clicks create exactly one row', async ({ page }) => {
    await page.goto('/transactions')
    await page.getByRole('radio', { name: /Chi tiêu|^Expense$/ }).click()
    await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
    await page.getByRole('option').first().click()
    await page.getByLabel(/Số tiền|^Amount$/).fill('99999')

    // Hold the server action so the lock is observable — the delay lives in
    // the ROUTE handler, not in a `waitForTimeout`.
    await page.route('**/transactions', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await route.fallback()
    })

    const submit = page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ })
    // Two `click()`s dispatched back-to-back INSIDE the page, not through
    // Playwright's own actionability-retrying locator method: a retried
    // second `locator.click()` would simply wait out the whole in-flight
    // window (until the button re-enables) and land as a legitimate SECOND
    // submit once the first one had already finished — which is not what
    // "two rapid clicks" means here. Calling the DOM method twice in one
    // browser-side tick is what actually exercises `useSubmitState`'s
    // re-entry guard.
    await submit.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })

    await expect(page.locator('form fieldset').first()).toHaveAttribute('aria-busy', 'true')
    await page.unroute('**/transactions')
    // A successful submit resets the amount back to 0.
    await expect(page.getByLabel(/Số tiền|^Amount$/)).toHaveValue('0')
    // Exactly one ROW for that amount — two accepted clicks would make two.
    // Scoped to `listitem`, not a bare `getByText`: the page header's own
    // month-total also happens to read "99.999" when this is the only
    // EXPENSE transaction of the month, so an unscoped text match would
    // count that too and pass even if a duplicate row existed.
    await expect(page.getByRole('listitem').filter({ hasText: '99.999' })).toHaveCount(1)
  })

  test('no raw enum text reaches the page body', async ({ page }) => {
    await page.goto('/transactions')
    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(RAW_ENUM_PATTERN)
  })

  test('375: no horizontal overflow, and the amount box never intersects the meta/note box', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/transactions')

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)

    const firstRow = page.getByRole('listitem').first()
    await expect(firstRow).toBeVisible()
    // `FinancialListRow` puts the title/meta column and the amount column in
    // separate flex children — the amount column is a fixed `min-w-[8.5rem]`
    // specifically so a long note or a wide meta line can never push into it.
    const metaBox = await firstRow.locator('div[class*="text-xs"]').first().boundingBox()
    const amountBox = await firstRow.locator('div[class*="min-w-[8.5rem]"]').first().boundingBox()
    expect(metaBox).not.toBeNull()
    expect(amountBox).not.toBeNull()
    if (metaBox && amountBox) {
      expect(metaBox.x + metaBox.width).toBeLessThanOrEqual(amountBox.x + 1)
    }
  })

  test('the row "…" menu opens with the keyboard, and Delete goes through ConfirmDialog', async ({
    page,
  }) => {
    await page.goto('/transactions')

    const row = page.getByRole('listitem').filter({ hasText: 'Food & Dining' })
    await expect(row).toHaveCount(1)
    const menuTrigger = row.getByRole('button', { name: /Tác vụ cho|Actions for/ })

    // Keyboard-driven open: focus the trigger, then Enter — no click anywhere
    // in this first half of the test.
    await menuTrigger.focus()
    await page.keyboard.press('Enter')
    const deleteItem = page.getByRole('menuitem', { name: /Xóa giao dịch|Delete transaction/ })
    await expect(deleteItem).toBeVisible()
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog', {
      name: /Xóa giao dịch này\?|Delete this transaction\?/,
    })
    await expect(dialog).toBeVisible()

    // Cancel leaves the row untouched.
    await dialog.getByRole('button', { name: /Hủy|Cancel/ }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toHaveCount(1)

    // Re-open (by click this time) and Confirm removes it.
    await menuTrigger.click()
    await page.getByRole('menuitem', { name: /Xóa giao dịch|Delete transaction/ }).click()
    await page
      .getByRole('dialog', { name: /Xóa giao dịch này\?|Delete this transaction\?/ })
      .getByRole('button', { name: /^Xóa$|^Delete$/ })
      .click()
    await expect(row).toHaveCount(0)
  })
})
