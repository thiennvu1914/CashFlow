import { cn } from 'cn'

/**
 * A page- or form-level message (spec §10). Tone `negative` also gets
 * `role="alert"`, so a failure that appears after a submit is announced
 * without the user having to go looking for it; the other tones are
 * informational and are not interruptions.
 */
const TONE_CLASSES = {
  negative: 'border-negative/30 bg-negative/10 text-negative dark:bg-negative/18',
  positive: 'border-positive/30 bg-positive/10 text-positive dark:bg-positive/18',
  warning: 'border-warning/30 bg-warning/10 text-warning dark:bg-warning/18',
  neutral: 'border-border bg-muted text-foreground',
} as const

export function InlineAlert({
  tone,
  children,
  className,
}: {
  tone: keyof typeof TONE_CLASSES
  children: React.ReactNode
  className?: string
}) {
  return (
    <p
      role={tone === 'negative' ? 'alert' : undefined}
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
