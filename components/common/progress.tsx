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
      // `dark:bg-foreground/14` (Task 14 Step 3, finding 1): in dark,
      // `bg-muted` resolves to #2C2829, which is 1.05:1 against `--surface`
      // and 1.06:1 against `--surface-2` — the two surfaces this 6 px track is
      // ever drawn on. Measured in the browser and confirmed in every dark
      // screenshot: a 0 %-progress debt, a 0 %-progress loan and a 3 % Reports
      // category bar showed no track at all, so the bar could not be read as
      // "this far along a whole". A token nudge cannot fix it: swept in the
      // browser at 2 % steps, `--muted` bottoms out against `--surface` at
      // ~6 % and against `--surface-2` at ~10 %, so the shipped 8 % sits in the
      // trough between them, and moving it out in either direction breaks a
      // text pair that `bg-muted` carries elsewhere — 14-20 % drops
      // `text-brand` on it to 4.19-3.53:1 and `text-muted-foreground` to
      // 4.16-3.50:1, while going down to `--background` keeps the text but
      // leaves the wash at 1.01:1 on the page background, where the reminders
      // chips live. The track is the one `bg-muted` surface with NO text
      // on it (the fill is the only child, and the wrapper is either
      // `role="progressbar"` or `aria-hidden`), so it can take a lighter wash
      // for free. 14 % is `--border`'s own alpha, so the track reads exactly as
      // present as a card hairline (1.53:1 on all three surfaces) — above
      // light's 1.21:1, and calm. Light is untouched.
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted dark:bg-foreground/14', className)}
    >
      <div className={cn('h-full', TONE_CLASSES[tone])} style={{ width: `${width}%` }} />
    </div>
  )
}
