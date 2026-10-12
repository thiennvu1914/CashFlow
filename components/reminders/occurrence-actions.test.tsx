import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import type { OccurrenceDto } from '@/lib/ui/reminder-view-model'

/**
 * A markup test, like the rest of this repo's component tests: what a due
 * occurrence offers on first paint, and what the page says after a one-tap
 * "Đã trả / Paid" (money-source linking spec 2026-10-12 §2 Q6, §6.6) — in the
 * real Vietnamese copy (`loadMessages('vi')`).
 *
 * `useRouter` throws outside a mounted app router, and the action module would
 * pull Prisma and Better Auth in for a test that never clicks, so both are
 * mocked.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/reminder-actions', () => ({
  acknowledgeOccurrenceAction: vi.fn(),
  dismissOccurrenceAction: vi.fn(),
  payOccurrenceAction: vi.fn(),
}))

const { OccurrenceActions } = await import('./occurrence-actions')
const { OccurrencePaidProvider, PaidNoticeView } = await import('./occurrence-paid-notice')

const TIMEZONE = 'Asia/Ho_Chi_Minh'
const messages = await loadMessages('vi')

const OCCURRENCE: OccurrenceDto = {
  id: 'occ_1',
  reminderId: 'rem_1',
  title: 'Internet',
  type: 'EXPENSE',
  frequency: 'MONTHLY',
  interval: 1,
  amount: '350.000',
  currency: 'VND',
  dueDate: '2026-04-15',
  daysToDue: 0,
  overdue: false,
  categoryName: null,
  accountName: null,
  status: 'PENDING',
}

function renderActions(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone={TIMEZONE} messages={messages}>
      <OccurrencePaidProvider>
        <OccurrenceActions occurrence={OCCURRENCE} locale="vi" timeZone={TIMEZONE} />
      </OccurrencePaidProvider>
    </NextIntlClientProvider>,
  )
}

/** Every button's visible text, in document order. */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
}

describe('OccurrenceActions', () => {
  it('offers Paid first, then Mark only and Dismiss', () => {
    expect(buttonLabels(renderActions())).toEqual(['Đã trả', 'Chỉ đánh dấu', 'Bỏ qua'])
  })

  it('names each button after its row, by title and visible due date', () => {
    const html = renderActions()

    for (const action of ['Đã trả', 'Chỉ đánh dấu', 'Bỏ qua']) {
      expect(html).toContain(`aria-label="${action} Internet · 15/04/2026"`)
    }
  })

  it('gives only Paid a visible edge, and fills none of them', () => {
    const html = renderActions()
    const paid = html.match(/<button[^>]*aria-label="Đã trả[^"]*"[^>]*>/)?.[0] ?? ''
    const markOnly = html.match(/<button[^>]*aria-label="Chỉ đánh dấu[^"]*"[^>]*>/)?.[0] ?? ''

    // `outline`'s own border/surface classes versus `ghost`'s transparent one;
    // `bg-primary` is the filled default variant, kept for the header action.
    expect(paid).toContain('bg-surface')
    expect(markOnly).toContain('border-transparent')
    expect(html).not.toContain('bg-primary')
  })
})

describe('PaidNoticeView', () => {
  function renderNotice(): string {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="vi" timeZone={TIMEZONE} messages={messages}>
        <PaidNoticeView notice={{ title: 'Internet', transactionId: 'tx_1' }} />
      </NextIntlClientProvider>,
    )
  }

  it('says the transaction was recorded, politely, naming the reminder', () => {
    const html = renderNotice()

    expect(html).toContain('role="status"')
    expect(html).toContain('Đã ghi giao dịch: Internet — ')
  })

  it("links Edit to the new row's edit sheet, with a name that says what it edits", () => {
    const link = renderNotice().match(/<a [^>]*>Sửa<\/a>/)?.[0] ?? ''

    expect(link).toContain('href="/transactions?edit=tx_1"')
    expect(link).toContain('aria-label="Sửa giao dịch Internet"')
  })
})
