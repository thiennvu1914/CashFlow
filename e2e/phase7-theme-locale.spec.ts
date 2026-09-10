import { test, expect } from '@playwright/test'
import { authenticatedSession, eitherLocale, PAGES } from './helpers'

/**
 * Theme and locale, end to end (spec §12).
 *
 * The first-paint assertions read the RAW response body rather than the live
 * DOM, which is what makes them deterministic and what makes them prove the
 * claim: the `dark` class is server-rendered, so there is no flash by
 * construction and no client script to catch mid-flip. No `waitForTimeout`, no
 * retry helper.
 *
 * Test ORDER matters here in a way most specs in this repo don't have to think
 * about: exactly one test below signs out, and Better Auth's `signOut()`
 * revokes that session server-side — so the auth cookie captured once in
 * `beforeAll` and reused by every OTHER test via `test.use({ storageState })`
 * would be dead for any test that ran after it. That test (the theme one) is
 * therefore placed LAST, and it re-authenticates through the UI before
 * touching anything else, in its own context, precisely so nothing downstream
 * depends on a session it just killed.
 */
const SESSION = authenticatedSession('phase7-theme')

/**
 * The registered account, kept for every test that needs to sign back in
 * through the UI — the same module-level pattern `phase4.spec.ts` uses for its
 * user. `registerNewUser` always fills this fixed name, regardless of the
 * email prefix.
 */
let account: { email: string; password: string }
const REGISTERED_NAME = 'Phase 4 E2E User'

/** The Tùy chọn group, which is where all four preference controls live. */
function preferences(page: import('@playwright/test').Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /Tùy chọn|Preferences/ }) })
}

/**
 * Task 12 landed labelled, translated auth forms: `Email` is the same in both
 * locales, `Mật khẩu`/`Password` and `Đăng nhập`/`Sign in` are not — so every
 * selector here is locale-tolerant (`eitherLocale`/an anchored alternation)
 * rather than pinned to one language, the same pattern `e2e/phase7-auth.spec.ts`
 * and `e2e/helpers.ts`'s `registerNewUser` use post-Task-12.
 */
async function loginViaUi(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel(eitherLocale('Email', 'Email')).fill(account.email)
  await page.getByLabel(eitherLocale('Mật khẩu', 'Password')).fill(account.password)
  await page.getByRole('button', { name: /^(Đăng nhập|Sign in)$/ }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

test.describe.serial('Phase 7 — theme and locale', () => {
  test.use({ storageState: SESSION.path })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)

    account = await SESSION.bootstrap(browser)
  })

  test('a new account starts in Vietnamese and light', async ({ page }) => {
    const html = await (await page.request.get('/dashboard')).text()
    expect(html).toContain('lang="vi"')
    expect(html).not.toMatch(/<html[^>]*class="[^"]*\bdark\b/)
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { level: 1, name: 'Tổng quan' })).toBeVisible()
  })

  test('every preference control has a visible label', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByLabel(/^Tên$|^Name$/)).toBeVisible()
    await expect(page.getByLabel(/Tiền tệ hiển thị|Display currency/)).toBeVisible()
    await expect(page.getByLabel(/Ngôn ngữ|Language/)).toBeVisible()
    await expect(page.getByLabel(/Giao diện|^Theme$/)).toBeVisible()
    await expect(page.getByLabel(/Múi giờ|Time zone/)).toBeVisible()
  })

  test('the fieldset is busy while saving, and an edit made right after the success alert is not overwritten', async ({
    page,
  }) => {
    await page.goto('/settings')
    const name = page.getByLabel(/^Tên$|^Name$/)
    const save = page.getByRole('button', { name: /^Lưu$|^Save$/ })
    const fieldset = page.locator('form fieldset').first()

    await name.fill('Busy Probe')

    // Hold the server action so the busy window is observable — the delay
    // lives in the ROUTE handler, a server-side pause, not in a
    // `waitForTimeout` (same technique as
    // `transaction-form-hydration.spec.ts`'s "second submit impossible" test).
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await route.fallback()
    })

    await save.click()
    await expect(fieldset).toHaveAttribute('aria-busy', 'true')
    await page.unroute('**/settings')

    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    // Typed the moment the success alert appears — `router.refresh()`'s own
    // background fetch is still settling at this point. An uncontrolled
    // control's `defaultValue` prop changing when that refresh lands must
    // never touch the live DOM value (React does not re-apply `defaultValue`
    // after mount), so this edit must survive it.
    await name.fill('Post-Save Edit')
    await page.waitForLoadState('networkidle')
    await expect(name).toHaveValue('Post-Save Edit')

    // Leave the profile as the account started.
    await name.fill(REGISTERED_NAME)
    await save.click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()
  })

  test('switching to English changes lang and every nav label', async ({ page }) => {
    // Signed back in through the UI, not through storageState, so
    // `syncPreferenceCookies` runs and the cookies match the account.
    await loginViaUi(page)

    await page.goto('/settings')
    await preferences(page)
      .getByLabel(/Ngôn ngữ|Language/)
      .selectOption('en')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    await page.goto('/dashboard')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const rail = page.getByRole('navigation', { name: /^Primary$/ })
    await expect(rail.getByRole('link', { name: 'Transactions' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()

    // And back, so the suite leaves the account as it found it.
    await page.goto('/settings')
    await preferences(page)
      .getByLabel(/Language/)
      .selectOption('vi')
    await page.getByRole('button', { name: /^Save$/ }).click()
    await expect(page.getByText(/Profile saved/)).toBeVisible()
  })

  test('every page renders in the reader’s locale, with locale-formatted numbers (Task 13, Step 5)', async ({
    page,
  }) => {
    // Twelve full navigations plus two settings round-trips comfortably clear
    // the default 30 s — the same reasoning `registerNewUser`'s own widened
    // bound gives for a cold Turbopack compile.
    test.setTimeout(90_000)

    // Signed back in through the UI for the same reason the test above does —
    // `syncPreferenceCookies` keeps the cookie mirror in step with the account.
    await loginViaUi(page)

    await page.goto('/settings')
    await preferences(page)
      .getByLabel(/Ngôn ngữ|Language/)
      .selectOption('en')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    // This account (registerNewUser's fixed name, and lib/server/defaults.ts's
    // starter account types/categories) is deliberately ASCII-only, and never
    // creates an account, a transaction or anything else with a Vietnamese
    // name — so a diacritic found in `main` cannot be the user's own data
    // leaking through; it can only be an untranslated vi string under an en
    // page, which is exactly what this check is for.
    for (const url of PAGES) {
      await page.goto(url)
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      const text = (await page.locator('main').innerText())
        // The Language <select>'s Vietnamese option is a language's own
        // ENDONYM ("Tiếng Việt"), correctly shown in its own script regardless
        // of which locale is rendering — the same convention every language
        // switcher uses ("Français" stays "Français" in an English UI). Not a
        // translation this app owns, so it is the one string this check
        // excludes rather than a real leak.
        .replace('Tiếng Việt', '')
      // NOTE: the diacritic class below is a NET, not a proof. It lists the
      // precomposed (NFC) Vietnamese codepoints this suite happens to need —
      // so two kinds of Vietnamese text slip through it: a precomposed
      // codepoint that simply is not in the list (there is no "ữ", "ử" or "ẻ"
      // here), and the DECOMPOSED form of any of them, where a base vowel is
      // followed by a separate combining mark (U+0300–U+0323) that no member
      // of this class matches. It catches every string this app actually
      // emits — every literal in `messages/` is NFC and uses one of the
      // letters listed — but it is not a guarantee against every conceivable
      // Vietnamese string.
      expect(text, url).not.toMatch(/[ăâđêôơưĂÂĐÊÔƠƯ]|ạ|ả|ấ|ầ|ệ|ế|ị|ọ|ố|ồ|ộ|ớ|ợ|ủ|ứ|ự|ỳ|ỹ/)
      // Wherever a four-plus-digit figure appears, it must be comma-grouped
      // (en), never period-grouped (vi) — this account's own figures never
      // grow that large, so the assertion is a no-op where there is nothing
      // to group; it still catches the moment any page starts rendering one.
      //
      // Anchored with a negative lookahead for a percent sign (plain space OR
      // U+00A0 non-breaking space before it, `\s` matches both): the Loans
      // page's `interestRateLabel` can render up to three fraction digits
      // (`formatPercent`, Task 13 D2), and "12.345 %" in English is a decimal
      // point followed by exactly three digits — the same SHAPE a vi
      // thousands separator has, but not a leaked vi grouping at all.
      const viGrouped = text.match(/\d{1,3}(?:\.\d{3})+(?!\s?%)/)
      expect(viGrouped, `${url}: found a vi-grouped figure under an en page`).toBeNull()
    }

    // And back, so the suite leaves the account as it found it.
    await page.goto('/settings')
    await preferences(page)
      .getByLabel(/Language/)
      .selectOption('vi')
    await page.getByRole('button', { name: /^Save$/ }).click()
    await expect(page.getByText(/Profile saved/)).toBeVisible()
  })

  test('the change-password form is separate from the profile form and shows a friendly error on a wrong current password', async ({
    page,
  }) => {
    await page.goto('/settings')
    // Two <form>s, not one — the profile form's single Save never touches
    // the password fields, and vice versa.
    await expect(page.locator('form')).toHaveCount(2)

    await page
      .getByLabel(/Mật khẩu hiện tại|Current password/)
      .fill('definitely-the-wrong-password')
    await page.getByLabel(/Mật khẩu mới|New password/).fill('a-perfectly-valid-new-password-1')
    await page.getByRole('button', { name: /Đổi mật khẩu|Change password/ }).click()

    // Better Auth's own message is never echoed back — a fixed, friendly
    // string regardless of which half of the check failed.
    await expect(
      page.getByText(
        /Mật khẩu hiện tại không đúng hoặc mật khẩu mới không hợp lệ|Current password is incorrect or the new password is invalid/,
      ),
    ).toBeVisible()
  })

  test('saving dark applies immediately without a reload, survives sign-out, and reverses back to light', async ({
    page,
  }) => {
    await page.goto('/settings')

    // A page-local marker: a full navigation/reload tears down the JS realm
    // and wipes this, so its survival is proof the "optimistic" class toggle
    // happened in the document already on screen rather than via a hidden
    // reload.
    await page.evaluate(() => {
      ;(window as unknown as { __phase7Marker?: string }).__phase7Marker = 'still-here'
    })

    await preferences(page)
      .getByLabel(/Giao diện|^Theme$/)
      .selectOption('dark')
    // ONE Save for all five fields (amended spec §6.9), so it is not scoped
    // to a card.
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()

    // Optimistic, in the page the user is already looking at (spec §3) — and
    // no reload happened, proven by the marker surviving.
    await expect(page.locator('html')).toHaveClass(/dark/)
    expect(
      await page.evaluate(() => (window as unknown as { __phase7Marker?: string }).__phase7Marker),
    ).toBe('still-here')

    // And server-rendered on the next request — the flash-free guarantee.
    const darkHtml = await (await page.request.get('/dashboard')).text()
    expect(darkHtml).toMatch(/<html[^>]*class="[^"]*\bdark\b/)
    expect(darkHtml).toContain('color-scheme:dark')

    // Survives sign-out: with no session left to ask, `resolveTheme()` falls
    // back to the cookie mirror `updateProfile` wrote.
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /Đăng xuất|Log out/ }).click()
    await expect(page).toHaveURL(/\/login/)
    const loggedOutHtml = await (await page.request.get('/login')).text()
    expect(loggedOutHtml).toMatch(/<html[^>]*class="[^"]*\bdark\b/)

    // Sign back in (this test's OWN context — the shared `storageState`
    // snapshot's session token was just revoked by the sign-out above, which
    // is why this spec runs this test last) and reverse the toggle, so the
    // account is left exactly as the suite found it.
    await loginViaUi(page)

    await page.goto('/settings')
    await preferences(page)
      .getByLabel(/Giao diện|^Theme$/)
      .selectOption('light')
    await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
    await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    const lightHtml = await (await page.request.get('/dashboard')).text()
    expect(lightHtml).not.toMatch(/<html[^>]*class="[^"]*\bdark\b/)
  })
})
