import os from 'os'
import path from 'path'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { createAccountViaUi, registerNewUser } from './helpers'

/**
 * Phase 7 Task 6: owner requirement R — coverage the Accounts/Categories
 * rebuild adds.
 *
 * Accounts: active vs archived separation (an archived account also drops
 * out of the Transactions form's Account picker); the header-button + `Sheet`
 * create flow, every field labelled; the row `…` → `Dialog` edit flow; the
 * archive `ConfirmDialog` (Cancel keeps, Confirm archives a zero-balance
 * account, and a non-zero-balance account shows the server's friendly refusal
 * rather than a raw message); no horizontal overflow at 375, and a long VND
 * balance is shown in full, never clipped.
 *
 * Categories: a default item carries no `…` menu (it cannot be archived), a
 * custom one does; the Expense and Income sections are separate — a custom
 * expense category never leaks into the Income section; the inline add row's
 * input has its own visible label per section; archive goes through a
 * `ConfirmDialog`; no raw enum text; no horizontal overflow at 375.
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase7-accounts-categories-storage-state-${process.pid}.json`,
)

const ZERO_BALANCE = 'Cash Envelope'
const NON_ZERO = 'Main Bank'
const LONG_BALANCE_NAME = 'Long Balance Account'
const LONG_BALANCE = 123_456_789_012

/**
 * The section container a `CategoryChipList` renders (`className="flex
 * flex-col gap-3"`), found from its own `<h2>` (via `SectionHeader`).
 *
 * `SectionHeader` wraps the heading in its own two-level markup (a
 * title/caption column, then the row that adds `right`), so the container is
 * three `<div>` ancestors up from the `<h2>` itself, not a direct parent —
 * `ancestor::div[1]` is the title column, `[2]` is `SectionHeader`'s own root,
 * `[3]` is `CategoryChipList`'s.
 */
function categorySection(page: Page, heading: RegExp): Locator {
  return page.getByRole('heading', { name: heading, level: 2 }).locator('xpath=ancestor::div[3]')
}

test.describe.serial('Phase 7 Task 6 — accounts, categories', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase7-accounts' })
    await createAccountViaUi(page, { name: ZERO_BALANCE, currency: 'VND', initialBalance: 0 })
    await createAccountViaUi(page, { name: NON_ZERO, currency: 'VND', initialBalance: 500_000 })
    await createAccountViaUi(page, {
      name: LONG_BALANCE_NAME,
      currency: 'VND',
      initialBalance: LONG_BALANCE,
    })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('create flow: header action opens the Sheet, every field is labelled, and the row appears with the right balance and currency', async ({
    page,
  }) => {
    await page.goto('/accounts')

    await page.getByRole('button', { name: /^Thêm tài khoản$|^Add account$/ }).click()
    const sheet = page.getByRole('dialog', { name: /^Thêm tài khoản$|^Add account$/ })
    await expect(sheet).toBeVisible()

    for (const label of [
      /^Tên tài khoản$|^Account name$/,
      /^Loại tài khoản$|^Account type$/,
      /^Số dư ban đầu$|^Initial balance$/,
      /^Tiền tệ$|^Currency$/,
      /Mô tả|^Description/,
    ]) {
      await expect(sheet.getByLabel(label)).toBeVisible()
    }

    await sheet.getByLabel(/^Tên tài khoản$|^Account name$/).fill('E-wallet Fresh')
    await sheet.getByLabel(/^Tiền tệ$|^Currency$/).selectOption('USD')
    await sheet.getByLabel(/^Số dư ban đầu$|^Initial balance$/).fill('250')
    await sheet.getByRole('button', { name: /^Tạo tài khoản$|^Create account$/ }).click()
    await expect(sheet).toBeHidden()

    const row = page.getByRole('listitem').filter({ hasText: 'E-wallet Fresh' })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('250')
    await expect(row).toContainText('USD')
  })

  test("edit flow: the row's … menu opens a Dialog; a rename is saved and the row updates", async ({
    page,
  }) => {
    await page.goto('/accounts')

    const menuTrigger = page.getByRole('button', {
      name: /Tác vụ cho E-wallet Fresh|Actions for E-wallet Fresh/,
    })
    await menuTrigger.click()
    await page.getByRole('menuitem', { name: /^Sửa$|^Edit$/ }).click()

    const dialog = page.getByRole('dialog', {
      name: /^Sửa E-wallet Fresh$|^Edit E-wallet Fresh$/,
    })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel(/^Tên tài khoản$|^Account name$/).fill('E-wallet Renamed')
    await dialog.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(dialog).toBeHidden()

    await expect(page.getByRole('listitem').filter({ hasText: 'E-wallet Renamed' })).toHaveCount(1)
    await expect(page.getByRole('listitem').filter({ hasText: 'E-wallet Fresh' })).toHaveCount(0)
  })

  test("archive: Cancel keeps a zero-balance account active; Confirm archives it, and it drops out of the transaction form's account select", async ({
    page,
  }) => {
    await page.goto('/accounts')

    const menuTrigger = page.getByRole('button', {
      name: new RegExp(`Tác vụ cho ${ZERO_BALANCE}|Actions for ${ZERO_BALANCE}`),
    })
    const openArchiveConfirm = async () => {
      await menuTrigger.click()
      await page.getByRole('menuitem', { name: /^Lưu trữ$|^Archive$/ }).click()
      return page.getByRole('dialog', {
        name: new RegExp(`Lưu trữ ${ZERO_BALANCE}\\?|Archive ${ZERO_BALANCE}\\?`),
      })
    }

    const confirm = await openArchiveConfirm()
    await expect(confirm).toBeVisible()
    // Names the zero-balance rule (spec §6.4), not just "are you sure".
    await expect(confirm).toContainText(/số dư bằng 0|zero balance/i)

    // Cancel: the account stays active and in the visible list.
    await confirm.getByRole('button', { name: /^Hủy$|^Cancel$/ }).click()
    await expect(confirm).toBeHidden()
    await expect(page.getByRole('listitem').filter({ hasText: ZERO_BALANCE })).toHaveCount(1)

    // Confirm: it moves out of the active list into the archived section.
    const confirmAgain = await openArchiveConfirm()
    await confirmAgain.getByRole('button', { name: /^Lưu trữ$|^Archive$/ }).click()
    await expect(confirmAgain).toBeHidden()
    await expect(page.getByText(/Tài khoản đã lưu trữ \(1\)|Archived accounts \(1\)/)).toBeVisible()

    // And it is no longer offered as an account to record a transaction against.
    await page.goto('/transactions')
    await page.getByRole('combobox', { name: /Tài khoản|^Account$/ }).click()
    await expect(page.getByRole('option', { name: new RegExp(ZERO_BALANCE) })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test("archive with a non-zero balance shows the server's friendly error, not a raw message, and the account stays active", async ({
    page,
  }) => {
    await page.goto('/accounts')

    await page
      .getByRole('button', {
        name: new RegExp(`Tác vụ cho ${NON_ZERO}|Actions for ${NON_ZERO}`),
      })
      .click()
    await page.getByRole('menuitem', { name: /^Lưu trữ$|^Archive$/ }).click()
    const confirm = page.getByRole('dialog', {
      name: new RegExp(`Lưu trữ ${NON_ZERO}\\?|Archive ${NON_ZERO}\\?`),
    })
    await confirm.getByRole('button', { name: /^Lưu trữ$|^Archive$/ }).click()

    // The failed archive closes the dialog itself (fix round 1, finding A3):
    // left open, its scrim would hide the very InlineAlert that explains why
    // the archive was refused.
    await expect(confirm).toBeHidden()

    // The server's own friendly refusal (`errors.account.NON_ZERO_BALANCE`),
    // never a raw exception message or a validator-internal string.
    await expect(
      page.getByText(
        /Tài khoản phải có số dư bằng 0 trước khi lưu trữ|This account must have a zero balance before it can be archived/,
      ),
    ).toBeVisible()

    await expect(page.getByRole('listitem').filter({ hasText: NON_ZERO })).toHaveCount(1)
    // Still only the one account archived earlier — the failed archive above
    // added nothing to the archived section.
    await expect(page.getByText(/Tài khoản đã lưu trữ \(2\)|Archived accounts \(2\)/)).toHaveCount(
      0,
    )
  })

  test('375: no horizontal overflow, and a long VND balance is shown in full, never clipped', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/accounts')

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)

    const row = page.getByRole('listitem').filter({ hasText: LONG_BALANCE_NAME })
    await expect(row).toContainText(LONG_BALANCE.toLocaleString('vi-VN'))
  })

  test('categories: a default item carries no … menu; a custom item gets one, and archiving it goes through a ConfirmDialog', async ({
    page,
  }) => {
    await page.goto('/categories')

    const expenseSection = categorySection(page, /^Danh mục chi$|^Expense Categories$/)
    const incomeSection = categorySection(page, /^Danh mục thu$|^Income Categories$/)

    // A default expense category (`lib/server/defaults.ts`) is a quiet chip
    // with no actions menu — the server refuses to archive it, so offering
    // the option would be a promise the app breaks.
    const defaultChip = expenseSection.locator('li').filter({ hasText: 'Food & Dining' })
    await expect(defaultChip.getByRole('button')).toHaveCount(0)

    // Add a custom expense category through the section's own inline row.
    await expenseSection
      .getByLabel(/^Thêm danh mục chi$|^Add expense category$/)
      .fill('Zzz Custom Expense')
    await expenseSection.getByRole('button', { name: /^Thêm$|^Add$/ }).click()

    const customChip = expenseSection.locator('li').filter({ hasText: 'Zzz Custom Expense' })
    await expect(customChip).toHaveCount(1)
    const customMenuTrigger = customChip.getByRole('button', {
      name: /Tác vụ cho Zzz Custom Expense|Actions for Zzz Custom Expense/,
    })
    await expect(customMenuTrigger).toHaveCount(1)

    // Sections stay separate: the new EXPENSE category never leaks into Income.
    await expect(incomeSection.locator('li').filter({ hasText: 'Zzz Custom Expense' })).toHaveCount(
      0,
    )

    // Archive goes through a ConfirmDialog, not window.confirm.
    await customMenuTrigger.click()
    await page.getByRole('menuitem', { name: /^Lưu trữ$|^Archive$/ }).click()
    const confirm = page.getByRole('dialog', {
      name: /Lưu trữ Zzz Custom Expense\?|Archive Zzz Custom Expense\?/,
    })
    await expect(confirm).toBeVisible()

    // Cancel keeps the chip.
    await confirm.getByRole('button', { name: /^Hủy$|^Cancel$/ }).click()
    await expect(confirm).toBeHidden()
    await expect(customChip).toHaveCount(1)

    // Confirm removes it from the section.
    await customMenuTrigger.click()
    await page.getByRole('menuitem', { name: /^Lưu trữ$|^Archive$/ }).click()
    await page
      .getByRole('dialog', {
        name: /Lưu trữ Zzz Custom Expense\?|Archive Zzz Custom Expense\?/,
      })
      .getByRole('button', { name: /^Lưu trữ$|^Archive$/ })
      .click()
    await expect(customChip).toHaveCount(0)
  })

  test('categories: no raw enum text anywhere on the page', async ({ page }) => {
    await page.goto('/categories')
    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(/\bEXPENSE\b|\bINCOME\b/)
  })

  test('categories 375: no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/categories')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)
  })
})
