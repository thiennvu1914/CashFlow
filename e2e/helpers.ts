import type { Page } from '@playwright/test'
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
  // A wider bound than Playwright's default 5 s, for one reason only: on a
  // freshly started dev server (`CI=1` makes the config start its own) this is
  // the FIRST request that hits the auth API route and `/dashboard`, and
  // Turbopack compiles both on demand before it can answer — routinely more
  // than 5 s on a cold machine. That is the server building code, not the app
  // being slow, and it has nothing to do with the hydration gate: this form has
  // no `defaultValues`, so react-hook-form reads the typed values from the DOM
  // rather than writing over them. Every later assertion in the suite keeps the
  // default timeout.
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 })

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
 * transaction" form. Leaves the date/time fields at their pre-filled "now"
 * default (in the user's configured timezone) — the seed data does not need
 * a specific instant, only "today".
 *
 * Plain `fill`/`click`, with no verify-and-retry wrapper: the form is inside
 * a `<fieldset disabled>` until hydration finishes (`useHydrated`,
 * `lib/ui/use-hydrated.ts`), and Playwright's actionability check treats a
 * control in a disabled fieldset as disabled — so every action below already
 * waits for the earliest moment the app itself accepts input, and nothing it
 * accepts is ever thrown away afterwards. The two custom Selects (Account,
 * Category) only mount once `useHydrated()` flips too (`transaction-form.tsx`
 * renders their disabled native `<select>` stand-in until then), so clicking
 * their `combobox` trigger also waits out the same gate.
 */
export async function createTransactionViaUi(
  page: Page,
  opts: {
    type: 'INCOME' | 'EXPENSE'
    accountName: string
    categoryName: string
    amount: number
    /** Optional; typed into the Note field when given. */
    note?: string
  },
): Promise<void> {
  await page.goto('/transactions')
  // The type is a radiogroup of buttons now (spec §6.2), not a <select>: click
  // the radio whose accessible name is the type's product label. The vi/en
  // alternation keeps this helper working in either locale.
  const typeLabel = opts.type === 'INCOME' ? /Thu nhập|^Income$/ : /Chi tiêu|^Expense$/
  await page.getByRole('radio', { name: typeLabel }).click()

  // The account and category pickers are custom Selects (base-ui comboboxes):
  // open, then pick the option by name. `getByRole('combobox', { name })` finds
  // them by their visible <label>, which every field now has.
  await page.getByRole('combobox', { name: /Tài khoản|^Account$/ }).click()
  await page.getByRole('option', { name: new RegExp(opts.accountName) }).click()

  await page.getByRole('combobox', { name: /Danh mục|^Category$/ }).click()
  await page.getByRole('option', { name: opts.categoryName, exact: true }).click()

  const amountInput = page.getByLabel(/Số tiền|^Amount$/)
  await amountInput.fill(String(opts.amount))
  if (opts.note) await page.getByLabel(/Ghi chú|^Note/).fill(opts.note)

  // Both date fields stay at their pre-filled "now" — the seed needs "today",
  // not a specific instant, so the split into Ngày and Giờ costs this helper
  // nothing.
  await page.getByRole('button', { name: /Thêm giao dịch|Add transaction/ }).click()
  // A successful submit resets the form to its defaults, which sets the
  // amount field back to `0`.
  await expect(amountInput).toHaveValue('0')
}

/**
 * Creates one budget through the `/budgets` page's "Add budget" form.
 *
 * Navigates to `/budgets` first by default (the page's *current* local month —
 * no `?month=` is ever passed, matching every seed in `phase5.spec.ts`).
 * `stayOnPage` suppresses that navigation for the one case that must submit
 * the form exactly as the caller left it: a client-side month change keeps the
 * mounted form alive, and a fresh `goto` would remount it and hide the very
 * staleness that case exists to catch.
 *
 * Always selects `scope` explicitly rather than relying on the form's default
 * (which flips between `OVERALL`/`CATEGORY` depending on whether an overall
 * budget already exists for the month) — a caller creating a second Overall
 * budget on purpose, to exercise the duplicate rejection, needs the field
 * selected regardless of that default.
 *
 * Does not assert success: a duplicate submission is expected to fail with an
 * inline error rather than resetting the form, so the caller — not this
 * helper — asserts whichever outcome the scenario expects.
 *
 * Plain `selectOption`/`fill` here too — see `createTransactionViaUi` and
 * `lib/ui/use-hydrated.ts`.
 */
export async function createBudgetViaUi(
  page: Page,
  opts: {
    scope: 'OVERALL' | 'CATEGORY'
    categoryName?: string
    amount: number
    currency?: 'VND' | 'USD'
    stayOnPage?: boolean
  },
): Promise<void> {
  if (!opts.stayOnPage) await page.goto('/budgets')
  await page.getByLabel('Budget scope').selectOption(opts.scope)
  if (opts.scope === 'CATEGORY') {
    if (!opts.categoryName) {
      throw new Error('createBudgetViaUi: categoryName is required when scope is CATEGORY')
    }
    await page.getByLabel('Budget category').selectOption({ label: opts.categoryName })
  }
  await page.getByLabel('Budget amount').fill(String(opts.amount))
  if (opts.currency && opts.currency !== 'VND') {
    await page.getByLabel('Budget currency').selectOption(opts.currency)
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

/**
 * A vi/en alternation for one message, so a spec asserts that the right
 * message surfaced without pinning which locale is rendering. The message
 * TEXT is not what these tests are about — the alternation only proves it
 * localises to whichever locale the page is rendering.
 */
export function eitherLocale(vi: string, en: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escape(vi)}|${escape(en)}`)
}
