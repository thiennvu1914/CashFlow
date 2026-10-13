'use client'

import { useId, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import type { Currency } from '@prisma/client'
import { compareCalendarDates } from '@/lib/datetime/calendar-date'
import {
  linkToAccountFormSchemaAsOf,
  type LinkToAccountFormValues,
} from '@/lib/validation/link-to-account'
import {
  defaultLinkAccountId,
  defaultLinkDate,
  type DebtAccountOption,
} from '@/lib/ui/debt-accounts'
import { useActionSubmit, type ActionResult } from '@/lib/ui/use-action-submit'
import { DebtAccountField } from '@/components/debts/debt-account-field'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Which agreement the dialog records. Its copy lives under that namespace,
 * with the same `link*` keys (and `account`) in `debts` and in `loans`.
 */
export type LinkNamespace = 'debts' | 'loans'

const ID_PREFIX: Record<LinkNamespace, string> = { debts: 'debt-link', loans: 'loan-link' }

/**
 * The agreement's own error messages, with ARCHIVED_ACCOUNT replaced by the
 * dialog's own copy. The usual one points at "Không ghi vào tài khoản / Don't
 * record in an account", which this dialog does not offer; here the account
 * can only have been archived after the page loaded, so the user is told to
 * reload and pick an active one.
 */
export function linkFormErrorKeys<E extends string>(
  namespace: LinkNamespace,
  errorKeys: Record<E, string>,
): Record<E, string> {
  return { ...errorKeys, ARCHIVED_ACCOUNT: `${namespace}.linkArchivedAccount` }
}

/**
 * "Record in an account" (spec 2026-10-12 §2 Q3, §6.4), for a debt or a loan
 * recorded without an account — it predates the app, or "don't record" was
 * chosen. On submit the server writes its opening (debt) or disbursement (loan)
 * now, and, when the box is ticked, the transactions of every payment that has
 * none yet, each on its own date. This is how an account's balance is
 * reconciled with agreements that moved money before linking existed.
 * `DebtLinkForm` and `LoanLinkForm` bind it to their agreement; the dialog
 * itself is the same for both.
 *
 * - **Account**: only active accounts in the agreement's currency, and no
 *   "don't record" option — recording is the whole point. It starts on the
 *   most recently used account, else the first listed. With no account in the
 *   currency there is nothing to choose, so the dialog says so instead of
 *   offering an empty picker.
 * - **Date** (Ruling P7): the agreement's own date (the day a debt was added,
 *   a loan's start date) or the oldest payment still to record, whichever is
 *   earlier, so the opening never lands after its own repayments — and never
 *   later than `today` (Ruling P12: money recorded in an account cannot have
 *   moved in the future), which the form also refuses.
 * - **"Ghi bù N lần trả đã có / Also record the N existing payments"**: on by
 *   default, counting only the payments with no transaction yet (one already
 *   recorded in an account is skipped by the service), and not shown when
 *   there are none. A native checkbox, like the native `<select>` beside it:
 *   uncontrolled, it gets its server-rendered `checked` from `defaultChecked`.
 *   The whole label is the hit area, at least 44 px tall below the icon rail.
 *
 * On success the dialog closes and the page re-renders with the agreement
 * linked, so the menu item is gone and the balances on every page have moved.
 */
export function LinkToAccountForm<E extends string>({
  namespace,
  currency,
  agreementDate,
  today,
  payments,
  accounts,
  mostRecentAccountId,
  errorKeys,
  submit,
  onDone,
}: {
  namespace: LinkNamespace
  currency: Currency
  /** `yyyy-MM-dd`: the day a debt was added, or a loan's start date. */
  agreementDate: string
  /** The user's own calendar day, from the page (`todayCalendarDateInZone` in
   *  the profile zone) — never a browser clock. */
  today: string
  /** The agreement's payments; `accountId` null means not recorded yet. */
  payments: ReadonlyArray<{ date: string; accountId: string | null }>
  /** Every active account; the dialog keeps the ones in `currency`. */
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  errorKeys: Record<E, string>
  /** The agreement's action, with the date renamed to its own field. */
  submit: (values: LinkToAccountFormValues) => Promise<ActionResult<E>>
  onDone: () => void
}) {
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const runSubmit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `${ID_PREFIX[namespace]}-${name}-${uid}`
  const options = accounts.filter((account) => account.currency === currency)
  const initialAccountId = defaultLinkAccountId(options, mostRecentAccountId)
  const linkDate = defaultLinkDate(agreementDate, payments)
  // A loan that starts later can only be recorded once its money has arrived,
  // so the default never proposes a day the form would refuse.
  const initialDate = compareCalendarDates(linkDate, today) > 0 ? today : linkDate
  const schema = useMemo(() => linkToAccountFormSchemaAsOf(today), [today])
  const unlinkedPayments = payments.filter((payment) => payment.accountId === null).length
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LinkToAccountFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      accountId: initialAccountId,
      date: initialDate,
      // With nothing to record the box is not rendered, and this is what is sent.
      includePayments: unlinkedPayments > 0,
    },
  })

  async function onSubmit(values: LinkToAccountFormValues) {
    await runSubmit.run({
      tag: `LinkToAccountForm (${namespace}): link failed`,
      action: () => submit(values),
      errorKeys: linkFormErrorKeys(namespace, errorKeys),
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        onDone()
      },
    })
  }

  if (options.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t(`${namespace}.linkNoAccounts`, { currency })}
        </p>
        <div className="flex justify-end pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    )
  }

  const paymentsId = fieldId('payments')
  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset
        disabled={runSubmit.locked}
        aria-busy={runSubmit.busy}
        className="flex flex-col gap-3"
      >
        <legend className="sr-only">{t(`${namespace}.linkAction`)}</legend>

        <DebtAccountField
          id={fieldId('account')}
          label={t(`${namespace}.account`)}
          accounts={options}
          defaultAccountId={initialAccountId}
          registration={register('accountId')}
          error={errors.accountId?.message}
          allowNone={false}
        />

        <FormField
          id={fieldId('date')}
          label={t(`${namespace}.linkDate`)}
          error={errors.date?.message}
        >
          {/* `defaultValue` as well as the form default, so the server-rendered
              input already shows the day rather than filling in on mount. */}
          {(aria) => (
            <Input {...aria} type="date" defaultValue={initialDate} {...register('date')} />
          )}
        </FormField>

        {unlinkedPayments > 0 && (
          <div className="flex flex-col gap-1">
            <label
              htmlFor={paymentsId}
              className="flex min-h-11 items-center gap-2 text-sm text-foreground md:min-h-9"
            >
              <input
                id={paymentsId}
                type="checkbox"
                defaultChecked
                aria-describedby={`${paymentsId}-helper`}
                className="size-4 shrink-0 accent-brand"
                {...register('includePayments')}
              />
              {t(`${namespace}.linkIncludePayments`, { count: unlinkedPayments })}
            </label>
            <p id={`${paymentsId}-helper`} className="text-xs/[1rem] text-muted-foreground">
              {t(`${namespace}.linkIncludePaymentsHelper`)}
            </p>
          </div>
        )}

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit">
            {runSubmit.pending ? t(`${namespace}.linkPending`) : t(`${namespace}.linkSubmit`)}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
