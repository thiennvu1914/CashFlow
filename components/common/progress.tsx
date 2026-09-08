import { cn } from 'cn'

/**
 * The 6 px progress bar (spec §2), consolidating the three hand-rolled copies
 * in `BudgetProgressList`, `GoalList`, `DebtList` and `LoanList`.
 *
 * The ARIA contract is exactly what those four already had, and it matters:
 * `aria-valuenow` is the CLAMPED width (a bar may fill its track, never
 * overflow it) while `aria-valuetext` carries the TRUE figure — an exceeded
 * budget at 120 % must announce 120 %, not 100 %.
 */
const TONE_CLASSES = {
  brand: 'bg-brand',
  positive: 'bg-positive',
  warning: 'bg-warning',
  negative: 'bg-negative',
} as const

export function Progress({
  percent,
  valueText,
  label,
  tone = 'brand',
  className,
}: {
  percent: number
  valueText: string
  label: string
  tone?: keyof typeof TONE_CLASSES
  className?: string
}) {
  const width = Math.min(100, Math.max(0, percent))
  return (
    <div
      role="progressbar"
      aria-valuenow={width}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText}
      aria-label={label}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
    >
      <div className={cn('h-full', TONE_CLASSES[tone])} style={{ width: `${width}%` }} />
    </div>
  )
}
