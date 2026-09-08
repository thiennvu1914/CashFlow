import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { cn } from 'cn'
import { buttonVariants } from '@/components/ui/button'
import { Button } from '@/components/ui/button'

/**
 * What a list, widget or filtered view shows instead of nothing (spec §10).
 *
 * Icon, title, one sentence, one action — and never more than one action: an
 * empty screen is where a user is least sure what to do, and two buttons is a
 * question rather than an answer.
 *
 * `size="widget"` is the dashboard's variant (it lives inside a
 * `ChartContainer`, which already draws the border), `size="page"` is a whole
 * list's variant.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'widget',
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; href: string } | { label: string; onClick: () => void }
  size?: 'widget' | 'page'
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        size === 'widget' ? 'min-h-24 py-4' : 'min-h-40 py-8',
      )}
    >
      <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="max-w-[36ch] text-[0.8125rem]/[1.125rem] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action &&
        ('href' in action ? (
          <Link href={action.href} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {action.label}
          </Link>
        ) : (
          <Button type="button" variant="outline" size="lg" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  )
}
