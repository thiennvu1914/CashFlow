import { cn } from 'cn'

/**
 * A grey bar in the shape of the content that is coming (spec §10: "grey bars
 * in the real layout, no spinners"). `animate-pulse` is the one animation this
 * design system keeps, and the `prefers-reduced-motion` rule in
 * `app/globals.css` neutralises it for users who asked for stillness.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} />
}
