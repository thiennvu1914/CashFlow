import { test, expect } from '@playwright/test'
import { readFile, rm } from 'fs/promises'
import path from 'path'

// Matches the EMAIL_OUTBOX_FILE path computed in playwright.config.ts.
const OUTBOX_FILE = path.resolve(__dirname, '.outbox/emails.jsonl')

interface OutboxLine {
  to: string
  subject: string
  html: string
  sentAt: string
}

async function readOutboxLines(): Promise<OutboxLine[]> {
  let content: string
  try {
    content = await readFile(OUTBOX_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as OutboxLine)
}

test.beforeAll(async () => {
  // Stale lines from a previous run must never match the current test's email.
  await rm(OUTBOX_FILE, { force: true })
})

test('register, log out, forgot password with a real reset round trip, then log in', async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@example.com`
  const oldPassword = 'correct-horse-battery-staple'
  const newPassword = 'correct-horse-battery-staple-2'

  await page.goto('/register')
  await page.getByLabel(/^Tên$|^Name$/).fill('E2E Test User')
  await page.getByLabel(/^Email$/).fill(email)
  await page.getByLabel(/Mật khẩu|^Password$/).fill(oldPassword)
  await page.getByRole('button', { name: /Tạo tài khoản|Create account/ }).click()
  // The same bounded 30 s allowance `registerNewUser` carries, and for the same
  // reason — see the twelve-line comment on `e2e/helpers.ts`'s own
  // `toHaveURL`. This spec sorts first, so under `workers: 1` this is THE first
  // assertion in the whole suite and the one that waits out Turbopack's cold
  // compile of the auth route and `/dashboard`; it kept Playwright's 5 s
  // default only because it predates the helper. Not routed through the helper
  // itself: this test needs the email and both passwords it chose, which the
  // helper generates and does not take. Every later assertion here keeps the
  // default timeout, including the second `/dashboard` navigation below — by
  // then the routes are compiled.
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 })

  // Log out is now translated (default locale vi: "Đăng xuất") — see the same
  // vi/en alternation `phase4.spec.ts` etc. use for every other nav selector
  // Phase 7 moved.
  await page.getByRole('button', { name: /^Đăng xuất$|^Log out$/ }).click()
  await expect(page).toHaveURL(/\/login/)

  await page.goto('/forgot-password')
  await page.getByLabel(/^Email$/).fill(email)
  await page.getByRole('button', { name: /Gửi liên kết đặt lại|Send reset link/ }).click()
  // The message now continues past the full stop ("...and can only be used
  // once."), so an exact-string match would miss it — assert a vi/en
  // alternation on the leading clause instead.
  await expect(
    page.getByText(/Nếu có tài khoản dùng email đó|If an account exists for that email/),
  ).toBeVisible()

  // Poll the file outbox for the reset email (the dev server writes it
  // asynchronously) and pull the reset URL out of its HTML body.
  let resetUrl: string | null = null
  await expect
    .poll(
      async () => {
        const lines = await readOutboxLines()
        const match = [...lines].reverse().find((line) => line.to === email)
        resetUrl = match ? (match.html.match(/href="([^"]+)"/)?.[1] ?? null) : null
        return resetUrl
      },
      { timeout: 10_000, message: 'waiting for password reset email in the file outbox' },
    )
    .not.toBeNull()

  // Better Auth's reset link points at its own verification endpoint, which
  // redirects to /reset-password?token=... on success.
  await page.goto(resetUrl!)
  await expect(page).toHaveURL(/\/reset-password\?token=/)
  await page.getByLabel(/Mật khẩu mới|New password/).fill(newPassword)
  await page.getByRole('button', { name: /Đặt mật khẩu mới|Set new password/ }).click()
  await expect(page).toHaveURL(/\/login/)

  // The old password must no longer work.
  await page.getByLabel(/^Email$/).fill(email)
  await page.getByLabel(/Mật khẩu|^Password$/).fill(oldPassword)
  await page.getByRole('button', { name: /Đăng nhập|Sign in/ }).click()
  await expect(
    page.getByText(/Email hoặc mật khẩu không đúng|Invalid email or password/),
  ).toBeVisible()

  // The new password does.
  await page.getByLabel(/Mật khẩu|^Password$/).fill(newPassword)
  await page.getByRole('button', { name: /Đăng nhập|Sign in/ }).click()
  await expect(page).toHaveURL(/\/dashboard/)
})

test('a logged-out visitor is redirected to /login from protected routes', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)

  await page.goto('/settings')
  await expect(page).toHaveURL(/\/login/)
})

test('reset-password with an invalid or expired token shows an explicit invalid-token state', async ({
  page,
}) => {
  await page.goto('/reset-password?error=INVALID_TOKEN')
  await expect(page.getByRole('heading', { name: /không hợp lệ|invalid or expired/ })).toBeVisible()
  await expect(
    page.getByRole('link', { name: /Yêu cầu liên kết mới|Request a new reset link/ }),
  ).toHaveAttribute('href', '/forgot-password')
})
