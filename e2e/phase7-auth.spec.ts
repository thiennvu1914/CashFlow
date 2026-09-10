import { test, expect } from '@playwright/test'
import { registerNewUser } from './helpers'

/**
 * Phase 7 Task 12 — the rebuilt auth family (spec §6.10): a shared 400 px
 * card carrying the wordmark and tagline, an `h1` per screen, labelled
 * fields, translated errors, one primary button, subtle secondary links, and
 * Reset's explicit invalid-token state.
 *
 * No shared `storageState`: every test here either needs NO session (the
 * four screens are pre-auth by definition) or creates its own throwaway
 * account via `registerNewUser`, so the tests are independent of each other
 * and of run order.
 */

test('login renders the wordmark, tagline, an h1, labelled fields and the secondary links — Vietnamese by default', async ({
  page,
}) => {
  await page.goto('/login')

  await expect(page.getByText('CashFlow', { exact: true })).toBeVisible()
  await expect(page.getByText('Quản lý tài chính cá nhân')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Đăng nhập CashFlow' })).toBeVisible()
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByLabel('Mật khẩu')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Đăng nhập' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Quên mật khẩu?' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Tạo tài khoản' })).toBeVisible()
})

test('login renders in English via the NEXT_LOCALE cookie', async ({ page }) => {
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: 'http://localhost:3000' }])
  await page.goto('/login')

  await expect(page.getByText('CashFlow', { exact: true })).toBeVisible()
  await expect(page.getByText('Personal finance management')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to CashFlow' })).toBeVisible()
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByLabel('Password')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create one' })).toBeVisible()
})

test('registers a fresh user through the redesigned register form and lands on /dashboard', async ({
  page,
}) => {
  await registerNewUser(page, { emailPrefix: 'e2e-phase7-auth-register' })
  await expect(page).toHaveURL(/\/dashboard/)
})

test('a duplicate-email registration shows the translated "email taken" message, never a Better Auth code', async ({
  page,
}) => {
  const { email } = await registerNewUser(page, { emailPrefix: 'e2e-phase7-auth-dup' })

  await page.goto('/register')
  await page.getByLabel(/^Tên$/).fill('Second Attempt')
  await page.getByLabel(/^Email$/).fill(email)
  await page.getByLabel(/Mật khẩu/).fill('another-good-password-1')
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click()

  await expect(page.getByText('Đã có tài khoản dùng email đó.')).toBeVisible()
  // The technical Better Auth code must never reach the DOM.
  await expect(page.getByText(/USER_ALREADY_EXISTS/)).toHaveCount(0)
})

test('a rate-limited (429) registration shows the too-many-attempts message, not the generic one (D3)', async ({
  page,
}) => {
  // Routed rather than actually tripping the real limiter, so this stays
  // deterministic regardless of how many other sign-ups ran earlier in the
  // suite — mirroring the login form's identical 429 case above. The address
  // is unique and never actually created (the route answers before Better
  // Auth ever sees it), so there is nothing to clean up.
  await page.route('**/api/auth/sign-up/email', async (route) => {
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Too many requests' }),
    })
  })

  await page.goto('/register')
  await page.getByLabel(/^Tên$|^Name$/).fill('Rate Limited User')
  await page.getByLabel(/^Email$/).fill(`e2e-phase7-auth-register-429-${Date.now()}@example.com`)
  await page.getByLabel(/Mật khẩu|^Password$/).fill('correct-horse-battery-staple')
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click()

  await expect(
    page.getByText('Bạn đã thử quá nhiều lần. Vui lòng đợi một phút rồi thử lại.'),
  ).toBeVisible()
  await expect(page.getByText('Đã có tài khoản dùng email đó.')).toHaveCount(0)
  await expect(page.getByText('Đã xảy ra lỗi. Vui lòng thử lại.')).toHaveCount(0)

  await page.unroute('**/api/auth/sign-up/email')
})

test('a wrong password on login shows the translated friendly error', async ({ page }) => {
  const { email } = await registerNewUser(page, { emailPrefix: 'e2e-phase7-auth-wrongpw' })

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Mật khẩu').fill('definitely-the-wrong-password')
  await page.getByRole('button', { name: 'Đăng nhập' }).click()

  await expect(page.getByText('Email hoặc mật khẩu không đúng')).toBeVisible()
})

test('a rate-limited (429) sign-in shows the too-many-attempts message, not the uniform invalid-credentials one', async ({
  page,
}) => {
  const { email, password } = await registerNewUser(page, {
    emailPrefix: 'e2e-phase7-auth-429',
  })
  await page.context().clearCookies()

  // A real 429 from Better Auth's own rate limiter (`lib/auth/create-auth.ts`)
  // is a genuinely different situation from a wrong password — the visitor
  // needs to know to wait, not that their credentials were rejected. Routed
  // rather than actually tripping the real limiter, so this stays
  // deterministic regardless of how many other sign-ins ran earlier in the
  // suite.
  await page.route('**/api/auth/sign-in/email', async (route) => {
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Too many requests' }),
    })
  })

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Mật khẩu').fill(password)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()

  await expect(
    page.getByText('Bạn đã thử quá nhiều lần. Vui lòng đợi một phút rồi thử lại.'),
  ).toBeVisible()
  await expect(page.getByText('Email hoặc mật khẩu không đúng')).toHaveCount(0)

  await page.unroute('**/api/auth/sign-in/email')
})

test('forgot-password submits and shows the neutral confirmation regardless of whether the address is registered', async ({
  page,
}) => {
  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill('nobody-here@example.com')
  await page.getByRole('button', { name: 'Gửi liên kết đặt lại' }).click()

  await expect(
    page.getByText(/Nếu có tài khoản dùng email đó, một liên kết đặt lại đã được gửi/),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Về trang đăng nhập' })).toBeVisible()
})

test('reset-password with an invalid token shows its own heading, explanation and a link back to forgot-password', async ({
  page,
}) => {
  await page.goto('/reset-password?error=INVALID_TOKEN')

  await expect(
    page.getByRole('heading', { name: 'Liên kết đặt lại không hợp lệ hoặc đã hết hạn' }),
  ).toBeVisible()
  await expect(page.getByText(/hết hạn sau một giờ và chỉ dùng được một lần/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Yêu cầu liên kết mới' })).toHaveAttribute(
    'href',
    '/forgot-password',
  )
})

test('the login submit is disabled with aria-busy while the sign-in request is in flight', async ({
  page,
}) => {
  const { email, password } = await registerNewUser(page, {
    emailPrefix: 'e2e-phase7-auth-busy',
  })
  // A fresh, signed-out context: `registerNewUser` leaves `page` authenticated,
  // and this test needs to observe the LOGIN form's own in-flight lock.
  await page.context().clearCookies()

  // Route-delay the real sign-in POST so the busy window is observable
  // deterministically — the delay lives in the route handler, not in a
  // `waitForTimeout` (same technique `phase7-theme-locale.spec.ts` uses for
  // the settings save button).
  await page.route('**/api/auth/sign-in/email', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.fallback()
  })

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Mật khẩu').fill(password)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()

  const fieldset = page.locator('form fieldset').first()
  await expect(fieldset).toHaveAttribute('aria-busy', 'true')
  const submit = page.locator('form button[type="submit"]')
  await expect(submit).toHaveText('Đang đăng nhập…')
  // Not `expect(submit).toBeDisabled()`: Playwright's `toBeDisabled` reads the
  // button's OWN `disabled` IDL property, which stays `false` when a control is
  // only disabled via an ancestor `<fieldset disabled>` — verified against the
  // real browser instead (`transaction-form-hydration.spec.ts` documents the
  // same gap).
  expect(await submit.evaluate((el) => (el as HTMLButtonElement).matches(':disabled'))).toBe(true)

  await page.unroute('**/api/auth/sign-in/email')
  await expect(page).toHaveURL(/\/dashboard/)
})

test('no horizontal overflow at 375, and the card is full width with padding', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  for (const url of [
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password?error=INVALID_TOKEN',
  ]) {
    await page.goto(url)
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    expect(scrollWidth, `overflow at ${url}`).toBeLessThanOrEqual(innerWidth)

    // Not just "no overflow" — the card itself (`app/(auth)/layout.tsx`'s
    // `w-full max-w-[25rem]` div) must actually BE full width inside the
    // page wrapper's `p-4` (16px each side), not a narrower "mobile card"
    // floating in unexplained side margins.
    const card = page.locator('div.rounded-lg.border-border.bg-surface').first()
    const box = await card.boundingBox()
    expect(box, `card bounding box at ${url}`).not.toBeNull()
    expect(Math.abs(box!.width - (innerWidth - 32)), `card width at ${url}`).toBeLessThanOrEqual(1)
  }
})

test('the dark theme cookie renders html.dark on /login with no session to ask', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([{ name: 'cashflow-theme', value: 'dark', url: 'http://localhost:3000' }])
  const html = await (await page.request.get('/login')).text()
  expect(html).toMatch(/<html[^>]*class="[^"]*\bdark\b/)
})
