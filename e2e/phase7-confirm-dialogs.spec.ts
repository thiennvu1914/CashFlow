import os from 'os'
import path from 'path'
import { test, expect, type Page } from '@playwright/test'
import {
  createAccountViaUi,
  createBudgetViaUi,
  createDebtViaUi,
  createGoalViaUi,
  createLoanViaUi,
  createReminderViaUi,
  createTransactionViaUi,
  registerNewUser,
  todayInZone,
} from './helpers'

/**
 * Spec §10's confirmation rule, both halves (Task 17, owner item H4):
 *
 *  - EXACTLY these eight destructive actions ask first, in a `ConfirmDialog`
 *    that names what it will do: delete transaction, delete transfer, archive
 *    account, archive category, delete budget, archive goal, write off debt,
 *    close loan. Each is exercised twice here — Cancel changes nothing at all,
 *    and Confirm really does the thing.
 *  - The five harmless ones — acknowledge, dismiss, pause, resume, update
 *    progress — ask NOTHING. A dialog in front of an action that is its own
 *    undo trains the user to dismiss dialogs, which is how the eight above
 *    stop working.
 *  - And a stray Enter on an open confirmation cannot confirm it.
 *
 * There is no `window.confirm` left anywhere: this file registers no
 * `page.once('dialog')` handler, so a native dialog on any of these paths
 * would block the page and time the test out rather than be silently
 * accepted — which is the point.
 *
 * One user, one seed, `describe.serial`: the eight destructive cases each
 * consume the row they act on, so they can neither run in parallel nor in
 * another order. The seed is one of everything, plus three deliberate extras —
 * an untouched "Scratch" account (archiving requires a zero balance, so the
 * account being archived here has to be one nothing has ever moved through), a
 * second goal (an archived goal offers no progress button, and rightly), and
 * two one-off reminders (one occurrence each, so acknowledge and dismiss each
 * have their own row and neither depends on how a recurring reminder's group
 * collapses).
 */
const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-confirm-${process.pid}.json`)

/** The zone every registered user starts in — for the reminders' start date. */
const TODAY = todayInZone('Asia/Ho_Chi_Minh')

/** The accessible name of a row's `…` menu trigger (`common.rowActions`). */
function rowMenuName(row: string): RegExp {
  return new RegExp(`(Tác vụ cho|Actions for) ${row}`)
}

/** Opens a row's `…` menu and clicks the named item. */
async function rowAction(page: Page, row: string, itemName: RegExp): Promise<void> {
  await page
    .getByRole('button', { name: rowMenuName(row) })
    .first()
    .click()
  await page.getByRole('menuitem', { name: itemName }).click()
}

test.describe.serial('Phase 7 — confirmations', () => {
  test.use({ storageState: STORAGE_STATE_PATH })
  // `next dev` compiles each route and every server action behind it on first
  // request, exactly as `phase6.spec.ts` documents for its own seed.
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-confirm' })

    // One of everything the eight destructive actions need.
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    await createAccountViaUi(page, { name: 'Bank', currency: 'VND', initialBalance: 5_000_000 })
    // Never used by anything below, so its balance stays 0 — the one account
    // `archiveFinancialAccountAction` will accept (a non-zero balance is
    // refused as NON_ZERO_BALANCE, which is another test's subject).
    await createAccountViaUi(page, { name: 'Scratch', currency: 'VND', initialBalance: 0 })
    await createTransactionViaUi(page, {
      type: 'EXPENSE',
      accountName: 'Cash',
      categoryName: 'Food & Dining',
      amount: 100_000,
    })

    // A transfer, through its own form (there is no helper for one).
    await page.goto('/transfers')
    // The options read "<name> (<currency>)", so the label is the whole
    // string — and both are selected explicitly because the form's own
    // defaults are "the first account" and "the first one after it", which is
    // whatever order the service returns.
    await page.getByLabel(/^Từ$|^From$/).selectOption({ label: 'Cash (VND)' })
    await page.getByLabel(/^Đến$|^To$/).selectOption({ label: 'Bank (VND)' })
    await page.getByLabel(/^Số tiền$|^Amount$/).fill('50000')
    await page.getByRole('button', { name: /^Chuyển tiền$|^Transfer$/ }).click()
    await expect(page.getByRole('button', { name: rowMenuName('Cash → Bank') })).toBeVisible()

    // A custom expense category, so `/categories` has an archivable chip (a
    // default one cannot be archived and offers no menu at all). The page has
    // exactly three sections, each with one Add button, in the order account
    // types / expense / income — asserted, so a fourth section would fail here
    // loudly rather than silently type into the wrong one.
    await page.goto('/categories')
    const addButtons = page.getByRole('button', { name: /^Thêm$|^Add$/ })
    await expect(addButtons).toHaveCount(3)
    await page.getByLabel(/Thêm danh mục chi|Add expense category/).fill('Ca phe')
    await addButtons.nth(1).click()
    await expect(page.getByRole('button', { name: rowMenuName('Ca phe') })).toBeVisible()

    await createBudgetViaUi(page, { scope: 'OVERALL', amount: 10_000_000 })
    await createGoalViaUi(page, { name: 'Emergency fund', target: 20_000_000 })
    // The goal "update progress" acts on: the one above is archived below.
    await createGoalViaUi(page, { name: 'Laptop', target: 30_000_000 })
    await createDebtViaUi(page, { direction: 'RECEIVABLE', person: 'Minh', amount: 2_000_000 })
    await createLoanViaUi(page, {
      lender: 'Vietcombank',
      principal: 120_000_000,
      interestRate: 8.5,
      termMonths: 60,
      scheduledPayment: 3_800_000,
    })
    // MONTHLY, for pause/resume on the schedule tab.
    await createReminderViaUi(page, {
      title: 'Internet',
      type: 'EXPENSE',
      amount: 300_000,
      frequency: 'MONTHLY',
      startDate: TODAY,
    })
    // Two ONE_TIME reminders due today: one occurrence each, so acknowledge and
    // dismiss each have their own row.
    await createReminderViaUi(page, {
      title: 'Power bill',
      type: 'EXPENSE',
      amount: 400_000,
      frequency: 'ONE_TIME',
      startDate: TODAY,
    })
    await createReminderViaUi(page, {
      title: 'Water bill',
      type: 'EXPENSE',
      amount: 200_000,
      frequency: 'ONE_TIME',
      startDate: TODAY,
    })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  /**
   * The eight, in an order that respects what each one consumes. `row` is the
   * row's own visible name (what `common.rowActions` interpolates into the menu
   * trigger), `item` the menu item, `confirm` the dialog's confirm button, and
   * `effect` something the page shows only once the action has actually
   * happened — for five of them the list's own empty state, because the seed
   * gives those pages exactly one row.
   */
  const DESTRUCTIVE = [
    {
      name: 'delete transaction',
      url: '/transactions',
      row: 'Food & Dining',
      item: /Xóa giao dịch|Delete transaction/,
      confirm: /^(Xóa|Delete)$/,
      effect: /Chưa có giao dịch|No transactions yet/,
    },
    {
      name: 'delete transfer',
      url: '/transfers',
      row: 'Cash → Bank',
      item: /Xóa lệnh chuyển|Delete transfer/,
      confirm: /^(Xóa|Delete)$/,
      effect: /Chưa có lệnh chuyển nào|No transfers yet/,
    },
    {
      name: 'archive account',
      url: '/accounts',
      row: 'Scratch',
      item: /^(Lưu trữ|Archive)$/,
      confirm: /^(Lưu trữ|Archive)$/,
      // Two accounts are left, so there is no empty state to show: the
      // archived disclosure appearing with a count of one is the effect.
      effect: /Tài khoản đã lưu trữ \(1\)|Archived accounts \(1\)/,
    },
    {
      name: 'archive category',
      url: '/categories',
      row: 'Ca phe',
      item: /^(Lưu trữ|Archive)$/,
      confirm: /^(Lưu trữ|Archive)$/,
      // The default categories stay and this page has no archived section, so
      // the chip's own disappearance (asserted for every action below) is the
      // whole effect.
      effect: null,
    },
    {
      name: 'delete budget',
      url: '/budgets',
      row: '(?:Tổng thể|Overall)',
      item: /^(Xóa|Delete)$/,
      confirm: /^(Xóa|Delete)$/,
      effect: /Chưa có ngân sách cho|No budgets for/,
    },
    {
      name: 'archive goal',
      url: '/goals',
      row: 'Emergency fund',
      item: /^(Lưu trữ|Archive)$/,
      confirm: /^(Lưu trữ|Archive)$/,
      // "Laptop" is still active, so this page has no empty state either.
      effect: /Mục tiêu đã lưu trữ \(1\)|Archived goals \(1\)/,
    },
    {
      name: 'write off debt',
      url: '/debts',
      row: 'Minh',
      item: /Xóa nợ|Write off/,
      confirm: /Xóa nợ|Write off/,
      effect: /Chưa có công nợ|No debts yet/,
    },
    {
      name: 'close loan',
      url: '/loans',
      row: 'Vietcombank',
      item: /Đóng khoản vay|Close loan/,
      confirm: /Đóng khoản vay|Close loan/,
      effect: /Chưa có khoản vay|No loans yet/,
    },
  ] as const

  for (const action of DESTRUCTIVE) {
    test(`${action.name}: asks first, Cancel changes nothing, Confirm does it`, async ({
      page,
    }) => {
      await page.goto(action.url)
      const before = await page.locator('main').innerText()

      // --- It asks, and the question names what it will do.
      await rowAction(page, action.row, action.item)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      // A specific title, not "Are you sure?", and one sentence of consequence
      // under it (`ConfirmDialog` renders `description` through
      // `DialogDescription`, which is what `aria-describedby` points at).
      const title = dialog.getByRole('heading')
      await expect(title).toBeVisible()
      expect(
        (await title.innerText()).trim().length,
        `${action.name} dialog title`,
      ).toBeGreaterThan(0)
      const cancel = dialog.getByRole('button', { name: /^(Hủy|Cancel)$/ })
      await expect(cancel).toBeVisible()
      await expect(dialog.getByRole('button', { name: action.confirm })).toBeVisible()

      // --- Cancel changes nothing: not the row, not the page, not anything.
      await cancel.click()
      await expect(dialog).toBeHidden()
      expect(await page.locator('main').innerText(), `${action.name} after Cancel`).toBe(before)

      // --- Confirm really does it.
      await rowAction(page, action.row, action.item)
      await page.getByRole('dialog').getByRole('button', { name: action.confirm }).click()
      await expect(page.getByRole('dialog')).toBeHidden()
      // The row it acted on is gone from the page's operable list.
      await expect(page.getByRole('button', { name: rowMenuName(action.row) })).toHaveCount(0)
      if (action.effect) await expect(page.getByText(action.effect)).toBeVisible()
    })
  }

  /**
   * Five, not four: `resume` is a distinct code path
   * (`setReminderActiveAction(id, true)`) rendered by the same button as
   * `pause`, and "the action is its own undo" is only true if BOTH directions
   * are dialog-free. `resume` runs after `pause` in this serial file, so the
   * reminder really is paused by the time its button says "Tiếp tục".
   *
   * Every button is addressed by the row it belongs to — each of these
   * controls carries `aria-label="<action> <row title>"` precisely so two rows
   * can never present the same accessible name.
   */
  const HARMLESS = [
    {
      name: 'acknowledge',
      url: '/reminders?view=due&type=all',
      button: /(Ghi nhận|Acknowledge) Power bill/,
      form: false,
    },
    {
      name: 'dismiss',
      url: '/reminders?view=due&type=all',
      button: /(Bỏ qua|Dismiss) Water bill/,
      form: false,
    },
    {
      name: 'pause',
      url: '/reminders?view=schedule&type=all',
      button: /(Tạm dừng|Pause) Internet/,
      form: false,
    },
    {
      name: 'resume',
      url: '/reminders?view=schedule&type=all',
      button: /(Tiếp tục|Resume) Internet/,
      form: false,
    },
    {
      name: 'update progress',
      url: '/goals',
      button: /Cập nhật tiến độ|Update progress/,
      form: true,
    },
  ] as const

  for (const action of HARMLESS) {
    test(`${action.name} asks nothing`, async ({ page }) => {
      await page.goto(action.url)
      const button = page.getByRole('button', { name: action.button }).first()
      await expect(button).toBeVisible()
      await button.click()

      const dialog = page.getByRole('dialog')
      if (action.form) {
        // "Update progress" opens a FORM dialog, which is not a confirmation:
        // it has a labelled field to type a figure into and a Save button, not
        // a destructive verb.
        await expect(dialog).toBeVisible()
        await expect(dialog.getByLabel(/Số tiền hiện có|Current amount/)).toBeVisible()
        await expect(dialog.getByRole('button', { name: /^(Lưu|Save)$/ })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
      } else {
        // Nothing at all opens: the action ran on the click, and the button it
        // ran from is gone (acknowledge/dismiss) or has flipped to its
        // opposite (pause/resume).
        await expect(dialog).toHaveCount(0)
        await expect(button).toHaveCount(0)
      }
    })
  }

  /**
   * The a11y half of spec §10: a destructive dialog must not be confirmable by
   * a stray Enter on open. Base UI moves focus to the first tabbable element
   * inside the popup, which is the header's close button — ahead of both footer
   * buttons — so Enter reaches neither Confirm nor Cancel. Asserted by
   * consequence as well as by focus: after opening the dialog and pressing
   * Enter, the account is still exactly where it was.
   */
  test('a stray Enter on an open confirmation cannot confirm it', async ({ page }) => {
    await page.goto('/accounts')
    await rowAction(page, 'Cash', /^(Lưu trữ|Archive)$/)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    expect(
      ['Lưu trữ', 'Archive'].includes(focused),
      `the destructive button must not hold initial focus (focus was on "${focused}")`,
    ).toBe(false)

    await page.keyboard.press('Enter')
    // Cash is untouched — still listed, still with its own row menu, and no
    // second account has joined the archived disclosure. (It could not have
    // been archived anyway: its balance is not zero. The point is that nothing
    // was even attempted.)
    await page.goto('/accounts')
    await expect(page.getByRole('button', { name: rowMenuName('Cash') })).toBeVisible()
    await expect(page.getByText(/Tài khoản đã lưu trữ \(2\)|Archived accounts \(2\)/)).toHaveCount(
      0,
    )
  })
})
