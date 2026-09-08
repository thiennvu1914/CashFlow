import os from 'os'
import path from 'path'
import { test, expect, request as playwrightRequest } from '@playwright/test'
import {
  createAccountViaUi,
  createTransactionViaUi,
  digitsOnly,
  registerNewUser,
  todayInZone,
} from './helpers'

/**
 * Phase 4 Task 8: end-to-end coverage for the app shell, Dashboard, Reports
 * and the Excel export, across desktop/mobile/tablet viewports.
 *
 * One user is registered via the UI once (in `beforeAll`) and its login
 * session is captured as Playwright `storageState`, reused by every test in
 * this file via `test.use`. That avoids re-registering (and re-seeding) for
 * every viewport/assertion while still exercising the real login flow once.
 *
 * The user's profile defaults (a fresh registration, `lib/auth/user-defaults.ts`)
 * are `baseCurrency: 'VND'` and `timezone: 'Asia/Ho_Chi_Minh'` — both the
 * Dashboard/Reports figures and the transaction form's pre-filled date depend
 * on that timezone, so `TIMEZONE` below must match it.
 */

const TIMEZONE = 'Asia/Ho_Chi_Minh'
const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase4-storage-state-${process.pid}.json`,
)
const BASE_URL = 'http://localhost:3000'

test.describe.serial('Phase 4 — dashboard, reports and export', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    // `browser.newContext()` (the fixture-provided `browser`, not raw
    // Playwright) inherits the file-level `test.use({ storageState: ... })`
    // above by default — which, at this point, names a file this very step
    // is about to create. `storageState: undefined` overrides that back to a
    // clean, logged-out context.
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase4' })

    // A VND account and a USD account — enough to make FX conversion actually
    // apply on the Dashboard's Total Account Balance / Net Worth / distribution.
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 1_000_000 })
    await createAccountViaUi(page, { name: 'Wallet', currency: 'USD', initialBalance: 100 })

    // One income and one expense on Cash, both at today's pre-filled
    // date-time. A same-currency transfer needs two accounts in the same
    // currency, which this seed does not have — transfers are out of scope
    // for this spec per the task brief.
    await createTransactionViaUi(page, {
      type: 'INCOME',
      accountName: 'Cash',
      categoryName: 'Salary',
      amount: 500_000,
    })
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 200_000,
    })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('dashboard (desktop, 1280x800): shell, KPIs, widgets and seeded data', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    await expect(
      page.getByRole('heading', { name: /Tổng quan|^Dashboard$/, level: 1 }),
    ).toBeVisible()

    const rail = page.getByRole('navigation', { name: /^(Điều hướng chính|Primary)$/ })
    await expect(rail).toBeVisible()
    for (const label of [
      /^(Tổng quan|Dashboard)$/,
      /^(Giao dịch|Transactions)$/,
      /^(Chuyển tiền|Transfers)$/,
      /^(Tài khoản|Accounts)$/,
      /^(Ngân sách|Budgets)$/,
      /^(Tiết kiệm|Savings)$/,
      /^(Công nợ|Debts)$/,
      /^(Khoản vay|Loans)$/,
      /^(Nhắc nhở|Reminders)$/,
      /^(Danh mục|Categories)$/,
      /^(Báo cáo|Reports)$/,
      /^(Cài đặt|Settings)$/,
    ]) {
      await expect(rail.getByRole('link', { name: label })).toBeVisible()
    }

    // Scoped to the summary panel's <dl>: "Net Income" (and, on other pages,
    // "Income"/"Expense") also appear as recharts legend text elsewhere on
    // this page, which a page-wide getByText would ambiguously match too.
    // `getByText` with a regex, not `{ exact: true }`, because "Thu nhập ròng"
    // and "Thu nhập tháng" share a prefix and the exact-match form no longer
    // applies to a regex.
    const summary = page.locator('dl').first()
    for (const label of [
      /Tài sản ròng|Net Worth/,
      /Tổng số dư|Total Balance/,
      /Thu nhập tháng|Monthly Income/,
      /Chi tiêu tháng|Monthly Expense/,
      /Thu nhập ròng|Net Income/,
    ]) {
      await expect(summary.getByText(label)).toBeVisible()
    }

    for (const heading of [
      /Dòng tiền theo tháng|Cash Flow Trend/,
      /Thu và chi|Income vs Expense/,
      /Số dư theo thời gian|Account Balance Over Time/,
      /Chi tiêu theo danh mục|Expense by Category/,
      /Phân bổ số dư|Account Balance Distribution/,
      // The planning widgets, in the order the page renders them, with Recent
      // Transactions kept last (directive Z's hierarchy).
      /Tiến độ ngân sách|Budget Progress/,
      /Mục tiêu tiết kiệm|Savings Goals/,
      /Công nợ và khoản vay|Debt \/ Loan Overview/,
      /Nhắc nhở sắp tới|Upcoming Reminders/,
      /Giao dịch gần đây|Recent Transactions/,
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    }

    const recentSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: /Giao dịch gần đây|Recent Transactions/ }) })
    await expect(recentSection.getByText('Salary')).toBeVisible()
    await expect(recentSection.getByText('Food & Dining')).toBeVisible()

    // FX status region: `FxRateStatus` renders one <span> inside `PageHeader`'s
    // `meta` slot, in one of four exhaustive shapes. Scoped to `main`'s own
    // header — the mobile top bar is a second, hidden-but-present `<header>`
    // earlier in the DOM (`md:hidden` only hides it visually) with no such
    // span at all, so a bare `page.locator('header')` picks the wrong one.
    const fxStatusText = await page
      .locator('main header')
      .getByText(/USD = |Chưa có tỷ giá|FX rate unavailable|Không cần quy đổi|No conversion needed/)
      .first()
      .textContent()
    expect(fxStatusText).toMatch(
      /tỷ giá lưu tạm|cached rate|Chưa có tỷ giá|FX rate unavailable|USD = .* VND|Không cần quy đổi|No conversion needed/,
    )

    // Total Balance must be a formatted number or the "unknown" placeholder —
    // never a raw NaN/undefined leaking through the FX-unavailable fallback.
    const totalBalanceCell = page
      .locator('dl > div')
      .filter({ has: page.getByText(/Tổng số dư|Total Balance/) })
    const totalBalanceValue = (
      await totalBalanceCell.locator('dd span.tabular-nums').first().textContent()
    )?.trim()
    expect(totalBalanceValue).toBeTruthy()
    expect(totalBalanceValue).not.toMatch(/NaN|undefined/i)
    expect(totalBalanceValue === '—' || /^[\d.,\s]+$/.test(totalBalanceValue ?? '')).toBe(true)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)

    // The spec's 12-column grid (§6.1): Cash Flow Trend is 8/12 (≈ 66.7 %) and
    // Recent Transactions is 12/12 (full width) at 1440. `boundingBox()` reads
    // the rendered geometry directly, so this pins the grid rather than the
    // class names that produce it.
    const trendSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: /Dòng tiền theo tháng|Cash Flow Trend/ }) })
    const gridBox = await page.locator('main > div > div').last().boundingBox()
    const trendBox = await trendSection.boundingBox()
    const recentBox = await recentSection.boundingBox()
    if (gridBox && trendBox && recentBox) {
      const trendFraction = trendBox.width / gridBox.width
      const recentFraction = recentBox.width / gridBox.width
      expect(trendFraction).toBeGreaterThan(0.6)
      expect(trendFraction).toBeLessThan(0.7)
      expect(recentFraction).toBeGreaterThan(0.95)
    }
  })

  test('dashboard (mobile, 375x812): compact nav, More menu, tab navigation', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')

    const rail = page.getByRole('navigation', { name: /^(Điều hướng chính|Primary)$/ })
    await expect(rail).toBeHidden()

    const bar = page.getByRole('navigation', { name: /^(Điều hướng nhanh|Primary \(compact\))$/ })
    await expect(bar).toBeVisible()
    await expect(
      bar.getByRole('link', { name: /^(Thêm giao dịch|Add transaction)$/ }),
    ).toBeVisible()

    await page.getByRole('button', { name: /^(Menu|More)$/ }).click()
    const morePanel = page.getByRole('dialog', { name: /^(Tất cả mục|All sections)$/ })
    await expect(morePanel.getByRole('link', { name: /^(Chuyển tiền|Transfers)$/ })).toBeVisible()
    await expect(morePanel.getByRole('link', { name: /^(Ngân sách|Budgets)$/ })).toBeVisible()
    await expect(morePanel.getByRole('link', { name: /^(Danh mục|Categories)$/ })).toBeVisible()
    await expect(morePanel.getByRole('link', { name: /^(Cài đặt|Settings)$/ })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(morePanel).toBeHidden()

    // Re-open it, then dismiss it before using the bar underneath: the sheet
    // is now a real modal overlay (focus trap + full-viewport backdrop), so —
    // unlike the hand-rolled disclosure this replaces — it deliberately
    // intercepts clicks on the page behind it; a bottom-bar tap cannot reach
    // through it. The "a route change closes an open sheet" guarantee is
    // instead proven in `e2e/phase7-shell.spec.ts`, via a link INSIDE the
    // sheet, which is the only navigation a modal dialog actually permits.
    await page.getByRole('button', { name: /^(Menu|More)$/ }).click()
    await expect(morePanel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(morePanel).toBeHidden()
    await bar.getByRole('link', { name: /^(Tài khoản|Accounts)$/ }).click()
    await expect(page).toHaveURL(/\/accounts/)

    // The rightmost tab specifically: the bottom-right corner is where a
    // floating dev overlay would land, and it would swallow this tap rather
    // than navigate. Reports is the tab that occupies it.
    await bar.getByRole('link', { name: /^(Báo cáo|Reports)$/ }).click()
    await expect(page).toHaveURL(/\/reports/)
    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible()

    await bar.getByRole('link', { name: /^(Tổng quan|Dashboard)$/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)
  })

  test('dashboard (tablet, 768x1024): rail visible, bottom bar hidden', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/dashboard')

    await expect(
      page.getByRole('navigation', { name: /^(Điều hướng chính|Primary)$/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: /^(Điều hướng nhanh|Primary \(compact\))$/ }),
    ).toBeHidden()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)
  })

  test('reports: default month period shows the seeded totals', async ({ page }) => {
    await page.goto('/reports')

    await expect(page.getByRole('link', { name: 'month', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )

    async function kpiValue(label: string): Promise<string> {
      const cell = page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) })
      const text = await cell.locator('dd span.tabular-nums').first().textContent()
      return digitsOnly(text ?? '')
    }

    expect(await kpiValue('Income')).toBe('500000')
    expect(await kpiValue('Expense')).toBe('200000')
    expect(await kpiValue('Net Income')).toBe('300000')
  })

  test('reports: custom range via the form updates the URL and keeps totals', async ({ page }) => {
    await page.goto('/reports')
    const today = todayInZone(TIMEZONE)

    await page.getByLabel('From', { exact: true }).fill(today)
    await page.getByLabel('To', { exact: true }).fill(today)
    await page.getByRole('button', { name: 'Apply' }).click()

    await expect(page).toHaveURL(/\/reports\?/)
    const url = new URL(page.url())
    expect(url.searchParams.get('period')).toBe('custom')
    expect(url.searchParams.get('from')).toBe(today)
    expect(url.searchParams.get('to')).toBe(today)

    async function kpiValue(label: string): Promise<string> {
      const cell = page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) })
      const text = await cell.locator('dd span.tabular-nums').first().textContent()
      return digitsOnly(text ?? '')
    }

    expect(await kpiValue('Income')).toBe('500000')
    expect(await kpiValue('Expense')).toBe('200000')
    expect(await kpiValue('Net Income')).toBe('300000')
  })

  test('reports: an unknown named period renders an inline alert, not a crash', async ({
    page,
  }) => {
    await page.goto('/reports?period=weekly')
    // `page.getByRole('alert')` alone is ambiguous: Next's own client-side
    // route announcer (`#__next-route-announcer__`) also carries
    // `role="alert"` and can be mounted by this point, alongside the page's
    // own `<p role="alert">` message — scope to the tag the page actually
    // renders its error in.
    await expect(page.locator('p[role="alert"]')).toBeVisible()
  })

  test('reports: an inverted custom range (from after to) renders an inline alert', async ({
    page,
  }) => {
    await page.goto('/reports?period=custom&from=2026-03-31&to=2026-03-01')
    // `page.getByRole('alert')` alone is ambiguous: Next's own client-side
    // route announcer (`#__next-route-announcer__`) also carries
    // `role="alert"` and can be mounted by this point, alongside the page's
    // own `<p role="alert">` message — scope to the tag the page actually
    // renders its error in.
    await expect(page.locator('p[role="alert"]')).toBeVisible()
  })

  test('export: full and filtered workbooks, mode/range validation, and auth', async ({ page }) => {
    const fullResp = await page.request.get('/api/reports/export?mode=full')
    expect(fullResp.status()).toBe(200)
    expect(fullResp.headers()['content-type']).toContain('spreadsheetml')
    expect(fullResp.headers()['content-disposition']).toMatch(/cashflow-full-\d{8}\.xlsx/)
    expect(fullResp.headers()['x-content-type-options']).toBe('nosniff')
    const fullBody = await fullResp.body()
    expect(fullBody.length).toBeGreaterThan(1000)

    const today = todayInZone(TIMEZONE)
    const filteredResp = await page.request.get(
      `/api/reports/export?mode=filtered&period=custom&from=${today}&to=${today}`,
    )
    expect(filteredResp.status()).toBe(200)
    expect(filteredResp.headers()['content-type']).toContain('spreadsheetml')
    expect(filteredResp.headers()['content-disposition']).toMatch(/cashflow-filtered-/)
    const filteredBody = await filteredResp.body()
    expect(filteredBody.length).toBeGreaterThan(1000)

    const bogusModeResp = await page.request.get('/api/reports/export?mode=bogus')
    expect(bogusModeResp.status()).toBe(400)
    // Every response, refusals included: a plain-text refusal must never be
    // sniffed into HTML and rendered in the download's origin.
    expect(bogusModeResp.headers()['x-content-type-options']).toBe('nosniff')

    const badRangeResp = await page.request.get('/api/reports/export?mode=filtered&period=weekly')
    expect(badRangeResp.status()).toBe(400)
    expect(badRangeResp.headers()['x-content-type-options']).toBe('nosniff')

    // A fresh, unauthenticated context — no cookies at all — must be refused.
    // `storageState: undefined` explicitly overrides the file-level
    // `test.use({ storageState: STORAGE_STATE_PATH })`, which this module-level
    // `request.newContext()` would otherwise inherit while running inside a
    // test (same reasoning as the `beforeAll` context above) — without it,
    // this "anonymous" context is silently the logged-in seeded user.
    const anonContext = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: undefined,
    })
    try {
      const anonResp = await anonContext.get('/api/reports/export?mode=full')
      expect(anonResp.status()).toBe(401)
      expect(anonResp.headers()['x-content-type-options']).toBe('nosniff')
    } finally {
      await anonContext.dispose()
    }
  })

  test('error boundary: manual verification only', async () => {
    // Requirement 1g: triggering `app/(app)/error.tsx` needs a server
    // component throw, and the task brief explicitly forbids adding a
    // throwing route/fixture to the app just to exercise it in E2E. The
    // component was instead verified by reading
    // `app/(app)/error.tsx` — it renders a fixed, non-leaking message
    // ("Something went wrong loading this page.") and a "Retry" button
    // that calls the `retry` prop (a `router.refresh()`-based recovery,
    // per Next 16's error.md), so there is no dynamic app behaviour left
    // to assert without a real thrown error to catch.
    test.skip(
      true,
      'No safe way to trigger a real server-side throw without app changes; verified by code reading.',
    )
  })
})
