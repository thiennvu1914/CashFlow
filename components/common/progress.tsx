import { cn } from 'cn'

/**
 * The 6 px progress bar (spec §2), consolidating the three hand-rolled copies
 * in `BudgetProgressList`, `GoalList`, `DebtList` and `LoanList`.
 *
 * The ARIA contract is exactly what those four already had, and it matters:
 * `aria-valuenow` is the CLAMPED width (a bar may fill its track, never
 * overflow it) while `aria-valuetext` carries the TRUE figure — an exceeded
 * budget at 120 % must announce 120 %, not 100 %. That contract assumes ONE
 * quantity: percent-of-a-target, where the bar's fill and the announced
 * figure agree.
 *
 * `decorative` (fix round 1, promoted minor) is for a caller like
 * `CategoryBars` where that assumption breaks: the bar's width is a share of
 * the LARGEST row (so the chart reads as a comparison), but the figure beside
 * it is a share of the TOTAL (so the number means something on its own) —
 * two different percentages of the same row, which `role="progressbar"`'s
 * single-quantity contract cannot honestly state, and which produced a `NaN
 * %` announcement whenever a share-of-total denominator was zero. Decorative
 * mode drops `role`/`aria-valuenow`/`aria-valuemin`/`aria-valuemax`/
 * `aria-valuetext`/`aria-label` entirely and sets `aria-hidden="true"`
 * instead — the bar becomes a picture, and the caller's own visible name,
 * amount and percent (real text a screen reader already reads) carry 100 % of
 * the meaning.
 *
 * `dark:bg-foreground/14` on the track (Task 14 Step 3, finding 1): in dark
 * `bg-muted` lands almost exactly on the two surfaces this 6 px bar is drawn
 * on, so the track was invisible — a 0 %-progress debt or loan showed nothing
 * at all. `--muted` itself cannot be moved to fix it, because every value that
 * makes the wash visible breaks a text pair `bg-muted` carries elsewhere; the
 * track is the one `bg-muted` surface with NO text on it (the fill is its only
 * child, and the wrapper is either `role="progressbar"` or `aria-hidden`), so
 * it can take a lighter wash for free. 14 % is `--border`'s own alpha, so the
 * track reads exactly as present as a card hairline, and light is untouched.
 * Every measured figure behind that — the trough sweep and both directions'
 * costs — is in the MEASURED WCAG CONTRAST block in `app/globals.css`, note 2,
 * which is the single source for it.
 */
const TONE_CLASSES = {
  brand: 'bg-brand',
  accent: 'bg-accent',
  positive: 'bg-positive',
  warning: 'bg-warning',
  negative: 'bg-negative',
} as const

export function Progress({
  percent,
  valueText,
  label,
  tone = 'brand',
  decorative = false,
  className,
}: {
  percent: number
  valueText: string
  label: string
  tone?: keyof typeof TONE_CLASSES
  /** See the component doc above. Default `false` — every existing caller
   *  (budgets, goals, debts, loans) keeps its real progressbar semantics. */
  decorative?: boolean
  className?: string
}) {
  const width = Math.min(100, Math.max(0, percent))
  return (
    <div
      {...(decorative
        ? { 'aria-hidden': true }
        : {
            role: 'progressbar',
            'aria-valuenow': width,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuetext': valueText,
            'aria-label': label,
          })}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted dark:bg-foreground/14', className)}
    >
      <div
        className={cn('h-full rounded-full transition-all duration-500', TONE_CLASSES[tone])}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}
