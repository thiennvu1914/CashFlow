import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Registers a brand-new throwaway user via `/register` (the same UI flow
 * `auth.spec.ts` exercises) and leaves `page` on `/dashboard`, signed in.
 *
 * Each caller gets a unique email so parallel/serial runs never collide with a
 * user created by a previous run against the same dev database.
 */
export async function registerNewUser(
  page: Page,
  opts: { emailPrefix?: string } = {},
): Promise<{ email: string; password: string }> {
  const email = `${opts.emailPrefix ?? 'e2e-phase4'}-${Date.now()}@example.com`
  const password = 'correct-horse-battery-staple'

  await page.goto('/register')
  await page.getByPlaceholder('Name').fill('Phase 4 E2E User')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  return { email, password }
}

/**
 * Creates one financial account through the `/accounts` page's "Add account"
 * form, and waits for the form to reset (its `name` field clears back to `''`
 * on a successful submit) as proof the account was actually created before
 * the caller moves on.
 */
export async function createAccountViaUi(
  page: Page,
  opts: { name: string; currency: 'VND' | 'USD'; initialBalance: number },
): Promise<void> {
  await page.goto('/accounts')
  const nameInput = page.getByPlaceholder('Account name')
  await nameInput.fill(opts.name)
  if (opts.currency !== 'VND') {
    await page.getByLabel('Currency').selectOption(opts.currency)
  }
  await page.getByPlaceholder('Initial balance').fill(String(opts.initialBalance))
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(nameInput).toHaveValue('')
}

/**
 * Creates one transaction through the `/transactions` page's "Add
 * transaction" form. Leaves the date/time field at its pre-filled "now"
 * default (in the user's configured timezone) — the seed data does not need
 * a specific instant, only "today".
 */
export async function createTransactionViaUi(
  page: Page,
  opts: {
    type: 'INCOME' | 'EXPENSE'
    accountName: string
    categoryName: string
    amount: number
  },
): Promise<void> {
  await page.goto('/transactions')
  await page.getByLabel('Transaction type').selectOption(opts.type)
  // The category <select>'s options are re-filtered by `type` via client
  // state, not a fresh navigation — wait for the relevant category to
  // actually appear among its options before selecting it, so a slow
  // re-render cannot race the next action.
  const categorySelect = page.getByLabel('Category', { exact: true })
  await expect(categorySelect).toContainText(opts.categoryName)
  await page.getByLabel('Account', { exact: true }).selectOption({ label: opts.accountName })
  await categorySelect.selectOption({ label: opts.categoryName })
  const amountInput = page.getByLabel('Amount', { exact: true })
  await amountInput.fill(String(opts.amount))
  await page.getByRole('button', { name: 'Add transaction' }).click()
  // A successful submit resets the form to its defaults, which sets the
  // amount field back to `0`.
  await expect(amountInput).toHaveValue('0')
}

/**
 * `locator.selectOption()`, made robust against `BudgetForm`'s own
 * `react-hook-form` default: the field's `ref` callback applies
 * `useForm`'s `defaultValues` to the DOM `<select>` once React finishes
 * hydrating, which can land *after* an interaction made in the brief window
 * between the page's `load` event and that hydration completing — silently
 * reverting a selection back to the form's default. That is invisible
 * whenever the wanted option already matches the default (an Overall budget
 * on an otherwise-empty month, whose default *is* Overall), which is exactly
 * why this only surfaces once a different default has taken over (Overall
 * again, once a Category default already exists for the month) — the same
 * `<select>`, the same call, a different silent outcome. Retrying the whole
 * select-then-verify cycle (rather than the select alone) means a revert
 * landing mid-verification is simply tried again, until the value actually
 * sticks.
 */
async function selectAndVerify(
  locator: Locator,
  option: string | { label: string },
): Promise<void> {
  const page = locator.page()
  await expect(async () => {
    await locator.selectOption(option)
    // A value that "took" immediately after `selectOption` can still be
    // reverted a moment later — by the same `react-hook-form` mount-time
    // default landing just *after* this select fired, on a slow/cold dev
    // bundle. Checking only right away would race exactly that delayed
    // revert; pausing before reading back, then retrying the whole cycle on
    // a mismatch, is what actually catches it.
    await page.waitForTimeout(250)
    if (typeof option === 'string') {
      await expect(locator).toHaveValue(option)
    } else {
      await expect(locator.locator('option:checked')).toHaveText(option.label)
    }
  }).toPass({ timeout: 15_000 })
}

/** The same mount-time-default race `selectAndVerify` guards against, for a
 *  plain `<input>` — `react-hook-form`'s ref callback applies `defaultValues`
 *  to an uncontrolled input's DOM value on mount exactly as it does for a
 *  `<select>`, so a `.fill()` in that same window can just as easily be
 *  reverted to `0`. */
async function fillAndVerify(locator: Locator, value: string): Promise<void> {
  const page = locator.page()
  await expect(async () => {
    await locator.fill(value)
    await page.waitForTimeout(250)
    await expect(locator).toHaveValue(value)
  }).toPass({ timeout: 15_000 })
}

/**
 * Creates one budget through the `/budgets` page's "Add budget" form.
 *
 * Always navigates to `/budgets` first (the page's *current* local month —
 * no `?month=` is ever passed, matching every seed in `phase5.spec.ts`) and
 * always selects `scope` explicitly rather than relying on the form's default
 * (which flips between `OVERALL`/`CATEGORY` depending on whether an overall
 * budget already exists for the month) — a caller creating a second Overall
 * budget on purpose, to exercise the duplicate rejection, needs the field
 * selected regardless of that default.
 *
 * Does not assert success: a duplicate submission is expected to fail with an
 * inline error rather than resetting the form, so the caller — not this
 * helper — asserts whichever outcome the scenario expects.
 */
export async function createBudgetViaUi(
  page: Page,
  opts: {
    scope: 'OVERALL' | 'CATEGORY'
    categoryName?: string
    amount: number
    currency?: 'VND' | 'USD'
  },
): Promise<void> {
  await page.goto('/budgets')
  await selectAndVerify(page.getByLabel('Budget scope'), opts.scope)
  if (opts.scope === 'CATEGORY') {
    if (!opts.categoryName) {
      throw new Error('createBudgetViaUi: categoryName is required when scope is CATEGORY')
    }
    await selectAndVerify(page.getByLabel('Budget category'), { label: opts.categoryName })
  }
  await fillAndVerify(page.getByLabel('Budget amount'), String(opts.amount))
  if (opts.currency && opts.currency !== 'VND') {
    await selectAndVerify(page.getByLabel('Budget currency'), opts.currency)
  }
  await page.getByRole('button', { name: 'Add budget' }).click()
}

/** "Today" as `yyyy-MM-dd` in the given IANA timezone (no `Date` library needed). */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // en-CA formats as yyyy-MM-dd.
  return formatter.format(now)
}

/** Strips everything but digits — for comparing locale-formatted money without caring about separators. */
export function digitsOnly(text: string): string {
  return text.replace(/[^\d]/g, '')
}
