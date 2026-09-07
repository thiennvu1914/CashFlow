import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import { createAccountViaUi, createBudgetViaUi, registerNewUser } from './helpers'

/**
 * The money forms' hydration gate (spec-level regression for the
 * silent-reversion defect documented in `lib/ui/use-hydrated.ts`).
 *
 * The defect: `/transactions` server-rendered a Type `<select>` with no
 * default at all, so it showed its first option (Income) while form state —
 * and therefore the Category list — already said EXPENSE. A Type the user
 * changed before hydration finished was then overwritten by react-hook-form's
 * `ref` callback the moment React committed, with no `change` event ever
 * reaching React. A deliberate INCOME was silently recorded as an EXPENSE.
 * `/transfers`, `/budgets` and `/accounts` each reverted at least one control
 * the same way.
 *
 * Nothing in this file may paper over that. There is no retry helper, no
 * `waitForTimeout`, no sleep and no relaxed assertion anywhere below, and
 * `playwright.config.ts` runs with `retries: 0`.
 *
 * Two properties make the behavioural tests actually exercise the gate rather
 * than the dev server's incidental timing:
 *
 *  - every navigation uses `waitUntil: 'commit'`, so the interaction is
 *    attempted as soon as the document exists — long before `load`, and long
 *    before hydration;
 *  - the ONLY thing that then delays `selectOption` is Playwright's
 *    actionability check, which treats a control inside a `<fieldset disabled>`
 *    as disabled (`playwright-core`'s `belongsToDisabledFieldSet`). Locators
 *    auto-wait for attachment, so no other wait is needed or wanted.
 *
 * So the action lands at the earliest moment the application itself is willing
 * to accept input, and what it accepts has to survive. Were the gate deleted,
 * the interaction would land pre-hydration and be reverted — which is exactly
 * what happens when the fix is reverted (see the comment in test 2).
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

/**
 * Two VND accounts, deliberately. `TransferForm`'s `toAccountId` defaults to
 * `accounts[1]` — the one selector in the app whose default is not its first
 * option — so a single-account user could not exercise it at all.
 */
const FIRST_ACCOUNT = 'Cash'
const SECOND_ACCOUNT = 'Wallet'

/** The types that carry no category at all (`CATEGORY_REQUIRED_TYPES`'s complement). */
const CATEGORYLESS_TYPES = [
  'CASH_IN',
  'CASH_OUT',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
] as const

/** Every page that renders a gated money form. */
const GATED_PAGES = ['/transactions', '/transfers', '/budgets', '/accounts'] as const

/**
 * The markup of one `<select>`, found by its `aria-label` — `<select>`s cannot
 * nest, so the first `</select>` after the opening tag closes it.
 *
 * Scoping is what makes the `selected` assertions below meaningful:
 * `/transfers`' two account selectors render the SAME option values, and only
 * one of them may carry a pre-selected option.
 */
function selectMarkup(html: string, ariaLabel: string): string {
  const labelIndex = html.indexOf(`aria-label="${ariaLabel}"`)
  if (labelIndex === -1) throw new Error(`No element labelled "${ariaLabel}" in the markup`)
  const start = html.lastIndexOf('<select', labelIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> labelled "${ariaLabel}"`)
  return html.slice(start, end + '</select>'.length)
}

/**
 * The visible label of the `<option>` react-dom marked as pre-selected inside
 * `selectHtml`, or `null` when nothing is marked (i.e. the browser will fall
 * back to the first option).
 *
 * Reading the label rather than substring-matching `value="X" selected=""`
 * keeps the assertions independent of two things that are not under test: the
 * order react-dom happens to emit attributes in, and the `<!-- -->` text
 * separators it inserts between adjacent dynamic children — `/transfers`'
 * options really do arrive as `Wallet<!-- --> (<!-- -->VND<!-- -->)`.
 */
function selectedOptionLabel(selectHtml: string): string | null {
  const match = selectHtml.match(/<option[^>]*\sselected=""[^>]*>(.*?)<\/option>/)
  return match ? match[1].replaceAll('<!-- -->', '') : null
}

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

test.describe.serial('Money forms — hydration gate', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    // `storageState: undefined` overrides the file-level `test.use` above,
    // which at this point names a file this step is about to create — see the
    // identical reasoning in `phase4.spec.ts`'s `beforeAll`.
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-tx-hydration' })
    await createAccountViaUi(page, {
      name: FIRST_ACCOUNT,
      currency: 'VND',
      initialBalance: 1_000_000,
    })
    await createAccountViaUi(page, {
      name: SECOND_ACCOUNT,
      currency: 'VND',
      initialBalance: 500_000,
    })

    // An Overall budget on this month flips `BudgetForm`'s scope default to
    // CATEGORY — the branch where the default is *not* the first option, and
    // therefore the only branch its `defaultValue` actually matters on. The
    // helper does not assert success (a duplicate is a legitimate outcome
    // elsewhere), so the row assertion below is what proves the seed landed.
    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 1_000_000, currency: 'VND' })
    await expect(
      page.locator('li').filter({ has: page.getByText('Overall', { exact: true }) }),
    ).toHaveCount(1)

    await page.goto('/categories')
    incomeNames = await categoryNames(page, 'Income Categories')
    expenseNames = await categoryNames(page, 'Expense Categories')
    expenseOnlyNames = expenseNames.filter((name) => !incomeNames.includes(name))
    expect(incomeNames.length).toBeGreaterThan(0)
    expect(expenseOnlyNames.length).toBeGreaterThan(0)

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('server HTML gates every money form and carries its real defaults', async ({ page }) => {
    // Deterministic by construction: raw response bodies, no timing at all.
    const bodies = new Map<string, string>()
    for (const url of GATED_PAGES) {
      const response = await page.request.get(url)
      expect(response.status(), url).toBe(200)
      bodies.set(url, await response.text())
    }

    // 1. The gate itself, in the bytes the browser paints first: nothing inside
    //    any of the four forms is operable, and assistive tech is told the
    //    group is busy.
    for (const url of GATED_PAGES) {
      const html = bodies.get(url)!
      expect(html, url).toContain('<fieldset disabled=""')
      expect(html, url).toContain('aria-busy="true"')
    }

    // 2. `/transactions` — the Type the client is about to own is the Type the
    //    server showed. Without `defaultValue` the browser picks the first
    //    option, Income, while the Category list beside it is already EXPENSE.
    const transactions = bodies.get('/transactions')!
    expect(selectedOptionLabel(selectMarkup(transactions, 'Transaction type'))).toBe('Expense')
    // The Category select offers its placeholder, never a pre-chosen category.
    expect(selectedOptionLabel(selectMarkup(transactions, 'Category'))).toBe('Select a category')
    // Uncontrolled — a `value=` prop on the <select> would make it controlled.
    expect(selectMarkup(transactions, 'Transaction type')).not.toMatch(/<select[^>]*\svalue=/)

    // 3. `/transfers` — `toAccountId` defaults to the SECOND account, so its
    //    select must carry the marker; `fromAccountId` defaults to the first
    //    option and must carry none. Both selects list the identical option
    //    values, which is why each is asserted in its own slice.
    const transfers = bodies.get('/transfers')!
    expect(selectedOptionLabel(selectMarkup(transfers, 'To account'))).toBe(
      `${SECOND_ACCOUNT} (VND)`,
    )
    expect(selectedOptionLabel(selectMarkup(transfers, 'From account'))).toBeNull()

    // 4. `/budgets` — an Overall budget exists for this month (seeded in
    //    `beforeAll`), so the scope default is CATEGORY: the second option.
    const budgets = bodies.get('/budgets')!
    expect(selectedOptionLabel(selectMarkup(budgets, 'Budget scope'))).toBe('Category')
    expect(selectMarkup(budgets, 'Budget scope')).toMatch(
      /<option[^>]*\svalue="CATEGORY"[^>]*\sselected=""/,
    )
    // The CATEGORY-only field is server-rendered too — no post-hydration pop-in.
    expect(selectedOptionLabel(selectMarkup(budgets, 'Budget category'))).toBe('Select a category')

    // 5. `/accounts` — every select here defaults to its own first option, so
    //    correct behaviour is *no* marker anywhere. Asserted rather than
    //    skipped: a `defaultValue` added to the wrong select would otherwise
    //    pass unnoticed.
    const accounts = bodies.get('/accounts')!
    expect(selectedOptionLabel(selectMarkup(accounts, 'Account type'))).toBeNull()
    expect(selectedOptionLabel(selectMarkup(accounts, 'Currency'))).toBeNull()
  })

  test('an early INCOME selection is never reverted (5 fresh navigations)', async ({ page }) => {
    test.setTimeout(120_000)

    for (let i = 0; i < 5; i++) {
      // `commit` resolves the moment the response starts, so the very next
      // line runs while the document is still streaming — far earlier than
      // `load`, and certainly earlier than hydration.
      await page.goto('/transactions', { waitUntil: 'commit' })

      const type = page.getByLabel('Transaction type')
      // The locator auto-waits for attachment, then Playwright waits for
      // `:enabled` — i.e. for the fieldset's gate to lift. That is the sole
      // gate on this action, and the earliest moment the app allows input.
      await type.selectOption('INCOME')
      await expect(type).toHaveValue('INCOME')

      // The old failure window: hydration finishing *after* the interaction.
      // Against the unfixed code the ungated select accepts the change
      // natively before React is listening, react-hook-form's `ref` callback
      // writes EXPENSE straight back into the DOM, and no `change` event ever
      // reaches React — so `_formValues.type`, and the Category list it
      // drives, never move either. Verified by reverting
      // `transaction-form.tsx` to its pre-fix state and running this test: it
      // fails at the FIRST `toHaveValue` above (React hydrates the subtree
      // synchronously to replay the discrete `change`, so the overwrite lands
      // inside the same dispatch) with `unexpected value "EXPENSE"`. The
      // assertion after `networkidle` and the option list below are the
      // backstops for a machine where the overwrite arrives later.
      await page.waitForLoadState('networkidle')
      await expect(type).toHaveValue('INCOME')

      const options = page.getByLabel('Category', { exact: true }).locator('option')
      await expect(options).toHaveText(['Select a category', ...incomeNames])
      const texts = await options.allTextContents()
      for (const name of expenseOnlyNames) expect(texts).not.toContain(name)
    }
  })

  test('INCOME → EXPENSE → INCOME after hydration, dependent list each time', async ({ page }) => {
    await page.goto('/transactions', { waitUntil: 'commit' })
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
    // effect never fired on this transition and left the INCOME category in
    // form state under an EXPENSE transaction — invisible until the server
    // rejected it. The name comes from the scraped list, not a seed constant.
    await category.selectOption({ label: incomeNames[0] })
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
    await page.goto('/transactions', { waitUntil: 'commit' })
    await page.waitForLoadState('networkidle')

    const type = page.getByLabel('Transaction type')
    for (const value of CATEGORYLESS_TYPES) {
      await type.selectOption(value)
      await expect(page.getByLabel('Category', { exact: true })).toHaveCount(0)
      await expect(type).toHaveValue(value)
    }
  })
})
