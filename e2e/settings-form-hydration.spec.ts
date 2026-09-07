import os from 'os'
import path from 'path'
import { test, expect } from '@playwright/test'
import { registerNewUser } from './helpers'

/**
 * The Settings profile form's hydration gate — the same silent-reversion defect
 * the money forms were fixed for (`lib/ui/use-hydrated.ts`,
 * `e2e/transaction-form-hydration.spec.ts`), on the one form where EVERY field
 * carries a `defaultValues` entry and was therefore revertible.
 *
 * The defect: `/settings` server-rendered an empty Name, an empty Timezone and
 * the FIRST option of the Base currency, Language and Theme selects, whatever
 * the user had actually stored. A name typed — or a select changed — before
 * hydration finished was then overwritten by react-hook-form's `ref` callback
 * the moment React committed, with no `change` event ever reaching React. A
 * live pre-fix probe reverted a typed name 5/5.
 *
 * Nothing here may paper over that. No retry helper, no `waitForTimeout`, no
 * `toPass`, no relaxed assertion; `playwright.config.ts` runs `retries: 0`.
 * Two properties make the behavioural test exercise the gate rather than the
 * dev server's incidental timing:
 *
 *  - every navigation uses `waitUntil: 'commit'`, so the interaction is
 *    attempted as soon as the document exists — long before `load`, and long
 *    before hydration;
 *  - the ONLY thing that then delays `fill`/`selectOption` is Playwright's
 *    actionability check, which treats a control inside a `<fieldset disabled>`
 *    as disabled (`playwright-core`'s `belongsToDisabledFieldSet`).
 *
 * So each action lands at the earliest moment the application itself is willing
 * to accept input, and what it accepts has to survive.
 *
 * One user is registered via the UI once (in `beforeAll`) and its session is
 * captured as `storageState`, reused by every test via `test.use` — the same
 * pattern the other specs use. The suite leaves that user's profile exactly as
 * it found it (see the last test).
 */

const STORAGE_STATE_PATH = path.join(
  os.tmpdir(),
  `cashflow-settings-hydration-storage-state-${process.pid}.json`,
)

/** The profile a freshly registered user has: `registerNewUser`'s name plus
 *  `USER_FIELD_DEFAULTS` (`lib/auth/user-defaults.ts`). */
const STORED = {
  name: 'Phase 4 E2E User',
  baseCurrency: 'VND',
  locale: 'vi',
  theme: 'light',
  timezone: 'Asia/Ho_Chi_Minh',
} as const

/**
 * The edited profile. Every select value here is the SECOND option of its
 * select, deliberately: a form that ignores its defaults still renders
 * `VND`/`vi`/`light` correctly by accident, so only non-first values can prove
 * the server-rendered defaults and the surviving edits are real.
 */
const EDITED = {
  name: 'Settings Saved User',
  baseCurrency: 'USD',
  locale: 'en',
  theme: 'dark',
  timezone: 'Europe/London',
} as const

const NAME_PLACEHOLDER = 'Name'
const TIMEZONE_PLACEHOLDER = 'Timezone (IANA, e.g. Asia/Ho_Chi_Minh)'

/**
 * The markup of one `<select>`, found by the `name` attribute `register()`
 * emits — these three selects carry no accessible name today, which is out of
 * scope for a hydration patch. `<select>`s cannot nest, so the first
 * `</select>` after the opening tag closes it. Scoping is what makes the
 * `selected` assertions meaningful: three selects render options of their own.
 */
function selectMarkup(html: string, name: string): string {
  const nameIndex = html.indexOf(`name="${name}"`)
  if (nameIndex === -1) throw new Error(`No element named "${name}" in the markup`)
  const start = html.lastIndexOf('<select', nameIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> named "${name}"`)
  return html.slice(start, end + '</select>'.length)
}

/** The `<input>` markup carrying the given `name` attribute. */
function inputMarkup(html: string, name: string): string {
  const nameIndex = html.indexOf(`name="${name}"`)
  if (nameIndex === -1) throw new Error(`No element named "${name}" in the markup`)
  const start = html.lastIndexOf('<input', nameIndex)
  const end = html.indexOf('>', nameIndex)
  if (start === -1 || end === -1) throw new Error(`No <input> named "${name}"`)
  return html.slice(start, end + 1)
}

/** `<option value="…" … selected="">` regardless of attribute order — the order
 *  react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

/** Asserts the raw `/settings` HTML shows exactly `profile` as its initial state. */
function expectServerRenderedProfile(html: string, profile: typeof STORED | typeof EDITED): void {
  expect(inputMarkup(html, 'name')).toContain(`value="${profile.name}"`)
  expect(inputMarkup(html, 'timezone')).toContain(`value="${profile.timezone}"`)
  for (const field of ['baseCurrency', 'locale', 'theme'] as const) {
    const markup = selectMarkup(html, field)
    expect(markup, field).toMatch(selectedOption(profile[field]))
    // Exactly one option is pre-selected, and the <select> is not controlled.
    expect(markup.split('selected=""').length - 1, field).toBe(1)
    expect(markup, field).not.toMatch(/<select[^>]*\svalue=/)
  }
}

test.describe.serial('Settings profile form — hydration gate', () => {
  test.use({ storageState: STORAGE_STATE_PATH })

  test.beforeAll(async ({ browser }) => {
    // `storageState: undefined` overrides the file-level `test.use` above,
    // which at this point names a file this step is about to create — the same
    // reasoning as `phase4.spec.ts`' and `transaction-form-hydration.spec.ts`'
    // `beforeAll`.
    const context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await registerNewUser(page, { emailPrefix: 'e2e-settings-hydration' })

    await context.storageState({ path: STORAGE_STATE_PATH })
    await context.close()
  })

  test('server HTML gates the profile form and carries the stored profile', async ({ page }) => {
    // Deterministic by construction: a raw response body, no timing at all.
    const response = await page.request.get('/settings')
    expect(response.status()).toBe(200)
    const html = await response.text()

    // 1. The gate itself, in the bytes the browser paints first: nothing inside
    //    the profile form is operable, and assistive tech is told it is busy.
    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')

    // 2. The state the client is about to own is the state the server showed.
    //    Pre-fix this was an empty Name, an empty Timezone and VND/vi/light
    //    regardless of what the user had stored.
    expectServerRenderedProfile(html, STORED)
  })

  test('early edits to every field survive hydration (5 fresh navigations)', async ({ page }) => {
    test.setTimeout(120_000)

    const name = page.getByPlaceholder(NAME_PLACEHOLDER, { exact: true })
    const timezone = page.getByPlaceholder(TIMEZONE_PLACEHOLDER, { exact: true })
    const baseCurrency = page.locator('select[name="baseCurrency"]')
    const locale = page.locator('select[name="locale"]')
    const theme = page.locator('select[name="theme"]')

    for (let i = 0; i < 5; i++) {
      // `commit` resolves the moment the response starts, so the very next line
      // runs while the document is still streaming — far earlier than `load`,
      // and certainly earlier than hydration. Nothing is saved inside the loop,
      // so every iteration starts from the stored profile again.
      await page.goto('/settings', { waitUntil: 'commit' })

      const renamed = `Renamed ${i}`
      // Each locator auto-waits for attachment, then Playwright waits for
      // `:enabled` — i.e. for the fieldset's gate to lift. That is the sole
      // gate on these actions, and the earliest moment the app allows input.
      await name.fill(renamed)
      await expect(name).toHaveValue(renamed)
      await baseCurrency.selectOption(EDITED.baseCurrency)
      await expect(baseCurrency).toHaveValue(EDITED.baseCurrency)
      await locale.selectOption(EDITED.locale)
      await expect(locale).toHaveValue(EDITED.locale)
      await theme.selectOption(EDITED.theme)
      await expect(theme).toHaveValue(EDITED.theme)
      await timezone.fill(EDITED.timezone)
      await expect(timezone).toHaveValue(EDITED.timezone)

      // The old failure window: hydration finishing *after* the interaction.
      // Against the unfixed code the ungated controls accept the input before
      // React is listening, react-hook-form's `ref` callback writes the stored
      // profile straight back into the DOM, and no `change` event ever reaches
      // React — so `_formValues` never learns about the edit either.
      await page.waitForLoadState('networkidle')
      await expect(name).toHaveValue(renamed)
      await expect(baseCurrency).toHaveValue(EDITED.baseCurrency)
      await expect(locale).toHaveValue(EDITED.locale)
      await expect(theme).toHaveValue(EDITED.theme)
      await expect(timezone).toHaveValue(EDITED.timezone)
    }
  })

  test('saving persists every field, and the next server render shows it', async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'commit' })

    const name = page.getByPlaceholder(NAME_PLACEHOLDER, { exact: true })
    const timezone = page.getByPlaceholder(TIMEZONE_PLACEHOLDER, { exact: true })
    const baseCurrency = page.locator('select[name="baseCurrency"]')
    const locale = page.locator('select[name="locale"]')
    const theme = page.locator('select[name="theme"]')
    const save = page.getByRole('button', { name: 'Save changes' })

    await name.fill(EDITED.name)
    await baseCurrency.selectOption(EDITED.baseCurrency)
    await locale.selectOption(EDITED.locale)
    await theme.selectOption(EDITED.theme)
    await timezone.fill(EDITED.timezone)
    await save.click()
    await expect(page.getByText('Profile saved')).toBeVisible()

    // The one render path this patch introduces: after a save the form calls
    // `router.refresh()`, so `ProfileForm` re-renders in place with a NEW
    // `defaultValues` prop and new `defaultValue` attributes while the user's
    // edited values are still the live form state. `networkidle` marks the
    // refresh round-trip as finished; every control must still read the edited
    // value afterwards — the changed attributes may never replay over the DOM.
    await page.waitForLoadState('networkidle')
    await expect(name).toHaveValue(EDITED.name)
    await expect(baseCurrency).toHaveValue(EDITED.baseCurrency)
    await expect(locale).toHaveValue(EDITED.locale)
    await expect(theme).toHaveValue(EDITED.theme)
    await expect(timezone).toHaveValue(EDITED.timezone)

    // A fresh navigation: the values now come from the database, not from the
    // form state the click left behind.
    await page.goto('/settings')
    await expect(name).toHaveValue(EDITED.name)
    await expect(baseCurrency).toHaveValue(EDITED.baseCurrency)
    await expect(locale).toHaveValue(EDITED.locale)
    await expect(theme).toHaveValue(EDITED.theme)
    await expect(timezone).toHaveValue(EDITED.timezone)

    // And the server HTML itself moved — the `value=`/`selected=""` markers now
    // describe the saved profile, so first paint never shows the old one.
    const html = await (await page.request.get('/settings')).text()
    expectServerRenderedProfile(html, EDITED)

    // Restore the profile this suite's user started with, so the rest of the
    // suite's assumptions about a freshly registered user still hold.
    await name.fill(STORED.name)
    await baseCurrency.selectOption(STORED.baseCurrency)
    await locale.selectOption(STORED.locale)
    await theme.selectOption(STORED.theme)
    await timezone.fill(STORED.timezone)
    await save.click()
    await expect(page.getByText('Profile saved')).toBeVisible()
  })
})
