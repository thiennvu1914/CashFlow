import { test, expect } from '@playwright/test'
import viReports from '@/messages/vi/reports.json'
import {
  authenticatedSession,
  createAccountViaUi,
  createTransactionViaUi,
  digitsOnly,
  todayInZone,
} from './helpers'

/**
 * Phase 7 Task 10: owner requirement S — coverage the Reports rebuild adds on
 * top of `phase4.spec.ts` (migrated in the same task to the new translated
 * segments and the single export menu).
 *
 * This file is deliberately narrow, on top of that migration: the real
 * `SegmentedControl`'s URL/`aria-current` contract for every named period, the
 * "Tùy chọn"/custom segment's reveal-and-apply flow including its invalid-range
 * branch, the three-figure summary's tabular DOM shape, the account table's
 * responsive swap to stacked rows at 375 with no horizontal overflow, the
 * export menu's keyboard operability and its two items' exact hrefs (proven
 * live with a real `GET`), vi/en copy, and the no-raw-enum guarantee every
 * other Phase 7 page spec carries.
 *
 * `resolveLocale()` reads the signed-in session's stored `locale` before the
 * `NEXT_LOCALE` cookie (the same reasoning `phase7-reminders.spec.ts` and its
 * siblings give), so the English case goes through `/settings`, not a cookie
 * set directly.
 *
 * No `waitForTimeout`, no retries — `playwright.config.ts` runs with
 * `retries: 0`.
 */

const TIMEZONE = 'Asia/Ho_Chi_Minh'

const SESSION = authenticatedSession('phase7-reports')

/** A raw enum value: two-plus upper-case words joined by underscores
 *  (`CASH_OUT`) — never a translated label, which is prose in vi or en. */
const RAW_ENUM_PATTERN = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/

/** The six segments, in the order `PeriodFilter` renders them, with each
 *  locale's exact label. */
const PERIOD_SEGMENTS = [
  { id: 'day', vi: 'Ngày', en: 'Day' },
  { id: 'week', vi: 'Tuần', en: 'Week' },
  { id: 'month', vi: 'Tháng', en: 'Month' },
  { id: 'quarter', vi: 'Quý', en: 'Quarter' },
  { id: 'year', vi: 'Năm', en: 'Year' },
] as const

test.describe.serial('Phase 7 Task 10 — reports', () => {
  test.use({ storageState: SESSION.path })
  test.describe.configure({ timeout: 120_000 })

  test.beforeAll(async ({ browser }) => {
    await SESSION.bootstrap(browser, async (page) => {
      // Two accounts so By Account renders two rows, one of them net-negative —
      // the case the responsive table and its `text-negative` treatment need.
      await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 0 })
      await createAccountViaUi(page, { name: 'Bank', currency: 'VND', initialBalance: 0 })
      await createTransactionViaUi(page, {
        type: 'INCOME',
        accountName: 'Cash',
        categoryName: 'Salary',
        amount: 500_000,
      })
      await createTransactionViaUi(page, {
        type: 'EXPENSE',
        accountName: 'Bank',
        categoryName: 'Food & Dining',
        amount: 200_000,
      })
    })
  })

  test('vi: each named period segment navigates to its own ?period= URL and carries aria-current', async ({
    page,
  }) => {
    await page.goto('/reports')

    for (const { id, vi } of PERIOD_SEGMENTS) {
      const link = page.getByRole('link', { name: vi, exact: true })
      await expect(link).toHaveAttribute('href', `/reports?period=${id}`)
      await link.click()
      await expect(page).toHaveURL(new RegExp(`\\?period=${id}$`))
      await expect(page.getByRole('link', { name: vi, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      )
    }
  })

  test('vi: the custom segment reveals From/To/Apply, a valid range applies and updates the header, and an invalid range shows the inline alert without navigating', async ({
    page,
  }) => {
    await page.goto('/reports')
    const today = todayInZone(TIMEZONE)

    // No From/To for a named period.
    await expect(page.getByLabel('Từ ngày', { exact: true })).toHaveCount(0)

    await page.getByRole('link', { name: 'Tùy chọn', exact: true }).click()
    // No from/to yet: the resolver's own invalid-range branch, which still
    // renders the segmented control (with "Tùy chọn" selected) and the form.
    // The alert says it in Vietnamese — `reports.invalidRange`, not
    // `InvalidReportRangeError`'s English developer message, which is what this
    // rendered until Task 17 fix round 1.
    await expect(page.locator('p[role="alert"]')).toHaveText(viReports.invalidRange)
    await expect(page.getByRole('link', { name: 'Tùy chọn', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )

    const fromInput = page.getByLabel('Từ ngày', { exact: true })
    const toInput = page.getByLabel('Đến ngày', { exact: true })
    await expect(fromInput).toBeVisible()
    await expect(toInput).toBeVisible()

    // A malformed range (from after to): the control and echoed dates stay on
    // screen, the alert shows the localized invalid-range sentence, and the URL
    // is NOT one the page treats as resolved.
    await fromInput.fill(today)
    await toInput.fill('2020-01-01')
    await page.getByRole('button', { name: 'Áp dụng' }).click()
    const alert = page.locator('p[role="alert"]')
    await expect(alert).toHaveText(viReports.invalidRange)
    await expect(page.getByLabel('Từ ngày', { exact: true })).toHaveValue(today)
    await expect(page.getByLabel('Đến ngày', { exact: true })).toHaveValue('2020-01-01')
    // Both date inputs point aria-describedby at the alert's own id and carry
    // aria-invalid (fix round 1, promoted minor) — the alert's id is real, so
    // a screen-reader user tabbing into either field hears why it failed.
    const alertId = await alert.getAttribute('id')
    expect(alertId).toBeTruthy()
    await expect(page.getByLabel('Từ ngày', { exact: true })).toHaveAttribute(
      'aria-describedby',
      alertId!,
    )
    await expect(page.getByLabel('Từ ngày', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    await expect(page.getByLabel('Đến ngày', { exact: true })).toHaveAttribute(
      'aria-describedby',
      alertId!,
    )
    await expect(page.getByLabel('Đến ngày', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    )

    // Now a valid range: the header's range text updates and the alert is gone.
    await page.getByLabel('Đến ngày', { exact: true }).fill(today)
    await page.getByRole('button', { name: 'Áp dụng' }).click()
    await expect(page.locator('p[role="alert"]')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1, name: 'Báo cáo' })).toBeVisible()
    const url = new URL(page.url())
    expect(url.searchParams.get('period')).toBe('custom')
    expect(url.searchParams.get('from')).toBe(today)
    expect(url.searchParams.get('to')).toBe(today)
    // The header's description switched from "choose a range" to the real
    // resolved window — scoped to the header's own paragraph (not a bare
    // "VND" text search, which now also matches the summary panel's
    // responsive-duplicate — see SummaryPanel's flat `lg` split, fix round
    // 1 — currency spans, one of which is legitimately CSS-hidden at this
    // viewport).
    const rangeDescription = page.locator('header p').first()
    await expect(rangeDescription).not.toContainText('Chọn khoảng thời gian')
    await expect(rangeDescription).toContainText('VND')
  })

  test('vi: the summary is three figures in one tabular-aligned card', async ({ page }) => {
    await page.goto('/reports')

    const panel = page.locator('dl').first()
    await expect(panel.locator('dt')).toHaveCount(3)
    await expect(panel.locator('dd')).toHaveCount(3)
    // Right-aligned tabular numerals — the DOM shape the brief requires,
    // never a pixel measurement. `:visible`, not a bare count: each figure
    // now renders as TWO responsive copies (fix round 1 — SummaryPanel's
    // flat variant splits at `lg` to fix a 768 clipping bug), one of which
    // is legitimately CSS-hidden at any given width, so exactly 3 are ever
    // visible at once even though 6 exist in the DOM.
    await expect(panel.locator('span.tabular-nums:visible')).toHaveCount(3)

    async function kpiValue(label: string): Promise<string> {
      const cell = panel.locator('div').filter({ has: page.getByText(label, { exact: true }) })
      const text = await cell.locator('dd span.tabular-nums').first().textContent()
      return digitsOnly(text ?? '')
    }
    expect(await kpiValue('Thu nhập')).toBe('500000')
    expect(await kpiValue('Chi tiêu')).toBe('200000')
    expect(await kpiValue('Thu nhập ròng')).toBe('300000')
  })

  test('375: the account table becomes stacked labelled rows, not a sideways table, with no horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/reports')

    // The desktop `<table>` is present in the DOM (both renderings always are)
    // but hidden below md; the stacked list is what a reader can actually see.
    await expect(page.locator('table')).toBeHidden()
    const stacked = page.locator('ul.md\\:hidden')
    await expect(stacked).toBeVisible()
    await expect(stacked.getByText('Cash', { exact: true })).toBeVisible()
    await expect(stacked.getByText('Bank', { exact: true })).toBeVisible()
    // Bank's net income is negative (an expense with no income of its own).
    const bankRow = stacked.locator('li').filter({ has: page.getByText('Bank', { exact: true }) })
    await expect(bankRow.locator('.text-negative')).toHaveCount(1)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)
  })

  test('the export menu opens with the keyboard, lists both entries, and each href is the real export route — proven with a live GET', async ({
    page,
  }) => {
    await page.goto('/reports')

    const trigger = page.getByRole('button', { name: 'Xuất Excel' })
    await expect(trigger).toBeVisible()
    await trigger.focus()
    await page.keyboard.press('Enter')

    const items = page.getByRole('menuitem')
    await expect(items).toHaveCount(2)
    const rangeItem = page.getByRole('menuitem', { name: 'Khoảng này' })
    const allItem = page.getByRole('menuitem', { name: 'Toàn bộ dữ liệu' })
    await expect(rangeItem).toBeVisible()
    await expect(allItem).toBeVisible()

    // Escape closes the popup and returns focus to the trigger.
    await page.keyboard.press('Escape')
    await expect(items).toHaveCount(0)
    await expect(trigger).toBeFocused()

    // Reopen to read the hrefs — real `<a>`s, not `onSelect` callbacks.
    await trigger.click()
    const rangeHref = await page.getByRole('menuitem', { name: 'Khoảng này' }).getAttribute('href')
    const allHref = await page
      .getByRole('menuitem', { name: 'Toàn bộ dữ liệu' })
      .getAttribute('href')
    expect(rangeHref).toBe('/api/reports/export?mode=filtered&period=month')
    expect(allHref).toBe('/api/reports/export?mode=full')
    await page.keyboard.press('Escape')

    const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const rangeResp = await page.request.get(rangeHref!)
    expect(rangeResp.status()).toBe(200)
    expect(rangeResp.headers()['content-type']).toBe(XLSX_CONTENT_TYPE)
    const allResp = await page.request.get(allHref!)
    expect(allResp.status()).toBe(200)
    expect(allResp.headers()['content-type']).toBe(XLSX_CONTENT_TYPE)
  })

  test('en (via Settings): the picker segments, headings and export menu read in English, with no raw enum literal', async ({
    page,
  }) => {
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('en')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    for (const { en } of PERIOD_SEGMENTS) {
      await expect(page.getByRole('link', { name: en, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('link', { name: 'Custom', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'By Category' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'By Account' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export Excel' })).toBeVisible()

    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(RAW_ENUM_PATTERN)

    // Switch back to vi for any test that might run after this one in the
    // same worker.
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('vi')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()
  })
})
