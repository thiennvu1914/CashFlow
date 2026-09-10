import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { createAccountViaUi, createTransactionViaUi, registerNewUser } from './helpers'

/**
 * Phase 7 Task 4: owner requirement R — coverage the Dashboard rebuild adds on
 * top of `phase4.spec.ts`'s existing dashboard checks (the shell, the seeded
 * KPI figures, the eleven widget headings).
 *
 * This file is deliberately narrow: it proves the summary panel's five labels
 * render in both locales, that a dark theme actually reaches `<html>`, that a
 * brand-new user sees contextual empty states rather than a flat zero line,
 * that nothing overflows at the narrowest phone widths, that the summary
 * labels are never clipped at 768, that no raw enum value ever reaches the
 * DOM, and that the ledger's amount column never overlaps its meta text at
 * 375 — the layout bug `FinancialListRow`'s fixed amount column exists to
 * prevent.
 *
 * `resolveLocale()`/`resolveTheme()` (`lib/i18n/config.ts`, `lib/theme/config.ts`)
 * both read the SIGNED-IN SESSION's stored `locale`/`theme` before the
 * `NEXT_LOCALE`/`cashflow-theme` cookie — the cookie only matters pre-auth, so
 * setting it alone on an authenticated `/dashboard` visit has no effect. The
 * locale/dark-theme cases below therefore go through the Settings form, the
 * same way `settings-form-hydration.spec.ts` changes either preference, and
 * end up exercising the real save → session → render path rather than a
 * cookie the page would ignore.
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase7-dashboard-storage-state-${process.pid}.json`,
)

/** A raw enum value would look like this: two-plus upper-case words joined by
 *  underscores (`CASH_OUT`, `ADJUSTMENT_INCREASE`) — never a translated label,
 *  which is prose in Vietnamese or English. */
const RAW_ENUM_PATTERN = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/

test.describe
  .serial('Phase 7 Task 4 — dashboard summary panel, locales, themes and empty states', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase7-dashboard' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 1_000_000 })
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 150_000,
    })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('renders the five summary labels in Vietnamese by default', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    const summary = page.locator('dl').first()
    for (const label of [
      'Tài sản ròng',
      'Tổng số dư',
      'Thu nhập tháng',
      'Chi tiêu tháng',
      'Thu nhập ròng',
    ]) {
      await expect(summary.getByText(label, { exact: true })).toBeVisible()
    }
  })

  test('no horizontal overflow at 375, 414, 768, 1024 or 1280', async ({ page }) => {
    for (const width of [375, 414, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/dashboard')
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(scrollWidth, `overflow at ${width}px`).toBeLessThanOrEqual(innerWidth)
    }
  })

  test("at 375 every summary figure fits without clipping, clear of the panel's right edge", async ({
    page,
  }) => {
    // Fix round 1, area C: the 2×2 cells' right-column figures ("Thu nhập
    // ròng", "Chi tiêu tháng") were sitting flush against — or past — the
    // panel's right edge at 375, because `size="lg"`/`size="md"` (24 px/22 px)
    // no longer fit a 14-character VND figure in half of a phone-width
    // column. `summary-panel.tsx` now renders those four cells' figures at a
    // smaller size below `sm`.
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')

    const summary = page.locator('dl').first()
    const panelBox = await summary.boundingBox()
    expect(panelBox).not.toBeNull()

    const valueCells = summary.locator('dd')
    const count = await valueCells.count()
    expect(count).toBe(5)
    for (let i = 0; i < count; i++) {
      const cell = valueCells.nth(i)
      const { scrollWidth, clientWidth, text } = await cell.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        text: el.textContent,
      }))
      // A one pixel tolerance for sub-pixel rounding, matching the existing
      // 768 `dt` check below — a figure that genuinely overflows its box is
      // clipped by several pixels, not one.
      expect(scrollWidth, `figure "${text}" clipped at 375px`).toBeLessThanOrEqual(clientWidth + 1)

      const cellBox = await cell.boundingBox()
      expect(cellBox, `figure "${text}" has no bounding box`).not.toBeNull()
      if (cellBox && panelBox) {
        const marginFromPanelRight = panelBox.x + panelBox.width - (cellBox.x + cellBox.width)
        expect(
          marginFromPanelRight,
          `figure "${text}" sits within 12px of the panel's right edge`,
        ).toBeGreaterThanOrEqual(12)
      }
    }
  })

  test('at 768 every summary label is fully visible, never clipped', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/dashboard')

    const summary = page.locator('dl').first()
    const labelCells = summary.locator('dt')
    const count = await labelCells.count()
    expect(count).toBe(5)
    for (let i = 0; i < count; i++) {
      const cell = labelCells.nth(i)
      const { scrollWidth, clientWidth, text } = await cell.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        text: el.textContent,
      }))
      // A one pixel tolerance for sub-pixel rounding — a `dt` whose content
      // genuinely overflows its box is clipped by several pixels, not one.
      expect(scrollWidth, `label "${text}" clipped at 768px`).toBeLessThanOrEqual(clientWidth + 1)
    }
  })

  test('no raw enum value reaches the dashboard body', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(RAW_ENUM_PATTERN)
  })

  test('the recent-transactions amount cell never overlaps its meta text at 375', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')

    const recentSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: /Giao dịch gần đây|Recent Transactions/ }) })
    const firstRow = recentSection.locator('li').first()
    await expect(firstRow).toBeVisible()

    // `FinancialListRow` puts the title/meta column and the amount column in
    // separate flex children — the amount column is a fixed `min-w-[8.5rem]`
    // specifically so a long note or a wide meta line can never push into it.
    // `[class*=...]` (a substring match on the raw `class` attribute) rather
    // than a `.` class selector: Tailwind's arbitrary-value classes contain
    // `[`/`]`/`.` characters that a `.` selector cannot address without
    // CSS-escaping every one of them, and a quoted attribute value needs none.
    const metaBox = await firstRow.locator('div[class*="text-xs"]').first().boundingBox()
    const amountBox = await firstRow.locator('div[class*="min-w-[8.5rem]"]').first().boundingBox()
    expect(metaBox).not.toBeNull()
    expect(amountBox).not.toBeNull()
    if (metaBox && amountBox) {
      expect(metaBox.x + metaBox.width).toBeLessThanOrEqual(amountBox.x + 1)
    }
  })

  /**
   * Task 17, owner item H1. This test used to assert that a brand-new
   * dashboard showed five contextual empty states ("Chưa có giao dịch", "Chưa
   * có dữ liệu số dư", …) rather than a flat zero line. A user with nothing at
   * all now gets the three-step onboarding card in place of the whole widget
   * grid, so the five empty states are no longer what that user sees — and the
   * guarantee they encoded is asserted here in its stronger form: a brand-new
   * dashboard draws no chart AT ALL, so it cannot draw a flat line at zero.
   *
   * The per-widget empty states did not go away; they belong to a dashboard
   * that has *something* to show, and the test below this one asserts all
   * three of them on the populated user — which is the state a real user is in
   * when a widget is genuinely empty.
   */
  test('a brand-new dashboard guides the user, and the guidance goes away after the first transaction', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    // A throwaway registration inside the test: this user must have NOTHING
    // (no account, no transaction, no budget, no goal, no debt, no loan, no
    // reminder), which the populated user above deliberately is not.
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-dashboard-empty' })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    const card = page.getByRole('region', {
      name: /Bắt đầu với CashFlow|Get started with CashFlow/,
    })
    await expect(card).toBeVisible()
    // Three steps, in order, each offering its own way forward — and step 3's
    // two links are the "a budget OR a reminder" choice.
    await expect(card.getByRole('listitem')).toHaveCount(3)
    for (const name of [
      /Thêm tài khoản|Add account/,
      /Thêm giao dịch|Add transaction/,
      /Đặt ngân sách|Set a budget/,
      /Thêm nhắc nhở|Add reminder/,
    ]) {
      await expect(card.getByRole('link', { name })).toBeVisible()
    }

    // The widget grid is not merely empty — it is not rendered: no chart
    // anywhere (every chart wrapper is a `<figure aria-label>`; the
    // `EmptyState`'s own lucide icon is `aria-hidden` and carries no role), and
    // the card's own `h2` is the only section heading on the page.
    //
    // `figure`, not `[role="img"]`: Task 16 fix round 1 swapped the wrapper,
    // because `role="img"` pruned recharts' keyboard layer out of the
    // accessibility tree while leaving its plot in the tab order.
    await expect(page.getByRole('figure')).toHaveCount(0)
    await expect(page.locator('main section h2')).toHaveCount(1)
    for (const text of ['Chưa có giao dịch', 'Chưa có dữ liệu số dư']) {
      await expect(page.getByText(text, { exact: true })).toHaveCount(0)
    }

    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(RAW_ENUM_PATTERN)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'no overflow on the onboarding dashboard',
    ).toBe(true)

    // Step 1 completes on its own once an account exists — the only step that
    // can be complete while this card is on screen.
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 2_000_000 })
    await page.goto('/dashboard')
    await expect(card).toBeVisible()
    await expect(card.getByText(/^(Đã xong|Done)$/)).toBeVisible()
    await expect(card.getByRole('link', { name: /Thêm tài khoản|Add account/ })).toHaveCount(0)

    // And the whole card goes away the moment there is a transaction: the
    // normal dashboard renders unchanged from there on.
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 120_000,
    })
    await page.goto('/dashboard')
    await expect(card).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: /Giao dịch gần đây|Recent Transactions/ }),
    ).toBeVisible()
    await expect(page.getByRole('figure').first()).toBeVisible()
  })

  test('a populated dashboard still shows one empty state, with one action, per widget that has nothing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    // The onboarding card belongs to a user with no transactions; this one has
    // one, so the grid is what renders.
    await expect(
      page.getByRole('region', { name: /Bắt đầu với CashFlow|Get started with CashFlow/ }),
    ).toHaveCount(0)

    // Three widgets this user has nothing for. Each says what is missing and
    // offers exactly one way to fix it — and draws no chart while it does
    // (`ChartContainer`'s "view all" link is rendered only when the widget has
    // rows, so one link per section here IS the empty state's action).
    for (const [heading, empty, action] of [
      [/Tiến độ ngân sách|Budget Progress/, 'Chưa có ngân sách tháng này', /Đặt ngân sách/],
      [/Mục tiêu tiết kiệm|Savings Goals/, 'Chưa có mục tiêu tiết kiệm', /Đặt mục tiêu/],
      [
        /Nhắc nhở sắp tới|Upcoming Reminders/,
        'Không có gì đến hạn trong 30 ngày tới',
        /Thêm nhắc nhở/,
      ],
    ] as const) {
      const section = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: heading }) })
      await expect(section.getByText(empty, { exact: true })).toBeVisible()
      await expect(section.getByRole('link')).toHaveCount(1)
      await expect(section.getByRole('link', { name: action })).toBeVisible()
      await expect(section.getByRole('figure')).toHaveCount(0)
    }
  })

  test('switching to English in Settings renders the summary panel in English', async ({
    page,
  }) => {
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('en')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    await page.goto('/dashboard')
    const summary = page.locator('dl').first()
    for (const label of [
      'Net Worth',
      'Total Balance',
      'Monthly Income',
      'Monthly Expense',
      'Net Income',
    ]) {
      await expect(summary.getByText(label, { exact: true })).toBeVisible()
    }
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
  })

  test('switching to dark theme in Settings renders html.dark on /dashboard', async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="theme"]').selectOption('dark')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    await page.goto('/dashboard')
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    expect(isDark).toBe(true)
  })
})
