'use client'

import { useId, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { createDebtSchemaAsOf, type CreateDebtInput } from '@/lib/validation/debt'
import type { Currency } from '@prisma/client'
import { createDebtAction } from '@/lib/server/actions/debt-actions'
import { DEBT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import { debtDirectionLabelKey } from '@/lib/ui/labels'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { DebtAccountField } from '@/components/debts/debt-account-field'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The create form for a debt.
 *
 * A debt belongs to no month and no category, so the only page state it needs
 * is the account list for the picker below (and the user's `today`).
 *
 * `direction` and `currency` get a `defaultValue`; `person` a default at all.
 * The money field is left without one on purpose: react-hook-form overwrites
 * the DOM with a JavaScript default when one exists and *reads* the DOM when it
 * does not (`lib/ui/use-hydrated.ts` documents the mechanism and the line
 * numbers), and an original amount pre-filled with `0` would be the one value
 * `createDebtSchema` always rejects.
 *
 * Direction and currency are asked here and never again: `updateDebtSchema`
 * does not contain them, because they define *which* debt a row is and
 * changing one after payments exist would re-interpret that history against
 * terms the debt never had. The wording of the two direction options
 * (`debtDirectionLabelKey`, `labels.debtDirection.*`) is therefore the only
 * place the user states it — and it is now the SAME wording the row itself
 * reads (a deliberate copy change: the pre-Phase-7 form read "Someone owes
 * me"/"I owe someone" while the row read "Owes you"/"You owe" — two sentences
 * for one fact).
 */
function defaultValues(
  baseCurrency: Currency,
  defaultAccountId: string | null,
  today: string,
): Partial<CreateDebtInput> {
  return {
    direction: 'RECEIVABLE',
    person: '',
    currency: baseCurrency,
    // `undefined`, not `''`, for "don't record": it is what `setValueAs` below
    // turns the picker's empty option into.
    accountId: defaultAccountId ?? undefined,
    movedOn: today,
  }
}

/**
 * Money-source linking (spec 2026-10-12 §2 Q2, §6.2): the form asks which
 * account the money moved through. The picker starts on the user's most
 * recently used account (`defaultAccountId`, null when there is none) and its
 * first option, "don't record in an account", is for an agreement that
 * predates the app. Choosing an account makes the date the money moved
 * (`movedOn`, defaulting to the user's `today`) meaningful and fixes the
 * currency to the account's; choosing none hides the date and offers the
 * VND/USD choice, defaulting to `baseCurrency`. The server takes the currency
 * from the account either way — the read-only field only shows it.
 */
export function DebtForm({
  accounts,
  defaultAccountId,
  baseCurrency,
  today,
  onCreated,
}: {
  accounts: ReadonlyArray<DebtAccountOption>
  defaultAccountId: string | null
  baseCurrency: Currency
  /** The user's own calendar day, from the page — never the browser's. */
  today: string
  onCreated?: () => void
}) {
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `debt-${name}-${uid}`
  // Built for the page's `today` in the profile zone, never a browser clock:
  // money recorded in an account cannot have moved later (Ruling P12).
  const schema = useMemo(() => createDebtSchemaAsOf(today), [today])
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<CreateDebtInput>({
    resolver: zodResolver(schema),
    defaultValues: defaultValues(baseCurrency, defaultAccountId, today),
  })
  const accountId = useWatch({ control, name: 'accountId' })
  const account = accounts.find((option) => option.id === accountId)

  async function onSubmit(values: CreateDebtInput) {
    // The two fields the picker makes meaningless are dropped rather than
    // sent: a stale `movedOn` from a hidden input, or a currency the server
    // would ignore in favour of the account's.
    const input: CreateDebtInput = account
      ? { ...values, currency: account.currency }
      : { ...values, accountId: undefined, movedOn: undefined }
    await submit.run({
      tag: 'DebtForm: create failed',
      action: () => createDebtAction(input),
      errorKeys: DEBT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        reset(defaultValues(baseCurrency, defaultAccountId, today))
        onCreated?.()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as `GoalForm`'s;
          `lib/ui/use-hydrated.ts` documents the defect. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">{t('debts.createTitle')}</legend>

        <FormField
          id={fieldId('direction')}
          label={t('debts.direction')}
          error={errors.direction?.message}
        >
          {(aria) => (
            // `defaultValue` (never `value` — that would make this
            // controlled). RECEIVABLE is already the first option, so
            // react-dom would land here anyway; it is passed so the server
            // HTML states the form's own default rather than relying on a
            // browser fallback, and so this select cannot silently disagree
            // with `useForm`'s default the way `/transactions`' Type select
            // once did.
            <select
              {...aria}
              {...register('direction')}
              defaultValue="RECEIVABLE"
              className={SELECT_CLASS}
            >
              <option value="RECEIVABLE">{t(debtDirectionLabelKey('RECEIVABLE'))}</option>
              <option value="PAYABLE">{t(debtDirectionLabelKey('PAYABLE'))}</option>
            </select>
          )}
        </FormField>

        <FormField
          id={fieldId('person')}
          label={t('debts.person')}
          helper={t('debts.personPlaceholder')}
          error={errors.person?.message}
        >
          {(aria) => <Input {...aria} {...register('person')} />}
        </FormField>

        <FormField
          id={fieldId('original-amount')}
          label={t('debts.originalAmount')}
          error={errors.originalAmount?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              {...register('originalAmount', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <DebtAccountField
          id={fieldId('account')}
          accounts={accounts}
          defaultAccountId={defaultAccountId ?? ''}
          registration={register('accountId', {
            setValueAs: (v: string) => (v === '' ? undefined : v),
          })}
          error={errors.accountId?.message}
          helper={t('debts.accountHelper')}
        />

        {account && (
          <FormField
            id={fieldId('moved-on')}
            label={t('debts.movedOn')}
            error={errors.movedOn?.message}
          >
            {/* `defaultValue` too, so the server HTML already shows today —
                RHF only writes its default into the DOM once hydrated. */}
            {(aria) => (
              <Input {...aria} type="date" defaultValue={today} {...register('movedOn')} />
            )}
          </FormField>
        )}

        {account ? (
          <FormField
            id={fieldId('currency')}
            label={t('debts.currency')}
            helper={t('debts.currencyFromAccount')}
          >
            {(aria) => <Input {...aria} readOnly value={account.currency} />}
          </FormField>
        ) : (
          <FormField
            id={fieldId('currency')}
            label={t('debts.currency')}
            error={errors.currency?.message}
          >
            {(aria) => (
              <select
                {...aria}
                {...register('currency')}
                defaultValue={baseCurrency}
                className={SELECT_CLASS}
              >
                <option value="VND">VND</option>
                <option value="USD">USD</option>
              </select>
            )}
          </FormField>
        )}

        <FormField
          id={fieldId('due-date')}
          label={t('debts.dueDate')}
          error={errors.dueDate?.message}
        >
          {/* A calendar date as a string, never `valueAsDate`: the value that
              travels is `yyyy-MM-dd` and the carrier is built server-side by
              `calendarDateToUtcCarrier` (ruling R6-7). `valueAsDate` would hand
              over an instant the browser's zone had already coloured. */}
          {(aria) => <Input {...aria} type="date" {...register('dueDate')} />}
        </FormField>

        <FormField
          id={fieldId('description')}
          label={t('debts.descriptionField')}
          error={errors.description?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              {...register('description', {
                // `''` means "no description", so it is normalised to
                // `undefined` here and the service stores `null` — otherwise an
                // untouched field would write an empty string that reads back
                // as a value.
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <FormField id={fieldId('notes')} label={t('debts.notes')} error={errors.notes?.message}>
          {(aria) => (
            <Input
              {...aria}
              {...register('notes', {
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          )}
        </FormField>

        <Button type="submit" className="self-start">
          {submit.pending ? t('debts.createPending') : t('debts.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
