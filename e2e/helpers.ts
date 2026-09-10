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
  await page.getByLabel(/^Tên$|^Name$/).fill('Phase 4 E2E User')
  await page.getByLabel(/^Email$/).fill(email)
  await page.getByLabel(/Mật khẩu|^Password$/).fill(password)
  await page.getByRole('button', { name: /Tạo tài khoản|Create account/ }).click()
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
 * Creates one financial account through the `/accounts` page's header action
 * and its create `Sheet` (spec §6.4) — creation lives behind "Thêm tài
 * khoản", not inline on the page.
 *
 * The sheet closing on success is the proof used here, not a cleared field:
 * `AccountForm.onCreated` closes the sheet, which is the app's own
 * confirmation that the account was actually created before the caller moves
 * on.
 */
export async function createAccountViaUi(
  page: Page,
  opts: { name: string; currency: 'VND' | 'USD'; initialBalance: number },
): Promise<void> {
  await page.goto('/accounts')
  await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm tài khoản|Add account/ })
  const nameInput = sheet.getByLabel(/Tên tài khoản|Account name/)
  await nameInput.fill(opts.name)
  if (opts.currency !== 'VND') {
    await sheet.getByLabel(/^Tiền tệ$|^Currency$/).selectOption(opts.currency)
  }
  await sheet.getByLabel(/Số dư ban đầu|Initial balance/).fill(String(opts.initialBalance))
  await sheet.getByRole('button', { name: /Tạo tài khoản|Create account/ }).click()
  // A successful submit resets the form, which clears the name field — and the
  // sheet closes itself, so wait for that instead: it is the app's own
  // confirmation that the account was created.
  await expect(sheet).toBeHidden()
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
 * Creates one budget through the `/budgets` page's header action ("Thêm ngân
 * sách") and its create `Sheet` (spec §6.5) — creation lives behind that
 * button, not inline on the page.
 *
 * Navigates to `/budgets` first by default (the page's *current* local month —
 * no `?month=` is ever passed, matching every seed in `phase5.spec.ts`).
 * `stayOnPage` suppresses that navigation for the one case that must submit
 * the form exactly as the caller left it: a client-side month change keeps the
 * mounted form alive, and a fresh `goto` would remount it and hide the very
 * staleness that case exists to catch. The sheet itself unmounts its form on
 * close, so that staleness is now prevented structurally too — reopening the
 * button always mounts a fresh `BudgetForm` with the current props — but the
 * client-side month MERGE this case actually asserts (the props a mounted
 * form was given, not a re-navigated one) is still real and still exercised.
 *
 * Always selects `scope` explicitly rather than relying on the form's default
 * (which flips between `OVERALL`/`CATEGORY` depending on whether an overall
 * budget already exists for the month) — a caller creating a second Overall
 * budget on purpose, to exercise the duplicate rejection, needs the field
 * selected regardless of that default.
 *
 * Does not assert success: a duplicate submission is expected to fail with an
 * inline error rather than resetting the form, so the caller — not this
 * helper — asserts whichever outcome its scenario expects.
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
  await page.getByRole('button', { name: /Thêm ngân sách|Add budget/ }).click()
  const sheet = page.getByRole('dialog', { name: /Thêm ngân sách|Add budget/ })
  await sheet.getByLabel(/Phạm vi|Budget scope/).selectOption(opts.scope)
  if (opts.scope === 'CATEGORY') {
    if (!opts.categoryName) {
      throw new Error('createBudgetViaUi: categoryName is required when scope is CATEGORY')
    }
    await sheet.getByLabel(/Danh mục|Budget category/).selectOption({ label: opts.categoryName })
  }
  await sheet.getByLabel(/Hạn mức|Budget amount/).fill(String(opts.amount))
  if (opts.currency && opts.currency !== 'VND') {
    await sheet.getByLabel(/Tiền tệ|Budget currency/).selectOption(opts.currency)
  }
  await sheet.getByRole('button', { name: /Thêm ngân sách|Add budget/ }).click()
  // Deliberately NOT asserted here: a duplicate submission is expected to
  // fail with an inline error rather than resetting the form, so the caller —
  // not this helper — asserts whichever outcome its scenario expects.
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
 *
 * A caller indexing `validation.json` directly (rather than passing a literal
 * string here) must go through `validationMessageKey`'s escaping rule first
 * (`lib/ui/validation-messages.ts`): next-intl reads `.` as a path separator,
 * so a Zod message containing a literal dot is keyed in `validation.json`
 * with every `.` replaced by `․` (ONE DOT LEADER) — e.g.
 * `viValidation[validationMessageKey(RAW_MESSAGE).replace('validation.', '')]`.
 * A message with no dot needs no such treatment, which is why every existing
 * caller in this suite indexes `viValidation[RAW_MESSAGE]` directly.
 */
export function eitherLocale(vi: string, en: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escape(vi)}|${escape(en)}`)
}

/**
 * Every signed-in route, in nav order. Shared by the specs that walk the
 * whole app — this task's enum sweep and the all-pages locale assertion in
 * `phase7-theme-locale.spec.ts` — so a per-spec copy is not how one of them
 * ends up missing a route a later phase adds.
 */
export const PAGES = [
  '/dashboard',
  '/transactions',
  '/transfers',
  '/accounts',
  '/categories',
  '/budgets',
  '/goals',
  '/debts',
  '/loans',
  '/reminders',
  '/reports',
  '/settings',
] as const
