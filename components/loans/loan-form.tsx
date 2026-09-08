'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createLoanSchema, type CreateLoanInput } from '@/lib/validation/loan'
import { createLoanAction } from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The create form for a loan.
 *
 * Takes `today` — the user's own calendar day, from `todayCalendarDateInZone`
 * on the page — because the next due date is pre-filled with it. Never
 * `new Date()` in the browser: the visitor's zone is not the profile's, so a
 * user in `Asia/Ho_Chi_Minh` reading the page on a UTC machine would be handed
 * yesterday.
 *
 * Every term is asked here and most are asked *only* here: `updateLoanSchema`
 * contains just the lender, the scheduled payment and the notes, because the
 * principal, currency, rate, start date, term, frequency and first due date
 * define which loan a row is and what its terms are — changing one after
 * instalments exist would re-interpret that history against terms the loan
 * never had, or rewrite a schedule the recorded payments already advanced.
 *
 * Both selects carry a `defaultValue`, and the frequency one is why this form
 * has a test of its own: MONTHLY is the *second* option, so without the
 * explicit marker the server HTML would select WEEKLY (a `<select>`'s browser
 * fallback) while `useForm` held MONTHLY, and a submission before hydration
 * would file a monthly loan as weekly. `lib/ui/use-hydrated.ts` documents the
 * mechanism, the line numbers and the defect it was found as.
 *
 * The four numeric fields are left without a default on purpose:
 * react-hook-form overwrites the DOM with a JavaScript default when one exists
 * and *reads* the DOM when it does not (same file), and a principal or
 * scheduled payment pre-filled with `0` would be the one value
 * `createLoanSchema` always rejects. A rate of 0 is legitimate — the
 * interest-free loan from family — but pre-filling it would state a term the
 * user never gave.
 */
function defaultValues(today: string): Partial<CreateLoanInput> {
  return { lender: '', currency: 'VND', paymentFrequency: 'MONTHLY', nextDueDate: today }
}

export function LoanForm({ today }: { today: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateLoanInput>({
    resolver: zodResolver(createLoanSchema),
    defaultValues: defaultValues(today),
  })

  async function onSubmit(values: CreateLoanInput) {
    setError(null)
    try {
      const result = await createLoanAction(values)
      if (!result.ok) {
        setError(LOAN_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues(today))
      router.refresh()
    } catch {
      console.error('LoanForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as `DebtForm`'s;
          `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">New loan</legend>
        <div>
          <Input aria-label="Lender" placeholder="Who (e.g. Vietcombank)" {...register('lender')} />
          {errors.lender && <p className="text-sm text-negative">{errors.lender.message}</p>}
        </div>
        <div>
          <Input
            type="number"
            step="0.01"
            aria-label="Principal"
            placeholder="Amount borrowed"
            {...register('principal', { valueAsNumber: true })}
          />
          {errors.principal && <p className="text-sm text-negative">{errors.principal.message}</p>}
        </div>
        <div>
          {/* `defaultValue` (never `value` — that would make this controlled).
              VND is already the first option, so react-dom would land here
              anyway; it is passed so the server HTML states the form's own
              default rather than relying on a browser fallback. */}
          <select
            {...register('currency')}
            defaultValue="VND"
            aria-label="Loan currency"
            className="rounded-md border p-2"
          >
            <option value="VND">VND</option>
            <option value="USD">USD</option>
          </select>
          {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
        </div>
        <div>
          {/* `step="0.001"`, matching `Decimal(6, 3)` and the schema's
              three-decimal refine, so the browser's own stepper cannot produce
              a value the schema then rejects. */}
          <Input
            type="number"
            step="0.001"
            aria-label="Interest rate (%)"
            placeholder="Percent per year (e.g. 8.5)"
            {...register('interestRate', { valueAsNumber: true })}
          />
          {errors.interestRate && (
            <p className="text-sm text-negative">{errors.interestRate.message}</p>
          )}
        </div>
        <div>
          {/* A calendar date as a string, never `valueAsDate`: the value that
              travels is `yyyy-MM-dd` and the carrier is built server-side by
              `calendarDateToUtcCarrier` (ruling R6-7). `valueAsDate` would hand
              over an instant the browser's zone had already coloured. */}
          <Input type="date" aria-label="Start date" {...register('startDate')} />
          {errors.startDate && <p className="text-sm text-negative">{errors.startDate.message}</p>}
        </div>
        <div>
          <Input
            type="number"
            step="1"
            aria-label="Term (months)"
            placeholder="Term in months (e.g. 60)"
            {...register('termMonths', { valueAsNumber: true })}
          />
          {errors.termMonths && (
            <p className="text-sm text-negative">{errors.termMonths.message}</p>
          )}
        </div>
        <div>
          {/* The options are in the Prisma enum's own order, which puts the
              default *second* — hence the explicit `defaultValue`. See the
              module comment. */}
          <select
            {...register('paymentFrequency')}
            defaultValue="MONTHLY"
            aria-label="Payment frequency"
            className="rounded-md border p-2"
          >
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Yearly</option>
          </select>
          {errors.paymentFrequency && (
            <p className="text-sm text-negative">{errors.paymentFrequency.message}</p>
          )}
        </div>
        <div>
          <Input
            type="number"
            step="0.01"
            aria-label="Scheduled payment"
            placeholder="Instalment amount"
            {...register('scheduledPaymentAmount', { valueAsNumber: true })}
          />
          {errors.scheduledPaymentAmount && (
            <p className="text-sm text-negative">{errors.scheduledPaymentAmount.message}</p>
          )}
        </div>
        <div>
          {/* Pre-filled with the user's own today, and the source of the
              schedule's anchor: the service reads this date's day of the month
              into `dueDayOfMonth` and advances from that anchor after every
              payment, so a loan due on the 31st goes Jan 31 → Feb 28 → Mar 31
              rather than drifting (ruling R6-6a). */}
          <Input
            type="date"
            aria-label="Next due date"
            {...register('nextDueDate')}
            defaultValue={today}
          />
          {errors.nextDueDate && (
            <p className="text-sm text-negative">{errors.nextDueDate.message}</p>
          )}
        </div>
        <div>
          <Input
            aria-label="Notes"
            placeholder="Notes (optional)"
            {...register('notes', {
              // `''` means "no notes", so it is normalised to `undefined` here
              // and the service stores `null` — otherwise an untouched field
              // would write an empty string that reads back as a value.
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
          />
          {errors.notes && <p className="text-sm text-negative">{errors.notes.message}</p>}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          Add loan
        </Button>
        {error && <p className="text-sm text-negative">{error}</p>}
      </fieldset>
    </form>
  )
}
