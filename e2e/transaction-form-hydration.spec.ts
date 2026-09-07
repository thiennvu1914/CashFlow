import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import { createAccountViaUi, registerNewUser } from './helpers'

/**
 * The Transaction form's hydration gate (spec-level regression for the
 * silent-reversion defect documented in `lib/ui/use-hydrated.ts`).
 *
 * The defect: `/transactions` server-rendered a Type `<select>` with no
 * default at all, so it showed its first option (Income) while form state —
 * and therefore the Category list — already said EXPENSE. A Type the user
 * changed before hydration finished was then overwritten by react-hook-form's
 * `ref` callback the moment React committed, with no `change` event ever
 * reaching React. A deliberate INCOME was silently recorded as an EXPENSE.
 *
 * Nothing in this file may paper over that. There is no retry helper, no
 * `waitForTimeout`, no sleep and no relaxed assertion anywhere below, and
 * `playwright.config.ts` runs with `retries: 0`. The only waiting is
 * Playwright's own actionability check — which treats a control inside a
 * `<fieldset disabled>` as disabled — so `selectOption` lands at the earliest
 * moment the application itself is willing to accept input, and what it
 * accepts has to survive.
 *
 * One user is registered via the UI once (in `beforeAll`) and its session is
 * captured as `storageState`, reused by every test via `test.use` — the same
 * pattern `phase4.spec.ts` uses.
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-tx-hydration-storage-state-${process.pid}.json`,
)

const CATEGORY_REQUIRED_MESSAGE = 'Category is required for income and expense transactions'

/** The types that carry no category at all (`CATEGORY_REQUIRED_TYPES`'s complement). */
const CATEGORYLESS_TYPES = [
  'CASH_IN',
  'CASH_OUT',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
] as const

/**
 * The user's own category names, read off `/categories` rather than hard-coded:
 * the two `NamedListManager` lists there and the form's Category `<select>` are
 * both `listCategories(userId, type)`, ordered `isDefault desc, name asc`
 * (`lib/server/services/category.ts`) — so the expected option list can be
 * exact instead of a "contains" approximation that a wrongly-filtered list
 * would still satisfy.
 */
async function categoryNames(page: Page, listTitle: string): Promise<string[]> {
  const list = page
    .getByRole('heading', { name: listTitle, level: 2 })
    .locator('xpath=following-sibling::ul[1]')
  return list.locator('li > span').allTextContents()
}

let incomeNames: string[] = []
let expenseNames: string[] = []
/**
 * "Other" is a default in BOTH taxonomies (`lib/server/defaults.ts`), so it is
 * legitimately present under either type — only the names unique to EXPENSE
 * prove the list was actually re-filtered.
 */
let expenseOnlyNames: string[] = []

test.describe.serial('Transaction form — hydration gate', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    // `storageState: undefined` overrides the file-level `test.use` above,
    // which at this point names a file this step is about to create — see the
    // identical reasoning in `phase4.spec.ts`'s `beforeAll`.
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-tx-hydration' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 1_000_000 })

    await page.goto('/categories')
    incomeNames = await categoryNames(page, 'Income Categories')
    expenseNames = await categoryNames(page, 'Expense Categories')
    expenseOnlyNames = expenseNames.filter((name) => !incomeNames.includes(name))
    expect(incomeNames.length).toBeGreaterThan(0)
    expect(expenseOnlyNames.length).toBeGreaterThan(0)

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('server HTML gates the form and shows the real default', async ({ page }) => {
    // Deterministic by construction: a raw response body, no timing at all.
    const response = await page.request.get('/transactions')
    expect(response.status()).toBe(200)
    const html = await response.text()

    // Nothing inside the form is operable in the bytes the browser paints
    // first, and assistive tech is told why.
    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    // And the Type the client is about to own is the Type the server showed —
    // without this the browser picks the first option, Income, while the
    // Category list beside it is already EXPENSE.
    expect(html).toContain('value="EXPENSE" selected=""')
    expect(html).not.toContain('value="INCOME" selected=""')
  })

  test('an early INCOME selection is never reverted (5 fresh navigations)', async ({ page }) => {
    test.setTimeout(120_000)

    for (let i = 0; i < 5; i++) {
      await page.goto('/transactions')

      const type = page.getByLabel('Transaction type')
      // Playwright waits for `:enabled` — i.e. for the fieldset's gate to
      // lift. That is the earliest moment the app intentionally allows input.
      await type.selectOption('INCOME')
      await expect(type).toHaveValue('INCOME')

      // The previous failure window: hydration finishing *after* the
      // interaction. Against the unfixed code the ungated select accepts the
      // change natively before React is listening, react-hook-form's `ref`
      // callback writes EXPENSE straight back into the DOM, and no `change`
      // event ever reaches React — so `_formValues.type`, and the Category
      // list it drives, never move either. Verified by reverting
      // `transaction-form.tsx` to its pre-fix state and running this test:
      // it fails at the FIRST `toHaveValue` above (React hydrates the subtree
      // synchronously to replay the discrete `change`, so the overwrite lands
      // inside the same dispatch) with `unexpected value "EXPENSE"`; the
      // assertion after `networkidle` and the option list below are the
      // backstops for a slower machine where the overwrite arrives later.
      await page.waitForLoadState('networkidle')
      await expect(type).toHaveValue('INCOME')

      const options = page.getByLabel('Category', { exact: true }).locator('option')
      await expect(options).toHaveText(['Select a category', ...incomeNames])
      const texts = await options.allTextContents()
      for (const name of expenseOnlyNames) expect(texts).not.toContain(name)
    }
  })

  test('INCOME → EXPENSE → INCOME after hydration, dependent list each time', async ({ page }) => {
    await page.goto('/transactions')
    await page.waitForLoadState('networkidle')

    const type = page.getByLabel('Transaction type')
    const category = page.getByLabel('Category', { exact: true })
    const options = category.locator('option')

    // EXPENSE is the default, so the first assertion is the state the page
    // arrived in; the cycle then proves each transition re-filters the list.
    await expect(options).toHaveText(['Select a category', ...expenseNames])

    for (const [next, expected] of [
      ['INCOME', incomeNames],
      ['EXPENSE', expenseNames],
      ['INCOME', incomeNames],
    ] as const) {
      await type.selectOption(next)
      await expect(type).toHaveValue(next)
      await expect(options).toHaveText(['Select a category', ...expected])
    }

    // A category chosen under INCOME must not survive the switch to EXPENSE.
    // Both types require a category, so the old `needsCategory`-watching
    // effect never fired on this transition and left "Salary" in form state
    // under an EXPENSE transaction — invisible until the server rejected it.
    await category.selectOption({ label: 'Salary' })
    await expect(category).not.toHaveValue('')
    await type.selectOption('EXPENSE')
    await expect(category).toHaveValue('')

    // And the form says so itself, in product copy, instead of accepting a
    // stale INCOME category and failing server-side.
    await page.getByLabel('Amount', { exact: true }).fill('50000')
    await page.getByRole('button', { name: 'Add transaction' }).click()
    await expect(page.getByText(CATEGORY_REQUIRED_MESSAGE)).toBeVisible()
    await expect(category).toHaveValue('')
  })

  test('CASH_IN/CASH_OUT/ADJUSTMENT_* hide the category', async ({ page }) => {
    await page.goto('/transactions')
    await page.waitForLoadState('networkidle')

    const type = page.getByLabel('Transaction type')
    for (const value of CATEGORYLESS_TYPES) {
      await type.selectOption(value)
      await expect(page.getByLabel('Category', { exact: true })).toHaveCount(0)
      await expect(type).toHaveValue(value)
    }
  })
})
