import os from 'os'
import path from 'path'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'
import { PAGES, registerNewUser, createAccountViaUi } from './helpers'

/**
 * The accessibility guarantees spec §8 makes, as tests (Task 16).
 *
 * Two layers, deliberately, because neither one alone is enough:
 *
 *  1. `@axe-core/playwright`, on every page in BOTH themes plus the four auth
 *     screens, an open sheet, an open menu and the phone's More sheet. A real
 *     rule engine catches what nobody thinks to assert — it is what found the
 *     one alpha-diluted text colour in the product (`text-muted-foreground/80`
 *     at 3.74:1) that twelve pages of hand-written assertions had walked past.
 *     Scoped to the WCAG tags only (`wcag2a`, `wcag2aa`, `wcag21a`,
 *     `wcag21aa`, `wcag22aa`), NOT `best-practice`: this is a conformance
 *     gate, and axe's `region` best-practice rule fires on any portalled
 *     popup (a menu popup is a `document.body` child, so it is outside every
 *     landmark by construction) — excluding a whole category by its own tag
 *     is honest, whereas disabling `region` by name would be the spec
 *     apologising for a defect it has not got.
 *
 *  2. structural assertions read off the live accessibility tree, for the four
 *     things axe cannot see: that a focus ring is actually PAINTED (axe reads
 *     no computed outline), that a dialog really traps and restores focus,
 *     that the transaction type radiogroup still implements the WAI-ARIA
 *     pattern, and that `prefers-reduced-motion` reaches the primitives.
 *     Each failure names the exact element.
 *
 * `describe.serial` and one registered user, like every other Phase 7 spec:
 * the fixtures are a signed-in session and one financial account. The DARK
 * tests come LAST on purpose — `resolveTheme()` reads the signed-in session's
 * stored theme before the cookie (see `e2e/phase7-dashboard.spec.ts`'s note),
 * so switching theme means saving the Settings form, and every light test has
 * to have run before that happens.
 *
 * No retries, no skips, no `waitForTimeout`. Where a value settles
 * asynchronously — the focus ring animates, because these base classes carry
 * `transition-all` — the wait is `expect.poll`, a retrying assertion with a
 * real condition, not a slept-through interval.
 */
const STORAGE_STATE_PATH = path.join(os.tmpdir(), `cashflow-phase7-a11y-${process.pid}.json`)

/** WCAG conformance only. See the file doc for why `best-practice` is out. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/**
 * Every WCAG violation axe finds, as one readable line each — so a failure
 * says which rule, how bad, how many nodes and exactly which selectors,
 * instead of dumping axe's whole result object.
 */
async function axeViolations(page: Page): Promise<string[]> {
  // Scan the page a user actually operates, not one mid-hydration. Every form
  // in this app ships inside a `<fieldset disabled>` until `useHydrated()`
  // flips (`lib/ui/use-hydrated.ts`), and `disabled:opacity-50` therefore
  // halves the submit button's contrast for as long as the gate is up: axe
  // read `/transactions`' "Thêm giao dịch" at under 4.5:1 for exactly that
  // window. That is the gate working, not a defect — WCAG 1.4.3 explicitly
  // exempts an inactive component, and axe only flags it because the
  // `disabled` state is inherited from the fieldset rather than set on the
  // button — so the fix is to scan after the gate lifts, never to touch the
  // gate. `toHaveCount(0)` is a retrying assertion with a real condition and
  // passes immediately on a page that has no gated form at all.
  await expect(page.locator('fieldset[disabled]')).toHaveCount(0)
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  return results.violations.map(
    (violation) =>
      `${violation.id} [${violation.impact}] × ${violation.nodes.length} — ${violation.help}` +
      ` :: ${violation.nodes
        .slice(0, 5)
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  )
}

/** Every operable form control with no programmatic label. */
function unlabelledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>('input, select, textarea')]
      .filter((control) => {
        // A hidden input, an `aria-hidden` one, and anything taken out of the
        // tab order are not controls a person operates. Base UI's Select
        // renders a 1×1 clipped `aria-hidden` `tabindex="-1"` input per
        // combobox purely so the value posts with a native form; labelling it
        // would be labelling a plumbing detail, and it is correctly invisible
        // to assistive technology already.
        if (control.getAttribute('type') === 'hidden') return false
        if (control.getAttribute('aria-hidden') === 'true') return false
        if (control.tabIndex === -1) return false
        const rect = control.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .filter((control) => {
        const id = control.getAttribute('id')
        const labelled = id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`)
        return (
          !labelled &&
          control.closest('label') === null &&
          !control.getAttribute('aria-label') &&
          !control.getAttribute('aria-labelledby')
        )
      })
      .map(
        (control) =>
          `${control.tagName.toLowerCase()}#${control.id || '(no id)'}[name=${control.getAttribute('name') ?? '?'}]`,
      )
  })
}

/** Every button/link/menuitem/radio/summary with no accessible name at all. */
function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="radio"], [role="combobox"]',
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .filter((element) => {
        if ((element.textContent ?? '').trim().length > 0) return false
        const labelledBy = element.getAttribute('aria-labelledby')
        const named =
          (element.getAttribute('aria-label') ?? '').trim().length > 0 ||
          (element.getAttribute('title') ?? '').trim().length > 0 ||
          (labelledBy !== null &&
            labelledBy
              .split(/\s+/)
              .some((id) => (document.getElementById(id)?.textContent ?? '').trim().length > 0))
        return !named
      })
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}.${(element.getAttribute('class') ?? '').slice(0, 60)}`,
      ),
  )
}

/** The landmark/heading shape of the page, as one object. */
function structure(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const main = document.querySelector('main')
    return {
      mainCount: document.querySelectorAll('main, [role="main"]').length,
      h1Count: [...document.querySelectorAll('h1')].filter(visible).length,
      navLabels: [...document.querySelectorAll('nav')]
        .filter(visible)
        .map((nav) => nav.getAttribute('aria-label')),
      headingLevels: main
        ? [...main.querySelectorAll('h1, h2, h3, h4, h5, h6')]
            .filter(visible)
            .map((heading) => Number(heading.tagName.slice(1)))
        : [],
      positiveTabIndex: [...document.querySelectorAll('[tabindex]')]
        .filter((element) => Number(element.getAttribute('tabindex')) > 0)
        .map((element) => element.tagName.toLowerCase()),
      progressbars: [...document.querySelectorAll('[role="progressbar"]')].map((bar) => ({
        label: bar.getAttribute('aria-label'),
        valueText: bar.getAttribute('aria-valuetext'),
      })),
    }
  })
}

/**
 * Which item of the open menu currently holds the highlight, or -1. Base UI
 * moves real DOM focus onto the highlighted `menuitem`, so `activeElement` is
 * the honest reading; `data-highlighted` is checked too, because that is the
 * attribute the item's own styling hangs off.
 */
function highlightedIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
    const focused = items.indexOf(document.activeElement as Element)
    if (focused !== -1) return focused
    return items.findIndex((item) => item.hasAttribute('data-highlighted'))
  })
}

/** `--focus` as the browser paints it, for an exact ring-colour comparison. */
function focusColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    probe.style.color = 'var(--focus)'
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
}

/**
 * Asserts spec §2's focus ring is really painted on the currently focused
 * element: `solid`, 2 px, offset ±2 px, in `--focus`.
 *
 * `expect.poll`, because `outline-width`, `-offset` and `-color` are all
 * animatable and these base classes carry `transition-all` (150 ms) — read at
 * t = 0 the ring is `medium` (3 px) at offset 0 in `currentColor`, which is
 * indistinguishable from having no ring at all. That is exactly the trap Task
 * 14's F13 investigation and this task's first measurement both fell into.
 *
 * The offset is `±2px` because a menu item draws the ring INSIDE its box
 * (`-outline-offset-2`): the popup's own padding is 4 px, and an outward ring
 * would sit on its edge.
 */
async function expectFocusRing(page: Page, what: string): Promise<void> {
  const expected = await focusColor(page)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const style = getComputedStyle(document.activeElement!)
          return {
            focusVisible: document.activeElement!.matches(':focus-visible'),
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`,
            color: style.outlineColor,
          }
        }),
      { message: `focus ring on ${what}` },
    )
    .toEqual({
      focusVisible: true,
      outline: expect.stringMatching(/^solid 2px -?2px$/),
      color: expected,
    })
}

/** Saves one preference through the Settings form, the only path that sticks. */
async function savePreference(page: Page, name: 'theme' | 'locale', value: string): Promise<void> {
  await page.goto('/settings')
  await page.locator(`select[name="${name}"]`).selectOption(value)
  await page.getByRole('button', { name: /^Lưu$|^Save$/ }).click()
  await expect(page.getByText(/Đã lưu hồ sơ|Profile saved/)).toBeVisible()
}

test.describe.serial('Phase 7 — accessibility', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    await registerNewUser(page, { emailPrefix: 'e2e-phase7-a11y' })
    await createAccountViaUi(page, { name: 'Cash', currency: 'VND', initialBalance: 5_000_000 })
    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  for (const url of PAGES) {
    test(`${url}: axe finds no WCAG violation`, async ({ page }) => {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await axeViolations(page)).toEqual([])
    })

    test(`${url}: one main, one h1, named navigations and no skipped heading level`, async ({
      page,
    }) => {
      await page.goto(url)
      const shape = await structure(page)
      expect(shape.mainCount, 'exactly one main landmark').toBe(1)
      expect(shape.h1Count, 'exactly one h1').toBe(1)
      expect(shape.navLabels, 'every nav landmark is named').not.toContain(null)
      expect(
        new Set(shape.navLabels).size,
        `nav landmark names are distinct: ${JSON.stringify(shape.navLabels)}`,
      ).toBe(shape.navLabels.length)
      expect(shape.positiveTabIndex, 'no positive tabindex').toEqual([])

      let deepest = 0
      for (const level of shape.headingLevels) {
        expect(level, `heading order in main: h${deepest} then h${level}`).toBeLessThanOrEqual(
          deepest + 1,
        )
        deepest = Math.max(deepest, level)
      }

      // Whatever progress bars this page has must announce the TRUE figure and
      // carry a name — a bar's `aria-valuenow` is the CLAMPED width, so
      // `aria-valuetext` is the only place 115 % can be stated (Task 7).
      for (const bar of shape.progressbars) {
        expect(bar.label, 'progressbar has an accessible name').toBeTruthy()
        expect(bar.valueText, 'progressbar states its true value').toBeTruthy()
      }
    })

    test(`${url}: every control is labelled and every icon-only control is named`, async ({
      page,
    }) => {
      await page.goto(url)
      expect(await unlabelledControls(page)).toEqual([])
      expect(await unnamedControls(page)).toEqual([])
    })
  }

  test('the four auth screens each have a main landmark, one h1 and no WCAG violation', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()
    for (const url of [
      '/login',
      '/register',
      '/forgot-password',
      '/reset-password?token=not-a-real-token',
    ]) {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      const shape = await structure(page)
      expect(shape.mainCount, `main landmark on ${url}`).toBe(1)
      expect(shape.h1Count, `one h1 on ${url}`).toBe(1)
      expect(await unlabelledControls(page), `labels on ${url}`).toEqual([])
      expect(await axeViolations(page), `axe on ${url}`).toEqual([])
    }
    await context.close()
  })

  test('the skip link is the first focusable element and reaches the content', async ({ page }) => {
    await page.goto('/dashboard')
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: /Đến nội dung|Skip to content/ })
    await expect(skip).toBeFocused()
    await expectFocusRing(page, 'the skip link')
    await page.keyboard.press('Enter')
    await expect(page.locator('#main')).toBeVisible()
  })

  test('the focus ring is painted on every primitive that once had outline-none', async ({
    page,
  }) => {
    // Keyboard modality first: `:focus-visible` is correctly false in a
    // mouse-only session, so a ring assertion driven by clicks would be
    // asserting the wrong thing.
    await page.goto('/settings')
    await page.keyboard.press('Tab')

    // On `--surface`: a `buttonVariants` link, a ghost Button, an Input and a
    // native select — the four base classes that carried `outline-none`.
    await page
      .getByRole('link', { name: /Thêm giao dịch|Add transaction/ })
      .first()
      .focus()
    await expectFocusRing(page, 'the rail CTA (a buttonVariants link)')
    await page
      .getByRole('button', { name: /Đăng xuất|Log out/ })
      .first()
      .focus()
    await expectFocusRing(page, 'LogoutButton')
    await page.getByLabel(/^Tên$|^Name$/).focus()
    await expectFocusRing(page, 'an Input on --surface')
    await page.locator('select[name="theme"]').focus()
    await expectFocusRing(page, 'a native select on --surface')
    await page.getByRole('button', { name: /Đổi mật khẩu|Change password/ }).focus()
    await expectFocusRing(page, 'a Button on --surface')

    // Inside a Sheet, i.e. on `--surface-2`.
    await page.goto('/accounts')
    await page.keyboard.press('Tab')
    await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).focus()
    await page.keyboard.press('Enter')
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await sheet.getByLabel(/Tên tài khoản|Account name/).focus()
    await expectFocusRing(page, 'an Input inside a Sheet (--surface-2)')
    await sheet.getByLabel(/^Tiền tệ$|^Currency$/).focus()
    await expectFocusRing(page, 'a native select inside a Sheet (--surface-2)')
    await sheet.getByRole('button', { name: /Tạo tài khoản|Create account/ }).focus()
    await expectFocusRing(page, 'a Button inside a Sheet (--surface-2)')
    await sheet.getByRole('button', { name: /^Đóng$|^Close$/ }).focus()
    await expectFocusRing(page, "a Sheet's close button (--surface-2)")
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()

    // A keyboard-highlighted menu item, whose only other cue is a wash that
    // measures 1.05:1 against `--surface-2` in dark.
    const trigger = page.getByRole('button', { name: /Tác vụ cho Cash|Actions for Cash/ }).first()
    await trigger.focus()
    await expectFocusRing(page, 'a RowActionsMenu trigger')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expectFocusRing(page, 'a keyboard-highlighted menu item')
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  })

  test('a sheet is modal: aria-modal, a focus trap, Escape restores focus, an overlay click closes it', async ({
    page,
  }) => {
    await page.goto('/accounts')
    const opener = page.getByRole('button', { name: /Thêm tài khoản|Add account/ })
    await opener.click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    // Base UI supplies the trap but marks nothing outside the popup, so
    // `aria-modal` is what stops a virtual cursor walking the page behind it.
    await expect(sheet).toHaveAttribute('aria-modal', 'true')
    await expect(sheet).toHaveAttribute('aria-labelledby', /.+/)

    // Twenty tabs, and not one of them may hand focus to a control on the page
    // behind the sheet — which is the whole guarantee. Two landings other than
    // "inside" are legitimate, and are named rather than waved through: Base
    // UI's 1x1 focus-guard spans, which sit OUTSIDE the popup element on
    // purpose and are how the wrap-around is implemented, and the one frame
    // where `document.activeElement` is `body` while a guard blurs and Base UI
    // moves focus back in (observed in both forms across runs, which is why
    // both are allowed). Neither is an operable element, so neither is an
    // escape. The `inside` COUNT is asserted afterwards, so a "trap" that
    // simply parked focus on `body` for ever could not pass this.
    const landings: string[] = []
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press('Tab')
      const where = await page.evaluate(() => {
        const active = document.activeElement
        const dialog = document.querySelector('[role="dialog"]')
        if (active === null || dialog === null) return 'nothing-focused'
        if (dialog.contains(active)) return 'inside'
        if (active === document.body || active === document.documentElement) return 'handover'
        const rect = active.getBoundingClientRect()
        return active.tagName === 'SPAN' && rect.width <= 1 && rect.height <= 1
          ? 'focus-guard'
          : `escaped: ${active.tagName.toLowerCase()}.${active.className}`
      })
      landings.push(where)
      expect(where, `after ${index + 1} tabs`).toMatch(/^(inside|focus-guard|handover)$/)
    }
    expect(
      landings.filter((where) => where === 'inside').length,
      `most tabs land on a control inside the sheet: ${JSON.stringify(landings)}`,
    ).toBeGreaterThanOrEqual(12)

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(opener).toBeFocused()

    // And again, closed by the backdrop: the top-left corner of the viewport
    // is overlay at every width the sheet renders at.
    await opener.click()
    await expect(sheet).toBeVisible()
    await page.mouse.click(5, 5)
    await expect(sheet).toBeHidden()
  })

  test('a row actions menu is keyboard operable and hands focus back to its trigger', async ({
    page,
  }) => {
    await page.goto('/accounts')
    const trigger = page.getByRole('button', { name: /Tác vụ cho Cash|Actions for Cash/ }).first()
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    const count = await menu.getByRole('menuitem').count()
    expect(count, 'the menu has items to walk').toBeGreaterThanOrEqual(2)

    // Which item is highlighted the instant a menu opens is Base UI's
    // business, and it genuinely differs between the keyboard path (first item
    // highlighted immediately) and the pointer path (focus stays on the
    // trigger) — `page.keyboard.press('Enter')` on a `<button>` fires a
    // synthetic click after the keydown, so a run can legitimately end up on
    // either. Asserting an absolute index here is asserting that race. What
    // the spec actually requires is that the arrow keys MOVE the highlight and
    // that Escape hands focus back, so that is what is asserted: the first
    // ArrowDown puts the highlight somewhere, and each key after it moves the
    // highlight by exactly one, wrapping.
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(() => highlightedIndex(page), { message: 'an item is highlighted' })
      .not.toBe(-1)
    const start = await highlightedIndex(page)
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(() => highlightedIndex(page), { message: 'ArrowDown moves to the next item' })
      .toBe((start + 1) % count)
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => highlightedIndex(page), { message: 'ArrowUp moves back' }).toBe(start)

    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('a validation error is linked to its field, announced, and takes focus', async ({
    page,
  }) => {
    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    // Submit with an empty name — the schema refuses it.
    await sheet.getByRole('button', { name: /Tạo tài khoản|Create account/ }).click()

    const nameInput = sheet.getByLabel(/Tên tài khoản|Account name/)
    await expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    const describedBy = await nameInput.getAttribute('aria-describedby')
    expect(describedBy, 'the invalid field points at its message').toBeTruthy()
    const errorId = describedBy!.split(/\s+/).find((id) => id.endsWith('-error'))
    expect(errorId, `an -error id among "${describedBy}"`).toBeTruthy()
    const error = page.locator(`#${errorId}`)
    await expect(error).toBeVisible()
    // `role="alert"` is what announces a message that appears after a submit.
    await expect(error).toHaveAttribute('role', 'alert')
    // The message is translated, never a raw Zod literal.
    await expect(error).not.toHaveText(/Enter a name/)
    // And focus is on the field the reader has to fix.
    await expect(nameInput).toBeFocused()
  })

  test('the transaction type radiogroup keeps the WAI-ARIA pattern, and "Khác" cannot hide the checked radio', async ({
    page,
  }) => {
    await page.goto('/transactions')
    const group = page.getByRole('radiogroup').first()
    await expect(group).toBeVisible()
    await expect(group).toHaveAttribute('aria-labelledby', /.+/)

    // Exactly one tab stop in the whole group, collapsed and expanded.
    const tabStops = () =>
      group.evaluate(
        (element) =>
          [...element.querySelectorAll('[role="radio"]')].filter(
            (radio) => radio.getAttribute('tabindex') === '0',
          ).length,
      )
    await expect(group.getByRole('radio')).toHaveCount(2)
    expect(await tabStops(), 'one tab stop while collapsed').toBe(1)

    // An arrow key both moves focus AND checks — the native radio convention.
    await group.getByRole('radio', { name: /Chi tiêu|^Expense$/ }).focus()
    await page.keyboard.press('ArrowRight')
    const income = group.getByRole('radio', { name: /Thu nhập|^Income$/ })
    await expect(income).toBeFocused()
    await expect(income).toHaveAttribute('aria-checked', 'true')
    await expectFocusRing(page, 'a checked type radio')

    // The disclosure adds the four rarer types to the SAME group.
    const disclosure = page.getByRole('button', { name: /^Khác$|^Other$/ })
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(group.getByRole('radio')).toHaveCount(6)
    expect(await tabStops(), 'still one tab stop while expanded').toBe(1)

    // Checking an Other type locks the disclosure open: collapsing it would
    // drop the checked radio out of the group and leave zero tab stops.
    await group.getByRole('radio', { name: /Điều chỉnh tăng|Adjustment increase/ }).click()
    await expect(disclosure).toBeDisabled()
    await expect(group.getByRole('radio')).toHaveCount(6)
    expect(await tabStops(), 'one tab stop with an Other type checked').toBe(1)
  })

  test('prefers-reduced-motion stops the sheet transition, the overlay and the skeleton pulse', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: STORAGE_STATE_PATH,
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    await page.goto('/accounts')
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      'the context really asks for reduced motion',
    ).toBe(true)

    await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()

    // `app/globals.css` collapses every duration to 0.01ms under the query, so
    // "no motion" is a measurable fact, not a look.
    const durations = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')!
      const dialogStyle = getComputedStyle(dialog)
      const probe = document.createElement('div')
      probe.className = 'animate-pulse'
      document.body.appendChild(probe)
      const pulse = getComputedStyle(probe).animationDuration
      probe.remove()
      return {
        transition: dialogStyle.transitionDuration,
        animation: dialogStyle.animationDuration,
        pulse,
      }
    })
    for (const [what, value] of Object.entries(durations)) {
      expect(Number.parseFloat(value), `${what} duration under reduced motion`).toBeLessThan(0.001)
    }
    await context.close()
  })

  test('@375: three distinct navigation landmarks, a 44 px sheet close button, and no WCAG violation', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(await axeViolations(page), 'axe on the phone dashboard').toEqual([])

    await page.getByRole('button', { name: /^Menu$|^More$/ }).click()
    const more = page.getByRole('dialog')
    await expect(more).toBeVisible()
    await expect(more).toHaveAttribute('aria-modal', 'true')
    expect(await axeViolations(page), 'axe on the More sheet').toEqual([])

    // The rail, the bottom bar and the More sheet's grid are three landmarks
    // with three different names — a screen reader listing them has to be able
    // to tell them apart.
    const navLabels = await page.evaluate(() =>
      [...document.querySelectorAll('nav')].map((nav) => nav.getAttribute('aria-label')),
    )
    expect(navLabels).not.toContain(null)
    expect(new Set(navLabels).size, `distinct nav names: ${JSON.stringify(navLabels)}`).toBe(
      navLabels.length,
    )

    // The close × is the only visible way to close a sheet on a phone.
    const close = more.getByRole('button', { name: /^Đóng$|^Close$/ })
    const box = (await close.boundingBox())!
    expect(Math.round(box.width), 'close button width at 375').toBeGreaterThanOrEqual(44)
    expect(Math.round(box.height), 'close button height at 375').toBeGreaterThanOrEqual(44)
  })

  // ---------------------------------------------------------------------------
  // DARK. Last, because `resolveTheme()` reads the session before the cookie,
  // so the only way to change theme is to save it — and every light assertion
  // above has to have run first.
  // ---------------------------------------------------------------------------

  test('dark: axe finds no WCAG violation on any page, or in an open sheet or menu', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await savePreference(page, 'theme', 'dark')
    await page.goto('/dashboard')
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('dark')),
      'the dark theme really applied',
    ).toBe(true)

    for (const url of PAGES) {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await axeViolations(page), `axe on ${url} in dark`).toEqual([])
    }

    await page.goto('/accounts')
    await page.getByRole('button', { name: /Thêm tài khoản|Add account/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await axeViolations(page), 'axe on an open sheet in dark').toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()

    await page
      .getByRole('button', { name: /Tác vụ cho Cash|Actions for Cash/ })
      .first()
      .click()
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await axeViolations(page), 'axe on an open menu in dark').toEqual([])
  })

  test('dark: the focus ring is painted on --surface and on --surface-2', async ({ page }) => {
    await page.goto('/accounts')
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('dark')),
      'this test runs after the dark switch above',
    ).toBe(true)
    await page.keyboard.press('Tab')

    const opener = page.getByRole('button', { name: /Thêm tài khoản|Add account/ })
    await opener.focus()
    await expectFocusRing(page, 'a Button on --surface, dark')

    await page.keyboard.press('Enter')
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await sheet.getByLabel(/Tên tài khoản|Account name/).focus()
    await expectFocusRing(page, 'an Input inside a Sheet (--surface-2), dark')
    await sheet.getByRole('button', { name: /Tạo tài khoản|Create account/ }).focus()
    await expectFocusRing(page, 'a Button inside a Sheet (--surface-2), dark')
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()

    const trigger = page.getByRole('button', { name: /Tác vụ cho Cash|Actions for Cash/ }).first()
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expectFocusRing(page, 'a keyboard-highlighted menu item, dark')
  })
})
