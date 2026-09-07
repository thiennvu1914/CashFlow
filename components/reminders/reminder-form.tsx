'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createReminderSchema, type CreateReminderInput } from '@/lib/validation/reminder'
import { createReminderAction } from '@/lib/server/actions/reminder-actions'
import { GENERIC_ERROR_MESSAGE, REMINDER_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
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
 * The word after the interval, so "Every 2" is never ambiguous. ONE_TIME has no
 * entry the user can see — the field is not rendered for it (see below) — and
 * is present only so this map is total over the enum.
 */
const INTERVAL_UNITS: Record<ReminderFrequency, string> = {
  ONE_TIME: '',
  WEEKLY: 'weeks',
  MONTHLY: 'months',
  YEARLY: 'years',
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
 * Fixed English copy (Phase 7 replaces these literals with i18n keys). The
 * value posted is the human 1–12 the column stores, not JavaScript's 0–11 —
 * an off-by-one here would move every yearly reminder back a month.
 */
const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

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
  expenseCategories,
  incomeCategories,
  accounts,
}: {
  today: string
  /** The user's ACTIVE expense and income categories, kept apart so the select
   *  can switch with the type without a round trip. */
  expenseCategories: Category[]
  incomeCategories: Category[]
  accounts: Account[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateReminderInput>({
    resolver: zodResolver(createReminderSchema),
    defaultValues: defaultValues(today),
  })

  const type = useWatch({ control, name: 'type' })
  const frequency = useWatch({ control, name: 'frequency' })
  const categories = type === 'INCOME' ? incomeCategories : expenseCategories
  const showInterval = frequency !== 'ONE_TIME'
  const showDayOfMonth = DAY_OF_MONTH_FREQUENCIES.has(frequency)
  const showMonth = frequency === 'YEARLY'

  async function onSubmit(values: CreateReminderInput) {
    setError(null)
    try {
      const result = await createReminderAction(values)
      if (!result.ok) {
        setError(REMINDER_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues(today))
      router.refresh()
    } catch {
      console.error('ReminderForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as `LoanForm`'s;
          `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">New reminder</legend>
        <div>
          <Input
            aria-label="Title"
            placeholder="What (e.g. Internet bill)"
            {...register('title')}
          />
          {errors.title && <p className="text-sm text-negative">{errors.title.message}</p>}
        </div>
        <div>
          {/* `defaultValue` (never `value` — that would make this controlled).
              EXPENSE is already the first option, so react-dom would land here
              anyway; it is passed so the server HTML states the form's own
              default rather than relying on a browser fallback. */}
          <select
            {...register('type', {
              // Runs after react-hook-form has stored the new type, so the
              // category is cleared on EVERY type change — the same defect
              // `transaction-form.tsx` documents: an EXPENSE category left in
              // form state under an INCOME reminder is a submission the service
              // refuses with `InvalidReminderCategoryError`, and the list below
              // has already stopped showing it.
              onChange: () => setValue('categoryId', undefined),
            })}
            defaultValue={DEFAULT_TYPE}
            aria-label="Type"
            className="rounded-md border p-2"
          >
            {/* "Bill", not "Expense": EXPENSE is the ledger's word for a
                transaction that already happened, and nothing here has. */}
            <option value="EXPENSE">Bill (expense)</option>
            <option value="INCOME">Income</option>
          </select>
          {errors.type && <p className="text-sm text-negative">{errors.type.message}</p>}
        </div>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Input
              type="number"
              step="0.01"
              aria-label="Expected amount"
              placeholder="What you expect to pay or receive"
              {...register('expectedAmount', { valueAsNumber: true })}
            />
            {errors.expectedAmount && (
              <p className="text-sm text-negative">{errors.expectedAmount.message}</p>
            )}
          </div>
          <div>
            {/* The reminder's own currency, and the one every figure on the page
                is shown in — nothing here is converted to `User.baseCurrency`,
                which is display-only (ledger ruling R5-3). */}
            <select
              {...register('currency')}
              defaultValue="VND"
              aria-label="Reminder currency"
              className="rounded-md border p-2"
            >
              <option value="VND">VND</option>
              <option value="USD">USD</option>
            </select>
            {errors.currency && <p className="text-sm text-negative">{errors.currency.message}</p>}
          </div>
        </div>
        <div>
          {/* The options are in the Prisma enum's own order, which puts the
              default *third* — hence the explicit `defaultValue`. See the
              module comment for the clearing this `onChange` does. */}
          <select
            {...register('frequency', {
              onChange: () => {
                // Unconditional, so the result does not depend on which
                // frequency the user came from: react-hook-form keeps the value
                // of an unmounted field, so a `dayOfMonth` typed under MONTHLY
                // would still be in form state after a switch to WEEKLY — and
                // the schema rejects it there. Resetting the interval to 1 is
                // what makes ONE_TIME (whose only legal interval is 1)
                // submittable after "every 3 months".
                setValue('dayOfMonth', undefined)
                setValue('month', undefined)
                setValue('interval', DEFAULT_INTERVAL)
              },
            })}
            defaultValue={DEFAULT_FREQUENCY}
            aria-label="Frequency"
            className="rounded-md border p-2"
          >
            <option value="ONE_TIME">Once</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Yearly</option>
          </select>
          {errors.frequency && <p className="text-sm text-negative">{errors.frequency.message}</p>}
        </div>
        {showInterval && (
          <div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="1"
                min={MIN_INTERVAL}
                max={MAX_INTERVAL}
                aria-label="Every"
                className="w-24"
                {...register('interval', { valueAsNumber: true })}
                // `register()` emits no default of its own, so without this the
                // server HTML would ship an empty box while `useForm` held 1 —
                // and a submit before hydration would send `NaN`.
                defaultValue={DEFAULT_INTERVAL}
              />
              <span className="text-sm text-muted-foreground">{INTERVAL_UNITS[frequency]}</span>
            </div>
            {errors.interval && <p className="text-sm text-negative">{errors.interval.message}</p>}
          </div>
        )}
        {showDayOfMonth && (
          <div>
            <Input
              type="number"
              step="1"
              min={1}
              max={31}
              aria-label="Day of month"
              placeholder="Day of the month (defaults to the start date's)"
              {...register('dayOfMonth', {
                // `setValueAs` rather than `valueAsNumber` (the two are
                // mutually exclusive, and `valueAsNumber` wins): an untouched
                // optional field's DOM value is `''`, which `valueAsNumber`
                // would hand to Zod as `NaN` — "Enter the day of the month"
                // under a field the user is entitled to skip, and which the
                // service defaults from the start date.
                setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
              })}
            />
            {errors.dayOfMonth && (
              <p className="text-sm text-negative">{errors.dayOfMonth.message}</p>
            )}
          </div>
        )}
        {showMonth && (
          <div>
            {/* YEARLY only (ruling R6-18). A monthly reminder recurs in every
                month, so it has no anchor month to name — and the schema
                rejects one rather than dropping it. */}
            <select
              {...register('month', {
                setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
              })}
              defaultValue=""
              aria-label="Month"
              className="rounded-md border p-2"
            >
              <option value="">Month of the start date</option>
              {MONTH_LABELS.map((label, index) => (
                <option key={label} value={index + 1}>
                  {label}
                </option>
              ))}
            </select>
            {errors.month && <p className="text-sm text-negative">{errors.month.message}</p>}
          </div>
        )}
        <div>
          {/* A calendar date as a string, never `valueAsDate`: the value that
              travels is `yyyy-MM-dd` and the instant of local midnight is built
              server-side, in the user's own zone (ruling R6-7). `valueAsDate`
              would hand over an instant the browser's zone had already
              coloured. */}
          <Input
            type="date"
            aria-label="Start date"
            {...register('startDate')}
            defaultValue={today}
          />
          {errors.startDate && <p className="text-sm text-negative">{errors.startDate.message}</p>}
        </div>
        <div>
          {/* Filtered by the selected type: the service refuses a category
              whose type does not match the reminder's, so offering one would be
              a choice that can only fail. Optional — a reminder is useful with
              no category at all ("Renew passport fee"). */}
          <select
            {...register('categoryId', {
              // An untouched select's DOM value is `''` (the "None" option);
              // `undefined` is what the schema and the service read as "no
              // category", so an empty string never travels as an id.
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
            defaultValue=""
            aria-label="Category"
            className="rounded-md border p-2"
          >
            <option value="">None</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          {errors.categoryId && (
            <p className="text-sm text-negative">{errors.categoryId.message}</p>
          )}
        </div>
        <div>
          {/* Which account the user *expects* to pay from — a label, not a link
              that debits anything. The page passes
              `listActiveFinancialAccounts`, so this component filters nothing
              itself. */}
          <select
            {...register('accountId', {
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
            defaultValue=""
            aria-label="Account"
            className="rounded-md border p-2"
          >
            <option value="">None</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          {errors.accountId && <p className="text-sm text-negative">{errors.accountId.message}</p>}
        </div>
        <div>
          {/* There is no `Textarea` in `components/ui/`, and adding one for a
              single optional line would be a component with one caller. */}
          <Input
            aria-label="Note"
            placeholder="Note (optional)"
            {...register('note', {
              // `''` means "no note", so it is normalised to `undefined` here
              // and the service stores `null` — otherwise an untouched field
              // would write an empty string that reads back as a value.
              setValueAs: (v: string) => (v === '' ? undefined : v),
            })}
          />
          {errors.note && <p className="text-sm text-negative">{errors.note.message}</p>}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          Add reminder
        </Button>
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </fieldset>
    </form>
  )
}
