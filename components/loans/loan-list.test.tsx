import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}|${JSON.stringify(args)}` : key,
}))

import { LoanList } from './loan-list'
import type { LoanDto } from '@/lib/ui/loan-view-model'

function dto(overrides: Partial<LoanDto> = {}): LoanDto {
  return {
    id: 'l1',
    lender: 'Vietcombank',
    currency: 'VND',
    principal: '240.000.000',
    principalPaid: '3.500.000',
    interestPaid: '1.500.000',
    outstandingPrincipal: '236.500.000',
    percentRepaid: 1,
    percentLabel: '1 %',
    nextDueDate: '2026-05-15',
    dueSoon: false,
    overdue: false,
    scheduledPayment: '5.000.000',
    paymentFrequency: 'MONTHLY',
    interestRateLabel: '8,5 %',
    termMonths: 60,
    startDate: '2026-01-15',
    status: 'ACTIVE',
    active: true,
    notes: null,
    payments: [],
    editable: { lender: 'Vietcombank', scheduledPaymentAmount: '5000000.00', notes: '' },
    ...overrides,
  }
}

describe('LoanList', () => {
  it('renders a muted caption via loans.outstandingLabel plus the dominant figure, at two sizes for two breakpoints', async () => {
    const html = renderToStaticMarkup(
      await LoanList({ loans: [dto()], locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' }),
    )
    expect(html).toContain('loans.outstandingLabel')
    expect(html).toContain('236.500.000')
    // Two `MoneyText`s, one per breakpoint (fix round 1, finding 6) — never
    // the whole label+figure+currency sentence forced through `MoneyText`'s
    // own `whitespace-nowrap`, which clips at narrow widths.
    expect(html).toMatch(/text-\[1\.5rem\][^"]*"[^>]*>236\.500\.000/) // sm:hidden, size="lg"
    expect(html).toMatch(/sm:hidden/)
    expect(html).toMatch(/hidden sm:inline-flex/)
    // The dominant-figure size class from `MoneyText`'s `kpi` variant.
    expect(html).toMatch(/text-\[1\.625rem\]/)
  })

  it('renders the second line via loans.nextDueLine with the date, instalment and frequency label', async () => {
    const html = renderToStaticMarkup(
      await LoanList({
        loans: [dto({ nextDueDate: '2026-05-15', paymentFrequency: 'MONTHLY' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('loans.nextDueLine')
    // The carrier is read in UTC and formatted for the reader's locale — vi-VN
    // renders dd/MM/yyyy — never the raw `yyyy-MM-dd` carrier string.
    expect(html).toContain('&quot;date&quot;:&quot;15/05/2026&quot;')
    expect(html).toContain('labels.paymentFrequency.MONTHLY')
  })

  it('uses loans.overdueLine/text-negative and loans.dueSoonLine/text-warning, and the plain line for a settled loan regardless of stored flags', async () => {
    const overdueHtml = renderToStaticMarkup(
      await LoanList({
        loans: [dto({ overdue: true, dueSoon: false, status: 'OVERDUE' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(overdueHtml).toContain('loans.overdueLine')
    expect(overdueHtml).toContain('text-negative')
    expect(overdueHtml).not.toContain('loans.dueSoonLine')
    expect(overdueHtml).not.toContain('loans.nextDueLine')

    const dueSoonHtml = renderToStaticMarkup(
      await LoanList({
        loans: [dto({ overdue: false, dueSoon: true })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(dueSoonHtml).toContain('loans.dueSoonLine')
    expect(dueSoonHtml).toContain('text-warning')
    expect(dueSoonHtml).not.toContain('loans.overdueLine')
    expect(dueSoonHtml).not.toContain('loans.nextDueLine')

    // A PAID_OFF or CLOSED loan always lands on the plain wording, whatever its
    // stored `overdue`/`dueSoon` flags say — the DTO makes the two mutually
    // exclusive with ACTIVE, but this asserts the row's own precedence too.
    for (const status of ['PAID_OFF', 'CLOSED'] as const) {
      const html = renderToStaticMarkup(
        await LoanList({
          loans: [dto({ status, overdue: false, dueSoon: false, active: status !== 'CLOSED' })],
          locale: 'vi',
          timeZone: 'Asia/Ho_Chi_Minh',
        }),
      )
      expect(html, status).toContain('loans.nextDueLine')
      expect(html, status).not.toContain('loans.overdueLine')
      expect(html, status).not.toContain('loans.dueSoonLine')
    }
  })

  it('renders the third line via loans.interestLine with the rate and the interest paid', async () => {
    const html = renderToStaticMarkup(
      await LoanList({
        loans: [dto({ interestRateLabel: '8,5 %', interestPaid: '1.500.000' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('loans.interestLine')
    expect(html).toContain('&quot;rate&quot;:&quot;8,5 %&quot;')
    expect(html).toContain('&quot;paid&quot;:&quot;1.500.000&quot;')
  })

  it('measures principal repaid with a bg-positive bar, announcing the true percentage when clamped', async () => {
    const html = renderToStaticMarkup(
      await LoanList({
        loans: [dto({ percentRepaid: 100, percentLabel: '120 %' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('bg-positive')
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuetext="120 %"')
  })

  it('names the progress bar with the bare lender, never a hard-coded English suffix (fix round 1, finding 2)', async () => {
    const html = renderToStaticMarkup(
      await LoanList({
        loans: [dto({ lender: 'Techcombank' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('aria-label="Techcombank"')
    expect(html).not.toContain('principal repaid')
  })

  it('renders loans.principalOfLine with the original principal beside the outstanding figure', async () => {
    const html = renderToStaticMarkup(
      await LoanList({
        loans: [dto({ principal: '240.000.000', currency: 'VND' })],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    )
    expect(html).toContain('loans.principalOfLine')
    expect(html).toContain('&quot;principal&quot;:&quot;240.000.000&quot;')
  })

  it('compact renders only the lender and the outstanding principal', async () => {
    const html = renderToStaticMarkup(
      await LoanList({
        loans: [dto()],
        locale: 'vi',
        timeZone: 'Asia/Ho_Chi_Minh',
        compact: true,
      }),
    )
    expect(html).toContain('Vietcombank')
    expect(html).toContain('236.500.000')
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('labels.loanStatus')
    expect(html).not.toContain('loans.nextDueLine')
    expect(html).not.toContain('loans.interestLine')
    expect(html).not.toContain('loans.termLine')
  })
})
