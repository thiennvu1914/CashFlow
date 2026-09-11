import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import viErrors from '@/messages/vi/errors.json'

/**
 * `not-found.tsx` is an async Server Component that calls `getTranslations()`
 * from `next-intl/server`, which needs a live Next request (the
 * `i18n/request.ts` config reads cookies/session) to resolve anything —
 * unavailable in a plain Vitest run. The factory does its own dynamic
 * `import()`s rather than closing over a top-level binding, so nothing here
 * needs `vi.hoisted()`: it stands up a real `next-intl` translator
 * (`createTranslator`, the same engine `getTranslations` uses) over the
 * actual `messages/vi/errors.json` file, so the assertions below exercise the
 * real product copy, not a stand-in string.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async () => {
    const { createTranslator } = await import('next-intl')
    const errors = (await import('@/messages/vi/errors.json')).default
    return createTranslator({ locale: 'vi', messages: { errors } })
  },
}))

const { default: NotFound } = await import('./not-found')

describe('NotFound (app/not-found.tsx)', () => {
  it('renders exactly one heading, the localized copy and both ways forward', async () => {
    const html = renderToStaticMarkup(await NotFound())

    expect(html.match(/<h1[ >]/g)).toHaveLength(1)
    expect(html).toContain(viErrors.notFoundTitle)
    expect(html).toContain(viErrors.notFoundBody)
    expect(html).toContain(viErrors.goToDashboard)
    expect(html).toContain(viErrors.goToLogin)
    expect(html).toContain('href="/dashboard"')
    expect(html).toContain('href="/login"')
  })

  it('carries no stack trace or raw Error text — there is nothing here to leak', async () => {
    const html = renderToStaticMarkup(await NotFound())

    expect(html).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/) // a stack-frame line
    expect(html).not.toMatch(/TypeError|ReferenceError/)
  })
})
