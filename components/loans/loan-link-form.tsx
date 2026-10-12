'use client'

import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { linkLoanToAccountSchema, type LinkLoanToAccountInput } from '@/lib/validation/loan'
import { linkLoanToAccountAction } from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { defaultLinkAccountId, type DebtAccountOption } from '@/lib/ui/debt-accounts'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { LoanDto } from '@/lib/ui/loan-view-model'
import { DebtAccountField } from '@/components/debts/debt-account-field'
import { LinkPaymentsCheckbox } from '@/components/debts/link-payments-checkbox'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * "Record in an account" for a loan (spec 2026-10-12 §2 Q3, §6.4): a loan
 * recorded without an account — it predates the app, or "don't record" was
 * chosen — gets its disbursement (the CASH_IN of the principal) now, and, when
 * the box is ticked, the transactions of every instalment that has none yet:
 * principal and interest, each on the instalment's own date. This is how an
 * account's balance is reconciled with loans that moved money before linking
 * existed. Mounted by `LoanRowMenu`, the same as the debt's `DebtLinkForm`.
 *
 * The picker lists only active accounts in the loan's currency, under the
 * create form's own label ("received into"), with no "don't record" option —
 * recording is the whole point — and starts on the most recently used account
 * (else the first). The date starts on the loan's start date, the day the
 * create form would have dated the disbursement on. The box counts only the
 * instalments with no transaction yet (one already paid from an account is
 * skipped by the service), and is not shown when there are none. With no
 * account in the loan's currency the dialog says so instead of offering an
 * empty picker.
 *
 * On success the dialog closes, and the page re-renders with the loan linked,
 * so the menu item is gone and the balances on every page have moved.
 */
export function LoanLinkForm({
  loan,
  accounts,
  mostRecentAccountId,
  onDone,
}: {
  loan: LoanDto
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  onDone: () => void
}) {
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `loan-link-${name}-${uid}`
  const options = accounts.filter((account) => account.currency === loan.currency)
  const initialAccountId = defaultLinkAccountId(options, mostRecentAccountId)
  const unlinkedPayments = loan.payments.filter((payment) => payment.accountId === null).length
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LinkLoanToAccountInput>({
    resolver: zodResolver(linkLoanToAccountSchema),
    defaultValues: {
      accountId: initialAccountId,
      disbursedOn: loan.startDate,
      // With nothing to record the box is not rendered, and this is what is sent.
      includePayments: unlinkedPayments > 0,
    },
  })

  async function onSubmit(values: LinkLoanToAccountInput) {
    await submit.run({
      tag: 'LoanLinkForm: link failed',
      action: () => linkLoanToAccountAction(loan.id, values),
      errorKeys: LOAN_ERROR_KEYS,
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
          {t('loans.linkNoAccounts', { currency: loan.currency })}
        </p>
        <div className="flex justify-end pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">{t('loans.linkAction')}</legend>

        <DebtAccountField
          id={fieldId('account')}
          label={t('loans.account')}
          accounts={options}
          defaultAccountId={initialAccountId}
          registration={register('accountId')}
          error={errors.accountId?.message}
          allowNone={false}
        />

        <FormField
          id={fieldId('date')}
          label={t('loans.linkDisbursedOn')}
          error={errors.disbursedOn?.message}
        >
          {/* `defaultValue` as well as the form default, so the server-rendered
              input already shows the day rather than filling in on mount. */}
          {(aria) => (
            <Input
              {...aria}
              type="date"
              defaultValue={loan.startDate}
              {...register('disbursedOn')}
            />
          )}
        </FormField>

        {unlinkedPayments > 0 && (
          <LinkPaymentsCheckbox
            id={fieldId('payments')}
            label={t('loans.linkIncludePayments', { count: unlinkedPayments })}
            helper={t('loans.linkIncludePaymentsHelper')}
            registration={register('includePayments')}
          />
        )}

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit">
            {submit.pending ? t('loans.linkPending') : t('loans.linkSubmit')}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
