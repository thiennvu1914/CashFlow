'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { AccountForm } from '@/components/accounts/account-form'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'

/**
 * The header's "Thêm tài khoản" action (spec §6.4): creation is secondary to
 * the overview, so it opens a right sheet rather than sitting inline on the
 * page. Same shape as `TransactionCreatePanelProvider`'s sheet half, minus the
 * always-visible sticky panel — Accounts has no tablet/desktop inline form, so
 * this button is the form's only home at every width.
 */
export function AccountCreateButton({
  accountTypes,
}: {
  accountTypes: { id: string; name: string }[]
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t('accounts.openCreate')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('accounts.createTitle')}
        closeLabel={t('common.close')}
      >
        <AccountForm accountTypes={accountTypes} onCreated={() => setOpen(false)} />
      </Sheet>
    </>
  )
}
