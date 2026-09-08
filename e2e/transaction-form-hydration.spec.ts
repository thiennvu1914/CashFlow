import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import viValidation from '@/messages/vi/validation.json'
import {
  createAccountViaUi,
  createBudgetViaUi,
  eitherLocale,
  registerNewUser,
  todayInZone,
} from './helpers'

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
 * The markup of one `<select>` on `/transactions`, found by a field name
 * rather than `aria-label` — the Account and Category pickers there are
 * custom Selects now (spec §6.2), and their pre-hydration stand-in is a
 * disabled native `<select>` whose `id` (`transaction-<name>-<useId()
 * suffix>`, unique per mounted `TransactionForm` instance — spec §14 fix
 * round 1, finding 2) `FormField` binds the visible `<label>` to, not an
 * `aria-label`. Matched by prefix, since the suffix is generated at runtime.
 */
function selectMarkupById(html: string, name: string): string {
  const idMatch = html.match(new RegExp(`id="transaction-${name}-[^"]*"`))
  if (!idMatch) throw new Error(`No element with a transaction-${name}-* id in the markup`)
  const idIndex = html.indexOf(idMatch[0])
  const start = html.lastIndexOf('<select', idIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select id="transaction-${name}-*">`)
  return html.slice(start, end + '</select>'.length)
}

/**
 * The markup of the type radiogroup itself on `/transactions` — from
 * `role="radiogroup"` up to the first `</div>`. The "Khác" disclosure button
 * is a SIBLING of the radiogroup now (spec §14 fix round 1, finding 3: it is
 * not itself a radio, so it may not be a child of the group), and every
 * `TypeButton` inside is a plain `<button>` with no nested `<div>`, so this
 * first `</div>` is exactly the radiogroup's own closing tag.
 */
function radiogroupMarkup(html: string): string {
  const start = html.indexOf('role="radiogroup"')
  if (start === -1) throw new Error('No radiogroup in the markup')
  const end = html.indexOf('</div>', start)
  return html.slice(start, end)
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
    //    server showed. The control is a radiogroup of buttons now (spec
    //    §6.2), so the marker is `aria-checked`, not a `<select>`'s `selected`
    //    — same guarantee, different element.
    const transactions = bodies.get('/transactions')!
    const typeGroup = radiogroupMarkup(transactions)
    expect(typeGroup).toMatch(/aria-checked="true"[^>]*>(Chi tiêu|Expense)/)
    expect(typeGroup).not.toMatch(/aria-checked="true"[^>]*>(Thu nhập|Income)/)
    // The Category select offers its placeholder, never a pre-chosen category
    // — and it is disabled, the gate in the bytes the browser paints first.
    expect(selectedOptionLabel(selectMarkupById(transactions, 'category'))).toMatch(
      /Chọn danh mục|Select a category/,
    )
    expect(selectMarkupById(transactions, 'category')).toContain('disabled')
    // The account stand-in shows the form's own default (`accounts[0]`, seeded
    // as "Cash" in `beforeAll`) — not hard-coded, so the two could not
    // silently disagree the first time that default changes.
    expect(selectMarkupById(transactions, 'account')).toContain('Cash')
    // Both date parts are pre-filled with "now" in the user's zone.
    expect(transactions).toMatch(/id="transaction-date-[^"]*"[^>]*value="\d{4}-\d{2}-\d{2}"/)
    expect(transactions).toMatch(/id="transaction-time-[^"]*"[^>]*value="\d{2}:\d{2}"/)
    // Uncontrolled — a `value=` prop on either stand-in `<select>` would make
    // it controlled.
    expect(selectMarkupById(transactions, 'account')).not.toMatch(/<select[^>]*\svalue=/)
    expect(selectMarkupById(transactions, 'category')).not.toMatch(/<select[^>]*\svalue=/)

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

      // The type is a `role="radio"` button inside a `<fieldset disabled>`
      // now (spec §6.2), not a `<select>` — a disabled button is not
      // clickable, which is the SAME protection the disabled `<select>` gave.
      // The locator auto-waits for attachment, then Playwright waits for the
      // fieldset's gate to lift. That is the sole gate on this action, and
      // the earliest moment the app allows input.
      const income = page.getByRole('radio', { name: /Thu nhập|^Income$/ })
      await income.click()
      await expect(income).toHaveAttribute('aria-checked', 'true')

      // The old failure window: hydration finishing *after* the interaction.
      // Against the unfixed code the ungated control accepts the change
      // natively before React is listening, react-hook-form's `ref` callback
      // writes EXPENSE straight back into the DOM, and no `change` event ever
      // reaches React — so `_formValues.type`, and the Category list it
      // drives, never move either. The assertion after `networkidle` and the
      // option list below are the backstops for a machine where the
      // overwrite arrives later.
      await page.waitForLoadState('networkidle')
      await expect(income).toHaveAttribute('aria-checked', 'true')

      // The Category picker is a custom Select now — read its options by
      // opening it, the same way a hydrated Base UI Select's portal-rendered
      // list has to be read anywhere in this suite.
      const category = page.getByRole('combobox', { name: /Danh mục|^Category$/ })
      const options = page.getByRole('option')
      await category.click()
      // `toHaveText` (not a one-shot `allTextContents()`) auto-retries until
      // the popup's rendered options actually match, so this cannot race the
      // re-render the INCOME switch triggers.
      await expect(options).toHaveText(incomeNames)
      const texts = await options.allTextContents()
      await page.keyboard.press('Escape')
      for (const name of expenseOnlyNames) expect(texts).not.toContain(name)
    }
  })

  test('INCOME → EXPENSE → INCOME after hydration, dependent list each time', async ({ page }) => {
    await page.goto('/transactions', { waitUntil: 'commit' })
    await page.waitForLoadState('networkidle')

    const income = page.getByRole('radio', { name: /Thu nhập|^Income$/ })
    const expense = page.getByRole('radio', { name: /Chi tiêu|^Expense$/ })
    const category = page.getByRole('combobox', { name: /Danh mục|^Category$/ })

    const options = page.getByRole('option')

    /**
     * `expect(options).toHaveText([...])` (not a one-shot `allTextContents()`)
     * auto-retries until the portal-rendered popup's options actually match
     * the expectation — reading the list the instant `click()` resolves can
     * race the re-render a type change triggers, since `click()` only waits
     * for the click event to dispatch, not for React's resulting commit.
     */
    async function expectCategoryOptions(expected: string[]): Promise<void> {
      await category.click()
      await expect(options).toHaveText(expected)
      await page.keyboard.press('Escape')
    }

    // EXPENSE is the default, so the first assertion is the state the page
    // arrived in; the cycle then proves each transition re-filters the list.
    await expectCategoryOptions(expenseNames)

    for (const [radio, expected] of [
      [income, incomeNames],
      [expense, expenseNames],
      [income, incomeNames],
    ] as const) {
      await radio.click()
      await expect(radio).toHaveAttribute('aria-checked', 'true')
      await expectCategoryOptions(expected)
    }

    // A category chosen under INCOME must not survive the switch to EXPENSE.
    // Both types require a category, so the old `needsCategory`-watching
    // effect never fired on this transition and left the INCOME category in
    // form state under an EXPENSE transaction — invisible until the server
    // rejected it. The name comes from the scraped list, not a seed constant.
    const placeholder = eitherLocale('Chọn danh mục', 'Select a category')
    await category.click()
    await page.getByRole('option', { name: incomeNames[0], exact: true }).click()
    await expect(category).not.toHaveText(placeholder)
    await expense.click()
    await expect(category).toHaveText(placeholder)

    // And the form says so itself, in product copy, instead of accepting a
    // stale INCOME category and failing server-side.
    await page.getByLabel(/Số tiền|^Amount$/).fill('50000')
    await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
    await expect(
      page.getByText(
        eitherLocale(viValidation[CATEGORY_REQUIRED_MESSAGE], CATEGORY_REQUIRED_MESSAGE),
      ),
    ).toBeVisible()
    await expect(category).toHaveText(placeholder)
  })

  test('CASH_IN/CASH_OUT/ADJUSTMENT_* hide the category', async ({ page }) => {
    await page.goto('/transactions', { waitUntil: 'commit' })
    await page.waitForLoadState('networkidle')

    // The four "Khác" types live behind that disclosure (spec §6.2) — open it
    // once so every radio below is reachable.
    await page.getByRole('button', { name: /Khác|^Other$/ }).click()

    const TYPE_LABELS: Record<(typeof CATEGORYLESS_TYPES)[number], RegExp> = {
      CASH_IN: /Tiền vào \(khác\)|Cash In/,
      CASH_OUT: /Tiền ra \(khác\)|Cash Out/,
      ADJUSTMENT_INCREASE: /Điều chỉnh tăng|Balance Adjustment — increase/,
      ADJUSTMENT_DECREASE: /Điều chỉnh giảm|Balance Adjustment — decrease/,
    }

    for (const value of CATEGORYLESS_TYPES) {
      const radio = page.getByRole('radio', { name: TYPE_LABELS[value] })
      await radio.click()
      await expect(page.getByRole('combobox', { name: /Danh mục|^Category$/ })).toHaveCount(0)
      await expect(radio).toHaveAttribute('aria-checked', 'true')
    }
  })

  test('the raw server HTML carries the gate on both the radiogroup and the split date/time', async ({
    page,
  }) => {
    // Deterministic: a raw response body, no timing at all. Extends the
    // "server HTML gates every money form" block above rather than
    // duplicating its GATED_PAGES loop.
    const response = await page.request.get('/transactions')
    const html = await response.text()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    const typeGroup = radiogroupMarkup(html)
    expect(typeGroup).toMatch(/aria-checked="true"[^>]*>(Chi tiêu|Expense)/)
    expect(html).toMatch(/id="transaction-date-[^"]*"[^>]*value="\d{4}-\d{2}-\d{2}"/)
    expect(html).toMatch(/id="transaction-time-[^"]*"[^>]*value="\d{2}:\d{2}"/)
  })

  test('a second submit is impossible while the first is in flight', async ({ page }) => {
    await page.goto('/transactions')
    await page.getByRole('radio', { name: /Chi tiêu|^Expense$/ }).click()
    await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
    await page.getByRole('option').first().click()
    await page.getByLabel(/Số tiền|^Amount$/).fill('12345')

    // Hold the server action so the lock is observable. The delay lives in
    // the ROUTE handler — a server-side pause — not in a `waitForTimeout`.
    await page.route('**/transactions', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.fallback()
    })

    const submit = page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ })
    // `.first()`: one fieldset today, but a width where both the sticky panel
    // and the sheet were mounted would match two, and a strict locator throws
    // rather than picking one.
    const fieldset = page.locator('form fieldset').first()
    await submit.click()
    await expect(fieldset).toHaveAttribute('aria-busy', 'true')
    // Not `expect(fieldset).toBeDisabled()` / `expect(submit).toBeDisabled()`:
    // verified directly (`fieldset.evaluate((el) => el.disabled)` → `true`)
    // that the fieldset genuinely IS disabled, and that disabling genuinely
    // propagates to the submit button as far as the BROWSER is concerned
    // (`submit.matches(':disabled')` → `true`) — but Playwright's own
    // `isDisabled`/`toBeDisabled` do not special-case `<fieldset>` (they
    // report "enabled" regardless of its `disabled` property) and do not
    // account for ancestor-fieldset disabling on a descendant control either
    // (a plain `<button>`'s OWN `.disabled` IDL property stays `false` when it
    // is only disabled via an ancestor fieldset, which is exactly what
    // `toBeDisabled` reads). `aria-busy` above and the outcome asserted below
    // — one row, not two — are what this test can reliably check.
    await page.unroute('**/transactions')
    await expect(page.getByLabel(/Số tiền|^Amount$/)).toHaveValue('0')
    // Exactly one ROW for that amount — a double submit would make two.
    // Scoped to `listitem`, not a bare `getByText`: the page header's own
    // month-total also happens to read "12.345" when this is the only
    // EXPENSE transaction of the month, so an unscoped text match would
    // count that too and pass even if a duplicate row existed.
    await expect(page.getByRole('listitem').filter({ hasText: '12.345' })).toHaveCount(1)
  })

  test('the split date and time submit as one instant', async ({ page }) => {
    const TODAY = todayInZone('Asia/Ho_Chi_Minh')
    await page.goto('/transactions')
    await page.getByRole('radio', { name: /Chi tiêu|^Expense$/ }).click()
    await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
    await page.getByRole('option').first().click()
    await page.getByLabel(/Số tiền|^Amount$/).fill('77000')
    await page.getByLabel(/^Ngày$|^Date$/).fill(TODAY)
    await page.getByLabel(/^Giờ$|^Time$/).fill('14:30')
    await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
    await expect(page.getByLabel(/Số tiền|^Amount$/)).toHaveValue('0')
    // The row's meta carries the time the two fields combined to, formatted
    // by `formatDate(..., 'dateTime')` in the user's zone.
    await expect(page.getByRole('listitem').filter({ hasText: '77.000' })).toContainText('14:30')
  })
})
