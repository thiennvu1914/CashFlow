import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

const buttonVariants = cva(
  // `border-transparent` used to live HERE, unconditionally, meant to be
  // overridden by `outline`'s own `border-border`. It wasn't: Tailwind's
  // compiled stylesheet orders its generated `.border-*` colour rules by its
  // own internal rule (not by where the class sits in this string or in the
  // JSX `class` attribute), so `.border-transparent` was landing AFTER
  // `.border-border` in the actual CSS — verified with a computed style of
  // `border-color: rgba(0,0,0,0)` on a rendered `variant="outline"` button.
  // Two conflicting border-colour classes on one element is inherently at the
  // mercy of that ordering, so the fix is to never emit two: the base carries
  // no border-colour utility at all (only `border`, which is width/style),
  // and every variant below states its own — `border-transparent` where a
  // border is not meant to show, `border-border` on `outline`.
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'border-transparent hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
        link: 'border-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        // Spec §2: primary 40 px, compact 36 px, icon 36×36. `default` is 40
        // because that is what a page's one primary action is; `sm` is the row
        // action. The old 32 px `default` was below every touch guideline.
        default: 'h-10 gap-2 px-4',
        sm: 'h-9 gap-1.5 px-3 text-[0.8125rem]',
        lg: 'h-10 gap-2 px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
