import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { PageSkeleton } from './page-skeleton'

describe('PageSkeleton', () => {
  it('hides every bar from assistive technology and marks the region busy', () => {
    const html = renderToStaticMarkup(<PageSkeleton rows={3} />)
    // Every `<div>` in the output is either the layout or a `Skeleton`; the
    // bars are what must be hidden, and the region is what must say "busy".
    expect(html).toContain('aria-busy="true"')
    const bars = html.match(/animate-pulse/g) ?? []
    expect(bars.length).toBeGreaterThan(0)
    expect(html.match(/aria-hidden="true"/g) ?? []).toHaveLength(bars.length)
  })

  it('contains no text node at all — a skeleton says nothing it has to translate', () => {
    const html = renderToStaticMarkup(
      <PageSkeleton rows={8} summary="panel" twoColumn maxWidth="max-w-[75rem]" />,
    )
    expect(html.replace(/<[^>]+>/g, '').trim()).toBe('')
  })

  it('renders exactly the requested number of rows', () => {
    const html = renderToStaticMarkup(<PageSkeleton rows={8} />)
    expect(html.match(/<li /g) ?? []).toHaveLength(8)
  })

  it('draws the summary panel and the summary strip only when asked', () => {
    // The panel's dominant figure is `h-10`; the strip's three cells are not.
    expect(renderToStaticMarkup(<PageSkeleton summary="panel" rows={1} />)).toContain('h-10 w-40')
    expect(renderToStaticMarkup(<PageSkeleton summary="strip" rows={1} />)).not.toContain(
      'h-10 w-40',
    )
    const none = renderToStaticMarkup(<PageSkeleton rows={1} />)
    expect(none).not.toContain('h-10 w-40')
    expect(none).not.toContain('h-7 w-28')
  })

  it('makes the second column desktop-only, exactly as the pages that have one do', () => {
    const two = renderToStaticMarkup(<PageSkeleton rows={2} twoColumn />)
    expect(two).toContain('xl:col-span-7')
    expect(two).toContain('hidden xl:col-span-5 xl:block')
    expect(renderToStaticMarkup(<PageSkeleton rows={2} />)).not.toContain('xl:col-span-5')
  })
})

/**
 * The ruled set of route-level skeletons (owner item H5), asserted as a file
 * list rather than in a browser: a missing `loading.tsx` is invisible on a fast
 * local navigation, and an EXTRA one is just as much a defect — `/categories`,
 * `/goals`, `/settings` and the auth screens were ruled out (each is a short
 * page whose skeleton would flash for less time than it takes to read).
 */
describe('route-level skeletons', () => {
  const APP_DIR = path.join(process.cwd(), 'app', '(app)')
  const RULED = [
    'accounts',
    'budgets',
    'dashboard',
    'debts',
    'loans',
    'reminders',
    'reports',
    'transactions',
    'transfers',
  ]

  it('exists for the ruled routes and for no others', () => {
    const routes = fs
      .readdirSync(APP_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const withSkeleton = routes
      .filter((route) => fs.existsSync(path.join(APP_DIR, route, 'loading.tsx')))
      .sort()
    expect(withSkeleton).toEqual(RULED)
    // And the routes that were ruled out really exist — otherwise this test
    // would pass by simply not having those pages any more.
    for (const route of ['categories', 'goals', 'settings']) {
      expect(routes, `${route} is still a route`).toContain(route)
    }
  })

  it('every skeleton renders through PageSkeleton — one shape, nine routes', () => {
    for (const route of RULED) {
      const source = fs.readFileSync(path.join(APP_DIR, route, 'loading.tsx'), 'utf8')
      expect(source, route).toContain('<PageSkeleton')
      expect(source, route).toContain("from '@/components/common/page-skeleton'")
    }
  })
})
