import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
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

function render(defaultValues: ProfileInput): string {
  return renderToStaticMarkup(<ProfileForm defaultValues={defaultValues} />)
}

/**
 * The markup of one `<select>`, found by the `name` attribute `register()`
 * emits — these selects carry no accessible name today, and that is out of
 * scope for a hydration patch. `<select>`s cannot nest, so the first
 * `</select>` after the opening tag closes it. Scoping matters: the three
 * selects each render their own options, and an assertion against the whole
 * document could not tell them apart.
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
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render(PROBE)

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">Profile</legend>')
  })

  it('moves the form layout onto the fieldset, so lifting the gate shifts nothing', () => {
    const html = render(PROBE)

    // The flex column lives on the fieldset (the new flex container), not on
    // the <form> — a <fieldset> wrapping a flex form's children without taking
    // over its layout would re-flow every field the moment the gate lifts.
    expect(html).toContain('class="flex min-w-0 flex-col gap-4"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
    expect(html).not.toMatch(/<form[^>]*class=/)
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
    expect(inputMarkup(html, 'timezone')).toContain('value="Europe/London"')

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
    expect(inputMarkup(html, 'timezone')).toContain('value="Asia/Ho_Chi_Minh"')
  })
})
