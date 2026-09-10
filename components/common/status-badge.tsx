import { cn } from 'cn'

export type StatusTone = 'neutral' | 'positive' | 'warning' | 'negative' | 'brand' | 'muted'

/**
 * The one status pill in the product (spec §2).
 *
 * Six tones, each a 10 % tint of its own colour (18 % in dark, where a 10 %
 * wash on a charcoal surface is invisible). A tint rather than a fill because
 * a row can carry two or three of these and six saturated pills would shout
 * louder than the figures beside them.
 *
 * The text is `text-<tone>-on-tint`, NOT the tone itself (Task 16, F6 routed
 * from Task 14): a wash of a tone moves the surface toward that tone, so
 * `text-positive` on `bg-positive/10` measured 4.30:1 in light and 3.28:1 in
 * dark — under the 4.5:1 text minimum. The `*-on-tint` tokens are the same
 * hue and chroma with L stepped only as far as clearing 4.5:1 on all three
 * tinted fills needs; the wash and the tones themselves are unchanged. Every
 * number is in `app/globals.css`'s MEASURED WCAG CONTRAST block, ON-TINT
 * table.
 *
 * `label` is always rendered. Colour is never the only signal — every caller
 * passes wording that differs per state, so a colour-blind reader and a screen
 * reader get the same fact as everyone else.
 *
 * A server component with no state: it may be rendered from a server page or
 * from inside a client row alike, which is why it takes an already-translated
 * `label` string and never calls `useTranslations` itself.
 */
const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  positive: 'bg-positive/10 text-positive-on-tint dark:bg-positive/18',
  warning: 'bg-warning/10 text-warning-on-tint dark:bg-warning/18',
  negative: 'bg-negative/10 text-negative-on-tint dark:bg-negative/18',
  brand: 'bg-brand/10 text-brand-on-tint dark:bg-brand/18',
  muted: 'bg-muted text-muted-foreground',
}

export function StatusBadge({
  label,
  tone = 'neutral',
  className,
}: {
  label: string
  tone?: StatusTone
  className?: string
}) {
  return (
    <span
      className={cn(
        // Wraps to a second line rather than truncating (spec §4): a Vietnamese
        // status word is longer than its English original and a clipped badge
        // is a badge that says the wrong thing.
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs/[1rem] font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {label}
    </span>
  )
}
