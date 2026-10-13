import { describe, expect, it, vi } from 'vitest'
import { agreementMenuActions } from './agreement-menu-actions'

/**
 * Which items a debt's or a loan's `…` menu offers — the pure half of
 * `DebtRowMenu` / `LoanRowMenu`, tested here because a closed Base UI menu
 * renders no items into static markup.
 *
 * An agreement is always either recorded in an account or not, so it always
 * offers exactly one of "Record in an account" and "Remove from account" — the
 * undo (final review F1) — whatever its status: a written-off debt or a closed
 * loan refuses every other write, but which account its money moved through can
 * still be corrected.
 */
const ITEMS = {
  edit: { id: 'edit', label: 'Sửa', onSelect: vi.fn() },
  link: { id: 'link', label: 'Ghi vào tài khoản', onSelect: vi.fn() },
  unlink: { id: 'unlink', label: 'Bỏ ghi vào tài khoản', onSelect: vi.fn() },
  finish: { id: 'finish', label: 'Xóa nợ', onSelect: vi.fn() },
}

function ids(state: { active: boolean; linked: boolean }): string[] {
  return agreementMenuActions(state, ITEMS).map((action) => action.id)
}

describe('agreementMenuActions', () => {
  it('offers Edit, Record in an account and the finishing action on a live agreement that moved no money', () => {
    expect(ids({ active: true, linked: false })).toEqual(['edit', 'link', 'finish'])
  })

  it('offers Remove from account instead of Record in an account once the agreement is recorded', () => {
    expect(ids({ active: true, linked: true })).toEqual(['edit', 'unlink', 'finish'])
  })

  it('offers only Record in an account on a finished agreement that moved no money', () => {
    expect(ids({ active: false, linked: false })).toEqual(['link'])
  })

  it('offers only Remove from account on a finished agreement that is recorded in an account', () => {
    expect(ids({ active: false, linked: true })).toEqual(['unlink'])
  })

  it('marks Remove from account as destructive: it deletes transactions', () => {
    const [unlink] = agreementMenuActions({ active: false, linked: true }, ITEMS)
    expect(unlink).toMatchObject({ id: 'unlink', tone: 'negative' })
  })
})
