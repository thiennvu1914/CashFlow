'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import {
  createFinancialAccountSchema,
  type CreateFinancialAccountInput,
} from '@/lib/validation/financial-account'
import { createFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'
import { ACCOUNT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type AccountType = { id: string; name: string }

export function AccountForm({
  accountTypes,
  onCreated,
}: {
  accountTypes: AccountType[]
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
  /**
   * A per-instance prefix, same reasoning as `TransactionForm`'s `uid`: a
   * hard-coded id would make `<label for>` bind to whichever instance's
   * control happens to match first, were this form ever mounted more than
   * once at a time.
   */
  const uid = useId().replace(/:/g, '')
  const fieldId = (name: string) => `account-${name}-${uid}`
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateFinancialAccountInput>({
    resolver: zodResolver(createFinancialAccountSchema),
    // `accountTypeId` defaults to the first option so the <select>'s visible
    // selection and the form's actual value always agree — without this, the
    // browser renders the first <option> while the form field stays `''`
    // until the user touches the control, so a submit before any interaction
    // would silently send an empty accountTypeId.
    defaultValues: {
      currency: 'VND',
      initialBalance: 0,
      accountTypeId: accountTypes[0]?.id ?? '',
    },
  })

  async function onSubmit(values: CreateFinancialAccountInput) {
    await submit.run({
      tag: 'AccountForm: create failed',
      action: () => createFinancialAccountAction(values),
      errorKeys: ACCOUNT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => {
        reset()
        router.refresh()
        onCreated?.()
      },
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate — same mechanism, same reasoning, as
          `TransactionForm`'s; `lib/ui/use-hydrated.ts` documents the defect.
          A live pre-fix probe reverted this form's "Initial balance" to `0`
          5/5 times when it was typed before hydration finished. (The Account
          name survived 5/5 — it has no `defaultValues` entry, and RHF only
          overwrites the DOM for fields that do; the gate covers both rather
          than leaving the rule "whichever fields happen to have a default".)

          Every `<select>` here defaults to its own first option, so none needs
          a `defaultValue` to make the server HTML agree with the form — and
          none may EVER carry one (or an explicit `<option selected>`), which
          `account-form.test.tsx` asserts on the real SSR markup. */}
      <fieldset
        disabled={!hydrated || submit.locked}
        aria-busy={!hydrated || submit.busy ? true : undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">{t('accounts.createTitle')}</legend>

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
              <select {...aria} {...register('currency')} className={SELECT_CLASS}>
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
          id={fieldId('description')}
          label={t('accounts.description')}
          error={errors.description?.message}
        >
          {(aria) => <Input {...aria} {...register('description')} />}
        </FormField>

        <Button type="submit" className="self-start">
          {submit.pending ? t('accounts.createPending') : t('accounts.createAction')}
        </Button>

        {error && <InlineAlert tone="negative">{error}</InlineAlert>}
      </fieldset>
    </form>
  )
}
