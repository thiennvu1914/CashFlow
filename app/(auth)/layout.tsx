import { getTranslations } from 'next-intl/server'

/**
 * The frame the four auth screens share (spec §6.10): a centred 400 px card on
 * the app background, with the wordmark and a one-line tagline above whatever
 * the page renders.
 *
 * A layout rather than four copies of the same wrapper, which is what the four
 * pages had — and they had drifted: each declared its own
 * `min-h-screen max-w-sm` wrapper with slightly different gaps.
 *
 * No illustration and no marketing panel. This is a finance app's front door;
 * the fastest possible path to the form is the whole design.
 *
 * The THEME comes from the `cashflow-theme` cookie via `resolveTheme()` in the
 * root layout — there is no session here to ask, which is exactly why that
 * cookie exists (spec §3).
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      {/* A `<main>`, not a `<div>` (Task 16, owner item G1: exactly one `main`
          per page). The four auth screens had NO main landmark at all — their
          `h1` and their form sat in plain divs — so a screen-reader user had
          no landmark to jump to and "skip to the main content" had nothing to
          skip to. The card IS the whole page here, wordmark included, so the
          card is the landmark; nothing else moves, and the class list is
          unchanged. The signed-in shell's `main` is in
          `components/layout/app-shell.tsx`. */}
      <main className="flex w-full max-w-[25rem] flex-col gap-6 rounded-lg border border-border bg-surface p-6 sm:p-8">
        <div className="flex flex-col gap-1">
          <p className="text-base font-semibold text-brand">{t('common.appName')}</p>
          <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{t('common.tagline')}</p>
        </div>
        {children}
      </main>
    </div>
  )
}
