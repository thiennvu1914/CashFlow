'use client'

import type { UseFormRegisterReturn } from 'react-hook-form'
import { useTranslations } from 'next-intl'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'

/**
 * The account picker the debt forms share (spec §2 Q2): "Không ghi vào tài
 * khoản" first, then the active accounts the caller passes.
 *
 * A native `<select>`, like the reminder form's account field and every other
 * select here that is not choosing between rich options: a name and a currency
 * fit in an `<option>`'s text, and being uncontrolled it gets its server-side
 * `selected` marker from `defaultValue` with no hydration gymnastics.
 * `''` is "don't record in an account"; the form's `setValueAs` turns it into
 * `undefined` so the schema reads it as no account.
 */
export function DebtAccountField({
  id,
  accounts,
  defaultAccountId,
  registration,
  error,
  helper,
}: {
  id: string
  accounts: ReadonlyArray<DebtAccountOption>
  defaultAccountId: string
  registration: UseFormRegisterReturn
  error?: string
  helper?: string
}) {
  const t = useTranslations()

  return (
    <FormField id={id} label={t('debts.account')} helper={helper} error={error}>
      {(aria) => (
        <select
          {...aria}
          {...registration}
          defaultValue={defaultAccountId}
          className={SELECT_CLASS}
        >
          <option value="">{t('debts.accountNone')}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {t('debts.accountOption', { name: account.name, currency: account.currency })}
            </option>
          ))}
        </select>
      )}
    </FormField>
  )
}
