'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { GoalForm } from '@/components/goals/goal-form'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'

/**
 * The header's "Thêm mục tiêu" action (spec §6.5): creation is secondary to
 * the goals already on screen, so it opens a right sheet rather than sitting
 * inline on the page (as `GoalForm` used to, under an "Add goal" `h2`).
 */
export function GoalCreateButton() {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t('goals.openCreate')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('goals.createTitle')}
        closeLabel={t('common.close')}
      >
        <GoalForm onCreated={() => setOpen(false)} />
      </Sheet>
    </>
  )
}
