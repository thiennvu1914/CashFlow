import { test, expect } from '@playwright/test'
import { authenticatedSession } from './helpers'

/**
 * The app shell (spec §5): the rail's three widths, and the mobile More sheet's
 * accessibility contract.
 *
 * Breakpoint ruling (product owner, overrides the task brief's "≥ 1024 /
 * 768–1023" wording): desktop is ≥ 1280 (Tailwind `xl`), tablet is 768–1279
 * (`md`..<`xl`) — 1024–1279 is deliberately the TABLET composition, a 64 px
 * icon rail, not a squeezed desktop. So this file asserts 240 px at 1280,
 * 64 px at BOTH 1024 and 768, and no rail at all at 375.
 *
 * The sheet's four dismissals — its own button, Escape, an overlay tap and a
 * navigation — plus the focus trap and the focus return are what the `Sheet`
 * primitive was adopted for; the disclosure it replaces had none of the last
 * three. Asserting them here means a regression in `components/common/sheet.tsx`
 * fails the task that owns it rather than a sweep four tasks later.
 *
 * No `waitForTimeout` and no retry helper: every assertion is an
 * auto-retrying matcher or a focus check on an element the previous action
 * already awaited.
 */
const SESSION = authenticatedSession('phase7-shell')

test.describe.serial('Phase 7 — app shell', () => {
  test.use({ storageState: SESSION.path })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    await SESSION.bootstrap(browser)
  })

  test('the rail is 240 px at 1280, 64 px at 1024 and 768, and absent at 375', async ({ page }) => {
    const rail = page.getByRole('navigation', { name: /^(Điều hướng chính|Primary)$/ })

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/dashboard')
    await expect(rail).toBeVisible()
    // The <nav> sits inside the <aside> that carries the width, so measure the
    // aside — the rail's own box is its content box.
    expect((await page.locator('aside').first().boundingBox())!.width).toBe(240)

    // 1024 is the middle of the tablet band under the ruling above (Tailwind
    // `lg`, which this shell does not use as a switch point at all) — still
    // the 64 px icon rail, not the 240 px desktop rail.
    await page.setViewportSize({ width: 1024, height: 900 })
    await page.goto('/dashboard')
    await expect(rail).toBeVisible()
    expect((await page.locator('aside').first().boundingBox())!.width).toBe(64)
    await expect(
      page.getByRole('navigation', { name: /^(Điều hướng nhanh|Primary \(compact\))$/ }),
    ).toBeHidden()

    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/dashboard')
    await expect(rail).toBeVisible()
    expect((await page.locator('aside').first().boundingBox())!.width).toBe(64)
    await expect(
      page.getByRole('navigation', { name: /^(Điều hướng nhanh|Primary \(compact\))$/ }),
    ).toBeHidden()

    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    await expect(rail).toBeHidden()
    await expect(
      page.getByRole('navigation', { name: /^(Điều hướng nhanh|Primary \(compact\))$/ }),
    ).toBeVisible()
  })

  test('the skip link is the first focusable element and reaches the content', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/dashboard')
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: /^(Đến nội dung|Skip to content)$/ })
    await expect(skip).toBeFocused()
    await skip.press('Enter')
    await expect(page.locator('#main')).toBeFocused()
  })

  test('the More sheet traps focus and Escape returns it to the trigger', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    const trigger = page.getByRole('button', { name: /^(Menu|More)$/ })
    await trigger.click()

    const sheet = page.getByRole('dialog', { name: /^(Tất cả mục|All sections)$/ })
    await expect(sheet).toBeVisible()
    // Adaptation: the installed Base UI (`node_modules/@base-ui/react/dialog/popup/DialogPopup.js`)
    // does not stamp `aria-modal` on the popup — only its Toast root does.
    // Modality here is real (a `FloatingFocusManager` with `modal: true`
    // behind the scenes) but is not surfaced as that attribute, so it is
    // proven the only way that is actually observable: the focus trap below.

    // Focus lands inside on open, and twenty tabs never leave. Base UI's trap
    // is built on `FloatingFocusManager`'s focus-guard sentinels (tabbable
    // elements just outside the popup that redirect focus back in on
    // `focusin`) — so a Tab can land on a guard for one tick before the
    // redirect runs. `waitForFunction` (auto-retrying, not a fixed sleep)
    // waits out exactly that correction instead of asserting on the
    // transient frame a synchronous read would catch.
    for (let index = 0; index < 20; index += 1) {
      await page.waitForFunction(
        () => {
          const active = document.activeElement
          const dialog = document.querySelector('[role="dialog"]')
          return active !== null && dialog !== null && dialog.contains(active)
        },
        undefined,
        { timeout: 2000 },
      )
      await page.keyboard.press('Tab')
    }

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('the More sheet closes on its own button and on an overlay tap', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    const trigger = page.getByRole('button', { name: /^(Menu|More)$/ })

    await trigger.click()
    const sheet = page.getByRole('dialog', { name: /^(Tất cả mục|All sections)$/ })
    await sheet.getByRole('button', { name: /^(Đóng|Close)$/ }).click()
    await expect(sheet).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.click()
    await expect(sheet).toBeVisible()
    // The sheet is bottom-anchored below 640, so the top-left corner of the
    // viewport is the backdrop.
    await page.mouse.click(5, 5)
    await expect(sheet).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('the More sheet closes on navigation and lists the eight non-tab routes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /^(Menu|More)$/ }).click()
    const sheet = page.getByRole('dialog', { name: /^(Tất cả mục|All sections)$/ })

    for (const label of [
      /^(Chuyển tiền|Transfers)$/,
      /^(Danh mục|Categories)$/,
      /^(Ngân sách|Budgets)$/,
      /^(Tiết kiệm|Savings)$/,
      /^(Công nợ|Debts)$/,
      /^(Khoản vay|Loans)$/,
      /^(Nhắc nhở|Reminders)$/,
      /^(Cài đặt|Settings)$/,
    ]) {
      await expect(sheet.getByRole('link', { name: label })).toBeVisible()
    }

    await sheet.getByRole('link', { name: /^(Chuyển tiền|Transfers)$/ }).click()
    await expect(page).toHaveURL(/\/transfers/)
    await expect(sheet).toBeHidden()
  })

  test('every response carries the production security headers and no x-powered-by', async ({
    page,
  }) => {
    // Playwright spawns `next dev` (`playwright.config.ts`'s `webServer`),
    // which serves `next.config.ts`'s `headers()` too — so this asserts the
    // real config, not a mock. HSTS is production-only (`lib/server/security-
    // headers.ts`) and TLS never terminates at `next dev`, so it is
    // deliberately not asserted here.
    const response = await page.goto('/dashboard')
    const headers = response!.headers()

    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(headers['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    )
    expect(headers['x-powered-by']).toBeUndefined()
  })
})

test.describe('Phase 7 — app shell / /api/health', () => {
  // Deliberately no session cookie (fix round, promoted minor): the outer
  // describe's `storageState` is a signed-in session, and running the health
  // check under it would prove nothing about whether the endpoint itself
  // requires auth. An explicit empty `storageState` here is what actually
  // demonstrates `/api/health` answers an unauthenticated request.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('GET /api/health answers ok, uncached, and carries the same headers', async ({ page }) => {
    // The platform probe (`app/api/health/route.ts`): unauthenticated, one key,
    // never cached — and covered by `next.config.ts`'s `/(.*)` header rule like
    // every other response, which is the thing a header matcher regression
    // would break silently.
    const response = await page.request.get('/api/health')

    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })

    const headers = response.headers()
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(headers['x-powered-by']).toBeUndefined()
  })
})
