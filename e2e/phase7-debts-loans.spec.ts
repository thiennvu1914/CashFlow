import { test, expect, type Locator, type Page } from '@playwright/test'
import { addMonthsUtcClamped } from '@/lib/datetime/add-months-clamped'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { formatDate } from '@/lib/ui/format-date'
import { authenticatedSession, eitherLocale, todayInZone } from './helpers'

/**
 * Phase 7 Task 8: owner requirement S — coverage the Debts/Loans rebuild adds
 * on top of `phase6.spec.ts` (which this task already migrated to the new
 * two-section/PlanningRow/Dialog/ConfirmDialog UI). This file is the NEW,
 * additional coverage: the two directional Debts sections and their separate
 * per-currency subtotals, the payment Dialog's outstanding/status update and
 * its friendly OVERPAYMENT message, the payment-history disclosure, write-off
 * and close-loan behind a `ConfirmDialog`, the loan instalment Dialog's live
 * Tổng (a computed figure at every point, including two blank/zero parts,
 * never an em dash), and real localisation (vi by default, English through
 * Settings — `resolveLocale()` reads the signed-in session's stored `locale`
 * before the `NEXT_LOCALE` cookie, so a cookie set on an authenticated visit
 * has no effect; `phase7-budgets-goals.spec.ts` and `phase7-dashboard.spec.ts`
 * give the same reasoning).
 *
 * The user's profile defaults (a fresh registration, `lib/auth/user-defaults.ts`)
 * are `baseCurrency: 'VND'` and `timezone: 'Asia/Ho_Chi_Minh'`, and both pages
 * seed their date fields from `todayCalendarDateInZone(timezone, …)` — so
 * `TIMEZONE` below must match.
 *
 * No `waitForTimeout`, no retries, and `playwright.config.ts` runs with
 * `retries: 0`: every value that can still change is asserted through an
 * auto-retrying matcher, and every "today"/"next due" reading goes through
 * `formatDate` exactly as the page renders it, never a raw carrier string.
 */

const TIMEZONE = 'Asia/Ho_Chi_Minh'

const SESSION = authenticatedSession('phase7-debts-loans')

const TODAY = todayInZone(TIMEZONE)

/** Where a MONTHLY loan due today lands after one accepted instalment — the
 *  same month arithmetic `e2e/phase6.spec.ts`'s `NEXT_DUE_AFTER_ONE_PAYMENT`
 *  uses, so a test run on the 31st expects the 28th/29th and not a rollover. */
const NEXT_DUE_AFTER_ONE_PAYMENT = formatCalendarDate(
  addMonthsUtcClamped(calendarDateToUtcCarrier(TODAY), 1),
)

/** A `yyyy-MM-dd` calendar-date carrier, formatted the way `formatDate(...,
 *  'date')` actually displays it on a row — in either locale. Never the raw
 *  carrier string, which is only what an `<input type="date">`'s VALUE holds. */
function displayDate(carrier: string): RegExp {
  return eitherLocale(
    formatDate(carrier, { locale: 'vi', timeZone: TIMEZONE, style: 'date' }),
    formatDate(carrier, { locale: 'en', timeZone: TIMEZONE, style: 'date' }),
  )
}

/** The `<li>` row `DebtList`/`LoanList` renders for one record, found by the
 *  visible name in its header line (a debt's person, a loan's lender). */
function namedRow(page: Page, root: Page | Locator, name: string): Locator {
  return root.locator('li').filter({ has: page.getByText(name, { exact: true }) })
}

/** Opens a row's `…` menu — `name` is the row's own visible label. */
async function openRowMenu(page: Page, row: Locator, name: string): Promise<void> {
  await row
    .getByRole('button', { name: eitherLocale(`Tác vụ cho ${name}`, `Actions for ${name}`) })
    .click()
}

/** The `<details>` whose `<summary>` reads exactly `summary` (a `RegExp` for a
 *  vi/en alternation). */
function detailsFor(page: Page, summary: string | RegExp): Locator {
  return page.locator('details').filter({ has: page.getByText(summary, { exact: true }) })
}

async function openDetails(details: Locator): Promise<Locator> {
  await details.locator('summary').first().click()
  return details
}

/**
 * Creates one debt through the `/debts` page's header action ("Thêm công
 * nợ") and its create `Sheet` — the same flow `e2e/phase6.spec.ts`'s local
 * helper uses.
 */
async function createDebtViaUi(
  page: Page,
  opts: { direction: 'RECEIVABLE' | 'PAYABLE'; person: string; amount: number },
): Promise<void> {
  await page.goto('/debts')
  await page.getByRole('button', { name: /Thêm công nợ|Add debt/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm công nợ|Add debt/ })
  await sheet.getByLabel(/^Chiều$|^Direction$/).selectOption(opts.direction)
  await sheet.getByLabel(/^Người$|^Person$/).fill(opts.person)
  await sheet.getByLabel(/Số tiền ban đầu|Original amount/).fill(String(opts.amount))
  await sheet.getByRole('button', { name: /Thêm công nợ|Add debt/ }).click()
  await expect(sheet).toBeHidden()
}

/**
 * Creates one loan through the `/loans` page's header action ("Thêm khoản
 * vay") and its create `Sheet` — the same flow `e2e/phase6.spec.ts`'s local
 * helper uses.
 */
async function createLoanViaUi(
  page: Page,
  opts: {
    lender: string
    principal: number
    interestRate: number
    termMonths: number
    scheduledPayment: number
  },
): Promise<void> {
  await page.goto('/loans')
  await page.getByRole('button', { name: /Thêm khoản vay|Add loan/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm khoản vay|Add loan/ })
  await sheet.getByLabel(/^Bên cho vay$|^Lender$/).fill(opts.lender)
  await sheet.getByLabel(/^Số tiền vay$|^Principal$/).fill(String(opts.principal))
  await sheet.getByLabel(/Lãi suất|Interest rate/).fill(String(opts.interestRate))
  await sheet.getByLabel(/^Ngày bắt đầu$|^Start date$/).fill(TODAY)
  await sheet.getByLabel(/Kỳ hạn|Term \(months\)/).fill(String(opts.termMonths))
  await sheet.getByLabel(/Tần suất trả|Payment frequency/).selectOption('MONTHLY')
  await sheet.getByLabel(/Số tiền mỗi kỳ|Scheduled payment/).fill(String(opts.scheduledPayment))
  await sheet.getByRole('button', { name: /Thêm khoản vay|Add loan/ }).click()
  await expect(sheet).toBeHidden()
}

test.describe.serial('Phase 7 Task 8 — debts, loans', () => {
  test.use({ storageState: SESSION.path })
  test.describe.configure({ timeout: 120_000 })

  test.beforeAll(async ({ browser }) => {
    await SESSION.bootstrap(browser)
  })

  test('vi: receivable and payable sections show separate per-currency subtotals, and a row states counterparty/direction/status', async ({
    page,
  }) => {
    await createDebtViaUi(page, { direction: 'RECEIVABLE', person: 'Minh', amount: 1_000_000 })
    await createDebtViaUi(page, { direction: 'PAYABLE', person: 'Landlord', amount: 2_000_000 })

    await expect(page.getByRole('heading', { name: 'Người khác nợ bạn', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Bạn nợ người khác', level: 2 })).toBeVisible()

    const minhRow = namedRow(page, page, 'Minh')
    await expect(minhRow).toBeVisible()
    await expect(minhRow.getByText('Minh', { exact: true })).toBeVisible()
    await expect(minhRow.getByText('Họ nợ bạn', { exact: true })).toBeVisible()
    await expect(minhRow.getByText('Đang mở', { exact: true })).toBeVisible()

    const landlordRow = namedRow(page, page, 'Landlord')
    await expect(landlordRow.getByText('Bạn nợ họ', { exact: true })).toBeVisible()

    // Each section states only its own half — never the other figure, and
    // never both stated twice.
    const receivableSubtotal = page.locator('li').filter({ hasText: 'Khoản phải thu' })
    await expect(receivableSubtotal).toContainText('1.000.000')
    await expect(receivableSubtotal).not.toContainText('2.000.000')

    const payableSubtotal = page.locator('li').filter({ hasText: 'Khoản phải trả' })
    await expect(payableSubtotal).toContainText('2.000.000')
    await expect(payableSubtotal).not.toContainText('1.000.000')
  })

  test('record a payment via the Dialog updates the outstanding figure and status to Partly paid; overpayment shows the friendly error', async ({
    page,
  }) => {
    await page.goto('/debts')
    const row = namedRow(page, page, 'Minh')

    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Minh' })
    await expect(dialog.getByText('Số tiền')).toBeVisible()
    await dialog.getByLabel('Số tiền').fill('400000')
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog).toBeHidden()

    await expect(row.getByText('Trả một phần', { exact: true })).toBeVisible()
    await expect(row).toContainText('600.000')
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')

    // Overpayment: the friendly, translated server message — never a raw
    // error code or an untranslated English literal.
    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    await dialog.getByLabel('Số tiền').fill('900000')
    await dialog.getByRole('button', { name: 'Lưu' }).click()

    await expect(dialog.getByText('Khoản thanh toán lớn hơn số còn nợ.')).toBeVisible()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Hủy' }).click()
    await expect(row).toContainText('600.000')
  })

  test("the payment history is inspectable through the row's own disclosure without permanently expanding every row", async ({
    page,
  }) => {
    await page.goto('/debts')
    const row = namedRow(page, page, 'Minh')

    const toggle = row.getByText('Lần thanh toán (1)', { exact: true })
    await expect(toggle).toBeVisible()
    // Collapsed by default: the amount is not yet visible.
    await expect(row.getByText('400.000')).toBeHidden()
    await toggle.click()
    await expect(row.getByText('400.000')).toBeVisible()
  })

  test('write off via … → ConfirmDialog: Cancel keeps the debt, Confirm marks it Written off and moves it to the written-off section', async ({
    page,
  }) => {
    await page.goto('/debts')
    const row = namedRow(page, page, 'Landlord')

    await openRowMenu(page, row, 'Landlord')
    await page.getByRole('menuitem', { name: 'Xóa nợ' }).click()
    const confirmDialog = page.getByRole('dialog', { name: 'Xóa nợ của Landlord?' })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Hủy' }).click()
    await expect(confirmDialog).toBeHidden()
    await expect(row.getByText('Đang mở', { exact: true })).toBeVisible()

    await openRowMenu(page, row, 'Landlord')
    await page.getByRole('menuitem', { name: 'Xóa nợ' }).click()
    await page
      .getByRole('dialog', { name: 'Xóa nợ của Landlord?' })
      .getByRole('button', { name: 'Xóa nợ' })
      .click()

    const writtenOff = detailsFor(page, 'Công nợ đã xóa (1)')
    await expect(writtenOff).toBeVisible()
    await openDetails(writtenOff)
    const writtenOffRow = namedRow(page, writtenOff, 'Landlord')
    await expect(writtenOffRow.getByText('Đã xóa nợ', { exact: true })).toBeVisible()
    await expect(writtenOffRow.getByRole('button')).toHaveCount(0)
  })

  test('the loan instalment Dialog shows Tổng computed live and never as a dash, including two blank/zero parts; a principal above outstanding shows the friendly error', async ({
    page,
  }) => {
    await createLoanViaUi(page, {
      lender: 'Bank',
      principal: 10_000_000,
      interestRate: 8.5,
      termMonths: 12,
      scheduledPayment: 900_000,
    })

    const row = namedRow(page, page, 'Bank')
    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Bank' })
    const principal = dialog.getByLabel('Gốc')
    const interest = dialog.getByLabel('Lãi')
    const total = dialog.getByLabel('Tổng')

    // Both parts blank: Tổng reads a computed zero, never an em dash.
    await expect(total).toHaveValue(/^0(,00)?\s?VND$/)
    await expect(total).not.toHaveValue('—')

    // Explicit zeros: still a computed figure, never a dash.
    await principal.fill('0')
    await interest.fill('0')
    await expect(total).toHaveValue(/^0(,00)?\s?VND$/)
    await expect(total).not.toHaveValue('—')

    // A real split: Tổng is the live sum.
    await principal.fill('900000')
    await interest.fill('85000')
    await expect(total).toHaveValue(/985.000/)
    await expect(total).not.toHaveValue('—')

    // A principal above what is outstanding → the friendly OVERPAYMENT
    // message, never a raw server error.
    await principal.fill('10000001')
    await interest.fill('0')
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog.getByText('Phần gốc thanh toán lớn hơn dư nợ gốc còn lại.')).toBeVisible()

    // Correct it to exactly the scheduled instalment, and save for real.
    await principal.fill('900000')
    await interest.fill('85000')
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog).toBeHidden()

    // The next-due text is present after the payment (the schedule advanced
    // exactly one calendar month, month-end clamp unchanged), and the
    // outstanding principal moved.
    await expect(row).toContainText('9.100.000')
    await expect(row).toContainText(/Kỳ tới/)
    await expect(row).toContainText(displayDate(NEXT_DUE_AFTER_ONE_PAYMENT))
  })

  test('close loan via ConfirmDialog', async ({ page }) => {
    await page.goto('/loans')
    const row = namedRow(page, page, 'Bank')

    await openRowMenu(page, row, 'Bank')
    await page.getByRole('menuitem', { name: 'Đóng khoản vay' }).click()
    const confirmDialog = page.getByRole('dialog', { name: 'Đóng khoản vay với Bank?' })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Hủy' }).click()
    await expect(confirmDialog).toBeHidden()

    await openRowMenu(page, row, 'Bank')
    await page.getByRole('menuitem', { name: 'Đóng khoản vay' }).click()
    await page
      .getByRole('dialog', { name: 'Đóng khoản vay với Bank?' })
      .getByRole('button', { name: 'Đóng khoản vay' })
      .click()

    const closed = detailsFor(page, 'Khoản vay đã đóng (1)')
    await expect(closed).toBeVisible()
    await openDetails(closed)
    const closedRow = namedRow(page, closed, 'Bank')
    await expect(closedRow.getByText('Đã đóng', { exact: true })).toBeVisible()
    await expect(closedRow.getByRole('button')).toHaveCount(0)
  })

  test('375: no horizontal overflow on /debts or /loans', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })

    for (const url of ['/debts', '/loans']) {
      await page.goto(url)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      )
      expect(overflow, url).toBe(true)
    }
  })

  test('switching to English in Settings renders debt/loan direction and status text in English, with no raw enum text', async ({
    page,
  }) => {
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('en')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    await page.goto('/debts')
    // Minh (receivable) is still active, so that section renders; Landlord
    // (the only payable debt) was written off in an earlier test, so the
    // payable section has nothing left to show and correctly renders no
    // section header at all — never an empty one.
    await expect(page.getByRole('heading', { name: 'People who owe you', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'People you owe', level: 2 })).toHaveCount(0)

    const writtenOff = detailsFor(page, 'Written-off debts (1)')
    await expect(writtenOff).toBeVisible()
    await openDetails(writtenOff)
    await expect(
      namedRow(page, writtenOff, 'Landlord').getByText('Written off', { exact: true }),
    ).toBeVisible()

    await page.goto('/loans')
    const closed = detailsFor(page, 'Closed loans (1)')
    await expect(closed).toBeVisible()
    await openDetails(closed)
    await expect(namedRow(page, closed, 'Bank').getByText('Closed', { exact: true })).toBeVisible()

    // No raw enum anywhere on either page.
    for (const url of ['/debts', '/loans']) {
      await page.goto(url)
      const bodyText = await page.locator('main').innerText()
      expect(bodyText, url).not.toMatch(
        /\bRECEIVABLE\b|\bPAYABLE\b|\bOPEN\b|\bPARTIALLY_PAID\b|\bWRITTEN_OFF\b|\bACTIVE\b|\bOVERDUE\b|\bPAID_OFF\b|\bCLOSED\b|\bMONTHLY\b|\bWEEKLY\b|\bYEARLY\b/,
      )
    }

    // fix round 1, finding 1: Tổng's digit grouping must follow the READER's
    // locale, not a hard-coded 'vi' default — `formatMoney`'s locale
    // parameter defaults to 'vi' when omitted, which is exactly the bug this
    // guards against. Bank (this file's only loan) was closed in an earlier
    // test, so a fresh loan is created here, now that the page itself
    // renders in English, to open a payment dialog against.
    await createLoanViaUi(page, {
      lender: 'English Bank',
      principal: 10_000_000,
      interestRate: 5,
      termMonths: 12,
      scheduledPayment: 900_000,
    })
    const englishRow = namedRow(page, page, 'English Bank')
    await englishRow.getByRole('button', { name: 'Record payment' }).click()
    const englishDialog = page.getByRole('dialog', { name: 'Record payment · English Bank' })
    await englishDialog.getByLabel('Principal').fill('3000000')
    await englishDialog.getByLabel('Interest').fill('800000')
    const englishTotal = englishDialog.getByLabel('Total')
    // Comma grouping (en-US), never the Vietnamese dot grouping.
    await expect(englishTotal).toHaveValue(/3,800,000/)
    await expect(englishTotal).not.toHaveValue(/3\.800\.000/)
  })
})
