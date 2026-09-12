import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AuthLayout from './layout'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}))

it('centres the tagline under the logo without centring the auth form', async () => {
  const html = renderToStaticMarkup(await AuthLayout({ children: <h1>Auth form</h1> }))
  expect(html).toMatch(/<img[^>]*class="[^"]*\bself-center\b/)
  expect(html).toMatch(/<p class="[^"]*\btext-center\b[^"]*">common\.tagline<\/p>/)
  expect(html).not.toMatch(/<main[^>]*class="[^"]*\btext-center\b/)
  expect(html).toContain('<h1>Auth form</h1>')
})
