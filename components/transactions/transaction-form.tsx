'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { Wallet } from 'lucide-react'
import type { Currency, TransactionType } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { nowInZone } from '@/lib/datetime/local-date-time'
import { createTransactionAction } from '@/lib/server/actions/transaction-actions'
import { TRANSACTION_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatMoney } from '@/lib/ui/format-money'
import { transactionTypeLabelKey } from '@/lib/ui/labels'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import {
  createTransactionFormSchema,
  type CreateTransactionFormInput,
  type CreateTransactionInput,
} from '@/lib/validation/transaction'
import { EmptyState } from '@/components/common/empty-state'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccountSelect } from './account-select'
import { CategorySelect } from './category-select'
import { TransactionTypeField } from './transaction-type-field'

/**
 * The form validates and submits `createTransactionFormSchema`, whose `date` is
 * the raw `yyyy-MM-ddTHH:mm` string the `<input type="datetime-local">`
 * produced — input and output types are the same here, so no `Date` ever exists
 * client-side.
 *
 * That is deliberate: a local date and time only becomes an instant once a
 * timezone is chosen, and the browser's zone is not necessarily the user's
 * configured zone. `createTransactionAction` does the conversion in the session
 * user's IANA zone; see `lib/datetime/local-date-time.ts`.
 *
 * The form's own shape: `createTransactionFormSchema`'s fields, but with `date`
 * split into the two native inputs spec §6.2 asks for.
 *
 * `date` itself is never a form field — it is derived at validation and at
 * submit by `mergeDateTime`, so the schema still sees exactly the
 * `yyyy-MM-ddTHH:mm` string it validates today and `lib/validation` does not
 * change.
 */
type FormInput = Omit<CreateTransactionFormInput, 'date'> & {
  /** `yyyy-MM-dd` from `<input type="date">`. */
  datePart: string
  /** `HH:mm` from `<input type="time">`. */
  timePart: string
}
type FormType = CreateTransactionInput['type']

/** The one string the schema and the action take, from the two the user sees. */
function mergeDateTime(values: FormInput): CreateTransactionFormInput {
  const { datePart, timePart, ...rest } = values
  return { ...rest, date: `${datePart}T${timePart}` }
}

/**
 * `zodResolver` over the MERGED values, with a `date` error re-pointed at the
 * field the user can actually see.
 *
 * The schema owns `date`; no control does. So a schema error keyed `date`
 * would land on nothing and the user would be told nothing — hence the remap.
 * But WHICH visible field the message belongs under is not always `datePart`:
 * an emptied Giờ merges into an unparseable string (`"2026-09-08T"`) exactly
 * as readily as a bad Ngày does, and the schema's single `date` error cannot
 * tell the two apart on its own. `values.timePart` empty is the tell — a
 * native `<input type="time">` emits `''` only when cleared, never a
 * malformed value — so an empty Giờ is what it is, and anything else lands on
 * Ngày (the field an out-of-range calendar date, e.g. 30 February, actually
 * comes from).
 *
 * Typed with react-hook-form 7.87's three-generic `Resolver<TFieldValues,
 * TContext, TTransformedValues>` (pre-flight A-6): the form's own fields
 * (`FormInput`) are the input, and the merged shape (`CreateTransactionFormInput`,
 * with `date` instead of `datePart`/`timePart`) is what `handleSubmit` hands
 * `onSubmit` on success — so `onSubmit` receives exactly what was validated,
 * with no second `mergeDateTime` call that could drift from it. That is what
 * lets every line below be exactly typed, with zero `as never`.
 */
const resolver: Resolver<FormInput, unknown, CreateTransactionFormInput> = async (
  values,
  context,
  options,
) => {
  const merged = mergeDateTime(values)
  // `zodResolver`'s returned function wants `ResolverOptions` shaped for the
  // MERGED schema, whose only field-shaped member is `names` (`fields` and
  // `shouldUseNativeValidation` are the same regardless of TFieldValues).
  // `names` is the form's own currently-registered field names — `datePart`/
  // `timePart`, never `date` — and `toNestErrors` only ever reads it to decide
  // whether a nested error belongs to a field ARRAY; this form has none, so
  // it is correctly left out rather than forwarded under the wrong shape.
  const result = await zodResolver(createTransactionFormSchema)(merged, context, {
    criteriaMode: options.criteriaMode,
    fields: options.fields,
    shouldUseNativeValidation: options.shouldUseNativeValidation,
  })

  // `result.errors` is keyed by the MERGED schema's fields (`date`, not
  // `datePart`/`timePart`), so the `date` entry is pulled out here and
  // re-attached under whichever visible field it belongs to below; `rest`
  // (the other, identically-named fields) needs no remapping.
  const { date: dateError, ...rest } = result.errors
  const errors: FieldErrors<FormInput> = dateError
    ? { ...rest, [values.timePart ? 'datePart' : 'timePart']: dateError }
    : rest

  // `zodResolver` returns `values: {}` on failure, never `undefined` or a
  // falsy `values` — the merged object is spread INTO the result either way,
  // so `result.values` alone can never distinguish success from failure (an
  // empty object is still truthy). Whether `errors` has any key is the real
  // signal, and it is what RHF itself checks.
  const succeeded = Object.keys(errors).length === 0
  return succeeded ? { values: merged, errors: {} } : { values: {}, errors }
}

export type AccountOption = { id: string; name: string; currency: Currency; balance: string }
export type CategoryOption = { id: string; name: string; type: 'INCOME' | 'EXPENSE' }

/**
 * The two types that hit the P&L and therefore need a matching category
 * (mirrors `CATEGORY_REQUIRED_TYPES` in `lib/validation/transaction.ts`).
 *
 * This decides only whether the Category picker is RENDERED. Clearing the
 * chosen category is deliberately not conditioned on it: the type's own change
 * handler clears on every change, so INCOME→EXPENSE — both category-requiring,
 * so this set never changes across it — cannot leave an INCOME category
 * attached to an EXPENSE transaction.
 */
const CATEGORY_REQUIRED_TYPES = new Set<FormType>(['INCOME', 'EXPENSE'])

const DEFAULT_TYPE: FormType = 'EXPENSE'

function defaultValues(accounts: AccountOption[], timezone: string): FormInput {
  // `nowInZone` returns exactly `yyyy-MM-ddTHH:mm`, so the split is the 'T' —
  // no second clock read, and therefore no chance of the date and the time
  // coming from two different instants either side of midnight.
  const [datePart, timePart] = nowInZone(timezone).split('T')
  return {
    accountId: accounts[0]?.id ?? '',
    categoryId: undefined,
    type: DEFAULT_TYPE,
    datePart,
    timePart,
    amount: 0,
    note: undefined,
  }
}

export function TransactionForm({
  accounts,
  categories,
  timezone,
  locale,
  onCreated,
}: {
  accounts: AccountOption[]
  categories: CategoryOption[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page) — the pre-filled date and time must be *their* now, not
   * whatever the clock reads in UTC when they open the form.
   */
  timezone: string
  locale: Locale
  /** The sheet closes itself on success; the sticky panel passes nothing. */
  onCreated?: () => void
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /**
   * A per-instance prefix (spec §14 fix round 1, finding 2): the sticky panel
   * and the mobile sheet can each mount their own `TransactionForm`, and a
   * hard-coded `id="transaction-account"` on both would make `<label for>`
   * bind to WHICHEVER instance's control happens to match first — an
   * unlabelled control on whichever path it does not bind to. Colons stripped
   * only for a tidier id string; both `:`-bearing and bare forms are valid
   * HTML ids.
   */
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `transaction-${name}-${uid}`
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  /** Spec §9: the same fieldset is locked while a mutation is in flight. */
  const submit = useActionSubmit(t)
  // Computed ONCE, at mount — not on every render — and reused for
  // `useForm`'s init, the account stand-in's option and the date/time
  // inputs' `defaultValue`s below. `datePart`/`timePart` are passed to
  // native `<input>`s as `defaultValue` (below), which Base UI's `Input`
  // treats as an UNCONTROLLED field's one-time initial value; recomputing
  // `defaultValues(...)` — i.e. calling `nowInZone(timezone)`, `new Date()`
  // — fresh on every render would occasionally change the MINUTE between
  // one render and the next, and Base UI logs "a component is changing the
  // default value state of an uncontrolled FieldControl after being
  // initialized" the moment it does. The lazy `useState` initializer is what
  // keeps it the one instant the form actually started from.
  const [initial] = useState(() => defaultValues(accounts, timezone))
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<FormInput, unknown, CreateTransactionFormInput>({
    resolver,
    defaultValues: initial,
  })

  const type = useWatch({ control, name: 'type' })
  const accountId = useWatch({ control, name: 'accountId' })
  const needsCategory = CATEGORY_REQUIRED_TYPES.has(type)
  const selectedAccount = accounts.find((account) => account.id === accountId)

  /**
   * The form's own default, which the pre-hydration `<select>` stand-in renders
   * as its single option. Read from `initial` rather than written as
   * `accounts[0]?.id` a second time, so the stand-in and the form state cannot
   * disagree the first time that default changes.
   */
  const defaultAccountId = initial.accountId

  /** "Cash · 5.000.000 VND" — one place, used by the Select and its stand-in. */
  function accountOptionLabel(account: AccountOption | undefined): string {
    if (!account) return ''
    return t('transactions.accountOption', {
      name: account.name,
      balance: formatMoney(account.balance, account.currency, locale),
      currency: account.currency,
    })
  }

  const typeLabels = Object.fromEntries(
    (
      [
        'INCOME',
        'EXPENSE',
        'CASH_IN',
        'CASH_OUT',
        'ADJUSTMENT_INCREASE',
        'ADJUSTMENT_DECREASE',
      ] as const
    ).map((value) => [value, t(transactionTypeLabelKey(value))]),
  ) as Record<TransactionType, string>

  /** Two groups, so the picker shows hierarchy rather than one flat list. */
  const categoryGroups = [
    {
      labelKey: 'transactions.categoryGroupExpense',
      label: t('transactions.categoryGroupExpense'),
      items: categories.filter((category) => category.type === 'EXPENSE'),
    },
    {
      labelKey: 'transactions.categoryGroupIncome',
      label: t('transactions.categoryGroupIncome'),
      items: categories.filter((category) => category.type === 'INCOME'),
    },
    // Only the group matching the chosen type is offered — the schema refuses
    // the other one anyway, and offering it would be a trap.
  ].filter((group) =>
    type === 'EXPENSE'
      ? group.labelKey === 'transactions.categoryGroupExpense'
      : group.labelKey === 'transactions.categoryGroupIncome',
  )

  async function onSubmit(values: CreateTransactionFormInput) {
    await submit.run({
      tag: 'TransactionForm: create failed',
      // `values` is the RESOLVER's transformed output (the three-generic
      // `Resolver`'s `TTransformedValues`), already merged — not the raw form
      // fields — so this is the exact object the resolver validated, with no
      // second `mergeDateTime` call that could drift from it.
      action: () => createTransactionAction(values),
      errorKeys: TRANSACTION_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        reset(defaultValues(accounts, timezone))
        router.refresh()
        onCreated?.()
      },
    })
  }

  /**
   * With no account there is nothing to add a transaction TO, so the form is
   * replaced rather than shown half-usable: an Account picker with no options
   * looks operable, and submitting it only produced a validation error under a
   * field the user could never fill.
   *
   * This lives in the component, not only in the page, on purpose. Any caller
   * that hands over an empty `accounts` list must get a usable screen — the
   * page cannot be the only place that knows this, or the next caller
   * reintroduces the empty selector. The page's job stays what it already is:
   * passing `listActiveFinancialAccounts`, so an archived account never counts
   * as one the user could pick.
   *
   * Placed after every hook above, deliberately: an early return before them
   * would call a different number of hooks depending on the prop.
   */
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        size="page"
        title={t('transactions.noAccountTitle')}
        description={t('transactions.noAccountBody')}
        action={{ label: t('transactions.noAccountAction'), href: '/accounts' }}
      />
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* TWO independent reasons to disable, on one native mechanism:
          `!hydrated` is the pre-hydration gate (`lib/ui/use-hydrated.ts`
          documents the react-hook-form/React interaction that made early input
          vanish, and why the gate can never lift before RHF's refs attach), and
          `submit.locked` is the in-flight lock spec §9 requires. A
          `<fieldset disabled>` is the one native mechanism that disables
          EVERYTHING inside it, submit button included, so a second submit is
          impossible while the first is running — with no per-control `disabled`
          prop and no controlled state. `min-w-0` neutralises a fieldset's
          default `min-inline-size: min-content`; Tailwind's preflight already
          zeroes its margin/padding/border, so nothing shifts when the gate
          lifts. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        // Busy for either reason the fieldset is disabled: the pre-hydration
        // gate (so the raw SSR response itself carries `aria-busy="true"`,
        // which `e2e/transaction-form-hydration.spec.ts` asserts on the
        // unauthenticated response body) and the in-flight submit lock.
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">{t('transactions.createTitle')}</legend>

        {/* `Controller`, not `register`, because `TransactionTypeField` is a
            button group with no form value of its own. The `onChange` clears
            the category on EVERY type change — INCOME→EXPENSE included, which
            a `needsCategory`-watching effect missed, leaving an INCOME category
            in form state under an EXPENSE transaction until the server rejected
            it. `undefined` (not `''`) is what lets the schema's friendly refine
            message fire. */}
        <Controller
          control={control}
          name="type"
          render={({ field }) => (
            <TransactionTypeField
              value={field.value}
              onChange={(next) => {
                field.onChange(next)
                setValue('categoryId', undefined)
              }}
              labels={typeLabels}
              legend={t('transactions.typeLegend')}
              otherLabel={t('transactions.typeOther')}
            />
          )}
        />
        {errors.type && (
          <p role="alert" className="text-xs/[1rem] text-negative">
            {errors.type.message}
          </p>
        )}

        {/* Amount FIRST after the type and dominant (spec §6.2: "Amount
            dominant (28/600 tabular input with the account's currency code
            inside the field)"). The code is a suffix inside the field, not a
            separate span, so the figure and its unit read as one value. */}
        <FormField
          id={fieldId('amount')}
          label={t('transactions.amount')}
          error={errors.amount?.message}
        >
          {(aria) => (
            <div className="relative">
              <Input
                {...aria}
                type="number"
                step="0.01"
                className="h-14 pr-16 text-[1.75rem]/[2.125rem] font-semibold tabular-nums md:h-14 md:text-[1.75rem]"
                {...register('amount', { valueAsNumber: true })}
              />
              {/* Read-only: currency always follows the selected account, so
                  the client never sends it — display only. */}
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-muted-foreground">
                {selectedAccount?.currency ?? ''}
              </span>
            </div>
          )}
        </FormField>

        <FormField
          id={fieldId('account')}
          label={t('transactions.account')}
          error={errors.accountId?.message}
        >
          {(aria) =>
            hydrated ? (
              <Controller
                control={control}
                name="accountId"
                render={({ field }) => (
                  <AccountSelect
                    id={aria.id}
                    accounts={accounts}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={t('transactions.accountPlaceholder')}
                    optionLabel={(account) => accountOptionLabel(account as AccountOption)}
                    aria-describedby={aria['aria-describedby']}
                    aria-invalid={aria['aria-invalid']}
                  />
                )}
              />
            ) : (
              // The pre-hydration stand-in: a DISABLED native `<select>` holding
              // the one option the form state actually has.
              //
              // A `<div>` was tried and is wrong three ways: a `<label
              // htmlFor>` may not point at one (so the field would be
              // unlabelled in the first paint, which is exactly what this phase
              // is fixing), it does not inherit the `<fieldset disabled>`
              // styling the rest of the form has, and it is a different shape
              // from every other control on the page. A disabled `<select>` is
              // labelable, is styled by `SELECT_CLASS` like its neighbours,
              // announces its value, and cannot be operated — which is the
              // whole point of the gate.
              //
              // Its option comes from the FORM's default (`defaultAccountId`),
              // not from `accounts[0]`: the two agree today, and hard-coding
              // the first account is how they would silently disagree the first
              // time a default changes.
              <select
                id={aria.id}
                disabled
                defaultValue={defaultAccountId}
                className={SELECT_CLASS}
              >
                <option value={defaultAccountId}>
                  {accountOptionLabel(
                    accounts.find((account) => account.id === defaultAccountId) ?? accounts[0],
                  )}
                </option>
              </select>
            )
          }
        </FormField>

        {needsCategory && (
          <FormField
            id={fieldId('category')}
            label={t('transactions.category')}
            error={errors.categoryId?.message}
          >
            {(aria) =>
              hydrated ? (
                <Controller
                  control={control}
                  name="categoryId"
                  render={({ field }) => (
                    <CategorySelect
                      id={aria.id}
                      groups={categoryGroups}
                      value={field.value}
                      // An emptied picker yields `undefined`, not `''`, which
                      // is what lets the schema's friendly "Category is
                      // required for income and expense transactions" refine
                      // message fire instead of the generic "at least 1
                      // character" a stray `''` would trigger.
                      onChange={(next) => field.onChange(next === '' ? undefined : next)}
                      placeholder={t('transactions.categoryPlaceholder')}
                      aria-describedby={aria['aria-describedby']}
                      aria-invalid={aria['aria-invalid']}
                    />
                  )}
                />
              ) : (
                // Same stand-in, same reasoning as the account field above. The
                // category has no default (`categoryId` starts `undefined`), so
                // the single option is the placeholder — and `value=""` keeps
                // it consistent with the hydrated Select's own placeholder
                // value.
                <select id={aria.id} disabled defaultValue="" className={SELECT_CLASS}>
                  <option value="">{t('transactions.categoryPlaceholder')}</option>
                </select>
              )
            }
          </FormField>
        )}

        {/* Two native inputs, not one `datetime-local` (spec §6.2: "Date and
            Time (native inputs, separate, defaulting to now in the user's
            timezone)").

            Separate because they are separate decisions: a user back-dating
            yesterday's lunch changes the day and leaves the time alone, and a
            single `datetime-local` makes them tab through the clock to do it.
            Its browser chrome is still not restyled and its visual format is
            still not claimed — only the two LABELS are localised.

            The pair recombines into the one `yyyy-MM-ddTHH:mm` string
            `createTransactionFormSchema` validates; see `mergeDateTime` and the
            resolver wrapper above. */}
        <div className="grid grid-cols-2 gap-3">
          <FormField
            id={fieldId('date')}
            label={t('transactions.date')}
            error={errors.datePart?.message}
          >
            {(aria) => (
              // `defaultValue`, not just `register()`: same reason the Type
              // `<select>` used to need one (`lib/ui/use-hydrated.ts`) —
              // `register()` emits no `value`/`defaultValue` of its own, so
              // without this the server renders an EMPTY date input while form
              // state (and `useSubmitState`'s submit payload) already holds
              // today's date.
              <Input
                {...aria}
                type="date"
                defaultValue={initial.datePart}
                {...register('datePart')}
              />
            )}
          </FormField>
          <FormField
            id={fieldId('time')}
            label={t('transactions.time')}
            error={errors.timePart?.message}
          >
            {(aria) => (
              <Input
                {...aria}
                type="time"
                defaultValue={initial.timePart}
                {...register('timePart')}
              />
            )}
          </FormField>
        </div>

        <FormField
          id={fieldId('note')}
          label={t('transactions.note')}
          helper={t('transactions.noteHelper')}
          error={errors.note?.message}
        >
          {(aria) => <Input {...aria} {...register('note')} />}
        </FormField>

        {/* One primary per view region, never full width at ≥ 768 (spec §2). */}
        <Button type="submit" className="self-start">
          {submit.pending ? t('transactions.createPending') : t('transactions.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
