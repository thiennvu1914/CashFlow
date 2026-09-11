import { test, expect } from '@playwright/test'
import { authenticatedSession, createAccountViaUi, createTransactionViaUi, PAGES } from './helpers'

/**
 * The guarantee spec §4 asks for, as a test rather than a habit (Task 13,
 * Step 4): **no raw enum reaches the DOM, in either locale (D1)**. Also
 * asserts exactly one `h1` per page (Task 13, Step 4's completion gate) —
 * kept in this file rather than a separate a11y spec because it walks the
 * exact same `PAGES` loop the enum sweep already does.
 *
 * `CASH_OUT`, `ADJUSTMENT_DECREASE`, `WRITTEN_OFF`, `PARTIALLY_PAID`,
 * `ONE_TIME`, `PAID_OFF` — every one of them was on screen somewhere before
 * Phase 7, because a view model's `?? row.type` fallback or a missing label
 * map let it through. The multi-underscore half of the regex below catches
 * the SHAPE, not a list, so a NEW multi-word enum member added in a later
 * phase is caught the first time it renders.
 *
 * That shape alone (fix round 1, Important 1) can never catch a SINGLE-WORD
 * enum member — `ACTIVE`, `PENDING`, `CLOSED` and the rest have no
 * underscore, so `/\b[A-Z]{2,}(?:_[A-Z]+)+\b/` structurally cannot match
 * them regardless of what leaks. Those have to be named, so `SINGLE_WORD_ENUMS`
 * below is every single-word value in `prisma/schema.prisma`'s enums plus the
 * single-word members of the derived display-status unions
 * (`DebtDisplayStatus`, `LoanDisplayStatus` in `lib/server/services/*.ts`)
 * that are not already a schema enum's own value. Currency codes (`VND`,
 * `USD`) are deliberately NOT in this list — they are legitimate data shown
 * everywhere, never a state a label map translates.
 *
 * MAINTENANCE: when a schema enum (`prisma/schema.prisma`) or a display-status
 * union gains a new single-word member, add it here. A new MULTI-word member
 * needs no change — the shape half of the regex already catches it.
 *
 * Deliberately scoped to `main`'s text content, not the whole document: a
 * `<select>`'s `value` attributes and a `data-*` hook legitimately carry the
 * enum, and only what a person can READ is the subject.
 */
const SINGLE_WORD_ENUMS = [
  // RecordStatus, SavingsGoalStatus, DebtStoredStatus, LoanStoredStatus
  'ACTIVE',
  'ARCHIVED',
  // CategoryType, TransactionType, ReminderType
  'INCOME',
  'EXPENSE',
  // BudgetScope
  'OVERALL',
  'CATEGORY',
  // SavingsGoalStatus
  'ACHIEVED',
  // DebtDirection
  'RECEIVABLE',
  'PAYABLE',
  // LoanStoredStatus
  'CLOSED',
  // PaymentFrequency, RecurrenceFrequency
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
  // OccurrenceStatus
  'PENDING',
  'ACKNOWLEDGED',
  'DISMISSED',
  // DebtDisplayStatus (not already a schema enum value)
  'OPEN',
  'PAID',
  // DebtDisplayStatus / LoanDisplayStatus (shared)
  'OVERDUE',
] as const

const RAW_ENUM = new RegExp(
  String.raw`\b(?:[A-Z]{2,}(?:_[A-Z]+)+|${SINGLE_WORD_ENUMS.join('|')})\b`,
)

/**
 * Ids and codes that legitimately look like the pattern. Empty on purpose:
 * the list exists so a real exception gets recorded here (with a reason)
 * rather than the regex being loosened to let it through unremarked. If the
 * tightened sweep goes red on a real page, that is a real D1 leak — fix it at
 * the label/view-model layer, never here.
 */
const ALLOWED: string[] = []

const SESSION = authenticatedSession('phase7-sweep')

async function sweepPage(
  page: import('@playwright/test').Page,
  url: string,
  locale: 'vi' | 'en',
): Promise<void> {
  await page.goto(url)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const main = page.locator('main')
  const allowed = new RegExp(ALLOWED.join('|') || '(?!)', 'g')
  // `textContent()`, not `innerText()`: several section headings and table
  // headers (`ChartContainer`'s `<h2>`, the reports account table's `<thead>`,
  // the transactions category-picker's group labels) render with a CSS
  // `uppercase` treatment purely for visual style — `innerText()` reflects
  // that rendered casing, so a perfectly translated "Expense by Category" or
  // "Income vs Expense" comes back as "EXPENSE BY CATEGORY"/"INCOME VS
  // EXPENSE" and false-positives against `SINGLE_WORD_ENUMS`. `textContent()`
  // returns the actual DOM string, which is what "a raw enum reaches the
  // DOM" is actually asking about — a genuine leak (`{row.type}` interpolated
  // bare) still appears verbatim in `textContent` exactly as it would in
  // `innerText`, so this loses no real detection power. (Found and fixed
  // fix round 1: the untightened, underscore-only regex could never have
  // surfaced this, because "EXPENSE" alone was never in the pattern.)
  const text = (await main.textContent())!.replace(allowed, '')
  const match = text.match(RAW_ENUM)
  expect(match, `${url} (${locale}) shows "${match?.[0]}"`).toBeNull()
}

test.describe.serial('Phase 7 — no raw enum on screen', () => {
  test.use({ storageState: SESSION.path })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)

    await SESSION.bootstrap(browser, async (page) => {
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
    })
  })

  test.describe.serial('vi', () => {
    for (const url of PAGES) {
      test(`${url} renders no raw enum in Vietnamese (vi)`, async ({ page }) => {
        await sweepPage(page, url, 'vi')
      })
    }
  })

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
    //
    // Runs while the account is still Vietnamese — the labels asserted below
    // are vi-only, and the 'en' describe block after this one switches the
    // account's language for the rest of the file.
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

  test.describe.serial('en', () => {
    test.beforeAll(async ({ browser }) => {
      // Switches the account itself to English (persisted on `User.locale`,
      // which `resolveLocale()` reads before any cookie — see
      // `lib/i18n/config.ts`), through the real Settings form rather than a
      // `NEXT_LOCALE` cookie: for a SIGNED-IN session the cookie is only a
      // mirror and never wins over the stored preference, so setting the
      // cookie alone would silently do nothing here.
      const context = await browser.newContext({ storageState: SESSION.path })
      const page = await context.newPage()
      await page.goto('/settings')
      await page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: /Tùy chọn|Preferences/ }) })
        .getByLabel(/Ngôn ngữ|Language/)
        .selectOption('en')
      await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
      await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()
      await context.close()
    })

    for (const url of PAGES) {
      test(`${url} renders no raw enum in English (en)`, async ({ page }) => {
        await sweepPage(page, url, 'en')
      })
    }
  })
})
