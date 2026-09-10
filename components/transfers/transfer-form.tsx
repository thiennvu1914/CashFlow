'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ArrowRight, ChevronDown } from 'lucide-react'
import type { Currency } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { createTransferFormSchema, type CreateTransferFormInput } from '@/lib/validation/transfer'
import { createTransferAction } from '@/lib/server/actions/transfer-actions'
import { TRANSFER_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatReadableRate } from '@/lib/ui/format-money'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { nowInZone } from '@/lib/datetime/local-date-time'
import { FieldError, FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Same convention as `TransactionForm`: the form validates and submits
 * `createTransferFormSchema`, whose `date` stays the raw `yyyy-MM-ddTHH:mm`
 * string the `<input type="datetime-local">` produced. `createTransferAction`
 * converts that wall-clock moment to an instant in the session user's IANA
 * zone; see `lib/datetime/local-date-time.ts`.
 */
type FormInput = CreateTransferFormInput

/**
 * `AccountOption` (transactions) is deliberately NOT reused here — this form
 * never shows a balance, so its own narrower type is the honest one.
 */
type Account = { id: string; name: string; currency: Currency }

/**
 * A transfer defaults to moving money *between* two accounts, so the "to"
 * account is the second one — which is exactly why it needs its own
 * `defaultValue` on the `<select>` below: unlike every other selector here it
 * is not the first option, so without it the server HTML shows account #1
 * while the form state already says account #2. Shared with the JSX so the two
 * can never drift apart.
 */
function defaultToAccountId(accounts: Account[]): string {
  return accounts[1]?.id ?? accounts[0]?.id ?? ''
}

/**
 * The shared chrome for BOTH amount inputs — same height and size whether the
 * field is the sole "Amount" (same-currency) or one half of an "Amount
 * sent"/"Amount received" pair (cross-currency): a visual mismatch between
 * the two legs of one transfer used to read as an error, not a design choice
 * (Task 5b fix round 1, finding 4 — "Amount received" was a plain, smaller
 * `Input` with no spinner suppression while "Amount sent" was the dominant
 * size). The three `appearance`-suppressing classes remove `type="number"`'s
 * native spin buttons, which Chrome renders by default — the ASYMMETRY
 * actually flagged was one field showing a spinner and the other not;
 * suppressing it on both is simpler and safer than moving either field off
 * `type="number"` (which `valueAsNumber` and the schema both still validate
 * against).
 */
const AMOUNT_INPUT_CLASS =
  'h-14 pr-16 text-[1.75rem]/[2.125rem] font-semibold tabular-nums md:h-14 md:text-[1.75rem] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'

function defaultValues(accounts: Account[], timezone: string): FormInput {
  return {
    fromAccountId: accounts[0]?.id ?? '',
    toAccountId: defaultToAccountId(accounts),
    fromAmount: 0,
    toAmount: 0,
    date: nowInZone(timezone),
    note: undefined,
  }
}

export function TransferForm({
  accounts,
  timezone,
  locale,
}: {
  accounts: Account[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page) — the pre-filled date and time must be *their* now, not
   * whatever the clock happens to read in UTC at the moment they open the
   * form.
   */
  timezone: string
  locale: Locale
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  /** Spec §9: the same fieldset is locked while a mutation is in flight. */
  const submit = useActionSubmit(t)
  /** A per-instance prefix, same reasoning as `TransactionForm`'s `fieldId`. */
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `transfer-${name}-${uid}`
  const {
    register,
    control,
    handleSubmit,
    reset,
    resetField,
    setValue,
    formState: { errors },
  } = useForm<FormInput>({
    resolver: zodResolver(createTransferFormSchema),
    defaultValues: defaultValues(accounts, timezone),
  })

  const fromAccountId = useWatch({ control, name: 'fromAccountId' })
  const toAccountId = useWatch({ control, name: 'toAccountId' })
  const fromAmount = useWatch({ control, name: 'fromAmount' })
  const toAmount = useWatch({ control, name: 'toAmount' })
  const fromAccount = accounts.find((a) => a.id === fromAccountId)
  const toAccount = accounts.find((a) => a.id === toAccountId)
  const sameCurrency = Boolean(fromAccount) && fromAccount?.currency === toAccount?.currency

  // A same-currency transfer conserves money by construction — the server
  // derives `toAmount` from `fromAmount` regardless of what arrives. The
  // field stays part of the validated shape even while its input is hidden,
  // so it is kept in sync here rather than left at its stale default.
  //
  // The reverse transition (currencies used to match and now don't) is
  // handled in the same effect via a ref rather than another state variable:
  // resetting `toAmount` back to its own default means the revealed "Amount
  // received" field starts over instead of pre-filled with the sent amount —
  // which would otherwise read as an accidental same-numbers cross-currency
  // transfer the user never entered.
  const wasSameCurrencyRef = useRef(sameCurrency)
  useEffect(() => {
    if (sameCurrency) {
      setValue('toAmount', fromAmount)
    } else if (wasSameCurrencyRef.current) {
      resetField('toAmount')
    }
    wasSameCurrencyRef.current = sameCurrency
  }, [sameCurrency, fromAmount, setValue, resetField])

  /**
   * A preview only — the rate implied by what the user has typed into BOTH
   * legs so far, formatted by the SAME `formatReadableRate` helper
   * `TransferList` uses on the persisted `exchangeRateUsed`, so the two can
   * never quote the same pair in different directions. `toAmount / fromAmount`
   * is handed over as destination-per-source — the exact shape the server
   * will eventually persist as `exchangeRateUsed` (see `lib/server/services/
   * transfer.ts`) — never a rate this component derives its own way; the
   * helper does the USD-per-1 normalisation once, in one place. Nothing here
   * is submitted or read back into the payload: the server derives the real,
   * FX-policy-sourced rate independently, and this figure exists only so the
   * person can sanity-check the two numbers they just typed before they hit
   * submit.
   */
  const rateLine =
    !sameCurrency && fromAccount && toAccount && fromAmount > 0 && toAmount > 0
      ? formatReadableRate(fromAccount.currency, toAccount.currency, toAmount / fromAmount, locale)
      : null

  async function onSubmit(values: FormInput) {
    // Belt and suspenders with the effect above: the client never trusts a
    // same-currency `toAmount` it might have raced past submitting — the
    // server re-derives it anyway, but this keeps the two paths agreeing.
    const payload = sameCurrency ? { ...values, toAmount: values.fromAmount } : values
    await submit.run({
      tag: 'TransferForm: create failed',
      action: () => createTransferAction(payload),
      errorKeys: TRANSFER_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        reset(defaultValues(accounts, timezone))
        router.refresh()
      },
    })
  }

  /**
   * With fewer than two accounts there is no valid TO leg — the page already
   * replaces this whole component with an `EmptyState` (spec §6.3: "a form
   * with two identical selects" is exactly the defect being fixed), so this
   * is defence in depth, not the primary guard: exactly `TransactionForm`'s
   * zero-account guard, and for the same reason.
   *
   * Placed after every hook above, deliberately: an early return before them
   * would call a different number of hooks depending on the prop.
   */
  if (accounts.length < 2) return null

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as
          `TransactionForm`'s; `lib/ui/use-hydrated.ts` documents the defect.
          A live pre-fix probe reverted this form's "Amount sent" 5/5 times and
          both account selectors 5/5 times when they were driven to a
          non-default value before hydration finished. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">{t('transfers.createTitle')}</legend>

        {/* FROM → TO, side by side at ≥ 640 with a horizontal arrow between
            them; stacked with the arrow rotated 90° below that (spec §6.3) —
            a `grid` with no `grid-cols` set at the base breakpoint puts every
            child on its own row already, so the mobile stack needs no
            override of its own. */}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <FormField
            id={fieldId('from')}
            label={t('transfers.from')}
            error={errors.fromAccountId?.message}
          >
            {(aria) => (
              <div className="relative">
                {/* No `defaultValue`: `fromAccountId` defaults to `accounts[0]`,
                    already the first option the browser selects on its own. */}
                <select {...aria} className={SELECT_CLASS} {...register('fromAccountId')}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            )}
          </FormField>

          <ArrowRight
            aria-hidden
            className="mb-3 size-4 rotate-90 text-muted-foreground sm:rotate-0"
          />

          <FormField
            id={fieldId('to')}
            label={t('transfers.to')}
            error={errors.toAccountId?.message}
          >
            {(aria) => (
              <div className="relative">
                {/* `defaultValue` (never `value` — that would make this
                    controlled) so the server renders `selected` on the second
                    account, the one the form state already holds. See
                    `defaultToAccountId`. */}
                <select
                  {...aria}
                  defaultValue={defaultToAccountId(accounts)}
                  className={SELECT_CLASS}
                  {...register('toAccountId')}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            )}
          </FormField>
        </div>

        {/* Same-currency: one primary amount — the server derives the
            destination leg, so asking for it again would be redundant data
            entry the service ignores anyway. Cross-currency: both legs, each
            labelled by direction, plus the rate a person would read. */}
        <div className={sameCurrency ? undefined : 'grid gap-3 sm:grid-cols-2'}>
          <FormField
            id={fieldId('fromAmount')}
            label={t(sameCurrency ? 'transfers.amount' : 'transfers.amountSent')}
            error={errors.fromAmount?.message}
          >
            {(aria) => (
              <div className="relative">
                <Input
                  {...aria}
                  type="number"
                  step="0.01"
                  className={AMOUNT_INPUT_CLASS}
                  {...register('fromAmount', { valueAsNumber: true })}
                />
                {/* Read-only: currency always follows the selected account, so
                    the client never sends it — display only. */}
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-muted-foreground">
                  {fromAccount?.currency ?? ''}
                </span>
              </div>
            )}
          </FormField>

          {!sameCurrency && (
            <FormField id={fieldId('toAmount')} label={t('transfers.amountReceived')}>
              {(aria) => (
                <div className="relative">
                  <Input
                    {...aria}
                    type="number"
                    step="0.01"
                    className={AMOUNT_INPUT_CLASS}
                    {...register('toAmount', { valueAsNumber: true })}
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-muted-foreground">
                    {toAccount?.currency ?? ''}
                  </span>
                </div>
              )}
            </FormField>
          )}
        </div>

        {rateLine && <p className="text-xs/[1rem] text-muted-foreground">{rateLine}</p>}

        {/* Rendered regardless of `sameCurrency` so a validation error on this
            field is never silently hidden by the field itself being hidden —
            when the field IS shown, its own `FormField` carries no `error`
            prop, so this is the only place the message ever renders. */}
        {errors.toAmount && (
          <FieldError id={fieldId('toAmount-error')}>{errors.toAmount.message}</FieldError>
        )}

        <FormField
          id={fieldId('date')}
          label={t('transfers.dateTime')}
          error={errors.date?.message}
        >
          {(aria) => <Input {...aria} type="datetime-local" {...register('date')} />}
        </FormField>

        <FormField id={fieldId('note')} label={t('transfers.note')} error={errors.note?.message}>
          {(aria) => <Input {...aria} {...register('note')} />}
        </FormField>

        <Button type="submit" className="self-start">
          {submit.pending ? t('transfers.createPending') : t('transfers.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
