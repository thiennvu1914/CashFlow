import os from 'os'
import path from 'path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { registerNewUser, todayInZone } from './helpers'

/**
 * Phase 7 Task 9: owner requirement S — coverage the Reminders rebuild adds on
 * top of `phase6.spec.ts` (which this task already migrated to the new two-
 * tab/collapse/PlanningRow UI). This file is the NEW, additional coverage:
 * Vietnamese relative-date text by default and real English text through
 * Settings (never a raw `dueLabel`/enum literal — the whole point of Task 9's
 * view-model change), the Dashboard widget's own localisation, acknowledge/
 * dismiss actually removing a row, the create form's twelve visible labels
 * with the monthly/yearly anchor fields, the weekly-reminder collapse with its
 * "+n kỳ" badge and expander, and the Overdue group's count.
 *
 * `resolveLocale()` reads the signed-in session's stored `locale` before the
 * `NEXT_LOCALE` cookie (same reasoning `phase7-debts-loans.spec.ts` and
 * `phase7-budgets-goals.spec.ts` give), so English is reached through
 * `/settings`, not a cookie set directly.
 *
 * No `waitForTimeout`, no retries, and `playwright.config.ts` runs with
 * `retries: 0`: every value that can still change is asserted through an
 * auto-retrying matcher.
 */

const TIMEZONE = 'Asia/Ho_Chi_Minh'

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-phase7-reminders-storage-state-${process.pid}.json`,
)

const TODAY = todayInZone(TIMEZONE)

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** `days` calendar days from `TODAY` (negative for the past), computed on
 *  UTC-midnight carriers — the same technique `phase6.spec.ts`'s `TOMORROW`
 *  uses — never by adding milliseconds to an instant. */
function offsetFromToday(days: number): string {
  return formatCalendarDate(new Date(calendarDateToUtcCarrier(TODAY).getTime() + days * MS_PER_DAY))
}

/** The `<li>` row `OccurrenceList`/`ReminderList` renders for one record,
 *  found by the visible name in its header line — same helper as
 *  `phase6.spec.ts`'s. */
function namedRow(page: Page, root: Page | Locator, name: string): Locator {
  return root.locator('li').filter({ has: page.getByText(name, { exact: true }) })
}

/** The `<section>` a group renders under `heading` — Overdue/Upcoming here. */
function sectionFor(page: Page, heading: string | RegExp): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) })
}

/**
 * Creates one reminder through the `/reminders` page's header action ("Thêm
 * nhắc nhở") and its create `Sheet` — the same flow `phase6.spec.ts`'s local
 * helper uses.
 */
async function createReminderViaUi(
  page: Page,
  opts: {
    title: string
    type: 'EXPENSE' | 'INCOME'
    amount: number
    frequency: 'ONE_TIME' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
    dayOfMonth?: number
    startDate: string
  },
): Promise<void> {
  await page.goto('/reminders')
  await page.getByRole('button', { name: /Thêm nhắc nhở|Add reminder/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm nhắc nhở|Add reminder/ })
  await sheet.getByLabel(/^Tiêu đề$|^Title$/).fill(opts.title)
  await sheet.getByLabel(/^Loại$|^Type$/).selectOption(opts.type)
  await sheet.getByLabel(/Số tiền dự kiến|Expected amount/).fill(String(opts.amount))
  await sheet.getByLabel(/^Tần suất$|^Frequency$/).selectOption(opts.frequency)
  if (opts.dayOfMonth !== undefined) {
    await sheet.getByLabel(/Ngày trong tháng|Day of month/).fill(String(opts.dayOfMonth))
  }
  await sheet.getByLabel(/^Ngày bắt đầu$|^Start date$/).fill(opts.startDate)
  await sheet.getByRole('button', { name: /Thêm nhắc nhở|Add reminder/ }).click()
  await expect(sheet).toBeHidden()
}

test.describe.serial('Phase 7 Task 9 — reminders', () => {
  test.use({ storageState: STORAGE_STATE_PATH })
  test.describe.configure({ timeout: 120_000 })

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-phase7-reminders' })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('vi: relative-date wording is Vietnamese, never a raw English literal, and the Overdue group states its count', async ({
    page,
  }) => {
    // One overdue (5 days late), one due today, one due in three days — the
    // three cases `dueKey` (`components/reminders/occurrence-list.tsx`) picks
    // between.
    await createReminderViaUi(page, {
      title: 'Old cable bill',
      type: 'EXPENSE',
      amount: 150_000,
      frequency: 'ONE_TIME',
      startDate: offsetFromToday(-5),
    })
    await createReminderViaUi(page, {
      title: 'Water bill',
      type: 'EXPENSE',
      amount: 80_000,
      frequency: 'ONE_TIME',
      startDate: TODAY,
    })
    await createReminderViaUi(page, {
      title: 'Phone bill',
      type: 'EXPENSE',
      amount: 200_000,
      frequency: 'ONE_TIME',
      startDate: offsetFromToday(3),
    })

    await page.goto('/reminders?view=due&type=all')

    await expect(page.getByRole('heading', { name: 'Quá hạn', level: 3 })).toBeVisible()
    await expect(page.getByText('1 quá hạn', { exact: true })).toBeVisible()

    const overdue = sectionFor(page, 'Quá hạn')
    await expect(namedRow(page, overdue, 'Old cable bill')).toContainText('Quá hạn')

    const upcoming = sectionFor(page, 'Sắp tới')
    await expect(namedRow(page, upcoming, 'Water bill')).toContainText('Hôm nay')
    await expect(namedRow(page, upcoming, 'Phone bill')).toContainText('Còn 3 ngày')

    // No raw literal anywhere on the page — the regression this task's owner
    // requirement N covers at the view-model layer, restated here on the
    // rendered DOM.
    const bodyText = await page.locator('main').innerText()
    expect(bodyText).not.toMatch(/\bToday\b|\bTomorrow\b|\bOverdue\b|\bIn \d+ days\b/)
  })

  test('en (via Settings): the same three rows read in English', async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('en')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Profile saved')).toBeVisible()

    await page.goto('/reminders?view=due&type=all')

    await expect(page.getByRole('heading', { name: 'Overdue', level: 3 })).toBeVisible()
    await expect(page.getByText('1 overdue', { exact: true })).toBeVisible()

    const overdue = sectionFor(page, 'Overdue')
    await expect(namedRow(page, overdue, 'Old cable bill')).toContainText('Overdue')

    const upcoming = sectionFor(page, 'Upcoming')
    await expect(namedRow(page, upcoming, 'Water bill')).toContainText('Today')
    await expect(namedRow(page, upcoming, 'Phone bill')).toContainText('In 3 days')

    // Switch back to vi for the tests that follow, which assert vi copy.
    // (The Settings form itself is not yet localised — Task 13's scope — so
    // its OWN button/notice stay the English literal `profile-form.tsx`
    // hard-codes regardless of which app locale is selected.)
    await page.goto('/settings', { waitUntil: 'commit' })
    await page.locator('select[name="locale"]').selectOption('vi')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Profile saved')).toBeVisible()
  })

  test('vi: the Dashboard Upcoming Reminders widget is fully Vietnamese, with no English relative-date literal', async ({
    page,
  }) => {
    await createReminderViaUi(page, {
      title: 'Gas bill',
      type: 'EXPENSE',
      amount: 120_000,
      frequency: 'ONE_TIME',
      startDate: offsetFromToday(1),
    })

    await page.goto('/dashboard')
    const widget = sectionFor(page, /Nhắc nhở sắp tới/)
    await expect(widget).toBeVisible()
    await expect(namedRow(page, widget, 'Gas bill')).toContainText('Ngày mai')

    const widgetText = await widget.innerText()
    expect(widgetText).not.toMatch(/\bToday\b|\bTomorrow\b|\bOverdue\b|\bIn \d+ days\b/)
  })

  test('acknowledge and dismiss each remove their own occurrence from Sắp đến hạn', async ({
    page,
  }) => {
    await createReminderViaUi(page, {
      title: 'Streaming subscription',
      type: 'EXPENSE',
      amount: 99_000,
      frequency: 'ONE_TIME',
      startDate: TODAY,
    })
    await createReminderViaUi(page, {
      title: 'Freelance payment',
      type: 'INCOME',
      amount: 3_000_000,
      frequency: 'ONE_TIME',
      startDate: TODAY,
    })

    await page.goto('/reminders?view=due&type=all')
    await page
      .getByRole('button', { name: new RegExp(`Ghi nhận.*Streaming subscription.*${TODAY}`) })
      .click()
    await expect(namedRow(page, page, 'Streaming subscription')).toHaveCount(0)

    await page
      .getByRole('button', { name: new RegExp(`Bỏ qua.*Freelance payment.*${TODAY}`) })
      .click()
    await expect(namedRow(page, page, 'Freelance payment')).toHaveCount(0)

    // Neither answer is a delete: both definitions remain in "Lịch nhắc".
    await page.goto('/reminders?view=schedule&type=all')
    await expect(namedRow(page, page, 'Streaming subscription')).toBeVisible()
    await expect(namedRow(page, page, 'Freelance payment')).toBeVisible()
  })

  test('the create form labels every field, and the monthly/yearly anchor options render', async ({
    page,
  }) => {
    await page.goto('/reminders')
    await page.getByRole('button', { name: 'Thêm nhắc nhở' }).click()
    const sheet = page.getByRole('dialog', { name: 'Thêm nhắc nhở' })

    // Eleven visible labels at the default frequency (MONTHLY) — Month is
    // YEARLY-only and not rendered yet. `exact: true` throughout: `hasText`'s
    // substring match is case-insensitive, and "Ngày trong tháng" would
    // otherwise falsely satisfy a bare "Tháng" check below.
    for (const label of [
      'Tiêu đề',
      'Loại',
      'Số tiền dự kiến',
      'Tiền tệ',
      'Tần suất',
      'Mỗi',
      'Ngày trong tháng',
      'Ngày bắt đầu',
      'Danh mục (tùy chọn)',
      'Tài khoản (tùy chọn)',
      'Ghi chú (tùy chọn)',
    ]) {
      await expect(sheet.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(sheet.getByText('Tháng', { exact: true })).toHaveCount(0)

    // Switch to YEARLY: the Month field appears, labelled, with twelve options.
    await sheet.getByLabel(/^Tần suất$/).selectOption('YEARLY')
    const monthField = sheet.getByLabel(/^Tháng$/)
    await expect(monthField).toBeVisible()
    await expect(monthField.locator('option')).toHaveCount(13) // placeholder + 12 months
    await expect(sheet.getByLabel(/^Ngày trong tháng$/)).toBeVisible()

    // Switch to WEEKLY: neither anchor is meaningful for it (ruling R6-18).
    await sheet.getByLabel(/^Tần suất$/).selectOption('WEEKLY')
    await expect(sheet.getByText('Tháng', { exact: true })).toHaveCount(0)
    await expect(sheet.getByText('Ngày trong tháng', { exact: true })).toHaveCount(0)
    await expect(sheet.getByText('tuần', { exact: true })).toBeVisible()
  })

  test('a weekly reminder collapses to one row with a "+n kỳ" badge, and the expander reveals the rest', async ({
    page,
  }) => {
    await createReminderViaUi(page, {
      title: 'Gym membership',
      type: 'EXPENSE',
      amount: 500_000,
      frequency: 'WEEKLY',
      startDate: TODAY,
    })

    await page.goto('/reminders?view=due&type=all')
    const rows = page.getByRole('listitem').filter({ hasText: 'Gym membership' })
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(/\+\d+ kỳ/)

    const summary = rows.first().locator('summary')
    await expect(summary).toContainText('Gym membership')
    const restRows = rows.first().locator('details ul li')
    await expect(restRows.first()).not.toBeVisible()
    await summary.click()
    await expect(restRows.first()).toBeVisible()
    const restCount = await restRows.count()
    expect(restCount).toBeGreaterThan(0)

    // Every remaining occurrence still gets its own Acknowledge/Dismiss pair —
    // nothing behind the disclosure is read-only.
    await expect(restRows.first().getByRole('button', { name: /^Ghi nhận/ })).toBeVisible()
  })

  test('375: no horizontal overflow on /reminders (both tabs)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })

    for (const url of ['/reminders?view=due', '/reminders?view=schedule']) {
      await page.goto(url)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      )
      expect(overflow, url).toBe(true)
    }
  })
})
