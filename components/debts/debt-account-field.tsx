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
 *
 * The loan forms use it too — the options and their wording are the same; only
 * the label differs ("received into" a loan's account, "paid from" an
 * instalment's), so `label` overrides the debts' plain "Account".
 *
 * The savings goals use it for "Linked account" (`label`, `noneLabel`): the
 * same list, the same archived-account labelling.
 *
 * "Record in an account" (spec 2026-10-12 §6.4) passes `allowNone={false}`:
 * recording is the whole point of that dialog, so it lists the accounts alone.
 */
export function DebtAccountField({
  id,
  accounts,
  defaultAccountId,
  registration,
  error,
  helper,
  label,
  noneLabel,
  allowNone = true,
}: {
  id: string
  accounts: ReadonlyArray<DebtAccountOption>
  defaultAccountId: string
  registration: UseFormRegisterReturn
  error?: string
  helper?: string
  label?: string
  /** The first option's wording, when "don't record in an account" is not what
   *  it means (the savings goals' "Not linked"). */
  noneLabel?: string
  /** Offer "don't record in an account" as the first option (the default). */
  allowNone?: boolean
}) {
  const t = useTranslations()

  return (
    <FormField id={id} label={label ?? t('debts.account')} helper={helper} error={error}>
      {(aria) => (
        <select
          {...aria}
          {...registration}
          defaultValue={defaultAccountId}
          className={SELECT_CLASS}
        >
          {allowNone && <option value="">{noneLabel ?? t('debts.accountNone')}</option>}
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {t(account.archived ? 'debts.accountOptionArchived' : 'debts.accountOption', {
                name: account.name,
                currency: account.currency,
              })}
            </option>
          ))}
        </select>
      )}
    </FormField>
  )
}
