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

  test('an empty (brand-new) dashboard shows contextual empty states, never a flat zero line', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    // A second, throwaway context: this user must have NOTHING (no account, no
    // transaction, no budget, no goal, no debt, no loan, no reminder), which
    // the populated user above deliberately is not.
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-dashboard-empty' })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    for (const text of [
      'Chưa có giao dịch',
      'Chưa có ngân sách tháng này',
      'Chưa có mục tiêu tiết kiệm',
      'Chưa có dữ liệu số dư',
      'Chưa có tài khoản nào',
    ]) {
      await expect(page.getByText(text, { exact: true })).toBeVisible()
    }

    // The balance-history widget's empty state, specifically — never a chart
    // with a flat line at zero. Every chart wrapper (not the `EmptyState`'s
    // own lucide icon, which is `aria-hidden` and carries no `role`) is a
    // `role="img"` div — its absence, alongside the visible empty-state copy,
    // is what tells "the chart rendered" and "the empty state rendered" apart.
    const balanceSection = page.locator('section').filter({
      has: page.getByRole('heading', { name: /Số dư theo thời gian|Account Balance Over Time/ }),
    })
    await expect(balanceSection.locator('[role="img"]')).toHaveCount(0)
    await expect(balanceSection.getByText('Chưa có dữ liệu số dư')).toBeVisible()

    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(RAW_ENUM_PATTERN)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
    expect(overflow).toBe(true)
  })

  test('switching to English in Settings renders the summary panel in English', async ({
    page,
  }) => {
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('en')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Profile saved')).toBeVisible()

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
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Profile saved')).toBeVisible()

    await page.goto('/dashboard')
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    expect(isDark).toBe(true)
  })
})
