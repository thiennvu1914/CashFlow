import { test, expect, type Locator, type Page } from '@playwright/test'
import { addMonthsUtcClamped } from '@/lib/datetime/add-months-clamped'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { formatDate } from '@/lib/ui/format-date'
import { authenticatedSession, createAccountViaUi, eitherLocale, todayInZone } from './helpers'

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

/** A new loan's first due date (the form seeds it one month after the start
 *  date), and where a MONTHLY loan lands after one accepted instalment — the
 *  same month arithmetic `e2e/phase6.spec.ts` uses, so a test run on the 31st
 *  expects the 28th/29th and not a rollover. */
const FIRST_DUE = formatCalendarDate(addMonthsUtcClamped(calendarDateToUtcCarrier(TODAY), 1))
// Two months after the start, from the START day: the form anchors the schedule on
// it (Jan 31 start: Feb 28, then Mar 31 — not Mar 28).
const NEXT_DUE_AFTER_ONE_PAYMENT = formatCalendarDate(
  addMonthsUtcClamped(calendarDateToUtcCarrier(TODAY), 2),
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
  // The account picker starts on the user's most recently used account, which
  // would record the loan as a ledger transaction and move balances. Callers of
  // this helper want a tracking-only loan (the account-linked flow has its own
  // coverage in `phase7-debts-loans.spec.ts`), so "don't record" is chosen
  // explicitly.
  await sheet.getByLabel(/^Nhận tiền vào tài khoản$|^Received into account$/).selectOption('')
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
    // Written off, every write is refused but one: the debt moved no money yet,
    // so its only action is "Record in an account" (spec 2026-10-12 §6.4).
    await expect(writtenOffRow.getByRole('button')).toHaveCount(1)
    await openRowMenu(page, writtenOffRow, 'Landlord')
    await expect(page.getByRole('menuitem')).toHaveText(['Ghi vào tài khoản'])
    await page.keyboard.press('Escape')
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
    const total = dialog.getByLabel('Tổng')
    const interest = dialog.getByLabel('Lãi')
    const principal = dialog.getByLabel('Gốc')

    // Pre-filled with the scheduled instalment; the interest is 0, so Gốc is
    // the whole total — a computed figure, never an em dash.
    await expect(total).toHaveValue('900000')
    await expect(principal).toHaveValue(/^900.000(,00)?\s?VND$/)
    await expect(principal).not.toHaveValue('—')

    // Interest equal to the total: an interest-only instalment, principal 0.
    await interest.fill('900000')
    await expect(principal).toHaveValue(/^0(,00)?\s?VND$/)
    await expect(principal).not.toHaveValue('—')

    // A real split: Gốc is the live difference.
    await interest.fill('85000')
    await expect(principal).toHaveValue(/815.000/)
    await expect(principal).not.toHaveValue('—')

    // Both blank: still a figure.
    await total.fill('')
    await interest.fill('')
    await expect(principal).toHaveValue(/^0(,00)?\s?VND$/)

    // A principal above what is outstanding → the friendly OVERPAYMENT
    // message, never a raw server error.
    await total.fill('10000001')
    await interest.fill('0')
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog.getByText('Phần gốc thanh toán lớn hơn dư nợ gốc còn lại.')).toBeVisible()

    // Correct it to the scheduled instalment with 85.000 of interest, and save
    // for real.
    await total.fill('985000')
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
    // Closed, every write is refused but one: the loan moved no money yet, so
    // its only action is "Record in an account" (spec 2026-10-12 §6.4).
    await expect(closedRow.getByRole('button')).toHaveCount(1)
    await openRowMenu(page, closedRow, 'Bank')
    await expect(page.getByRole('menuitem')).toHaveText(['Ghi vào tài khoản'])
    await page.keyboard.press('Escape')
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
    await englishDialog.getByLabel('Total').fill('3800000')
    await englishDialog.getByLabel('Interest').fill('800000')
    const englishPrincipal = englishDialog.getByLabel('Principal')
    // Comma grouping (en-US), never the Vietnamese dot grouping.
    await expect(englishPrincipal).toHaveValue(/3,000,000/)
    await expect(englishPrincipal).not.toHaveValue(/3\.000\.000/)
  })
})

/**
 * Money-source linking (spec 2026-10-12 §6.2, owner decision Q2): a debt and
 * its repayments can be recorded in an account, and then the account's derived
 * balance on `/accounts` follows — created, recorded, corrected and deleted —
 * or not recorded at all, in which case nothing moves.
 *
 * Its own user (`authenticatedSession` label): the describe above ends with the
 * profile switched to English and a handful of debts the figures below must not
 * share. One account, "Cash" at 5.000.000, so the picker's pre-selection (the
 * first active account, as the user has no transaction yet) is the account the
 * balances are read from.
 */
const LINKING_SESSION = authenticatedSession('phase7-debts-linking')

/**
 * Every date here is left at its default, today: an entry dated today is stamped
 * with the current instant, so the balance follows at once at any time of day.
 */

/** Cash's balance as `/accounts` renders it on the account's own row. */
async function expectCashBalance(page: Page, balance: string): Promise<void> {
  await page.goto('/accounts')
  await expect(namedRow(page, page, 'Cash')).toContainText(balance)
}

test.describe.serial('Money-source linking — debts', () => {
  test.use({ storageState: LINKING_SESSION.path })
  test.describe.configure({ timeout: 120_000 })

  test.beforeAll(async ({ browser }) => {
    await LINKING_SESSION.bootstrap(browser, async (page) => {
      await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    })
  })

  test('lending to someone from an account lowers its balance; the picker starts on that account with its currency read-only', async ({
    page,
  }) => {
    await page.goto('/debts')
    await page.getByRole('button', { name: 'Thêm công nợ' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm công nợ' })

    const account = sheet.getByLabel('Tài khoản')
    await expect(account.locator('option').first()).toHaveText('Không ghi vào tài khoản')
    await expect(account).toHaveValue(/.+/)
    await expect(account.locator('option:checked')).toHaveText('Cash · VND')
    // An account chosen: the money-moved-on date shows, the currency is the
    // account's and read-only (never the VND/USD choice).
    await expect(sheet.getByLabel('Tiền đi ngày')).toHaveValue(TODAY)
    await expect(sheet.getByLabel('Tiền tệ')).toHaveValue('VND')
    await expect(sheet.getByLabel('Tiền tệ')).toHaveJSProperty('readOnly', true)

    await sheet.getByLabel('Chiều').selectOption('RECEIVABLE')
    await sheet.getByLabel('Người', { exact: true }).fill('Minh')
    await sheet.getByLabel('Số tiền ban đầu').fill('1000000')
    await sheet.getByRole('button', { name: 'Thêm công nợ' }).click()
    await expect(sheet).toBeHidden()

    await expectCashBalance(page, '4.000.000')
  })

  test('recording a repayment starts on the opening account and raises the balance; editing and deleting it moves the balance back', async ({
    page,
  }) => {
    await page.goto('/debts')
    const row = namedRow(page, page, 'Minh')

    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Minh' })
    await expect(dialog.getByLabel('Tài khoản').locator('option:checked')).toHaveText('Cash · VND')
    await dialog.getByLabel('Số tiền').fill('400000')
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog).toBeHidden()
    await expectCashBalance(page, '4.400.000')

    // Edit: the same form, prefilled with what was recorded.
    await page.goto('/debts')
    await row.getByText('Lần thanh toán (1)', { exact: true }).click()
    await row.getByRole('button', { name: /^Sửa thanh toán / }).click()
    const editDialog = page.getByRole('dialog', { name: 'Sửa thanh toán · Minh' })
    await expect(editDialog.getByLabel('Số tiền')).toHaveValue('400000')
    await expect(editDialog.getByLabel('Tài khoản').locator('option:checked')).toHaveText(
      'Cash · VND',
    )
    await editDialog.getByLabel('Số tiền').fill('300000')
    await editDialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(editDialog).toBeHidden()
    await expect(row).toContainText('700.000')
    await expectCashBalance(page, '4.300.000')

    // Delete: the confirmation says the transaction goes too.
    await page.goto('/debts')
    await row.getByText('Lần thanh toán (1)', { exact: true }).click()
    await row.getByRole('button', { name: /^Xóa thanh toán / }).click()
    const confirm = page.getByRole('dialog', { name: 'Xóa lần thanh toán này?' })
    await expect(confirm).toContainText('Giao dịch đã ghi trong tài khoản cũng sẽ bị xóa')
    await confirm.getByRole('button', { name: 'Xóa', exact: true }).click()
    await expect(confirm).toBeHidden()
    await expect(row.getByText('Lần thanh toán', { exact: false })).toHaveCount(0)
    await expectCashBalance(page, '4.000.000')
  })

  test('a repayment recorded in an account cannot be dated after today (Ruling P12)', async ({
    page,
  }) => {
    const tomorrow = formatCalendarDate(
      new Date(calendarDateToUtcCarrier(TODAY).getTime() + 24 * 60 * 60 * 1000),
    )
    await page.goto('/debts')
    const row = namedRow(page, page, 'Minh')
    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Minh' })
    await expect(dialog.getByLabel('Tài khoản').locator('option:checked')).toHaveText('Cash · VND')
    await dialog.getByLabel('Số tiền').fill('100000')
    await dialog.getByLabel('Ngày thanh toán').fill(tomorrow)
    await dialog.getByRole('button', { name: 'Lưu' }).click()

    // Refused on the date field, from the page's own "today" — nothing written.
    await expect(dialog.getByText('Ngày không được sau hôm nay')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expectCashBalance(page, '4.000.000')
  })

  test("choosing 'don't record in an account' creates the debt and a repayment without touching any balance, and offers the currency choice", async ({
    page,
  }) => {
    await page.goto('/debts')
    await page.getByRole('button', { name: 'Thêm công nợ' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm công nợ' })

    await sheet.getByLabel('Tài khoản').selectOption('')
    // No account: no money-moved-on date, and the currency is a real choice.
    await expect(sheet.getByLabel('Tiền đi ngày')).toHaveCount(0)
    await expect(sheet.getByLabel('Tiền tệ')).toHaveValue('VND')
    await sheet.getByLabel('Tiền tệ').selectOption('USD')
    await sheet.getByLabel('Chiều').selectOption('PAYABLE')
    await sheet.getByLabel('Người', { exact: true }).fill('Landlord')
    await sheet.getByLabel('Số tiền ban đầu').fill('2000')
    await sheet.getByRole('button', { name: 'Thêm công nợ' }).click()
    await expect(sheet).toBeHidden()

    const row = namedRow(page, page, 'Landlord')
    await expect(row).toContainText('USD')
    // The only account is in VND, so a USD debt's picker offers nothing but
    // "don't record" — and a repayment with it moves no money either.
    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Landlord' })
    await expect(dialog.getByLabel('Tài khoản').locator('option')).toHaveCount(1)
    await dialog.getByLabel('Số tiền').fill('500')
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toContainText('1.500')

    await expectCashBalance(page, '4.000.000')
  })

  test("'Record in an account' books a debt created without one — and its existing repayment — into the account, then disappears", async ({
    page,
  }) => {
    // An agreement from before linking: the debt and a repayment, both with
    // "don't record in an account", so Cash does not move.
    await page.goto('/debts')
    await page.getByRole('button', { name: 'Thêm công nợ' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm công nợ' })
    await sheet.getByLabel('Tài khoản').selectOption('')
    await sheet.getByLabel('Chiều').selectOption('RECEIVABLE')
    await sheet.getByLabel('Người', { exact: true }).fill('Hoa')
    await sheet.getByLabel('Số tiền ban đầu').fill('600000')
    await sheet.getByRole('button', { name: 'Thêm công nợ' }).click()
    await expect(sheet).toBeHidden()

    const row = namedRow(page, page, 'Hoa')
    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const payment = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Hoa' })
    await payment.getByLabel('Tài khoản').selectOption('')
    await payment.getByLabel('Số tiền').fill('200000')
    await payment.getByRole('button', { name: 'Lưu' }).click()
    await expect(payment).toBeHidden()
    await expectCashBalance(page, '4.000.000')

    // Linked debts do not offer it: Minh's opening is already in Cash.
    await page.goto('/debts')
    await openRowMenu(page, namedRow(page, page, 'Minh'), 'Minh')
    await expect(
      page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')

    await openRowMenu(page, row, 'Hoa')
    await page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }).click()
    const link = page.getByRole('dialog', { name: 'Ghi vào tài khoản · Hoa' })
    // Only accounts in the debt's currency, and no "don't record" here.
    const account = link.getByLabel('Tài khoản')
    await expect(account.locator('option')).toHaveCount(1)
    await expect(account.locator('option:checked')).toHaveText('Cash · VND')
    // The debt was added today, which is the default day the money moved.
    await expect(link.getByLabel('Tiền đi ngày')).toHaveValue(TODAY)
    await expect(link.getByLabel('Ghi bù 1 lần trả đã có')).toBeChecked()
    await link.getByRole('button', { name: 'Ghi vào tài khoản' }).click()
    await expect(link).toBeHidden()

    // Recorded: the action is gone from the row's menu.
    await openRowMenu(page, row, 'Hoa')
    await expect(page.getByRole('menuitem', { name: 'Sửa' })).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')

    // 4.000.000 − 600.000 lent + 200.000 repaid.
    await expectCashBalance(page, '3.600.000')
    await page.goto('/transactions')
    await expect(page.getByText('Cho mượn – Hoa', { exact: true })).toBeVisible()
    await expect(page.getByText('Thu nợ – Hoa', { exact: true })).toBeVisible()
  })

  test("'Remove from account' takes a debt recorded in the wrong account back out — the balance moves back — and it can then be recorded in another one", async ({
    page,
  }) => {
    // The account Hoa should have been recorded in.
    await createAccountViaUi(page, { name: 'Bank', currency: 'VND', initialBalance: 1_000_000 })

    await page.goto('/debts')
    const row = namedRow(page, page, 'Hoa')
    await openRowMenu(page, row, 'Hoa')
    // Recorded, so the menu offers the undo rather than recording it again.
    await expect(
      page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }),
    ).toHaveCount(0)
    await page.getByRole('menuitem', { name: 'Bỏ ghi vào tài khoản' }).click()
    const confirm = page.getByRole('dialog', { name: 'Bỏ ghi khoản nợ với Hoa khỏi tài khoản?' })
    const payments = confirm.getByLabel('Bỏ ghi cả 1 lần trả đã ghi vào tài khoản')
    await expect(payments).toBeChecked()
    await expect(confirm).toContainText('giao dịch của 1 lần trả')
    // Unticked, the confirmation says the repayment keeps its transaction.
    await payments.uncheck()
    await expect(confirm).toContainText('vẫn giữ giao dịch của chúng')
    await payments.check()
    await confirm.getByRole('button', { name: 'Bỏ ghi vào tài khoản' }).click()
    await expect(confirm).toBeHidden()

    // Back to where Cash was before Hoa was recorded, and both rows are gone.
    await expectCashBalance(page, '4.000.000')
    await page.goto('/transactions')
    await expect(page.getByText('Cho mượn – Hoa', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Thu nợ – Hoa', { exact: true })).toHaveCount(0)

    // The debt and its repayment stay, and "Record in an account" is back.
    await page.goto('/debts')
    await expect(row).toContainText('400.000')
    await openRowMenu(page, row, 'Hoa')
    await page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }).click()
    const link = page.getByRole('dialog', { name: 'Ghi vào tài khoản · Hoa' })
    await link.getByLabel('Tài khoản').selectOption({ label: 'Bank · VND' })
    await expect(link.getByLabel('Ghi bù 1 lần trả đã có')).toBeChecked()
    await link.getByRole('button', { name: 'Ghi vào tài khoản' }).click()
    await expect(link).toBeHidden()

    await expectCashBalance(page, '4.000.000')
    // 1.000.000 − 600.000 lent + 200.000 repaid.
    await expect(namedRow(page, page, 'Bank')).toContainText('600.000')
  })
})

/**
 * Money-source linking for loans (spec 2026-10-12 §6.3, owner decision Q2): a
 * loan received into an account raises its balance; an instalment paid from an
 * account lowers it by the total (principal and interest are two transactions,
 * the interest one filed under "Lãi vay & phí"); correcting or deleting
 * the instalment moves the balance back — or the loan is not recorded at all
 * and nothing moves.
 *
 * Its own user, one account "Cash" at 5.000.000 (the picker's pre-selection:
 * the first active account while the user has no transaction yet).
 */
const LOAN_LINKING_SESSION = authenticatedSession('phase7-loans-linking')

test.describe.serial('Money-source linking — loans', () => {
  test.use({ storageState: LOAN_LINKING_SESSION.path })
  test.describe.configure({ timeout: 120_000 })

  test.beforeAll(async ({ browser }) => {
    await LOAN_LINKING_SESSION.bootstrap(browser, async (page) => {
      await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    })
  })

  test('a loan received into an account raises its balance; the picker starts on that account, the currency is read-only and the next due date is a month after the start', async ({
    page,
  }) => {
    await page.goto('/loans')
    await page.getByRole('button', { name: 'Thêm khoản vay' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm khoản vay' })

    const account = sheet.getByLabel('Nhận tiền vào tài khoản')
    await expect(account.locator('option').first()).toHaveText('Không ghi vào tài khoản')
    await expect(account.locator('option:checked')).toHaveText('Cash · VND')
    await expect(sheet.getByLabel('Tiền tệ')).toHaveValue('VND')
    await expect(sheet.getByLabel('Tiền tệ')).toHaveJSProperty('readOnly', true)
    await expect(sheet.getByLabel('Ngày bắt đầu')).toHaveValue(TODAY)
    // Not today: the first instalment is one period after the start date.
    await expect(sheet.getByLabel('Kỳ tới')).toHaveValue(FIRST_DUE)
    // ...and it follows the frequency until the user types a date of their own.
    await sheet.getByLabel('Tần suất trả').selectOption('YEARLY')
    await expect(sheet.getByLabel('Kỳ tới')).not.toHaveValue(FIRST_DUE)
    await sheet.getByLabel('Tần suất trả').selectOption('MONTHLY')
    await expect(sheet.getByLabel('Kỳ tới')).toHaveValue(FIRST_DUE)

    await sheet.getByLabel('Bên cho vay').fill('Home Bank')
    await sheet.getByLabel('Số tiền vay', { exact: true }).fill('2000000')
    await sheet.getByLabel(/Lãi suất/).fill('0')
    await sheet.getByLabel(/Kỳ hạn/).fill('4')
    await sheet.getByLabel('Số tiền mỗi kỳ').fill('500000')
    await sheet.getByRole('button', { name: 'Thêm khoản vay' }).click()
    await expect(sheet).toBeHidden()

    await expectCashBalance(page, '7.000.000')
  })

  test('an instalment starts at the scheduled amount on the receiving account; interest splits it into two transactions and the balance drops by the total; editing and deleting move it back', async ({
    page,
  }) => {
    await page.goto('/loans')
    const row = namedRow(page, page, 'Home Bank')

    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Home Bank' })
    await expect(dialog.getByLabel('Tổng')).toHaveValue('500000')
    await expect(dialog.getByLabel('Trả từ tài khoản').locator('option:checked')).toHaveText(
      'Cash · VND',
    )
    await expect(dialog.getByLabel('Gốc')).toHaveValue(/^500.000(,00)?\s?VND$/)
    await dialog.getByLabel('Lãi').fill('50000')
    await expect(dialog.getByLabel('Gốc')).toHaveValue(/^450.000(,00)?\s?VND$/)
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog).toBeHidden()

    await expect(row).toContainText('1.550.000')
    await expect(row).toContainText(displayDate(NEXT_DUE_AFTER_ONE_PAYMENT))
    await expectCashBalance(page, '6.500.000')

    // Two transactions: the principal out, and the interest as an expense in
    // "Lãi vay & phí".
    await page.goto('/transactions')
    await expect(page.getByText('Trả gốc – Home Bank')).toBeVisible()
    await expect(page.getByText('Lãi vay – Home Bank')).toBeVisible()
    await expect(page.getByText('Lãi vay & phí').first()).toBeVisible()

    // Edit: the same form, prefilled with what was recorded; a bigger interest
    // on the same total changes the split, not the balance.
    await page.goto('/loans')
    await row.getByText('Lần trả (1)', { exact: true }).click()
    await row.getByRole('button', { name: /^Sửa kỳ trả / }).click()
    const editDialog = page.getByRole('dialog', { name: 'Sửa kỳ trả · Home Bank' })
    await expect(editDialog.getByLabel('Tổng')).toHaveValue('500000')
    await expect(editDialog.getByLabel('Lãi')).toHaveValue('50000')
    await expect(editDialog.getByLabel('Trả từ tài khoản').locator('option:checked')).toHaveText(
      'Cash · VND',
    )
    await editDialog.getByLabel('Lãi').fill('100000')
    await editDialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(editDialog).toBeHidden()
    await expect(row).toContainText('1.600.000')
    await expectCashBalance(page, '6.500.000')

    // A bigger total lowers the balance by the difference.
    await page.goto('/loans')
    await row.getByText('Lần trả (1)', { exact: true }).click()
    await row.getByRole('button', { name: /^Sửa kỳ trả / }).click()
    await editDialog.getByLabel('Tổng').fill('600000')
    await editDialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(editDialog).toBeHidden()
    await expectCashBalance(page, '6.400.000')

    // Delete: the confirmation says both transactions go and the due date steps
    // back; the balance and the outstanding principal are restored.
    await page.goto('/loans')
    await row.getByText('Lần trả (1)', { exact: true }).click()
    await row.getByRole('button', { name: /^Xóa kỳ trả / }).click()
    const confirm = page.getByRole('dialog', { name: 'Xóa kỳ trả này?' })
    await expect(confirm).toContainText('Cả hai giao dịch đã ghi trong tài khoản')
    await expect(confirm).toContainText('lùi lại một kỳ')
    await confirm.getByRole('button', { name: 'Xóa', exact: true }).click()
    await expect(confirm).toBeHidden()
    await expect(row.getByText('Lần trả', { exact: false })).toHaveCount(0)
    await expect(row).toContainText('2.000.000')
    await expectCashBalance(page, '7.000.000')
  })

  test("choosing 'don't record in an account' creates the loan and an instalment without touching any balance, and offers the currency choice", async ({
    page,
  }) => {
    await page.goto('/loans')
    await page.getByRole('button', { name: 'Thêm khoản vay' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm khoản vay' })

    await sheet.getByLabel('Nhận tiền vào tài khoản').selectOption('')
    await expect(sheet.getByLabel('Tiền tệ')).toHaveValue('VND')
    await sheet.getByLabel('Tiền tệ').selectOption('USD')
    await sheet.getByLabel('Bên cho vay').fill('Old Lender')
    await sheet.getByLabel('Số tiền vay', { exact: true }).fill('1000')
    await sheet.getByLabel(/Lãi suất/).fill('0')
    await sheet.getByLabel(/Kỳ hạn/).fill('10')
    await sheet.getByLabel('Số tiền mỗi kỳ').fill('100')
    await sheet.getByRole('button', { name: 'Thêm khoản vay' }).click()
    await expect(sheet).toBeHidden()
    await expectCashBalance(page, '7.000.000')

    // A USD loan lists no VND account; the instalment records nothing.
    await page.goto('/loans')
    const row = namedRow(page, page, 'Old Lender')
    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Old Lender' })
    const paidFrom = dialog.getByLabel('Trả từ tài khoản')
    await expect(paidFrom.locator('option')).toHaveCount(1)
    await expect(paidFrom.locator('option:checked')).toHaveText('Không ghi vào tài khoản')
    await dialog.getByLabel('Lãi').fill('0')
    await dialog.getByRole('button', { name: 'Lưu' }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toContainText('Lần trả (1)')
    await expectCashBalance(page, '7.000.000')
  })

  test("'Record in an account' books a loan created without one — and its existing instalment — into the account, then disappears", async ({
    page,
  }) => {
    // A loan from before linking, and an instalment with interest, both with
    // "don't record in an account", so Cash does not move.
    await page.goto('/loans')
    await page.getByRole('button', { name: 'Thêm khoản vay' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm khoản vay' })
    await sheet.getByLabel('Nhận tiền vào tài khoản').selectOption('')
    await sheet.getByLabel('Bên cho vay').fill('Family')
    await sheet.getByLabel('Số tiền vay', { exact: true }).fill('3000000')
    await sheet.getByLabel(/Lãi suất/).fill('0')
    await sheet.getByLabel(/Kỳ hạn/).fill('6')
    await sheet.getByLabel('Số tiền mỗi kỳ').fill('500000')
    await sheet.getByRole('button', { name: 'Thêm khoản vay' }).click()
    await expect(sheet).toBeHidden()

    const row = namedRow(page, page, 'Family')
    await row.getByRole('button', { name: 'Ghi nhận thanh toán' }).click()
    const payment = page.getByRole('dialog', { name: 'Ghi nhận thanh toán · Family' })
    await payment.getByLabel('Trả từ tài khoản').selectOption('')
    await payment.getByLabel('Lãi').fill('20000')
    await payment.getByRole('button', { name: 'Lưu' }).click()
    await expect(payment).toBeHidden()
    await expectCashBalance(page, '7.000.000')

    await page.goto('/loans')
    await openRowMenu(page, row, 'Family')
    await page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }).click()
    const link = page.getByRole('dialog', { name: 'Ghi vào tài khoản · Family' })
    const account = link.getByLabel('Nhận tiền vào tài khoản')
    await expect(account.locator('option')).toHaveCount(1)
    await expect(account.locator('option:checked')).toHaveText('Cash · VND')
    // The loan started today, which is the default day the money arrived.
    await expect(link.getByLabel('Ngày nhận tiền vay')).toHaveValue(TODAY)
    await expect(link.getByLabel('Ghi bù 1 lần trả đã có')).toBeChecked()
    await link.getByRole('button', { name: 'Ghi vào tài khoản' }).click()
    await expect(link).toBeHidden()

    // Recorded: the action is gone from the row's menu.
    await openRowMenu(page, row, 'Family')
    await expect(page.getByRole('menuitem', { name: 'Sửa' })).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')

    // 7.000.000 + 3.000.000 received − 480.000 principal − 20.000 interest.
    await expectCashBalance(page, '9.500.000')
    await page.goto('/transactions')
    await expect(page.getByText('Vay – Family', { exact: true })).toBeVisible()
    await expect(page.getByText('Trả gốc – Family', { exact: true })).toBeVisible()
    await expect(page.getByText('Lãi vay – Family', { exact: true })).toBeVisible()
  })

  test("'Remove from account' takes a loan's money back out of the account; unticked, the instalment recorded there stays", async ({
    page,
  }) => {
    await page.goto('/loans')
    const row = namedRow(page, page, 'Family')
    await openRowMenu(page, row, 'Family')
    await page.getByRole('menuitem', { name: 'Bỏ ghi vào tài khoản' }).click()
    const confirm = page.getByRole('dialog', {
      name: 'Bỏ ghi khoản vay với Family khỏi tài khoản?',
    })
    await confirm.getByLabel('Bỏ ghi cả 1 lần trả đã ghi vào tài khoản').uncheck()
    await confirm.getByRole('button', { name: 'Bỏ ghi vào tài khoản' }).click()
    await expect(confirm).toBeHidden()

    // 9.500.000 − the 3.000.000 received; the instalment still left Cash.
    await expectCashBalance(page, '6.500.000')
    await page.goto('/transactions')
    await expect(page.getByText('Vay – Family', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Trả gốc – Family', { exact: true })).toBeVisible()

    await page.goto('/loans')
    await openRowMenu(page, row, 'Family')
    await expect(
      page.getByRole('menuitem', { name: 'Ghi vào tài khoản', exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
  })
})
