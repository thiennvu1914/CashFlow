import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Next.js 16's dev-mode route indicator renders inside a `<nextjs-portal>`
 * custom element whose invisible hit-testing area spans (at least) the whole
 * viewport, and it sits in front of ordinary page content — reproduced live
 * against this dev server: even the existing `e2e/auth.spec.ts`'s "Log out"
 * click times out after 30s with Playwright reporting
 * "<nextjs-portal></nextjs-portal> ... subtree intercepts pointer events",
 * nowhere near the indicator's own on-screen badge. `devIndicators: false` in
 * `next.config.ts` is Next's own documented way to turn this off, but that is
 * an app source change this task must not make.
 *
 * This is the test-side workaround instead: force the portal's pointer-events
 * off for this one Playwright page, before its first navigation. It changes
 * nothing about the app or what is rendered — only whether that (dev-only,
 * invisible) element can steal a click meant for the real page underneath it.
 * A descendant that explicitly re-asserts `pointer-events: auto` (the
 * indicator's own visible badge, presumably) is unaffected by this — CSS
 * `pointer-events` is inherited, not enforced top-down, so an explicit value
 * on a descendant always wins over an ancestor's.
 */
export async function neutralizeDevOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const STYLE_ID = '__e2e_disable_dev_overlay__'
    function install() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = 'nextjs-portal { pointer-events: none !important; }'
      document.documentElement.appendChild(style)
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install)
    } else {
      install()
    }
  })
}

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

  await neutralizeDevOverlay(page)
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
