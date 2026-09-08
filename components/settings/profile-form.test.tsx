import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import type { ProfileInput } from '@/lib/validation/profile'

/**
 * A markup test, not a DOM test — the same shape as
 * `components/transactions/transaction-form.test.tsx`: `renderToStaticMarkup`
 * is enough to pin down what the first paint offers, which is the whole defect
 * here, with no jsdom and no Testing Library.
 *
 * What is under test: the server HTML must show the STORED profile and must
 * not be operable before hydration. Before the fix every control here was an
 * uncontrolled `register()` field with a `defaultValues` entry, so the server
 * rendered an empty Name, an empty Timezone and the FIRST option of all three
 * selects — and anything the user changed in that window was overwritten by
 * react-hook-form's `ref` callback the moment React committed
 * (`lib/ui/use-hydrated.ts` has the full citation).
 *
 * `useRouter` is only reached in the submit path, but calling it at all throws
 * outside a mounted app router, so it is mocked; the server-action module is
 * mocked too, because importing the real one pulls in Prisma and Better Auth
 * for a test that never submits.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/update-profile', () => ({
  updateProfile: vi.fn(),
}))

const { ProfileForm } = await import('./profile-form')

/**
 * Deliberately NOT the app defaults: every value here is the *second* option of
 * its select, or a non-empty text field. A form that ignores its defaults still
 * renders `VND`/`vi`/`light` correctly by accident (they are each the first
 * option), so only non-first values can fail when the defaults are dropped.
 */
const PROBE: ProfileInput = {
  name: 'Probe User',
  baseCurrency: 'USD',
  locale: 'en',
  theme: 'dark',
  timezone: 'Europe/London',
}

/** CashFlow's own defaults (`lib/auth/user-defaults.ts`), the common case. */
const APP_DEFAULTS: ProfileInput = {
  name: 'Default User',
  baseCurrency: 'VND',
  locale: 'vi',
  theme: 'light',
  timezone: 'Asia/Ho_Chi_Minh',
}

const LABELS = {
  profileTitle: 'Profile',
  profileDescription: 'The name shown throughout the app.',
  preferencesTitle: 'Preferences',
  preferencesDescription: 'How CashFlow displays your figures.',
}

const messages = await loadMessages('vi')

function render(defaultValues: ProfileInput = APP_DEFAULTS): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <ProfileForm defaultValues={defaultValues} labels={LABELS} />
    </NextIntlClientProvider>,
  )
}

/**
 * The markup of one `<select>`, found by the `name` attribute `register()`
 * emits. `<select>`s cannot nest, so the first `</select>` after the opening
 * tag closes it. Scoping matters: the four selects each render their own
 * options, and an assertion against the whole document could not tell them
 * apart.
 */
function selectMarkup(html: string, name: string): string {
  const nameIndex = html.indexOf(`name="${name}"`)
  if (nameIndex === -1) throw new Error(`No element named "${name}" in the markup`)
  const start = html.lastIndexOf('<select', nameIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> named "${name}"`)
  return html.slice(start, end + '</select>'.length)
}

/** `<option value="…" … selected="">` regardless of attribute order — the
 *  order react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
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

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1
}

describe('ProfileForm hydration gate', () => {
  it('ships both groups gated: disabled fieldsets with sr-only legends', () => {
    const html = render()

    // `aria-busy` tracks the in-flight SUBMIT, not the hydration gate (spec's
    // accessibility criteria: "disabled + aria-busy while saving") — so on the
    // very first, pre-submit render it is absent even though both fieldsets
    // are already `disabled` by the hydration gate.
    expect(html.match(/<fieldset disabled=""/g)).toHaveLength(2)
    expect(html).toContain('<legend class="sr-only">Hồ sơ</legend>')
    expect(html).toContain('<legend class="sr-only">Tùy chọn hiển thị</legend>')
  })

  it("moves each group's layout onto its fieldset, so lifting the gate shifts nothing", () => {
    const html = render()

    // The flex column lives on each fieldset (the flex container), not on the
    // <form> — a <fieldset> wrapping a flex form's children without taking
    // over its layout would re-flow every field the moment the gate lifts.
    expect(countOf(html, 'class="flex min-w-0 flex-col gap-4"')).toBe(2)
    expect(html).toMatch(/<form[^>]*>[\s\S]*?<fieldset/)
  })
})

describe('ProfileForm server-rendered defaults', () => {
  it('renders the stored non-default profile, not empty boxes and first options', () => {
    const html = render(PROBE)

    // Text fields: `register()` emits no value of its own
    // (`react-hook-form/dist/index.esm.mjs:3118-3183`), so without an explicit
    // `defaultValue` these arrive EMPTY and the user's stored name only
    // appears once hydration has run.
    expect(inputMarkup(html, 'name')).toContain('value="Probe User"')

    // Selects: without a `defaultValue` the browser shows the FIRST option, so
    // a USD/en/dark profile was displayed as VND/vi/light until hydration.
    for (const [field, stored, first] of [
      ['baseCurrency', 'USD', 'VND'],
      ['locale', 'en', 'vi'],
      ['theme', 'dark', 'light'],
    ] as const) {
      const markup = selectMarkup(html, field)
      expect(markup, field).toMatch(selectedOption(stored))
      expect(markup, field).not.toMatch(selectedOption(first))
      // Exactly one option is pre-selected, and it is not a `value=` prop on
      // the <select> itself — that would make the control controlled.
      expect(countOf(markup, 'selected=""'), field).toBe(1)
      expect(markup, field).not.toMatch(/<select[^>]*\svalue=/)
    }

    // Timezone: a grouped native select, so the stored zone is asserted as the
    // hoisted leading option rather than via `inputMarkup`.
    const timezoneMarkup = selectMarkup(html, 'timezone')
    expect(timezoneMarkup).toMatch(selectedOption('Europe/London'))
    expect(countOf(timezoneMarkup, 'selected=""')).toBe(1)
  })

  it('renders the app defaults as the selected options too', () => {
    const html = render(APP_DEFAULTS)

    // These are each their select's first option, so the browser would land on
    // them anyway — asserted so a `defaultValue` wired to the wrong field, or
    // dropped for the common case, cannot pass unnoticed.
    for (const [field, stored] of [
      ['baseCurrency', 'VND'],
      ['locale', 'vi'],
      ['theme', 'light'],
    ] as const) {
      const markup = selectMarkup(html, field)
      expect(markup, field).toMatch(selectedOption(stored))
      expect(countOf(markup, 'selected=""'), field).toBe(1)
    }
    expect(inputMarkup(html, 'name')).toContain('value="Default User"')
    const timezoneMarkup = selectMarkup(html, 'timezone')
    expect(timezoneMarkup).toMatch(selectedOption('Asia/Ho_Chi_Minh'))
  })
})

describe('ProfileForm — one form, two groups, one Save', () => {
  it('renders the server-stored profile in ONE form with two gated fieldsets', () => {
    const html = render()
    expect(html.match(/<form/g)).toHaveLength(1)
    expect(html.match(/<fieldset/g)).toHaveLength(2)
    // Both gated before hydration, both marked busy-capable.
    expect(html.match(/<fieldset disabled/g)).toHaveLength(2)
    expect(html.match(/<legend class="sr-only"/g)).toHaveLength(2)
  })

  it('has exactly one submit button, outside both fieldsets', () => {
    const html = render()
    expect(html.match(/type="submit"/g)).toHaveLength(1)
    // The button follows the second `</fieldset>`, so it inherits neither
    // group's `disabled` — which is why it carries its own.
    expect(html.lastIndexOf('</fieldset>')).toBeLessThan(html.indexOf('type="submit"'))
  })

  it('gives all five controls a visible label bound to their id', () => {
    const html = render()
    for (const id of [
      'settings-name',
      'settings-base-currency',
      'settings-locale',
      'settings-theme',
      'settings-timezone',
    ]) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('hoists the stored timezone into the leading optgroup', () => {
    const html = render()
    const firstGroup = html.slice(html.indexOf('<optgroup'), html.indexOf('</optgroup>'))
    expect(firstGroup).toContain('Asia/Ho_Chi_Minh')
  })
})
