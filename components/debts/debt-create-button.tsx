'use client'

import { useState } from 'react'
import type { Currency } from '@prisma/client'
import { useTranslations } from 'next-intl'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import { DebtForm } from '@/components/debts/debt-form'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'

/**
 * The header's "Thêm công nợ" action (spec §6.6): creation is secondary to
 * the debts already on screen, so it opens a right sheet rather than sitting
 * inline on the page.
 */
export function DebtCreateButton({
  accounts,
  defaultAccountId,
  baseCurrency,
  today,
}: {
  accounts: ReadonlyArray<DebtAccountOption>
  /** The most recently used active account, or null. */
  defaultAccountId: string | null
  baseCurrency: Currency
  today: string
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t('debts.openCreate')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('debts.createTitle')}
        description={t('debts.description')}
        closeLabel={t('common.close')}
      >
        <DebtForm
          accounts={accounts}
          defaultAccountId={defaultAccountId}
          baseCurrency={baseCurrency}
          today={today}
          onCreated={() => setOpen(false)}
        />
      </Sheet>
    </>
  )
}
