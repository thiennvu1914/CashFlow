import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import type { SavingsGoalDto } from '@/lib/ui/savings-goal-view-model'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/lib/server/actions/savings-goal-actions', () => ({
  addSavingsGoalEntryAction: vi.fn(),
  archiveSavingsGoalAction: vi.fn(),
  deleteSavingsGoalEntryAction: vi.fn(),
  updateSavingsGoalAction: vi.fn(),
  updateSavingsGoalEntryAction: vi.fn(),
}))

const { GoalEditForm } = await import('./goal-row-actions')
const messages = await loadMessages('vi')
const CURRENCY_LOCKED = (messages as { goals: { currencyLocked: string } }).goals.currencyLocked

const ACCOUNTS = [
  { id: 'a1', name: 'Tiền mặt', currency: 'VND' as const },
  { id: 'a2', name: 'Đô la', currency: 'USD' as const },
]

function dto(overrides: Partial<SavingsGoalDto> = {}, linkedAccountId = ''): SavingsGoalDto {
  return {
    id: 'g1',
    name: 'MacBook',
    currency: 'VND',
    status: 'ACTIVE',
    target: '50.000.000',
    progress: '0',
    remaining: '50.000.000',
    percent: 0,
    percentLabel: '0 %',
    deadline: null,
    deadlinePassed: false,
    daysToDeadline: null,
    linkedAccount: null,
    entries: [],
    editable: {
      name: 'MacBook',
      targetAmount: '50000000.00',
      currency: 'VND',
      deadline: '',
      note: '',
      linkedAccountId,
    },
    ...overrides,
  }
}

function render(goal: SavingsGoalDto): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <GoalEditForm goal={goal} accounts={ACCOUNTS} onDone={() => {}} />
    </NextIntlClientProvider>,
  )
}

function selectById(html: string, prefix: string): string {
  const idMatch = html.match(new RegExp(`id="${prefix}-[^"]*"`))
  if (!idMatch) throw new Error(`No ${prefix} select`)
  const start = html.lastIndexOf('<select', html.indexOf(idMatch[0]))
  return html.slice(start, html.indexOf('</select>', start))
}

function selectedValue(select: string): string | null {
  const m =
    select.match(/<option[^>]*\svalue="([^"]*)"[^>]*\sselected=""/) ??
    select.match(/<option[^>]*\sselected=""[^>]*\svalue="([^"]*)"/)
  return m ? m[1] : null
}

const ENTRY = {
  id: 'e1',
  kind: 'CONTRIBUTION' as const,
  amount: '1',
  amountValue: '1.00',
  date: '2026-03-01',
  note: '',
}

describe('GoalEditForm', () => {
  it('starts on "Không gắn" for an unlinked goal, listing it first', () => {
    const select = selectById(render(dto()), 'goal-edit-account')
    expect(selectedValue(select)).toBe('')
    expect(select.indexOf('Không gắn')).toBeLessThan(select.indexOf('Tiền mặt'))
  })

  it('pre-selects the linked account so saving does not unlink', () => {
    const goal = dto({ linkedAccount: { id: 'a1', name: 'Tiền mặt', archived: false } }, 'a1')
    expect(selectedValue(selectById(render(goal), 'goal-edit-account'))).toBe('a1')
  })

  it('keeps an archived linked account selected and labelled', () => {
    const goal = dto({ linkedAccount: { id: 'gone', name: 'Quỹ cũ', archived: true } }, 'gone')
    const select = selectById(render(goal), 'goal-edit-account')
    expect(selectedValue(select)).toBe('gone')
    expect(select).toContain('Quỹ cũ · VND (đã lưu trữ)')
  })

  it('shows an enabled currency select and no hint when the goal has no entries', () => {
    const html = render(dto())
    expect(selectById(html, 'goal-edit-currency')).not.toMatch(/\sdisabled=""/)
    expect(html).not.toContain(CURRENCY_LOCKED)
  })

  it('disables the currency select and explains why when the goal has entries', () => {
    const html = render(dto({ entries: [ENTRY] }))
    expect(selectById(html, 'goal-edit-currency')).toMatch(/\sdisabled=""/)
    expect(html).toContain(CURRENCY_LOCKED)
    // Only the goal's own currency is offered as an account.
    expect(selectById(html, 'goal-edit-account')).not.toContain('Đô la')
  })

  it('hides the currency select while an account is chosen', () => {
    const goal = dto({ linkedAccount: { id: 'a1', name: 'Tiền mặt', archived: false } }, 'a1')
    expect(render(goal)).not.toMatch(/id="goal-edit-currency-/)
  })
})
