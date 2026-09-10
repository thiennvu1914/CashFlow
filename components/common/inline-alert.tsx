import { cn } from 'cn'

/**
 * A page- or form-level message (spec §10). Tone `negative` gets
 * `role="alert"`, so a failure that appears after a submit is announced
 * without the user having to go looking for it, and `positive` gets
 * `role="status"` — the polite counterpart, for the success message that
 * replaces a form after it submits ("Đã gửi liên kết đặt lại"), which was
 * previously announced to nobody (Task 16, owner item G4). `warning` and
 * `neutral` stay silent regions: both are rendered with the page rather than
 * in response to a submit, so they are read in document order like any other
 * paragraph and a live region would only make them interrupt twice.
 *
 * The tinted tones' text is `text-<tone>-on-tint`, not the tone itself — see
 * `components/common/status-badge.tsx` and `app/globals.css`'s ON-TINT table
 * (Task 16, F6). The border keeps `border-<tone>/30`: it is a boundary, not
 * text, and 1.4.11's 3:1 does not apply to a decorative edge around text that
 * already carries the meaning.
 */
const TONE_CLASSES = {
  negative: 'border-negative/30 bg-negative/10 text-negative-on-tint dark:bg-negative/18',
  positive: 'border-positive/30 bg-positive/10 text-positive-on-tint dark:bg-positive/18',
  warning: 'border-warning/30 bg-warning/10 text-warning-on-tint dark:bg-warning/18',
  neutral: 'border-border bg-muted text-foreground',
} as const

export function InlineAlert({
  tone,
  children,
  className,
  id,
}: {
  tone: keyof typeof TONE_CLASSES
  children: React.ReactNode
  className?: string
  /** Optional, so a caller with a field this alert explains (Reports'
   *  invalid-range message, say) can point at it with `aria-describedby`. */
  id?: string
}) {
  return (
    <p
      id={id}
      role={tone === 'negative' ? 'alert' : tone === 'positive' ? 'status' : undefined}
      className={cn(
        'rounded-md border px-3 py-2 text-[0.8125rem]/[1.125rem]',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </p>
  )
}
