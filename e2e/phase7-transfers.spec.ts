import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import { createAccountViaUi, digitsOnly, registerNewUser } from './helpers'

/**
 * Phase 7 Task 5b: owner requirement R — coverage the Transfers rebuild adds
 * beyond `transaction-form-hydration.spec.ts`'s reversion guard (which already
 * covers the hydration gate and the To-account `defaultValue` on this page).
 *
 * This file proves the PRODUCT behaviour once the page is hydrated: a
 * same-currency transfer shows exactly one amount field and the resulting row
 * reads `From → To` with one figure; a cross-currency transfer shows the
 * received-amount field and, after creation, the row shows both figures plus
 * a human-readable rate quoted VND-per-1-USD regardless of transfer
 * direction; every field carries a visible label; a user with fewer than two
 * active accounts sees the `EmptyState` and no broken `<select>`; delete goes
 * through `ConfirmDialog` and genuinely reverses both balances; and 375 has
 * no horizontal overflow.
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase7-transfers-storage-state-${process.pid}.json`,
)
const SINGLE_ACCOUNT_STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase7-transfers-single-account-storage-state-${process.pid}.json`,
)

const CASH = 'Cash'
const BANK = 'Bank'
const USD_SAVINGS = 'USD Savings'

/** The balance figure `/accounts` shows for one account row, as a plain number
 *  (its formatter is always `vi-VN` grouping regardless of the app locale —
 *  see `components/accounts/account-list.tsx#formatBalance` — so stripping
 *  everything but digits is enough; no account in this file ever goes
 *  negative). */
async function accountBalance(page: Page, name: string): Promise<number> {
  const row = page.locator('li').filter({ has: page.getByText(name, { exact: true }) })
  const text = await row.locator('span.tabular-nums').innerText()
  return Number(digitsOnly(text))
}

test.describe.serial('Phase 7 Task 5b — transfers form, rate line, a11y and row actions', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase7-transfers' })
    await createAccountViaUi(page, { name: CASH, currency: 'VND', initialBalance: 10_000_000 })
    await createAccountViaUi(page, { name: BANK, currency: 'VND', initialBalance: 1_000_000 })
    await createAccountViaUi(page, { name: USD_SAVINGS, currency: 'USD', initialBalance: 0 })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('every field in the create form has a visible label', async ({ page }) => {
    await page.goto('/transfers')

    // Scoped to `form`: the shell's own nav also carries a "Tài khoản"
    // (Accounts) link, which `getByLabel` would not match anyway (no `<label
    // for>` there), but scoping keeps this assertion about THIS form's fields.
    const form = page.locator('form')
    for (const label of [
      /^Từ$|^From$/,
      /^Đến$|^To$/,
      // The default FROM/TO pair (Cash, Bank) is same-currency, so the form
      // starts with the single generic "Amount" field, not "Amount sent".
      /^Số tiền$|^Amount$/,
      /^Ngày và giờ$|^Date and time$/,
      /Ghi chú|^Note/,
    ]) {
      await expect(form.getByLabel(label)).toBeVisible()
    }
  })

  test('same-currency: one amount field, and the created row reads From → To with one amount', async ({
    page,
  }) => {
    await page.goto('/transfers')

    // The default pair is Cash → Bank, both VND — no account selection needed.
    await expect(page.getByLabel(/^Số tiền$|^Amount$/)).toBeVisible()
    await expect(page.getByLabel(/^Số tiền gửi$|^Amount sent$/)).toHaveCount(0)
    await expect(page.getByLabel(/^Số tiền nhận$|^Amount received$/)).toHaveCount(0)

    await page.getByLabel(/^Số tiền$|^Amount$/).fill('50000')
    await page.getByRole('button', { name: /^Chuyển tiền$|^Transfer$/ }).click()

    const row = page.getByRole('listitem').filter({ hasText: '50.000' })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(`${CASH} → ${BANK}`)
    // Same-currency: no second figure and no rate line on this row.
    await expect(row).not.toContainText('USD')
  })

  test('cross-currency (VND → USD): the received-amount field appears, and the row shows both amounts plus the readable rate', async ({
    page,
  }) => {
    await page.goto('/transfers')

    await page.getByLabel(/^Đến$|^To$/).selectOption({ label: `${USD_SAVINGS} (USD)` })
    await expect(page.getByLabel(/^Số tiền$|^Amount$/)).toHaveCount(0)
    await expect(page.getByLabel(/^Số tiền gửi$|^Amount sent$/)).toBeVisible()
    await expect(page.getByLabel(/^Số tiền nhận$|^Amount received$/)).toBeVisible()

    // 2.500.000 VND sent, 100 USD received → an exchange rate of 25,000 VND
    // per USD, a round number chosen so the readable-direction rendering is
    // unambiguous to eyeball if this test ever needs to be debugged visually.
    await page.getByLabel(/^Số tiền gửi$|^Amount sent$/).fill('2500000')
    await page.getByLabel(/^Số tiền nhận$|^Amount received$/).fill('100')
    await page.getByRole('button', { name: /^Chuyển tiền$|^Transfer$/ }).click()

    const row = page.getByRole('listitem').filter({ hasText: `${CASH} → ${USD_SAVINGS}` })
    await expect(row).toHaveCount(1)
    // Both legs' figures are on the row.
    await expect(row).toContainText('2.500.000')
    await expect(row).toContainText('100')
    // The rate is quoted USD-per-1, never VND-per-1, regardless of which
    // currency the transfer moved FROM — this is the whole point of
    // `readableRate`'s reciprocal (`transfer-list.tsx`).
    await expect(row).toContainText(/1 USD = 25[.,]000 VND/)
  })

  test('375: no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/transfers')

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)
  })

  test('delete: Cancel keeps the row; Confirm removes it and both balances move back', async ({
    page,
  }) => {
    await page.goto('/accounts')
    const cashBefore = await accountBalance(page, CASH)
    const bankBefore = await accountBalance(page, BANK)

    await page.goto('/transfers')
    await page.getByLabel(/^Số tiền$|^Amount$/).fill('77000')
    await page.getByRole('button', { name: /^Chuyển tiền$|^Transfer$/ }).click()

    const row = page.getByRole('listitem').filter({ hasText: '77.000' })
    await expect(row).toHaveCount(1)

    await page.goto('/accounts')
    expect(await accountBalance(page, CASH)).toBe(cashBefore - 77_000)
    expect(await accountBalance(page, BANK)).toBe(bankBefore + 77_000)

    await page.goto('/transfers')
    const menuTrigger = row.getByRole('button', { name: /Tác vụ cho|Actions for/ })
    await menuTrigger.click()
    await page.getByRole('menuitem', { name: /Xóa lệnh chuyển|Delete transfer/ }).click()

    const dialog = page.getByRole('dialog', {
      name: /Xóa lệnh chuyển này\?|Delete this transfer\?/,
    })
    await expect(dialog).toBeVisible()
    // The dialog names what deleting actually does to the two accounts, not
    // just "are you sure" — the naming the brief's `deleteConfirmBody` asks for.
    await expect(dialog).toContainText(/Số dư của cả hai tài khoản|Both account balances/)

    // Cancel leaves the row — and both balances — untouched.
    await dialog.getByRole('button', { name: /Hủy|Cancel/ }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toHaveCount(1)

    // Re-open and Confirm removes it.
    await menuTrigger.click()
    await page.getByRole('menuitem', { name: /Xóa lệnh chuyển|Delete transfer/ }).click()
    await page
      .getByRole('dialog', { name: /Xóa lệnh chuyển này\?|Delete this transfer\?/ })
      .getByRole('button', { name: /^Xóa$|^Delete$/ })
      .click()
    await expect(row).toHaveCount(0)

    await page.goto('/accounts')
    expect(await accountBalance(page, CASH)).toBe(cashBefore)
    expect(await accountBalance(page, BANK)).toBe(bankBefore)
  })
})

test.describe('Phase 7 Task 5b — fewer than two active accounts', () => {
  test.use({ storageState: SINGLE_ACCOUNT_STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase7-transfers-solo' })
    await createAccountViaUi(page, { name: CASH, currency: 'VND', initialBalance: 1_000_000 })

    await context.storageState({ path: SINGLE_ACCOUNT_STORAGE_STATE_PATH })
    await context.close()
  })

  test('shows the EmptyState with a CTA to /accounts, and no <select> anywhere on the page', async ({
    page,
  }) => {
    await page.goto('/transfers')

    await expect(
      page.getByText(
        /Cần ít nhất hai tài khoản đang hoạt động|You need at least two active accounts/,
      ),
    ).toBeVisible()
    const cta = page.getByRole('link', { name: /^Đến Tài khoản$|^Go to Accounts$/ })
    await expect(cta).toBeVisible()
    await expect(cta).toHaveAttribute('href', '/accounts')

    // The defect this replaces: two selects with nothing (or the same one
    // account) to choose between. With the form gone, neither exists.
    await expect(page.locator('select')).toHaveCount(0)

    await cta.click()
    await expect(page).toHaveURL(/\/accounts/)
  })

  test('1440 and 375: no horizontal overflow in the fewer-than-two-accounts state', async ({
    page,
  }) => {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/transfers')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      )
      expect(overflow, `overflow at ${width}px`).toBe(true)
    }
  })
})
