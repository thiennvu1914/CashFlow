import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from './button'

/**
 * Regression guard for the border-colour bug (wave screenshot pass, fix
 * round 1, area B): the base class used to carry `border-transparent`
 * unconditionally, meant to be overridden by `outline`'s own `border-border`
 * — but Tailwind's compiled stylesheet orders its `.border-*` colour rules by
 * its own internal rule, not by class order in the JSX `class` attribute, so
 * `border-transparent` was winning the cascade and every `variant="outline"`
 * button (EmptyState CTAs, every dialog's Cancel) rendered borderless. The fix
 * is structural — never emit two conflicting border-colour classes on one
 * element — so these assertions read the actual rendered `class` string
 * rather than computed style (no jsdom in this repo).
 */
function classAttr(html: string): string {
  const match = html.match(/class="([^"]*)"/)
  if (!match) throw new Error('No class attribute in the rendered markup')
  return match[1]
}

describe('Button', () => {
  it('gives the outline variant its own visible border colour, never the transparent one', () => {
    const html = renderToStaticMarkup(<Button variant="outline">Cancel</Button>)
    const className = classAttr(html)
    expect(className).toContain('border-border')
    expect(className).not.toContain('border-transparent')
  })

  it('keeps the default variant borderless (no border-border leaking in)', () => {
    const html = renderToStaticMarkup(<Button>Save</Button>)
    const className = classAttr(html)
    expect(className).toContain('border-transparent')
    expect(className).not.toContain('border-border')
  })
})
