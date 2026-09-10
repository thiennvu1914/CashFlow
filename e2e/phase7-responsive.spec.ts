import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import {
  PAGES,
  registerNewUser,
  createAccountViaUi,
  createBudgetViaUi,
  createTransactionViaUi,
  todayInZone,
} from './helpers'

/**
 * Spec §7's acceptance widths, as a test.
 *
 * The assertion is `documentElement.scrollWidth <= innerWidth`, which is the
 * same check `phase4.spec.ts` and `phase6.spec.ts` already make on a few pages
 * — generalised to every page at every width, because an overflow introduced on
 * `/loans` at 414 is not caught by a check on `/dashboard` at 375.
 *
 * Seeded with real data on purpose: an empty page cannot overflow, and every
 * overflow this suite has ever caught came from a long row — a VND figure beside
 * a long note, a subtotal strip, a three-line loan row. The seed therefore
 * reaches every one of the twelve routes: two accounts (one VND, one USD), a
 * transaction with a very long Vietnamese note, a cross-currency transfer (the
 * row that carries a readable FX rate in its meta line), a budget, a goal, a
 * debt, a loan and a monthly reminder due today. Nine UI flows in one
 * `beforeAll`, run once for the whole file, so the twelve tests below all read
 * pages that actually have rows on them.
 *
 * Vietnamese, deliberately: it is the longer language, and an overflow that
 * English hides is the one that ships.
 */
const WIDTHS = [375, 414, 768, 1024, 1280, 1440] as const

/** The seeded user's timezone default, for the two date fields the seed types. */
const TIMEZONE = 'Asia/Ho_Chi_Minh'
const TODAY = todayInZone(TIMEZONE)
const TODAY_DAY_OF_MONTH = Number(TODAY.slice(8, 10))

const VND_ACCOUNT = 'Tiền mặt'
const USD_ACCOUNT = 'Đô la Mỹ'

const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-responsive-${process.pid}.json`)

/**
 * Every inline row action in the app (spec §8's 44 px rule at `< 768`), with
 * the page it lives on. These are the `Button size="sm"` sites the Step 3 audit
 * enumerated that are NOT inside a `RowActionsMenu` popup — the five labels the
 * brief names, plus the reminder Pause toggle, which lives on the schedule tab
 * rather than the due tab.
 *
 * Matched by accessible name: each of these buttons carries an `aria-label`
 * that prefixes the visible label with the row's own identity, so a regex on
 * the label finds it whichever row it belongs to.
 */
const INLINE_ROW_ACTIONS = [
  { url: '/debts', name: /Ghi nhận thanh toán|Record payment/ },
  { url: '/loans', name: /Ghi nhận thanh toán|Record payment/ },
  { url: '/goals', name: /Cập nhật tiến độ|Update progress/ },
  { url: '/reminders', name: /^Ghi nhận |^Acknowledge / },
  { url: '/reminders', name: /^Bỏ qua |^Dismiss / },
  { url: '/reminders?view=schedule', name: /^Tạm dừng |^Pause |^Tiếp tục |^Resume / },
] as const

/**
 * Creates one savings goal, debt, loan and reminder through the same header
 * action + create `Sheet` flow `e2e/phase6.spec.ts` uses. Local to this file
 * rather than lifted into `helpers.ts`: this file needs them only to put a row
 * on four pages, and moving four helpers would touch a file three other specs
 * depend on for no gain to them.
 */
async function createGoalViaUi(
  page: Page,
  opts: { name: string; target: number; current: number },
): Promise<void> {
  await page.goto('/goals')
  await page.getByRole('button', { name: /Thêm mục tiêu|Add goal/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm mục tiêu|Add goal/ })
  await sheet.getByLabel(/Tên mục tiêu|Goal name/).fill(opts.name)
  await sheet.getByLabel(/Số tiền mục tiêu|Target amount/).fill(String(opts.target))
  await sheet.getByLabel(/Đã tiết kiệm|Current amount/).fill(String(opts.current))
  await sheet.getByRole('button', { name: /Thêm mục tiêu|Add goal/ }).click()
  await expect(sheet).toBeHidden()
}

async function createDebtViaUi(
  page: Page,
  opts: { direction: 'RECEIVABLE' | 'PAYABLE'; person: string; amount: number },
): Promise<void> {
  await page.goto('/debts')
  await page.getByRole('button', { name: /Thêm công nợ|Add debt/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm công nợ|Add debt/ })
  // By VALUE, not by the option's label: the wording differs by locale, the
  // value does not.
  await sheet.getByLabel(/^Chiều$|^Direction$/).selectOption(opts.direction)
  await sheet.getByLabel(/^Người$|^Person$/).fill(opts.person)
  await sheet.getByLabel(/Số tiền ban đầu|Original amount/).fill(String(opts.amount))
  await sheet.getByRole('button', { name: /Thêm công nợ|Add debt/ }).click()
  await expect(sheet).toBeHidden()
}

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

async function createReminderViaUi(
  page: Page,
  opts: { title: string; amount: number },
): Promise<void> {
  await page.goto('/reminders')
  await page.getByRole('button', { name: /Thêm nhắc nhở|Add reminder/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm nhắc nhở|Add reminder/ })
  await sheet.getByLabel(/^Tiêu đề$|^Title$/).fill(opts.title)
  await sheet.getByLabel(/^Loại$|^Type$/).selectOption('EXPENSE')
  await sheet.getByLabel(/Số tiền dự kiến|Expected amount/).fill(String(opts.amount))
  // Before the day-of-month, never after: the frequency's `onChange` clears
  // both recurrence anchors, so a day typed first would be wiped.
  await sheet.getByLabel(/^Tần suất$|^Frequency$/).selectOption('MONTHLY')
  await sheet.getByLabel(/Ngày trong tháng|Day of month/).fill(String(TODAY_DAY_OF_MONTH))
  await sheet.getByLabel(/^Ngày bắt đầu$|^Start date$/).fill(TODAY)
  await sheet.getByRole('button', { name: /Thêm nhắc nhở|Add reminder/ }).click()
  await expect(sheet).toBeHidden()
}

/**
 * One cross-currency transfer, created on the `/transfers` page's own always-
 * visible form (spec §6.3) — 2.500.000 VND sent for 100 USD received, a round
 * 25.000 VND/USD so the row's readable rate line is unambiguous. This is the
 * row whose meta line carries that rate, which is the narrowest thing on the
 * page at 375.
 */
async function createCrossCurrencyTransferViaUi(page: Page): Promise<void> {
  await page.goto('/transfers')
  await page.getByLabel(/^Đến$|^To$/).selectOption({ label: `${USD_ACCOUNT} (USD)` })
  await page.getByLabel(/^Số tiền gửi$|^Amount sent$/).fill('2500000')
  await page.getByLabel(/^Số tiền nhận$|^Amount received$/).fill('100')
  await page.getByRole('button', { name: /^Chuyển tiền$|^Transfer$/ }).click()
  await expect(page.getByRole('listitem').filter({ hasText: USD_ACCOUNT })).toHaveCount(1)
}

test.describe.serial('Phase 7 — responsive', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-responsive' })
    await createAccountViaUi(page, {
      name: VND_ACCOUNT,
      currency: 'VND',
      initialBalance: 25_000_000,
    })
    await createAccountViaUi(page, { name: USD_ACCOUNT, currency: 'USD', initialBalance: 2_000 })
    // A long note beside a wide VND figure — the exact row that used to
    // overflow, and the reason `FinancialListRow` has a fixed amount column.
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: VND_ACCOUNT,
      categoryName: 'Food & Dining',
      amount: 12_500_000,
      note: 'Bữa trưa với khách hàng tại nhà hàng ở quận 1, đã bao gồm phí dịch vụ và thuế giá trị gia tăng',
    })
    await createCrossCurrencyTransferViaUi(page)
    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 20_000_000 })
    await createGoalViaUi(page, {
      name: 'Quỹ dự phòng khẩn cấp',
      target: 200_000_000,
      current: 45_000_000,
    })
    await createDebtViaUi(page, {
      direction: 'RECEIVABLE',
      person: 'Nguyễn Thị Minh Khai (bạn cùng phòng cũ)',
      amount: 18_500_000,
    })
    await createLoanViaUi(page, {
      lender: 'Ngân hàng Thương mại Cổ phần Ngoại thương',
      principal: 850_000_000,
      interestRate: 8.5,
      termMonths: 240,
      scheduledPayment: 7_400_000,
    })
    await createReminderViaUi(page, { title: 'Tiền điện nước tháng này', amount: 1_850_000 })
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const offenders: string[] = []
      for (const url of PAGES) {
        await page.goto(url)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        const overflowing = await page.evaluate(() => {
          const root = document.documentElement
          if (root.scrollWidth <= window.innerWidth) return null
          // Name the widest offending element, so a failure is actionable.
          const all = [...document.querySelectorAll('main *')]
          const widest = all
            .map((element) => ({
              element,
              right: element.getBoundingClientRect().right,
            }))
            .sort((a, b) => b.right - a.right)[0]
          return {
            scrollWidth: root.scrollWidth,
            innerWidth: window.innerWidth,
            offender:
              widest?.element.tagName + '.' + (widest?.element.className || '').slice(0, 120),
          }
        })
        if (overflowing) offenders.push(`${url}: ${JSON.stringify(overflowing)}`)
      }
      expect(offenders, offenders.join('\n')).toEqual([])
    })
  }

  test('tables become stacked rows below 768 and a table at 768', async ({ page }) => {
    // Spec §7's boundary, asserted rather than assumed. `/reports`' account
    // breakdown is the app's one `<table>`, and it renders BOTH shapes into the
    // DOM (`components/reports/account-table.tsx`) — so the boundary is a
    // question of which one is visible, not which one exists.
    await page.setViewportSize({ width: 767, height: 900 })
    await page.goto('/reports')
    await expect(page.locator('table')).toBeHidden()
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/reports')
    await expect(page.locator('table')).toBeVisible()
  })

  test('a dialog is a bottom sheet below 640 and a right-hand panel above it', async ({ page }) => {
    await page.setViewportSize({ width: 639, height: 900 })
    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).click()
    const sheet = page.getByRole('dialog')
    const belowBox = await sheet.boundingBox()
    expect(belowBox!.y + belowBox!.height).toBeCloseTo(900, 0)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).click()
    const aboveBox = await page.getByRole('dialog').boundingBox()
    // A right-hand sheet at ≥ 640: anchored to the right edge, full height.
    expect(aboveBox!.x + aboveBox!.width).toBeCloseTo(1440, 0)
    expect(aboveBox!.y).toBeCloseTo(0, 0)
    expect(aboveBox!.height).toBeCloseTo(900, 0)
  })

  test('the mobile bar does not cover the end of a page', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/transactions')
    await page.keyboard.press('End')
    const bar = page.getByRole('navigation', { name: /Điều hướng nhanh|Primary \(compact\)/ })
    const barBox = (await bar.boundingBox())!
    // The last row of the list must end above the bar's top edge. Scoped to
    // `main`: the bar's own tabs are list items too, and they are the LAST
    // ones in the document.
    const lastRow = page.locator('main').getByRole('listitem').last()
    const rowBox = (await lastRow.boundingBox())!
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(barBox.y)
  })

  test('every bottom-bar tab is at least 44 px tall at 375', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    const bar = page.getByRole('navigation', { name: /Điều hướng nhanh|Primary \(compact\)/ })
    for (const link of await bar.getByRole('link').all()) {
      const box = (await link.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('every inline row action is at least 44 px tall at 375', async ({ page }) => {
    // `Button size="sm"` is 36 px (spec §2), below spec §8's 44 px mobile
    // touch target — so every inline row action carries `h-11 md:h-9`: the
    // touch size on a phone, the compact size from the icon rail up.
    await page.setViewportSize({ width: 375, height: 812 })
    for (const { url, name } of INLINE_ROW_ACTIONS) {
      await page.goto(url)
      const buttons = page.getByRole('button', { name })
      await expect(buttons.first()).toBeVisible()
      for (const button of await buttons.all()) {
        const box = (await button.boundingBox())!
        expect(box.height, `${url} — ${await button.textContent()}`).toBeGreaterThanOrEqual(44)
      }
    }
  })

  test('every row `…` menu trigger is at least 44 px square at 375', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/transactions')
    const triggers = page.getByRole('button', { name: /Tác vụ|Actions for/ })
    await expect(triggers.first()).toBeVisible()
    for (const trigger of await triggers.all()) {
      const box = (await trigger.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
    }
  })

  test('the amount column never wraps a figure mid-number at 375', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/transactions')
    // A figure that wrapped would be taller than one line of its own text.
    const amounts = page.locator('li >> css=[class*="tabular-nums"]')
    await expect(amounts.first()).toBeVisible()
    for (const amount of await amounts.all()) {
      const box = (await amount.boundingBox())!
      expect(box.height, await amount.innerText()).toBeLessThan(28)
    }
  })
})
