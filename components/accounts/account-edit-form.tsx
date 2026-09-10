'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import type { Currency } from '@prisma/client'
import {
  updateFinancialAccountSchema,
  type UpdateFinancialAccountInput,
} from '@/lib/validation/financial-account'
import { updateFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'
import { ACCOUNT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type AccountType = { id: string; name: string }

/**
 * Edits an existing FinancialAccount. Kept as its own (small) component
 * rather than a mode-switched `AccountForm`, since create and edit submit
 * different action shapes (`createFinancialAccountAction` takes no id; this
 * always has one) and only edit ever needs the `locked` behaviour.
 *
 * `locked` is computed server-side (`accountsWithActivity`, in
 * `app/(app)/accounts/page.tsx`) and passed in as a prop — this component
 * has no business logic of its own, it only reacts to the flag. When locked,
 * currency and initialBalance are both disabled AND stripped from the
 * submitted payload: `updateFinancialAccount` rejects an update that even
 * *carries* either field once the account has activity, regardless of
 * whether the value actually changed, so the locked fields must never be
 * sent at all, not merely sent unchanged.
 *
 * Mounted only while its `Dialog` is open (`AccountList`), so it never
 * exists during SSR/hydration and needs no `useHydrated` gate (spec §9) —
 * but it still gets the in-flight lock (`useActionSubmit`, which wraps
 * `useSubmitState`), so a slow update cannot be double-submitted.
 */
export function AccountEditForm({
  accountId,
  accountTypes,
  locked,
  initialValues,
  onDone,
}: {
  accountId: string
  accountTypes: AccountType[]
  locked: boolean
  initialValues: {
    name: string
    accountTypeId: string
    description?: string | null
    currency: Currency
    initialBalance: number
  }
  onDone?: () => void
}) {
  const router = useRouter()
  const t = useTranslations()
  const [error, setError] = useState<string | null>(null)
  const submit = useActionSubmit(t)
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `account-edit-${name}-${uid}`
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UpdateFinancialAccountInput>({
    resolver: zodResolver(updateFinancialAccountSchema),
    defaultValues: {
      name: initialValues.name,
      accountTypeId: initialValues.accountTypeId,
      description: initialValues.description ?? undefined,
      currency: initialValues.currency,
      initialBalance: initialValues.initialBalance,
    },
  })

  async function onSubmit(values: UpdateFinancialAccountInput) {
    const payload: UpdateFinancialAccountInput = locked
      ? {
          name: values.name,
          accountTypeId: values.accountTypeId,
          description: values.description,
        }
      : values

    await submit.run({
      tag: 'AccountEditForm: update failed',
      action: () => updateFinancialAccountAction(accountId, payload),
      errorKeys: ACCOUNT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        router.refresh()
        onDone?.()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset disabled={submit.locked} aria-busy={submit.busy} className="flex flex-col gap-3">
        <legend className="sr-only">{t('accounts.editAction')}</legend>

        <FormField id={fieldId('name')} label={t('accounts.name')} error={errors.name?.message}>
          {(aria) => <Input {...aria} {...register('name')} />}
        </FormField>

        <FormField
          id={fieldId('type')}
          label={t('accounts.type')}
          error={errors.accountTypeId?.message}
        >
          {(aria) => (
            <div className="relative">
              <select {...aria} {...register('accountTypeId')} className={SELECT_CLASS}>
                {accountTypes.map((accountType) => (
                  <option key={accountType.id} value={accountType.id}>
                    {accountType.name}
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
          id={fieldId('initial-balance')}
          label={t('accounts.initialBalance')}
          error={errors.initialBalance?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              step="0.01"
              disabled={locked}
              {...register('initialBalance', { valueAsNumber: true })}
            />
          )}
        </FormField>

        <FormField
          id={fieldId('currency')}
          label={t('accounts.currency')}
          error={errors.currency?.message}
        >
          {(aria) => (
            <div className="relative">
              <select
                {...aria}
                {...register('currency')}
                disabled={locked}
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

        {locked && <InlineAlert tone="neutral">{t('accounts.lockedNotice')}</InlineAlert>}

        <FormField
          id={fieldId('description')}
          label={t('accounts.description')}
          error={errors.description?.message}
        >
          {(aria) => <Input {...aria} {...register('description')} />}
        </FormField>

        <div className="flex gap-2">
          <Button type="submit">{submit.pending ? t('common.saving') : t('common.save')}</Button>
          {onDone && (
            <Button type="button" variant="outline" onClick={onDone}>
              {t('common.cancel')}
            </Button>
          )}
        </div>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
