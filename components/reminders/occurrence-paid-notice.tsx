'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { InlineAlert } from '@/components/common/inline-alert'

/**
 * "Đã ghi giao dịch — Sửa / Transaction recorded — Edit": what the Reminders
 * page says after a one-tap "Paid" recorded the transaction (money-source
 * linking spec 2026-10-12 §6.6).
 *
 * It cannot live in the row that was paid: the action revalidates
 * `/reminders`, the paid occurrence leaves the pending list in the same
 * response, and its `OccurrenceActions` unmounts with it. So the confirmation
 * is lifted to a Context around the whole "due" region — the same
 * Server/Client-boundary pattern as `components/common/row-error-context.tsx`
 * — where it survives the row (and the region turning into its empty state
 * when that was the last bill) until the next Paid replaces it or the user
 * leaves the page.
 *
 * Edit opens the new row's edit sheet through the Transactions page's
 * `?edit=<id>` deep link, so a recorded amount that differed from the expected
 * one is one tap from being corrected.
 */

export interface PaidNotice {
  /** The reminder's title — the row the user just tapped is gone. */
  title: string
  transactionId: string
}

const AnnounceContext = createContext<((notice: PaidNotice) => void) | null>(null)
const NoticeContext = createContext<PaidNotice | null>(null)

export function OccurrencePaidProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<PaidNotice | null>(null)
  return (
    <AnnounceContext.Provider value={setNotice}>
      <NoticeContext.Provider value={notice}>{children}</NoticeContext.Provider>
    </AnnounceContext.Provider>
  )
}

/** What `OccurrenceActions` calls once Paid has recorded the transaction. */
export function useAnnouncePaid(): (notice: PaidNotice) => void {
  const announce = useContext(AnnounceContext)
  if (!announce) {
    throw new Error('useAnnouncePaid must be called from inside an OccurrencePaidProvider')
  }
  return announce
}

/** The confirmation, wherever the page puts it inside the provider. */
export function OccurrencePaidNotice() {
  const notice = useContext(NoticeContext)
  return notice ? <PaidNoticeView notice={notice} /> : null
}

/**
 * The confirmation itself — `positive`, so it is a polite live region
 * (`role="status"`) announced without stealing focus. The link carries the
 * reminder's title in its accessible name: "Sửa" alone would not say what it
 * edits once the row it came from has gone.
 */
export function PaidNoticeView({ notice }: { notice: PaidNotice }) {
  const t = useTranslations()
  return (
    <InlineAlert tone="positive">
      {t('reminders.paidNotice', { title: notice.title })}
      {' — '}
      <Link
        href={`/transactions?edit=${encodeURIComponent(notice.transactionId)}`}
        aria-label={t('reminders.paidNoticeEditLabel', { title: notice.title })}
        className="font-medium underline underline-offset-4"
      >
        {t('reminders.paidNoticeEdit')}
      </Link>
    </InlineAlert>
  )
}
