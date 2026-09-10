'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { createReminderSchema, type CreateReminderInput } from '@/lib/validation/reminder'
import { createReminderAction } from '@/lib/server/actions/reminder-actions'
import { REMINDER_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { type Locale, INTL_LOCALE } from '@/lib/i18n/locale'
import { recurrenceLabelKey, reminderTypeLabelKey } from '@/lib/ui/labels'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type ReminderFrequency = CreateReminderInput['frequency']
type ReminderTypeValue = CreateReminderInput['type']

/** Only what the selects render — the page passes `listCategories` /
 *  `listActiveFinancialAccounts` rows, and a full row would ship a category's
 *  `userId`/`status` and an account's `initialBalance` into the bundle. */
type Category = { id: string; name: string }
type Account = { id: string; name: string }

const DEFAULT_TYPE: ReminderTypeValue = 'EXPENSE'
const DEFAULT_FREQUENCY: ReminderFrequency = 'MONTHLY'
const DEFAULT_INTERVAL = 1

/**
 * The bounds `createReminderSchema` enforces, restated as the number input's
 * own `min`/`max` so the browser's stepper cannot produce a value the schema
 * then rejects. Not a second source of truth: the schema is still what refuses
 * a hand-typed 0, and the server re-parses.
 */
const MIN_INTERVAL = 1
const MAX_INTERVAL = 99

/**
 * The message key for the word after the interval, so "Mỗi 2" / "Every 2" is
 * never ambiguous. ONE_TIME has no entry the user can see — the field is not
 * rendered for it (see below) — and is present only so this map is total over
 * the enum.
 */
const INTERVAL_UNIT_KEYS: Record<ReminderFrequency, string> = {
  ONE_TIME: '',
  WEEKLY: 'reminders.intervalUnitWeeks',
  MONTHLY: 'reminders.intervalUnitMonths',
  YEARLY: 'reminders.intervalUnitYears',
}

/**
 * Which frequencies give `dayOfMonth` a meaning — a mirror of
 * `DAY_OF_MONTH_FREQUENCIES` in `lib/validation/reminder.ts`, and the *only*
 * reason it is duplicated here is that the schema's set is not exported. The
 * two must agree: this decides whether the field is rendered, and the schema
 * *rejects* a value on any other frequency.
 */
const DAY_OF_MONTH_FREQUENCIES = new Set<ReminderFrequency>(['MONTHLY', 'YEARLY'])

/**
 * The create form for a recurring reminder.
 *
 * Takes `today` — the user's own calendar day, from `todayCalendarDateInZone`
 * on the page — because the start date is pre-filled with it. Never
 * `new Date()` in the browser: the visitor's zone is not the profile's, so a
 * user in `Asia/Ho_Chi_Minh` reading the page on a UTC machine would be handed
 * yesterday, and the action turns this string into the instant of *local*
 * midnight on that day.
 *
 * `expectedAmount` is left without a default on purpose: react-hook-form
 * overwrites the DOM with a JavaScript default when one exists and *reads* the
 * DOM when it does not (`lib/ui/use-hydrated.ts` documents the mechanism), and
 * an amount pre-filled with `0` would be the one value `createReminderSchema`
 * always rejects — "a reminder for nothing is nothing to remind anyone of".
 *
 * Both anchors are conditional, and that is this form's own hazard rather than
 * a cosmetic nicety. `createReminderSchema` *rejects* an anchor the frequency
 * gives no meaning to instead of dropping it (ruling R6-18: `month` is
 * YEARLY-only and is refused on MONTHLY too), so a field left on screen — or a
 * value left in form state after the frequency changed — is a submission the
 * schema refuses under a field the user was invited to fill in. The frequency's
 * `onChange` therefore clears both anchors and resets the interval on EVERY
 * change, the same technique (and for the same reason) as
 * `transaction-form.tsx`'s category reset: react-hook-form keeps the values of
 * unmounted fields, so hiding the input is not clearing it.
 *
 * ## Phase 7: twelve visible labels, one month formatter
 *
 * Every field used to be labelled only via `aria-label` — invisible copy a
 * sighted user never saw at all. `FormField` gives each one a real `<label
 * for>`, and the twelfth ("Month") gets its options from
 * `new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', timeZone:
 * 'UTC' })` rather than the old hard-coded English `MONTH_LABELS` array — 2026
 * is an arbitrary anchor year for the formatter and is never displayed; only
 * the month name is.
 */
function defaultValues(today: string): Partial<CreateReminderInput> {
  return {
    title: '',
    type: DEFAULT_TYPE,
    currency: 'VND',
    categoryId: undefined,
    accountId: undefined,
    frequency: DEFAULT_FREQUENCY,
    interval: DEFAULT_INTERVAL,
    dayOfMonth: undefined,
    month: undefined,
    startDate: today,
    note: undefined,
  }
}

export function ReminderForm({
  today,
  locale,
  expenseCategories,
  incomeCategories,
  accounts,
  onCreated,
}: {
  today: string
  /** For the Month select's names — `Intl.DateTimeFormat`, not a hard-coded
   *  English array. */
  locale: Locale
  /** The user's ACTIVE expense and income categories, kept apart so the select
   *  can switch with the type without a round trip. */
  expenseCategories: Category[]
  incomeCategories: Category[]
  accounts: Account[]
  /** The create sheet closes itself on success. */
  onCreated?: () => void
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  /** Spec §9: the same fieldset is locked while a mutation is in flight. */
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `reminder-${name}-${uid}`
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<CreateReminderInput>({
    resolver: zodResolver(createReminderSchema),
    defaultValues: defaultValues(today),
  })

  const type = useWatch({ control, name: 'type' })
  const frequency = useWatch({ control, name: 'frequency' })
  const currency = useWatch({ control, name: 'currency' })
  const categories = type === 'INCOME' ? incomeCategories : expenseCategories
  const showInterval = frequency !== 'ONE_TIME'
  const showDayOfMonth = DAY_OF_MONTH_FREQUENCIES.has(frequency)
  const showMonth = frequency === 'YEARLY'

  /** The twelve month names, from the reader's own locale — never English
   *  regardless of which is showing. 2026 is an arbitrary leap-free anchor: no
   *  year is ever rendered, only the month. */
  const monthFormatter = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    month: 'long',
    timeZone: 'UTC',
  })
  const monthNames = Array.from({ length: 12 }, (_, index) =>
    monthFormatter.format(new Date(Date.UTC(2026, index, 1))),
  )

  async function onSubmit(values: CreateReminderInput) {
    await submit.run({
      tag: 'ReminderForm: create failed',
      action: () => createReminderAction(values),
      errorKeys: REMINDER_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        reset(defaultValues(today))
        router.refresh()
        onCreated?.()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as `LoanForm`'s;
          `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">{t('reminders.createTitle')}</legend>

        <FormField
          id={fieldId('title')}
          label={t('reminders.titleField')}
          helper={t('reminders.titlePlaceholder')}
          error={errors.title?.message}
        >
          {(aria) => <Input {...aria} {...register('title')} />}
        </FormField>

        <FormField id={fieldId('type')} label={t('reminders.type')} error={errors.type?.message}>
          {(aria) => (
            <div className="relative">
              {/* `defaultValue` (never `value` — that would make this
                  controlled). EXPENSE is already the first option, so
                  react-dom would land here anyway; it is passed so the server
                  HTML states the form's own default rather than relying on a
                  browser fallback. */}
              <select
                {...aria}
                {...register('type', {
                  // Runs after react-hook-form has stored the new type, so the
                  // category is cleared on EVERY type change — the same defect
                  // `transaction-form.tsx` documents: an EXPENSE category left
                  // in form state under an INCOME reminder is a submission the
                  // service refuses with `InvalidReminderCategoryError`, and
                  // the list below has already stopped showing it.
                  onChange: () => setValue('categoryId', undefined),
                })}
                defaultValue={DEFAULT_TYPE}
                className={SELECT_CLASS}
              >
                {/* "Bill", not "Expense": EXPENSE is the ledger's word for a
                    transaction that already happened, and nothing here has. */}
                <option value="EXPENSE">{t(reminderTypeLabelKey('EXPENSE'))}</option>
                <option value="INCOME">{t(reminderTypeLabelKey('INCOME'))}</option>
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
              />
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('expected-amount')}
          label={t('reminders.expectedAmount')}
          error={errors.expectedAmount?.message}
        >
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="pr-14"
                {...register('expectedAmount', { valueAsNumber: true })}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                {currency}
              </span>
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('currency')}
          label={t('reminders.currency')}
          error={errors.currency?.message}
        >
          {(aria) => (
            <div className="relative">
              {/* The reminder's own currency, and the one every figure on the
                  page is shown in — nothing here is converted to
                  `User.baseCurrency`, which is display-only (ledger ruling
                  R5-3). */}
              <select
                {...aria}
                {...register('currency')}
                defaultValue="VND"
                className={SELECT_CLASS}
              >
                <option value="VND">VND</option>
                <option value="USD">USD</option>
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
              />
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('frequency')}
          label={t('reminders.frequency')}
          error={errors.frequency?.message}
        >
          {(aria) => (
            <div className="relative">
              {/* The options are in the Prisma enum's own order, which puts
                  the default *third* — hence the explicit `defaultValue`. See
                  the module comment for the clearing this `onChange` does. */}
              <select
                {...aria}
                {...register('frequency', {
                  onChange: () => {
                    // Unconditional, so the result does not depend on which
                    // frequency the user came from: react-hook-form keeps the
                    // value of an unmounted field, so a `dayOfMonth` typed
                    // under MONTHLY would still be in form state after a
                    // switch to WEEKLY — and the schema rejects it there.
                    // Resetting the interval to 1 is what makes ONE_TIME
                    // (whose only legal interval is 1) submittable after
                    // "every 3 months".
                    setValue('dayOfMonth', undefined)
                    setValue('month', undefined)
                    setValue('interval', DEFAULT_INTERVAL)
                  },
                })}
                defaultValue={DEFAULT_FREQUENCY}
                className={SELECT_CLASS}
              >
                <option value="ONE_TIME">{t(recurrenceLabelKey('ONE_TIME', 1))}</option>
                <option value="WEEKLY">{t(recurrenceLabelKey('WEEKLY', 1))}</option>
                <option value="MONTHLY">{t(recurrenceLabelKey('MONTHLY', 1))}</option>
                <option value="YEARLY">{t(recurrenceLabelKey('YEARLY', 1))}</option>
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
              />
            </div>
          )}
        </FormField>

        {showInterval && (
          <FormField
            id={fieldId('interval')}
            label={t('reminders.interval')}
            error={errors.interval?.message}
          >
            {(aria) => (
              <div className="flex items-center gap-2">
                <Input
                  {...aria}
                  type="number"
                  step="1"
                  min={MIN_INTERVAL}
                  max={MAX_INTERVAL}
                  className="w-24"
                  {...register('interval', { valueAsNumber: true })}
                  // `register()` emits no default of its own, so without this
                  // the server HTML would ship an empty box while `useForm`
                  // held 1 — and a submit before hydration would send `NaN`.
                  defaultValue={DEFAULT_INTERVAL}
                />
                <span className="text-sm text-muted-foreground">
                  {t(INTERVAL_UNIT_KEYS[frequency])}
                </span>
              </div>
            )}
          </FormField>
        )}

        {showDayOfMonth && (
          <FormField
            id={fieldId('day-of-month')}
            label={t('reminders.dayOfMonth')}
            helper={t('reminders.dayOfMonthHelper')}
            error={errors.dayOfMonth?.message}
          >
            {(aria) => (
              <Input
                {...aria}
                type="number"
                step="1"
                min={1}
                max={31}
                {...register('dayOfMonth', {
                  // `setValueAs` rather than `valueAsNumber` (the two are
                  // mutually exclusive, and `valueAsNumber` wins): an untouched
                  // optional field's DOM value is `''`, which `valueAsNumber`
                  // would hand to Zod as `NaN` — a spurious error under a
                  // field the user is entitled to skip, and which the service
                  // defaults from the start date.
                  setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
                })}
              />
            )}
          </FormField>
        )}

        {showMonth && (
          <FormField
            id={fieldId('month')}
            label={t('reminders.month')}
            error={errors.month?.message}
          >
            {(aria) => (
              <div className="relative">
                {/* YEARLY only (ruling R6-18). A monthly reminder recurs in
                    every month, so it has no anchor month to name — and the
                    schema rejects one rather than dropping it. */}
                <select
                  {...aria}
                  {...register('month', {
                    setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
                  })}
                  defaultValue=""
                  className={SELECT_CLASS}
                >
                  <option value="">{t('reminders.monthPlaceholder')}</option>
                  {monthNames.map((label, index) => (
                    <option key={label} value={index + 1}>
                      {label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
                />
              </div>
            )}
          </FormField>
        )}

        <FormField
          id={fieldId('start-date')}
          label={t('reminders.startDate')}
          error={errors.startDate?.message}
        >
          {/* A calendar date as a string, never `valueAsDate`: the value that
              travels is `yyyy-MM-dd` and the instant of local midnight is
              built server-side, in the user's own zone (ruling R6-7).
              `valueAsDate` would hand over an instant the browser's zone had
              already coloured. */}
          {(aria) => (
            <Input {...aria} type="date" {...register('startDate')} defaultValue={today} />
          )}
        </FormField>

        <FormField
          id={fieldId('category')}
          label={t('reminders.categoryOptional')}
          error={errors.categoryId?.message}
        >
          {(aria) => (
            <div className="relative">
              {/* Filtered by the selected type: the service refuses a
                  category whose type does not match the reminder's, so
                  offering one would be a choice that can only fail. Optional —
                  a reminder is useful with no category at all ("Renew
                  passport fee"). */}
              <select
                {...aria}
                {...register('categoryId', {
                  // An untouched select's DOM value is `''` (the "None"
                  // option); `undefined` is what the schema and the service
                  // read as "no category", so an empty string never travels
                  // as an id.
                  setValueAs: (v: string) => (v === '' ? undefined : v),
                })}
                defaultValue=""
                className={SELECT_CLASS}
              >
                <option value="">{t('reminders.none')}</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
              />
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('account')}
          label={t('reminders.accountOptional')}
          error={errors.accountId?.message}
        >
          {(aria) => (
            <div className="relative">
              {/* Which account the user *expects* to pay from — a label, not a
                  link that debits anything. The page passes
                  `listActiveFinancialAccounts`, so this component filters
                  nothing itself. */}
              <select
                {...aria}
                {...register('accountId', {
                  setValueAs: (v: string) => (v === '' ? undefined : v),
                })}
                defaultValue=""
                className={SELECT_CLASS}
              >
                <option value="">{t('reminders.none')}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
              />
            </div>
          )}
        </FormField>

        <FormField id={fieldId('note')} label={t('reminders.note')} error={errors.note?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('note', {
                // `''` means "no note", so it is normalised to `undefined` here
                // and the service stores `null` — otherwise an untouched field
                // would write an empty string that reads back as a value.
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <Button type="submit" className="self-start">
          {submit.pending ? t('reminders.createPending') : t('reminders.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
