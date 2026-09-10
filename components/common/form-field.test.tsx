import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import viValidation from '@/messages/vi/validation.json'

import { FieldError } from './form-field'

/**
 * `FieldError` (Task 1b/2c, spec §4): a Zod message literal is translated
 * through `validationMessageKey`, with the literal itself as the fallback for
 * anything the dictionary does not (yet) cover — so an English message never
 * crashes the render, it just stays English (spec's own escape hatch).
 *
 * Rendered with `renderToStaticMarkup` rather than a DOM testing library:
 * this project's Vitest setup has no jsdom (see `AGENTS.md`/vitest.config.ts),
 * and `NextIntlClientProvider` is a plain React context provider that needs no
 * DOM to render.
 */
describe('FieldError', () => {
  it('translates a Zod message literal that has a validation.json entry', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale="vi"
        timeZone="Asia/Ho_Chi_Minh"
        messages={{ validation: viValidation }}
      >
        <FieldError id="amount-error">Enter an amount</FieldError>
      </NextIntlClientProvider>,
    )
    expect(html).toContain(viValidation['Enter an amount'])
    expect(html).not.toContain('Enter an amount')
  })

  it('falls back to the literal verbatim when the dictionary has no entry for it', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale="vi"
        timeZone="Asia/Ho_Chi_Minh"
        messages={{ validation: viValidation }}
      >
        <FieldError id="mystery-error">Some message no dictionary carries</FieldError>
      </NextIntlClientProvider>,
    )
    expect(html).toContain('Some message no dictionary carries')
  })

  it('still sets role="alert" and the id FormField binds via aria-describedby', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale="vi"
        timeZone="Asia/Ho_Chi_Minh"
        messages={{ validation: viValidation }}
      >
        <FieldError id="amount-error">Enter an amount</FieldError>
      </NextIntlClientProvider>,
    )
    expect(html).toContain('id="amount-error"')
    expect(html).toContain('role="alert"')
  })
})
