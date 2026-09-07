import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { createAccountViaUi, createTransactionViaUi, registerNewUser } from './helpers'

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

const NOTICE = 'You need an account before you can add a transaction.'

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

    // Nothing that looks operable: no empty Account selector, and no submit
    // action that could only ever fail.
    await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add transaction' })).toHaveCount(0)

    // And no internal validator text anywhere on the page.
    const mainText = await page.locator('main').innerText()
    expect(mainText).not.toMatch(RAW_VALIDATION_TEXT)

    const link = page.getByRole('link', { name: 'Go to Accounts' })
    await expect(link).toBeVisible()
    await link.click()
    await expect(page).toHaveURL(/\/accounts/)
  })

  test('only an archived account: the notice comes back', async ({ page }) => {
    await createAccountViaUi(page, { name: 'Old', currency: 'VND', initialBalance: 0 })

    await page.goto('/accounts')
    const row = page.locator('li').filter({ has: page.getByText('Old', { exact: true }) })
    // `AccountList.handleArchive` asks for confirmation via `window.confirm`.
    page.once('dialog', (dialog) => dialog.accept())
    await row.getByRole('button', { name: 'Archive' }).click()
    // Proof the archive actually landed (a `router.refresh()` away): the row
    // moves out of the active list and into the "Archived accounts" section.
    await expect(page.getByText('Archived accounts (1)')).toBeVisible()

    await page.goto('/transactions')
    await expect(page.getByText(NOTICE)).toBeVisible()
    await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add transaction' })).toHaveCount(0)
  })

  test('one active account: exactly that option, and a transaction can be created', async ({
    page,
  }) => {
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 1_000_000 })

    await page.goto('/transactions')
    const options = page.getByLabel('Account', { exact: true }).locator('option')
    await expect(options).toHaveCount(1)
    await expect(options).toHaveText(['Cash'])
    await expect(page.getByText(NOTICE)).toHaveCount(0)

    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 50_000,
    })

    // The list row is "<category> · <account>" (`TransactionList`).
    const listRow = page
      .locator('li')
      .filter({ has: page.getByText('Food & Dining · Cash', { exact: true }) })
    await expect(listRow).toHaveCount(1)
    await expect(listRow).toContainText('50.000')

    // The only state in this spec where validation can actually fire: with an
    // account to submit against, a failed submit renders a real message. An
    // emptied Amount reaches the schema as `NaN` (react-hook-form's
    // `valueAsNumber`), which used to render "Invalid input: expected number,
    // received NaN" — so this is the one live proof that what a user sees is
    // product copy, not validator internals.
    const amountInput = page.getByLabel('Amount', { exact: true })
    await amountInput.fill('')
    await expect(amountInput).toHaveValue('')
    await page.getByRole('button', { name: 'Add transaction' }).click()

    await expect(page.getByText('Enter an amount', { exact: true })).toBeVisible()
    expect(await page.locator('main').innerText()).not.toMatch(RAW_VALIDATION_TEXT)
    // The rejected submit created nothing: still exactly the one row above.
    await expect(listRow).toHaveCount(1)
  })

  test('a second active account joins the selector; the archived one stays out', async ({
    page,
  }) => {
    await createAccountViaUi(page, { name: 'Wallet', currency: 'USD', initialBalance: 100 })

    await page.goto('/transactions')
    const options = page.getByLabel('Account', { exact: true }).locator('option')
    // Both active accounts, oldest first (`listActiveFinancialAccounts` orders
    // by `createdAt`) — and "Old", archived in an earlier test, is absent.
    await expect(options).toHaveCount(2)
    await expect(options).toHaveText(['Cash', 'Wallet'])
  })
})
