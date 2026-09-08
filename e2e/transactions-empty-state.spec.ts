import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import {
  createAccountViaUi,
  createTransactionViaUi,
  eitherLocale,
  registerNewUser,
} from './helpers'

/**
 * The `/transactions` page for a user who has nothing to record a transaction
 * against — the case a fresh registration is actually in.
 *
 * One user is registered via the UI once (in `beforeAll`) and its login session
 * is captured as Playwright `storageState`, reused by every test here via
 * `test.use` — the same pattern `phase4.spec.ts` and `phase5.spec.ts` use.
 * Tests run `serial` and build on each other deliberately: no account, then one
 * archived account, then one active account, then two — the whole point is what
 * the Account selector offers at each of those stages, so the order is the test.
 *
 * "No active account" is not the same as "no account": an archived account still
 * exists, still holds history, and still must never appear as something new
 * activity can be added to. That is the one stage a component-level test cannot
 * reach on its own (archiving is a server round-trip), which is why it is here.
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-tx-empty-storage-state-${process.pid}.json`,
)

const NOTICE = eitherLocale(
  'Bạn cần ít nhất một tài khoản để ghi giao dịch.',
  'You need an account before you can add a transaction.',
)

/**
 * Zod's own machine phrasing — the defect this spec guards against. The same
 * pattern the unit tests use, so a leak cannot be invisible here and visible
 * there.
 */
const RAW_VALIDATION_TEXT = /expected string|>=1 characters|Too small|Invalid input/i

test.describe.serial('Transactions — no active financial account', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    // `storageState: undefined` overrides the file-level `test.use` above,
    // which at this point names a file this step is about to create — see the
    // identical reasoning in `phase4.spec.ts`'s `beforeAll`.
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    // No account is created here, deliberately: the first test is the
    // brand-new user's very first visit to `/transactions`.
    await registerNewUser(page, { emailPrefix: 'e2e-tx-empty' })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('zero accounts: a notice replaces the form and links to /accounts', async ({ page }) => {
    await page.goto('/transactions')

    await expect(page.getByText(NOTICE)).toBeVisible()

    // Nothing that looks operable anywhere on the page: with zero accounts
    // the PAGE itself (not just `TransactionForm`) replaces its whole body
    // with this one notice (spec §14 fix round 1, finding 6) — no empty
    // Account picker, no create trigger in the header or anywhere else, and
    // no submit action that could only ever fail.
    await expect(page.getByRole('combobox', { name: /Tài khoản|^Account$/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ })).toHaveCount(
      0,
    )
    await expect(page.locator('form')).toHaveCount(0)

    // And no internal validator text anywhere on the page.
    const mainText = await page.locator('main').innerText()
    expect(mainText).not.toMatch(RAW_VALIDATION_TEXT)

    const link = page.getByRole('link', { name: /Quản lý tài khoản|Manage accounts/ })
    await expect(link).toBeVisible()
    await link.click()
    await expect(page).toHaveURL(/\/accounts/)
  })

  test('only an archived account: the notice comes back', async ({ page }) => {
    await createAccountViaUi(page, { name: 'Old', currency: 'VND', initialBalance: 0 })

    await page.goto('/accounts')
    // Archive is a `RowActionsMenu` item behind the row's `…` trigger, plus a
    // `ConfirmDialog` naming the zero-balance rule (spec §6.4, §10) — not
    // `window.confirm`.
    await page.getByRole('button', { name: /Tác vụ cho Old|Actions for Old/ }).click()
    await page.getByRole('menuitem', { name: /Lưu trữ|^Archive$/ }).click()
    const confirm = page.getByRole('dialog')
    await confirm.getByRole('button', { name: /Lưu trữ|^Archive$/ }).click()
    await expect(confirm).toBeHidden()
    // Proof the archive actually landed (a `router.refresh()` away): the row
    // moves out of the active list and into the "Archived accounts" section.
    await expect(page.getByText(/Tài khoản đã lưu trữ \(1\)|Archived accounts \(1\)/)).toBeVisible()

    await page.goto('/transactions')
    await expect(page.getByText(NOTICE)).toBeVisible()
    await expect(page.getByRole('combobox', { name: /Tài khoản|^Account$/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ })).toHaveCount(
      0,
    )
    await expect(page.locator('form')).toHaveCount(0)
  })

  test('one active account: exactly that option, and a transaction can be created', async ({
    page,
  }) => {
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 1_000_000 })

    await page.goto('/transactions')
    // The Account picker is a custom Select now (spec §6.2) — open it and
    // read the option list, the same way every other spec in this suite does.
    const accountCombobox = page.getByRole('combobox', { name: /Tài khoản|^Account$/ })
    await accountCombobox.click()
    await expect(page.getByRole('option')).toHaveCount(1)
    // The option's label is `t('transactions.accountOption', ...)` —
    // "Cash · 1.000.000 VND", not the bare account name.
    await expect(page.getByRole('option')).toContainText('Cash')
    await page.keyboard.press('Escape')
    await expect(page.getByText(NOTICE)).toHaveCount(0)

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 50_000,
    })

    // The row's title is the category name, its meta carries the account
    // (`TransactionList`'s `FinancialListRow`, title and meta are separate
    // elements now — not one "<category> · <account>" string).
    const listRow = page.getByRole('listitem').filter({ hasText: 'Food & Dining' })
    await expect(listRow).toHaveCount(1)
    await expect(listRow).toContainText('Cash')
    await expect(listRow).toContainText('50.000')

    // The only state in this spec where validation can actually fire: with an
    // account to submit against, a failed submit renders a real message. An
    // emptied Amount reaches the schema as `NaN` (react-hook-form's
    // `valueAsNumber`), which used to render "Invalid input: expected number,
    // received NaN" — so this is the one live proof that what a user sees is
    // product copy, not validator internals.
    const amountInput = page.getByLabel(/Số tiền|^Amount$/)
    await amountInput.fill('')
    await expect(amountInput).toHaveValue('')
    await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()

    const validationText = eitherLocale('Hãy nhập số tiền', 'Enter an amount')
    await expect(page.getByText(validationText)).toBeVisible()
    expect(await page.locator('main').innerText()).not.toMatch(RAW_VALIDATION_TEXT)
    // The rejected submit created nothing: still exactly the one row above.
    await expect(listRow).toHaveCount(1)
  })

  test('a second active account joins the selector; the archived one stays out', async ({
    page,
  }) => {
    await createAccountViaUi(page, { name: 'Wallet', currency: 'USD', initialBalance: 100 })

    await page.goto('/transactions')
    const accountCombobox = page.getByRole('combobox', { name: /Tài khoản|^Account$/ })
    await accountCombobox.click()
    // Both active accounts, oldest first (`listActiveFinancialAccounts` orders
    // by `createdAt`) — and "Old", archived in an earlier test, is absent.
    await expect(page.getByRole('option')).toHaveCount(2)
    // Each option's label carries its balance too ("Cash · 1.000.000 VND"),
    // so this matches by account name rather than the exact templated text.
    await expect(page.getByRole('option')).toHaveText([/Cash/, /Wallet/])
    await page.keyboard.press('Escape')
  })
})
