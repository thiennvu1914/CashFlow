'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { LoanForm } from '@/components/loans/loan-form'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'

/**
 * The header's "Thêm khoản vay" action (spec §6.6): creation is secondary to
 * the loans already on screen, so it opens a right sheet rather than sitting
 * inline on the page.
 *
 * `today` is the page's own `todayCalendarDateInZone` reading, threaded
 * through to `LoanForm` for the next-due-date default — never `new Date()` in
 * the browser, whose zone is not the profile's.
 */
export function LoanCreateButton({ today }: { today: string }) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t('loans.openCreate')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('loans.createTitle')}
        description={t('loans.description')}
        closeLabel={t('common.close')}
      >
        <LoanForm today={today} onCreated={() => setOpen(false)} />
      </Sheet>
    </>
  )
}
