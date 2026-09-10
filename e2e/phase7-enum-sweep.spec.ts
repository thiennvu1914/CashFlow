import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { PAGES, registerNewUser, createAccountViaUi, createTransactionViaUi } from './helpers'

/**
 * The guarantee spec §4 asks for, as a test rather than a habit (Task 13,
 * Step 4): **no raw enum reaches the DOM**.
 *
 * `CASH_OUT`, `ADJUSTMENT_DECREASE`, `WRITTEN_OFF`, `PARTIALLY_PAID`,
 * `ONE_TIME`, `PAID_OFF` — every one of them was on screen somewhere before
 * Phase 7, because a view model's `?? row.type` fallback or a missing label
 * map let it through. The regex below catches the SHAPE, not a list, so a NEW
 * enum member added in a later phase is caught the first time it renders.
 *
 * Deliberately scoped to `main`'s text content, not the whole document: a
 * `<select>`'s `value` attributes and a `data-*` hook legitimately carry the
 * enum, and only what a person can READ is the subject.
 */
const RAW_ENUM = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/

/**
 * Ids and codes that legitimately look like the pattern. Empty on purpose:
 * the list exists so a real exception gets recorded here (with a reason)
 * rather than the regex being loosened to let it through unremarked.
 */
const ALLOWED: string[] = []

const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-sweep-${process.pid}.json`)

test.describe.serial('Phase 7 — no raw enum on screen', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-sweep' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    // One transaction of the two common types, so every list/widget that
    // shows recent transactions has at least one row rather than only its
    // empty state — the raw-enum bug this spec exists for happened in a
    // POPULATED row, never in an empty one.
    for (const type of ['EXPENSE', 'INCOME'] as const) {
      await createTransactionViaUi(page, {
        type,
        accountName: 'Cash',
        categoryName: type === 'EXPENSE' ? 'Food & Dining' : 'Salary',
        amount: 100_000,
      })
    }
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  for (const url of PAGES) {
    test(`${url} renders no raw enum in Vietnamese`, async ({ page }) => {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      const main = page.locator('main')
      const allowed = new RegExp(ALLOWED.join('|') || '(?!)', 'g')
      const text = (await main.innerText()).replace(allowed, '')
      const match = text.match(RAW_ENUM)
      expect(match, `${url} shows "${match?.[0]}"`).toBeNull()
    })
  }

  test('exactly one h1 on every page', async ({ page }) => {
    for (const url of PAGES) {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 }), url).toHaveCount(1)
    }
  })

  test('the four uncommon transaction types render as product labels, never their raw enum', async ({
    page,
  }) => {
    // Created through the UI so the enum→label path exercised is the real
    // one: `TransactionTypeField`'s "Khác" disclosure reveals these four
    // radios inside the SAME radiogroup as Income/Expense (see the component
    // doc comment) — none of the four needs a category
    // (`CATEGORY_REQUIRED_TYPES` in both `transaction-form.tsx` and
    // `lib/validation/transaction.ts` is `{INCOME, EXPENSE}` only).
    for (const [type, viLabel] of [
      ['CASH_IN', 'Tiền vào (khác)'],
      ['CASH_OUT', 'Tiền ra (khác)'],
      ['ADJUSTMENT_INCREASE', 'Điều chỉnh tăng'],
      ['ADJUSTMENT_DECREASE', 'Điều chỉnh giảm'],
    ] as const) {
      await page.goto('/transactions')
      await page.getByRole('button', { name: /^Khác$|^Other$/ }).click()
      await page.getByRole('radio', { name: viLabel }).click()
      const amount = page.getByLabel(/Số tiền|^Amount$/)
      await amount.fill('50000')
      await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
      // A successful submit resets the form back to its defaults.
      await expect(amount).toHaveValue('0')
      await expect(page.locator('main')).toContainText(viLabel)
      await expect(page.locator('main')).not.toContainText(type)
    }
  })
})
