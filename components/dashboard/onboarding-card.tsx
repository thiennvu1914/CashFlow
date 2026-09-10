import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Check } from 'lucide-react'
import { cn } from 'cn'
import { buttonVariants } from '@/components/ui/button'

/**
 * What `/dashboard` shows a user who has nothing to show yet (owner item H1).
 *
 * Ten widgets each saying "chưa có…" is a screen that answers a question the
 * user has not asked yet. Three steps in one card answer the one they have:
 * what do I do first. The card replaces the widget grid only — the header and
 * the summary panel stay, because a KPI of zero is a true figure rather than
 * an empty widget, and a user who has just entered an opening balance should
 * still see it.
 *
 * No illustration, no emoji, no progress bar: one card, three rows, and one
 * primary button on the first step that is still open (spec §2 — one primary
 * per view region). Step 1 is the only step with a completion state, because
 * it is the only one that can be complete while this card is on screen: the
 * card renders only when there are no transactions, so step 2 is by
 * definition open, and step 3 is offered only once nothing else is (see
 * `app/(app)/dashboard/page.tsx`'s `showOnboarding`).
 *
 * A server component: it renders three links and no state, so there is
 * nothing here for the client bundle to carry.
 */
export async function OnboardingCard({
  /** Whether the user has at least one active account — step 1's completion. */
  hasAccount,
}: {
  hasAccount: boolean
}) {
  const t = await getTranslations()

  /** The first step still open takes the primary button; the rest are outline. */
  const primaryStep = hasAccount ? 2 : 1

  return (
    <section
      aria-labelledby="onboarding-title"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 md:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="onboarding-title" className="text-[1.125rem]/[1.625rem] font-semibold">
          {t('dashboard.onboardingTitle')}
        </h2>
        <p className="text-sm/[1.25rem] text-muted-foreground">{t('dashboard.onboardingBody')}</p>
      </div>

      {/* An ordered list, because the steps are ordered — a screen reader
          announces "1 of 3" from the markup rather than from the numerals. */}
      <ol className="flex flex-col divide-y divide-border">
        <Step
          index={1}
          done={hasAccount}
          doneLabel={t('dashboard.onboardingDone')}
          title={t('dashboard.onboardingStep1Title')}
          body={t('dashboard.onboardingStep1Body')}
          actions={
            hasAccount
              ? []
              : [
                  {
                    href: '/accounts',
                    label: t('dashboard.onboardingStep1Action'),
                    primary: primaryStep === 1,
                  },
                ]
          }
        />
        <Step
          index={2}
          done={false}
          title={t('dashboard.onboardingStep2Title')}
          body={t('dashboard.onboardingStep2Body')}
          actions={[
            {
              // `#new` is the inline/sticky create panel on `/transactions`
              // (`components/transactions/transaction-create-panel.tsx`), which
              // scrolls itself into view and focuses its first field — the same
              // target the rail's "Thêm giao dịch" action uses.
              href: '/transactions#new',
              label: t('dashboard.onboardingStep2Action'),
              primary: primaryStep === 2,
            },
          ]}
        />
        <Step
          index={3}
          done={false}
          optionalLabel={t('dashboard.onboardingOptional')}
          title={t('dashboard.onboardingStep3Title')}
          body={t('dashboard.onboardingStep3Body')}
          actions={[
            { href: '/budgets', label: t('dashboard.onboardingStep3ActionBudget') },
            { href: '/reminders', label: t('dashboard.onboardingStep3ActionReminder') },
          ]}
        />
      </ol>
    </section>
  )
}

/**
 * One row of the card: a marker, the copy, and the action(s) for that step.
 *
 * Stacked below `sm` and inline from there up, so a 375 px phone never has a
 * button competing with a sentence for the same 40 px of width — and no button
 * is `w-full` at any width (spec §2).
 */
function Step({
  index,
  done,
  doneLabel,
  optionalLabel,
  title,
  body,
  actions,
}: {
  index: number
  done: boolean
  doneLabel?: string
  optionalLabel?: string
  title: string
  body: string
  actions: { href: string; label: string; primary?: boolean }[]
}) {
  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {/* The marker is decoration: the number is already in the list's own
            semantics, and "Đã xong" below carries the completion in text. */}
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs/[1rem] font-medium tabular-nums',
            done
              ? // The audited tinted pair (Task 16, F6): the tone's own
                // ON-TINT text token over its 10 % fill, never the raw tone.
                'bg-positive/10 text-positive-on-tint dark:bg-positive/18'
              : 'border border-border text-muted-foreground',
          )}
        >
          {done ? <Check className="size-4" /> : index}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm/[1.25rem] font-medium">
            {title}
            {optionalLabel && (
              <span className="font-normal text-muted-foreground"> {optionalLabel}</span>
            )}
          </p>
          <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">{body}</p>
        </div>
      </div>
      {done ? (
        <p className="text-[0.8125rem]/[1.125rem] text-positive-on-tint sm:shrink-0">{doneLabel}</p>
      ) : (
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          {actions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className={buttonVariants({ variant: action.primary ? 'default' : 'outline' })}
            >
              {action.label}
            </Link>
          ))}
        </div>
      )}
    </li>
  )
}
