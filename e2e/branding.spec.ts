import { test, expect } from '@playwright/test'
import { authenticatedSession } from './helpers'

const SESSION = authenticatedSession('branding')

test.describe('CashFlow branding', () => {
  test.describe('auth and metadata', () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test('the shared auth layout uses the responsive logo and the app icon resolves', async ({
      page,
    }) => {
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 })

        for (const url of [
          '/login',
          '/register',
          '/forgot-password',
          '/reset-password?error=INVALID_TOKEN',
        ]) {
          await page.goto(url)

          const logo = page.getByRole('img', { name: 'CashFlow' })
          await expect(logo).toBeVisible()
          await expect(logo).toHaveAttribute('src', /cashflow-logo\.png/)
          expect(
            await logo.evaluate((image) => (image as HTMLImageElement).naturalWidth),
          ).toBeGreaterThan(0)

          const logoBox = await logo.boundingBox()
          const cardBox = await page.getByRole('main').boundingBox()
          expect(logoBox).not.toBeNull()
          expect(cardBox).not.toBeNull()
          expect(logoBox!.width).toBe(width === 375 ? 176 : 188)
          expect(
            Math.abs(logoBox!.x + logoBox!.width / 2 - (cardBox!.x + cardBox!.width / 2)),
          ).toBeLessThanOrEqual(1)

          const hasOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          )
          expect(hasOverflow, `${url} overflows at ${width}px`).toBe(false)
        }
      }

      await page.goto('/login')
      const icon = page.locator('link[rel="icon"][type="image/png"][sizes="1254x1254"]')
      await expect(icon).toHaveCount(1)
      const iconHref = await icon.getAttribute('href')
      expect(iconHref).not.toBeNull()
      expect(new URL(iconHref!, page.url()).pathname).toBe('/icon.png')
      const iconResponse = await page.request.get(iconHref!)
      expect(iconResponse.ok()).toBe(true)
      expect(iconResponse.headers()['content-type']).toContain('image/png')
    })

    test('the auth logo loads in dark mode', async ({ context, page }) => {
      await context.addCookies([
        { name: 'cashflow-theme', value: 'dark', url: 'http://localhost:3000' },
      ])
      await page.goto('/login')

      await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      await expect(page.getByRole('img', { name: 'CashFlow' })).toBeVisible()
    })
  })

  test.describe('responsive app shell', () => {
    test.use({ storageState: SESSION.path })

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(120_000)
      await SESSION.bootstrap(browser)
    })

    test('the mark fits the unchanged desktop, tablet, and mobile navigation', async ({ page }) => {
      for (const { width, height, railWidth } of [
        { width: 1440, height: 900, railWidth: 240 },
        { width: 1024, height: 900, railWidth: 64 },
        { width: 375, height: 812, railWidth: 0 },
      ]) {
        await page.setViewportSize({ width, height })
        await page.goto('/dashboard')

        const brandLink = page.getByRole('link', { name: 'CashFlow', exact: true })
        await expect(brandLink).toBeVisible()
        const mark = brandLink.locator('img[alt=""]')
        await expect(mark).toBeVisible()
        await expect(mark).toHaveAttribute('src', /cashflow-mark\.png/)
        expect((await mark.boundingBox())?.width).toBe(48)
        expect((await mark.locator('..').boundingBox())?.width).toBe(28)

        if (railWidth > 0) {
          expect((await page.locator('aside').first().boundingBox())?.width).toBe(railWidth)
        } else {
          await expect(page.getByRole('button', { name: /^(Menu|More)$/ })).toBeVisible()
        }

        const hasOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        )
        expect(hasOverflow, `app shell overflows at ${width}px`).toBe(false)
      }
    })
  })
})
